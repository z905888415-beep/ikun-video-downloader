function normalizeIp(value) {
  const raw = String(value || '').trim()
  if (!raw) return 'unknown'
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw
}

export function createRateLimiter({ windowMs, max, message = '请求过于频繁，请稍后再试', now = () => Date.now() } = {}) {
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error('windowMs 必须为正数')
  if (!Number.isFinite(max) || max < 1) throw new Error('max 必须大于 0')

  const entries = new Map()

  function cleanup(timestamp) {
    for (const [ip, entry] of entries) {
      if (entry.resetAt <= timestamp) entries.delete(ip)
    }
  }

  return function rateLimit(req, res, next) {
    const timestamp = now()
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress)
    let entry = entries.get(ip)

    if (!entry || entry.resetAt <= timestamp) {
      entry = { count: 0, resetAt: timestamp + windowMs }
      entries.set(ip, entry)
    }

    entry.count += 1
    const remaining = Math.max(0, max - entry.count)
    res.setHeader('RateLimit-Limit', String(max))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)))

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - timestamp) / 1000))))
      return res.status(429).json({ error: message, code: 'RATE_LIMITED' })
    }

    if (entries.size > 10000) cleanup(timestamp)
    return next()
  }
}
