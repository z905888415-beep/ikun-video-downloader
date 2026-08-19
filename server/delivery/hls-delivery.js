export function rewritePlaylist(playlist, baseUrl) {
  const lines = String(playlist).split(/\r?\n/)
  const out = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      // 重写标签内嵌 URI（EXT-X-KEY URI=、EXT-X-MAP URI=、EXT-X-MEDIA URI=）
      if (/URI="([^"]+)"/.test(line)) {
        const uri = line.match(/URI="([^"]+)"/)[1]
        const target = new URL(uri, baseUrl).toString()
        out.push(line.replace(/URI="([^"]+)"/, `URI="${'/api/v2/hls-proxy?url=' + encodeURIComponent(target)}"`))
      } else {
        out.push(line)
      }
    } else {
      const target = new URL(line, baseUrl).toString()
      out.push(`/api/v2/hls-proxy?url=${encodeURIComponent(target)}`)
    }
  }
  return out.join('\n')
}

export function createHlsDelivery({ assets, fetchImpl = fetch }) {
  return {
    kind: 'hls',
    async handle(assetId, { headers = {} } = {}) {
      const entry = assets.get(assetId)
      if (!entry) return { type: 'error', code: 'ASSET_EXPIRED', message: '播放列表已过期' }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      try {
        const upstream = await fetchImpl(entry.url, { headers: { ...entry.headers }, signal: controller.signal })
        clearTimeout(timer)
        if (!upstream.ok) {
          await upstream.body?.cancel?.().catch(() => {})
          return { type: 'error', code: 'DOWNLOAD_FAILED', message: `HLS HTTP ${upstream.status}` }
        }
        const text = await upstream.text()
        if (!text.includes('#EXTM3U')) return { type: 'error', code: 'UNSUPPORTED_DRM', message: '非 HLS 播放列表' }
        const rewritten = rewritePlaylist(text, entry.url)
        return { type: 'text', status: 200, contentType: 'application/vnd.apple.mpegurl', body: rewritten }
      } catch (error) {
        clearTimeout(timer)
        if (controller.signal.aborted) return { type: 'error', code: 'DOWNLOAD_FAILED', message: 'HLS 请求超时' }
        return { type: 'error', code: 'DOWNLOAD_FAILED', message: `HLS 请求失败：${error.message}` }
      }
    }
  }
}
