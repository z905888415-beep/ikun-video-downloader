import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { toErrorResponse, AppError } from './core/errors.js'
import { validateAssetUrl } from './core/asset-registry.js'
import { rewritePlaylist } from './delivery/hls-delivery.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const STATUS_MAP = {
  VALIDATION_ERROR: 422,
  URL_UNSUPPORTED: 422,
  JOB_NOT_FOUND: 422,
  RATE_LIMITED: 429,
  RESOLUTION_EXPIRED: 422,
  ASSET_EXPIRED: 422
}

export function createApiV2Router({ resolutions, assets, deliveries, scheduler, store, rateLimits = {}, isAdmin = () => false }) {
  const router = Router()
  const resolveRateLimit = rateLimits.resolve || ((_req, _res, next) => next())
  const downloadRateLimit = rateLimits.download || ((_req, _res, next) => next())
  const assetRateLimit = rateLimits.asset || ((_req, _res, next) => next())

  function requestId() {
    return `req_${randomUUID().slice(0, 12)}`
  }

  function ok(res, data, status = 200) {
    res.status(status).json({ data, requestId: requestId() })
  }

  function fail(res, error) {
    const status = error instanceof AppError ? (STATUS_MAP[error.code] || 502) : 500
    res.status(status).json(toErrorResponse(error, requestId()))
  }

  function jobToken(req) {
    return String(req.headers['x-job-token'] || req.query?.token || '').trim()
  }

  function jobTokens(req) {
    return String(req.headers['x-job-tokens'] || '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 200)
  }

  function canAccessJob(req, job) {
    return Boolean(job) && (isAdmin(req) || (Boolean(job.controlToken) && jobToken(req) === job.controlToken))
  }

  function requireJobAccess(req, res, job) {
    if (canAccessJob(req, job)) return true
    fail(res, new AppError('JOB_NOT_FOUND', '任务不存在或已过期', false))
    return false
  }

  function publicJob(job) {
    if (!job) return job
    const { controlToken, clientId, ...safeJob } = job
    return safeJob
  }

  router.post('/resolutions', resolveRateLimit, async (req, res) => {
    try {
      const url = String(req.body?.url || '').trim()
      if (!url) throw new AppError('VALIDATION_ERROR', '请提供链接', false)
      const resolution = await resolutions.resolve(url)
      ok(res, resolution, 201)
    } catch (error) {
      fail(res, error)
    }
  })

  router.get('/resolutions/:id', (req, res) => {
    const resolution = resolutions.getCached(req.params.id)
    if (!resolution) {
      return fail(res, new AppError('RESOLUTION_EXPIRED', '解析结果已过期，请重新解析', true))
    }
    ok(res, resolution)
  })

  router.get('/hls-proxy', async (req, res) => {
    const raw = String(req.query.url || '')
    let target
    try {
      target = validateAssetUrl(raw)
    } catch {
      return fail(res, new AppError('VALIDATION_ERROR', '代理地址无效', false))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const upstream = await fetch(target, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal, redirect: 'manual' })
      clearTimeout(timer)
      if (upstream.status >= 300 && upstream.status < 400) {
        return fail(res, new AppError('DOWNLOAD_FAILED', '代理目标不允许重定向', false))
      }
      if (!upstream.ok) return fail(res, new AppError('DOWNLOAD_FAILED', `分片 HTTP ${upstream.status}`, true))
      const contentType = upstream.headers.get('content-type') || ''
      const buf = Buffer.from(await upstream.arrayBuffer())
      if (buf.length < 7 || !buf.subarray(0, 1024).toString('utf8').includes('#EXTM3U')) {
        // 二进制分片：原样转发
        res.status(upstream.status)
        res.setHeader('Content-Type', contentType || 'application/octet-stream')
        res.setHeader('Cache-Control', 'no-store')
        return res.send(buf)
      }
      // 播放列表（master 或媒体列表）：递归重写为站内代理地址
      res.status(200)
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      res.setHeader('Cache-Control', 'no-store')
      return res.send(rewritePlaylist(buf.toString('utf8'), target))
    } catch (error) {
      clearTimeout(timer)
      fail(res, new AppError('DOWNLOAD_FAILED', error.message, true))
    }
  })

  router.get('/assets/:id/content', assetRateLimit, async (req, res) => {
    const assetId = req.params.id
    const job = store.load(assetId)
    if (job && !requireJobAccess(req, res, job)) return
    const entry = assets.get(assetId)
    if (!entry) {
      return fail(res, new AppError('ASSET_EXPIRED', '媒体地址已过期或不存在', true))
    }
    if (entry.delivery === 'proxy') {
      const result = await deliveries.stream.handle(assetId, { headers: req.headers })
      if (result.type === 'error') {
        return fail(res, new AppError(result.code, result.message, true))
      }
      const stream = Readable.fromWeb(result.body)
      res.status(result.status)
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
      res.on('close', () => {
        if (!res.writableEnded) result.abort?.()
      })
      stream.on('error', () => {
        if (!res.headersSent) res.status(502)
        res.destroy()
      })
      return stream.pipe(res)
    }
    if (entry.delivery === 'hls') {
      const result = await deliveries.hls.handle(assetId, { headers: req.headers })
      if (result.type === 'error') {
        return fail(res, new AppError(result.code, result.message, true))
      }
      res.status(result.status)
      res.setHeader('Content-Type', result.contentType)
      res.setHeader('Cache-Control', 'no-store')
      return res.send(result.body)
    }
    if (entry.delivery === 'file') {
      const result = await deliveries.file.handle(assetId, { headers: req.headers })
      if (result.type === 'error') {
        return fail(res, new AppError(result.code, result.message, true))
      }
      res.status(result.status)
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
      const stream = createReadStream(result.filepath, { start: result.start, end: result.end })
      stream.on('error', () => {
        if (!res.headersSent) res.status(500)
        res.destroy()
      })
      return stream.pipe(res)
    }
    const result = await deliveries.direct.handle(assetId, { headers: req.headers })
    if (result.type === 'error') {
      return fail(res, new AppError(result.code, result.message, true))
    }
    res.redirect(result.location)
  })

  router.get('/assets/:id/proxy', assetRateLimit, async (req, res) => {
    const assetId = req.params.id
    const job = store.load(assetId)
    if (job && !requireJobAccess(req, res, job)) return
    const entry = assets.get(assetId)
    if (!entry) {
      return fail(res, new AppError('ASSET_EXPIRED', '媒体地址已过期或不存在', true))
    }
    const result = await deliveries.stream.handle(assetId, { headers: req.headers })
    if (result.type === 'error') return fail(res, new AppError(result.code, result.message, true))
    const stream = Readable.fromWeb(result.body)
    res.status(result.status)
    for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v)
    res.on('close', () => {
      if (!res.writableEnded) result.abort?.()
    })
    stream.on('error', () => {
      if (!res.headersSent) res.status(502)
      res.destroy()
    })
    return stream.pipe(res)
  })

  router.post('/downloads', downloadRateLimit, async (req, res) => {
    try {
      const { resolutionId, actionId, mode = 'auto' } = req.body || {}
      const clientId = String(req.headers['x-client-id'] || 'anonymous')
      const controlToken = randomUUID()
      if (!resolutionId || !actionId) {
        throw new AppError('VALIDATION_ERROR', '缺少 resolutionId 或 actionId', false)
      }
      const resolution = resolutions.getCached(resolutionId)
      if (!resolution) {
        throw new AppError('RESOLUTION_EXPIRED', '解析结果已过期，请重新解析', true)
      }
      const action = resolution.actions.find((a) => a.id === actionId)
      if (!action) throw new AppError('VALIDATION_ERROR', '动作不存在', false)

      const { createJob } = await import('./core/contracts.js')
      const job = createJob({ clientId, controlToken, resolutionId, sourceUrl: resolution.sourceUrl, actionId, mode })
      job.actionType = action.type
      job.requiresProcessing = action.requiresProcessing
      job.preferredExt = action.preferredExt
      job.assetUrls = action.assetIds
        .map((id) => assets.get(id)?.url)
        .filter(Boolean)
      job.headers = action.assetIds
        .map((id) => assets.get(id)?.headers || {})
        .reduce((acc, h) => ({ ...acc, ...h }), {})
      job.workDir = join(resolve(__dirname, '..'), 'downloads', job.id)
      job.requiresResolve = false
      store.save(job)

      if (!action.requiresProcessing && mode !== 'server' && mode !== 'merge') {
        // 直链：直接交付，不入队；前端直接使用 action 的 assetId 下载
        store.update(job.id, { status: 'READY' })
        res.setHeader('X-Job-Token', controlToken)
        return ok(res, publicJob(store.load(job.id)), 201)
      }
      scheduler.schedule(store.load(job.id))
      res.setHeader('X-Job-Token', controlToken)
      ok(res, publicJob(store.load(job.id)), 201)
    } catch (error) {
      fail(res, error)
    }
  })

  router.get('/downloads', (req, res) => {
    const jobs = isAdmin(req) ? store.all() : store.listByControlTokens(jobTokens(req))
    ok(res, jobs.map(publicJob))
  })

  router.get('/downloads/:id', (req, res) => {
    const job = store.load(req.params.id)
    if (!requireJobAccess(req, res, job)) return
    ok(res, publicJob(job))
  })

  router.get('/downloads/:id/events', (req, res) => {
    const job = store.load(req.params.id)
    if (!requireJobAccess(req, res, job)) return
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.setHeader('Connection', 'keep-alive')
    let lastUpdatedAt = job.updatedAt
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
    let poll
    const cleanup = () => {
      clearInterval(heartbeat)
      clearInterval(poll)
      res.end()
    }
    req.on('close', cleanup)
    poll = setInterval(() => {
      const current = store.load(job.id)
      if (!current) return cleanup()
      if (current.updatedAt !== lastUpdatedAt) {
        lastUpdatedAt = current.updatedAt
        res.write(`event: job-status\ndata: ${JSON.stringify({ id: current.id, status: current.status, percent: current.percent, error: current.error })}\n\n`)
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'READY', 'DELIVERED'].includes(current.status)) cleanup()
    }, 1000)
  })

  router.post('/downloads/:id/retry', (req, res) => {
    const job = store.load(req.params.id)
    if (!requireJobAccess(req, res, job)) return
    const updated = scheduler.retry(req.params.id)
    if (!updated) return fail(res, new AppError('VALIDATION_ERROR', '当前状态不可重试', false))
    ok(res, publicJob(updated))
  })

  router.delete('/downloads/:id', (req, res) => {
    const job = store.load(req.params.id)
    if (!requireJobAccess(req, res, job)) return
    scheduler.cancel(req.params.id)
    ok(res, { ok: true })
  })

  return router
}
