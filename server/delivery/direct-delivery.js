export function createDirectDelivery({ assets }) {
  return {
    async handle(assetId) {
      const entry = assets.get(assetId)
      if (!entry) return { type: 'error', code: 'ASSET_EXPIRED', message: '媒体地址已过期或不存在' }
      return { type: 'redirect', location: entry.url }
    }
  }
}

export function createStreamDelivery({ assets, fetchImpl = fetch, headerTimeoutMs = 30000 } = {}) {
  return {
    async handle(assetId, { headers = {} } = {}) {
      const entry = assets.get(assetId)
      if (!entry) return { type: 'error', code: 'ASSET_EXPIRED', message: '媒体地址已过期或不存在' }
      const upstreamHeaders = { ...entry.headers }
      for (const key of ['range', 'user-agent', 'accept']) {
        if (headers[key] !== undefined) upstreamHeaders[key] = headers[key]
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), headerTimeoutMs)
      let upstream
      try {
        upstream = await fetchImpl(entry.url, { headers: upstreamHeaders, signal: controller.signal })
      } catch (error) {
        clearTimeout(timer)
        return { type: 'error', code: 'DOWNLOAD_FAILED', message: `上游请求失败：${error.message}` }
      }
      clearTimeout(timer)
      const out = {
        type: 'stream',
        status: upstream.status,
        headers: {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'content-length': upstream.headers.get('content-length'),
          'accept-ranges': upstream.headers.get('accept-ranges'),
          'content-range': upstream.headers.get('content-range'),
          'cache-control': 'no-store'
        },
        body: upstream.body,
        abort: () => controller.abort()
      }
      for (const key of Object.keys(out.headers)) {
        if (out.headers[key] === null) delete out.headers[key]
      }
      return out
    }
  }
}
