import express from 'express'
import cors from 'cors'
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createApiV2Router } from './api-v2.js'
import { composeApp } from './compose.js'
import { createSettingsStore } from './core/settings.js'

const execFileAsync = promisify(execFile)

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')
const WEB_ROOT = resolve(__dirname, '..')
const DATA_DIR = join(WEB_ROOT, 'data')
const BIN_DIR = join(ROOT, 'resources', 'bin')
const DOWNLOADS_DIR = join(WEB_ROOT, 'downloads')
const PUBLIC_DIR = join(WEB_ROOT, 'client', 'dist')
const SUANLE_DIR = join(WEB_ROOT, 'suanle')
const CONFIG_PATH = join(DATA_DIR, 'share-config.json')

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7
const AUTH_REQUIRED = false
const WEB_VERSION = '0.3.1'

// miaoCut remote brain. Self-host: MIAOCUT_BASE_URL=http://127.0.0.1:8000
const MIAOCUT_BASE_URL = String(process.env.MIAOCUT_BASE_URL || 'https://api2.miaocut.app').replace(/\/$/, '')
const MIAOCUT_ORIGIN = String(process.env.MIAOCUT_ORIGIN || 'https://miaocut.app').replace(/\/$/, '')
const MIAOCUT_GATEWAY_SECRET = String(process.env.MIAOCUT_GATEWAY_SECRET || '').trim()
const MIAOCUT_TIMEOUT_MS = Number(process.env.MIAOCUT_TIMEOUT_MS || 120000)
const MIAOCUT_MAX_UPLOAD = Number(process.env.MIAOCUT_MAX_UPLOAD || 12 * 1024 * 1024)
const MIAOCUT_PROFILES = new Set(['sharp', 'fur'])

const app = express()
app.use(cors())
app.use(express.json({ limit: '1mb' }))

const settingsStore = createSettingsStore()

// v2 直链垂直切片：compose.js 统一装配（解析 + 任务调度 + 资产交付）
// 注意：compose 拿到的是 settings 快照；PUT /api/settings 后 applySettings 仅同步 concurrency，
// maxAttempts/redfoxApiKey 等保持启动值（已知限制，重启后生效）。
const composed = composeApp({ settings: settingsStore.get() })
app.use('/api/v2', createApiV2Router({ ...composed, authRequired: AUTH_REQUIRED ? authRequired : null }))

// 重启恢复：RESOLVING/DOWNLOADING/PROCESSING 的中断任务置为 RETRY_WAIT，由用户手动重试
const recovered = composed.store.recoverInterrupted()
console.log(`[recover] ${recovered.length} 个中断任务已恢复为可重试状态`)

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
}

// yt-dlp 以 DATA_DIR 为 TEMP 运行，异常退出会留下 _MEI* PyInstaller 解包目录
function cleanupStalePyinstallerDirs() {
  ensureDataDir()
  for (const name of readdirSync(DATA_DIR)) {
    if (!name.startsWith('_MEI')) continue
    try {
      const full = join(DATA_DIR, name)
      if (statSync(full).isDirectory()) rmSync(full, { recursive: true, force: true })
    } catch {
      /* 占用中则跳过 */
    }
  }
}

cleanupStalePyinstallerDirs()

function loadShareConfig() {
  ensureDataDir()
  const envPassword = String(process.env.IKUN_WEB_PASSWORD || '').trim()
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (envPassword) {
        raw.password = envPassword
        writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), 'utf8')
      }
      return raw
    } catch {
      /* recreate below */
    }
  }
  const password = envPassword || randomBytes(4).toString('hex')
  const config = {
    password,
    createdAt: Date.now(),
    note: '访问密码。可用环境变量 IKUN_WEB_PASSWORD 覆盖。'
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
  return config
}

const shareConfig = loadShareConfig()
const sessions = new Map()

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function createSession() {
  const token = randomBytes(24).toString('hex')
  const session = {
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS
  }
  sessions.set(session.tokenHash, session)
  return token
}

function getBearerToken(req) {
  const header = req.headers.authorization || ''
  if (header.startsWith('Bearer ')) return header.slice(7).trim()
  if (req.query?.token) return String(req.query.token)
  if (req.headers['x-access-token']) return String(req.headers['x-access-token'])
  return ''
}

function getClientId(req) {
  const raw = String(req.headers['x-client-id'] || req.query?.clientId || '').trim()
  if (raw && /^[a-zA-Z0-9_-]{8,80}$/.test(raw)) return raw
  return 'anonymous'
}

function authRequired(req, res, next) {
  if (!AUTH_REQUIRED) {
    req.clientId = getClientId(req)
    return next()
  }
  const token = getBearerToken(req)
  if (!token) {
    return res.status(401).json({ error: '需要访问密码', code: 'AUTH_REQUIRED' })
  }
  const session = sessions.get(hashToken(token))
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessions.delete(hashToken(token))
    return res.status(401).json({ error: '登录已过期，请重新输入访问密码', code: 'AUTH_EXPIRED' })
  }
  req.accessToken = token
  req.clientId = getClientId(req)
  next()
}

function getLanAddresses() {
  const nets = networkInterfaces()
  const result = []
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(net.address)
    }
  }
  return result
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    name: 'iKun Web',
    version: WEB_VERSION,
    shareable: true,
    authRequired: AUTH_REQUIRED
  })
})

app.get('/api/share-info', (_req, res) => {
  const lan = getLanAddresses()
  res.json({
    port: PORT,
    host: HOST,
    version: WEB_VERSION,
    localUrl: `http://127.0.0.1:${PORT}`,
    lanUrls: lan.map((ip) => `http://${ip}:${PORT}`),
    authRequired: AUTH_REQUIRED,
    passwordHint: AUTH_REQUIRED && shareConfig.password ? `${shareConfig.password.slice(0, 2)}****` : '',
    hasFrontend: existsSync(join(PUBLIC_DIR, 'index.html'))
  })
})

app.post('/api/login', (req, res) => {
  const password = String(req.body?.password || '').trim()
  if (!password || !safeEqual(password, shareConfig.password)) {
    return res.status(401).json({ error: '访问密码错误' })
  }
  const token = createSession()
  res.json({
    token,
    expiresIn: TOKEN_TTL_MS,
    message: '登录成功'
  })
})

app.get('/api/me', authRequired, (req, res) => {
  res.json({
    ok: true,
    clientId: req.clientId,
    expiresIn: TOKEN_TTL_MS
  })
})

app.get('/api/binaries', authRequired, async (_req, res) => {
  const ytdlpPath = join(BIN_DIR, 'yt-dlp.exe')
  const ffmpegPath = join(BIN_DIR, 'ffmpeg.exe')
  let ytdlpOk = false
  let version
  try {
    const { stdout } = await execFileAsync(ytdlpPath, ['--version'], { timeout: 15000, windowsHide: true })
    ytdlpOk = true
    version = stdout.trim()
  } catch {
    ytdlpOk = false
  }
  let ffmpegOk = false
  try {
    await execFileAsync(ffmpegPath, ['-version'], { timeout: 15000, windowsHide: true })
    ffmpegOk = true
  } catch {
    ffmpegOk = false
  }
  res.json({ ytdlp: ytdlpPath, ytdlpOk, version, ffmpeg: ffmpegPath, ffmpegOk })
})

app.get('/api/settings', authRequired, (_req, res) => {
  res.json(settingsStore.get())
})

app.put('/api/settings', authRequired, (req, res) => {
  try {
    const settings = settingsStore.set(req.body || {})
    composed.applySettings?.(settings)
    res.json(settings)
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) })
  }
})

function isRemoteMiaocut() {
  return /miaocut\.app$/i.test(new URL(MIAOCUT_BASE_URL).hostname)
}

function miaocutUpstreamHeaders(extra = {}) {
  const headers = { ...extra }
  // Official free API checks Origin/Referer; self-host usually does not.
  if (isRemoteMiaocut()) {
    headers.Origin = MIAOCUT_ORIGIN
    headers.Referer = `${MIAOCUT_ORIGIN}/`
  }
  if (MIAOCUT_GATEWAY_SECRET) headers['X-Gateway-Secret'] = MIAOCUT_GATEWAY_SECRET
  return headers
}

async function readRequestBody(req, limit = MIAOCUT_MAX_UPLOAD) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) {
      const err = new Error(`Upload exceeds ${Math.round(limit / 1024 / 1024)}MB limit`)
      err.status = 413
      throw err
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseMiaocutError(status, body) {
  const text = body?.toString?.('utf8') || ''
  try {
    const data = JSON.parse(text)
    const detail = data.detail || data.error || data.message
    if (typeof detail === 'string' && detail.trim()) return detail
    if (Array.isArray(detail) && detail[0]?.msg) return detail.map((d) => d.msg).join('; ')
  } catch {
    /* plain text */
  }
  if (status === 403) return '远程 AI 拒绝了请求（来源/网关校验）'
  if (status === 413) return '图片太大'
  if (status === 429) return '远程 AI 繁忙或今日额度已用尽，请稍后再试'
  if (status >= 500) return '远程 AI 暂时不可用'
  return text.slice(0, 200) || `上游错误（${status}）`
}

app.get('/api/ai/status', authRequired, async (_req, res) => {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const upstream = await fetch(`${MIAOCUT_BASE_URL}/readyz`, {
      headers: miaocutUpstreamHeaders({ Accept: 'application/json' }),
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
    const raw = await upstream.text()
    let data = null
    try {
      data = JSON.parse(raw)
    } catch {
      data = { raw: raw.slice(0, 200) }
    }
    res.json({
      ok: upstream.ok,
      status: upstream.status,
      baseUrl: MIAOCUT_BASE_URL,
      remote: isRemoteMiaocut(),
      upstream: data
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      baseUrl: MIAOCUT_BASE_URL,
      remote: isRemoteMiaocut(),
      error: error.name === 'AbortError' ? '探测超时' : error.message || String(error)
    })
  }
})

// 壳 + 远程脑：浏览器 → iKun /api/ai/* → miaoCut
app.post('/api/ai/remove-background', authRequired, async (req, res) => {
  try {
    const profileRaw = String(req.query.profile || 'sharp').toLowerCase()
    const profile = MIAOCUT_PROFILES.has(profileRaw) ? profileRaw : 'sharp'
    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      return res.status(400).json({ error: '请使用 multipart/form-data 上传图片（字段名 file）' })
    }

    const body = await readRequestBody(req)
    if (!body.length) return res.status(400).json({ error: '空请求体' })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MIAOCUT_TIMEOUT_MS)
    let upstream
    try {
      upstream = await fetch(
        `${MIAOCUT_BASE_URL}/api/remove-background?profile=${encodeURIComponent(profile)}`,
        {
          method: 'POST',
          headers: miaocutUpstreamHeaders({
            'Content-Type': contentType,
            Accept: 'image/png, application/json;q=0.9, */*;q=0.8'
          }),
          body,
          signal: controller.signal
        }
      )
    } finally {
      clearTimeout(timer)
    }

    const buf = Buffer.from(await upstream.arrayBuffer())
    if (!upstream.ok) {
      const retryAfter = upstream.headers.get('retry-after')
      if (retryAfter) res.setHeader('Retry-After', retryAfter)
      return res.status(upstream.status).json({
        error: parseMiaocutError(upstream.status, buf),
        code: upstream.status === 429 ? 'AI_RATE_LIMIT' : 'AI_UPSTREAM_ERROR'
      })
    }

    const outType = upstream.headers.get('content-type') || 'image/png'
    res.setHeader('Content-Type', outType)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-AI-Profile', profile)
    res.setHeader('X-AI-Upstream', isRemoteMiaocut() ? 'miaocut-remote' : 'miaocut-custom')
    const disposition = upstream.headers.get('content-disposition')
    if (disposition) res.setHeader('Content-Disposition', disposition)
    else res.setHeader('Content-Disposition', 'inline; filename="cutout.png"')
    res.send(buf)
  } catch (error) {
    if (error.status === 413) return res.status(413).json({ error: error.message })
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'AI 处理超时，请换更小的图或稍后再试', code: 'AI_TIMEOUT' })
    }
    console.error('[ai/remove-background]', error)
    res.status(502).json({ error: error.message || 'AI 代理失败', code: 'AI_PROXY_ERROR' })
  }
})

// 自动清理：删除 web/downloads/<jobId>/ 任务目录（及旧版散落文件），
// 并同步清理 jobs.json 中超过保留时长的终态任务记录
function cleanupExpiredDownloads() {
  const settings = settingsStore.get()
  if (!settings.autoCleanupEnabled) return { ok: true, skipped: true, deleted: 0, deletedJobs: 0 }
  const retentionHours = settings.retentionHours || 24
  const cutoff = Date.now() - retentionHours * 3600 * 1000
  let deleted = 0
  if (existsSync(DOWNLOADS_DIR)) {
    for (const name of readdirSync(DOWNLOADS_DIR)) {
      const full = join(DOWNLOADS_DIR, name)
      try {
        if (statSync(full).mtimeMs < cutoff) {
          rmSync(full, { recursive: true, force: true })
          deleted++
        }
      } catch {
        /* 单个条目失败则跳过 */
      }
    }
  }
  const deletedJobs = composed.store.pruneExpired(cutoff) || 0
  return { ok: true, skipped: false, deleted, deletedJobs }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

function dirSize(dir) {
  let total = 0
  if (!existsSync(dir)) return 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (st.isDirectory()) total += dirSize(full)
      else total += st.size
    } catch {
      /* 单条目失败则跳过 */
    }
  }
  return total
}

// 容量管理：downloads 目录超过 maxDownloadSizeGB 时，按最旧优先删除任务目录（跳过运行中任务），
// 直到低于阈值 90% 的余量线。这是对"按保留时长清理"的第二道防线，保护小硬盘服务器不被打满。
function enforceDownloadCapacity() {
  const settings = settingsStore.get()
  const maxBytes = (settings.maxDownloadSizeGB || 5) * 1024 * 1024 * 1024
  const current = dirSize(DOWNLOADS_DIR)
  if (current <= maxBytes) return { ok: true, skipped: true, deleted: 0, total: current }
  const running = new Set(
    composed.store
      .all()
      .filter((j) => ['QUEUED', 'DOWNLOADING', 'PROCESSING', 'RETRY_WAIT', 'RESOLVING'].includes(j.status))
      .map((j) => j.id)
  )
  const target = maxBytes * 0.9
  let deleted = 0
  let total = current
  if (existsSync(DOWNLOADS_DIR)) {
    const entries = readdirSync(DOWNLOADS_DIR)
      .map((name) => {
        const full = join(DOWNLOADS_DIR, name)
        try {
          return { name, full, mtime: statSync(full).mtimeMs }
        } catch {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime) // 最旧优先
    for (const entry of entries) {
      if (total <= target) break
      if (running.has(entry.name)) continue // 运行中任务目录不删
      try {
        rmSync(entry.full, { recursive: true, force: true })
        total = dirSize(DOWNLOADS_DIR)
        deleted++
      } catch {
        /* 占用中跳过 */
      }
    }
  }
  return { ok: true, skipped: false, deleted, total }
}

// 存储统计：下载目录用量 + 历史记录条数（供前端提示展示）
app.get('/api/downloads/stats', authRequired, (req, res) => {
  const settings = settingsStore.get()
  const usedBytes = dirSize(DOWNLOADS_DIR)
  const maxBytes = (settings.maxDownloadSizeGB || 5) * 1024 * 1024 * 1024
  const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'READY', 'DELIVERED'])
  const myJobs = composed.store.list(req.clientId)
  const historyCount = myJobs.filter((j) => terminal.has(j.status)).length
  res.json({
    usedBytes,
    maxBytes,
    usedPercent: maxBytes ? Math.min(999, Math.round((usedBytes / maxBytes) * 100)) : 0,
    historyCount,
    historyLimit: settings.historyLimit || 30
  })
})

// 算了么命理工具（suanle-me 静态产物，独立子路径）
if (existsSync(join(SUANLE_DIR, 'index.html'))) {
  app.use('/suanle', express.static(SUANLE_DIR, { maxAge: '1h' }))
  app.get('/suanle/*', (_req, res) => {
    res.sendFile(join(SUANLE_DIR, 'index.html'))
  })
}

if (existsSync(join(PUBLIC_DIR, 'index.html'))) {
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next()
    res.sendFile(join(PUBLIC_DIR, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>iKun Web</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;background:#080b0c;color:#f4f6f1;display:grid;place-items:center;min-height:100vh}
.card{max-width:560px;padding:28px;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(23,27,27,.8)}
code{color:#b9f22d}
</style></head><body><div class="card">
<h1>iKun Web API 已启动</h1>
<p>前端尚未构建。请先执行：</p>
<pre><code>npm run web:build
npm run web:start</code></pre>
<p>或开发模式分别启动 client / server。</p>
</div></body></html>`)
  })
}

app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: err.message || '服务器内部错误' })
})

// auto cleanup: expired-by-time + capacity limit + history limit, every 30 minutes
function scheduleCleanup() {
  try {
    const settings = settingsStore.get()
    const expired = cleanupExpiredDownloads()
    const capacity = enforceDownloadCapacity()
    const prunedHistory = composed.store.enforceHistoryLimit(settings.historyLimit || 30)
    if (!expired.skipped && (expired.deleted || expired.deletedJobs)) {
      console.log(`[cleanup] expired items=${expired.deleted} jobs=${expired.deletedJobs}`)
    }
    if (!capacity.skipped && capacity.deleted) {
      console.log(`[cleanup] capacity: deleted ${capacity.deleted} task dir(s), downloads now ${formatBytes(capacity.total)} / ${formatBytes((settings.maxDownloadSizeGB || 5) * 1024 * 1024 * 1024)}`)
    }
    if (prunedHistory) {
      console.log(`[cleanup] history: pruned ${prunedHistory} old record(s), limit=${settings.historyLimit || 30}`)
    }
  } catch (error) {
    console.error('[cleanup] failed:', error.message || error)
  }
}

app.listen(PORT, HOST, () => {
  const lan = getLanAddresses()
  const settings = settingsStore.get()
  console.log('')
  console.log('========================================')
  console.log('  iKun 可分享网页端已启动')
  console.log('========================================')
  console.log(`  本机访问:  http://127.0.0.1:${PORT}`)
  for (const ip of lan) {
    console.log(`  局域网:    http://${ip}:${PORT}`)
  }
  console.log(`  访问密码:  ${shareConfig.password}`)
  console.log(`  下载目录:  ${DOWNLOADS_DIR}`)
  console.log(`  前端资源:  ${existsSync(join(PUBLIC_DIR, 'index.html')) ? '已加载' : '未构建（仅 API）'}`)
  console.log(`  AI 抠图:   ${MIAOCUT_BASE_URL}${isRemoteMiaocut() ? '（远程）' : '（自定义）'}`)
  console.log(
    `  自动清理:  ${settings.autoCleanupEnabled ? `开启（保留 ${settings.retentionHours} 小时）` : '关闭'}`
  )
  console.log(
    `  容量上限:  ${settings.maxDownloadSizeGB || 5} GB（当前 ${formatBytes(dirSize(DOWNLOADS_DIR))}，超出自动删最旧）`
  )
  console.log(`  历史记录:  最多保留 ${settings.historyLimit || 30} 条终态记录`)
  console.log('  把局域网地址 + 密码发给朋友即可使用')
  console.log('========================================')
  console.log('')

  scheduleCleanup()
  setInterval(scheduleCleanup, 30 * 60 * 1000)
})
