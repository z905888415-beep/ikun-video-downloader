import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { AppError } from '../core/errors.js'

const execFileAsync = promisify(execFile)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

function resolveBin(binDir, name) {
  const p = join(binDir, name)
  return existsSync(p) ? p : name
}

function buildQualityLabel(f) {
  const parts = []
  if (f.height) parts.push(`${f.width || '?'}x${f.height}`)
  if (f.fps) parts.push(`${Math.round(f.fps)}fps`)
  if (f.ext) parts.push(f.ext)
  if (f.filesize || f.filesize_approx) {
    const n = f.filesize || f.filesize_approx
    parts.push(n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.round(n / 1024)}KB`)
  }
  parts.push(`[${f.format_id}]`)
  return parts.join(' · ')
}

export function createYtdlpProvider({ execFileImpl = execFileAsync, binDir = '', cookiesFile = '', proxy = '' } = {}) {
  return {
    id: 'ytdlp',
    canHandle() {
      return true
    },
    async resolve(sourceUrl) {
      const bin = resolveBin(binDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
      const args = [
        '--ignore-config',
        '--encoding', 'utf-8', '--no-playlist', '--no-warnings',
        '--add-header', `User-Agent:${UA}`,
        '--add-header', 'Accept-Language:zh-CN,zh;q=0.9,en;q=0.8'
      ]
      if (cookiesFile && existsSync(cookiesFile)) {
        args.push('--cookies', cookiesFile)
      }
      if (proxy) {
        args.push('--proxy', proxy)
      }
      args.push('--dump-single-json', '--skip-download', sourceUrl)
      let stdout = ''
      try {
        const result = await execFileImpl(bin, args, { timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
        stdout = result.stdout
      } catch (error) {
        const text = [error?.stderr, error?.stdout, error?.message].filter(Boolean).join('\n')
        if (/sign in|login required|fresh cookies/i.test(text)) {
          throw new AppError('AUTH_REQUIRED', '该站点需要登录或最新 Cookies：可在「设置」中配置 cookies.txt 后重试', false)
        }
        throw new AppError('PROVIDER_FAILED', String(text).split(/\r?\n/).reverse().find((l) => /^ERROR:/i.test(l.trim())) || text.slice(0, 200), true)
      }

      let info
      try {
        info = JSON.parse(stdout)
      } catch {
        throw new AppError('PROVIDER_FAILED', '无法解析 yt-dlp 输出', true)
      }
      if (!info || typeof info !== 'object' || Array.isArray(info)) {
        throw new AppError('PROVIDER_FAILED', 'yt-dlp 返回了无效的数据结构', true)
      }

      const rawFormats = Array.isArray(info.formats) ? info.formats : []
      const assets = []
      const assetUrls = {}
      const urlByFormatId = new Map()

      for (const f of rawFormats) {
        if (!f.format_id || !f.ext || typeof f.url !== 'string') continue
        let protocolOk = false
        try {
          protocolOk = /^https?:$/.test(new URL(f.url).protocol)
        } catch {
          protocolOk = false
        }
        if (!protocolOk) continue
        const isVideo = f.vcodec && f.vcodec !== 'none'
        const isAudio = !isVideo && f.acodec && f.acodec !== 'none'
        if (!isVideo && !isAudio) continue

        const asset = createAsset({
          kind: isVideo ? 'video' : 'audio',
          label: buildQualityLabel(f),
          ext: f.ext,
          protocol: f.protocol === 'm3u8_native' ? 'hls' : f.protocol || 'https',
          width: f.width,
          height: f.height,
          fps: f.fps,
          codec: isVideo ? f.vcodec : f.acodec,
          bitrate: f.tbr,
          size: f.filesize || f.filesize_approx,
          delivery: f.protocol === 'm3u8_native' ? 'hls' : 'redirect'
        })
        assets.push(asset)
        assetUrls[asset.id] = f.url
        urlByFormatId.set(`${f.format_id}::${f.protocol || 'https'}`, asset)
      }

      const actions = []
      const hasVideo = assets.some((a) => a.kind === 'video')
      const hasAudio = assets.some((a) => a.kind === 'audio')
      const bestAudio = assets.filter((a) => a.kind === 'audio').sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]

      const muxed = rawFormats
        .filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none')
        .sort((a, b) => (b.height || 0) - (a.height || 0))
      for (const f of muxed) {
        const asset = urlByFormatId.get(`${String(f.format_id)}::${f.protocol || 'https'}`)
        if (asset) {
          actions.push(createAction({ label: `直接下载 · ${asset.label}`, type: 'direct', assetIds: [asset.id] }))
        }
      }

      if (hasVideo && hasAudio) {
        const bestVideo = assets.filter((a) => a.kind === 'video').sort((a, b) => (b.height || 0) - (a.height || 0))[0]
        actions.push(createAction({
          label: `最高质量合并 · MP4（${bestVideo.label} + 音频）`,
          type: 'merge',
          assetIds: [bestVideo.id, bestAudio.id],
          requiresProcessing: true,
          preferredExt: 'mp4'
        }))
      }

      if (bestAudio) {
        actions.push(createAction({ label: '仅音频 · MP3', type: 'extract-audio', assetIds: [bestAudio.id], requiresProcessing: true, preferredExt: 'mp3' }))
      }

      // 当前为单视频语义（--no-playlist），播放列表批量下载为后续工作
      return createResolution({
        sourceUrl,
        provider: 'ytdlp',
        platform: info.extractor_key || info.extractor,
        title: info.title || '未命名视频',
        description: info.description,
        thumbnail: info.thumbnail,
        duration: info.duration,
        kind: info.entries?.length ? 'playlist' : 'video',
        assets,
        actions,
        assetUrls
      })
    }
  }
}
