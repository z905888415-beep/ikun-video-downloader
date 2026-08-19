import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { AppError } from '../core/errors.js'

export function createBrowserCaptureProvider({ assets }) {
  const captured = new Map() // sourceUrl -> captured payload

  return {
    id: 'browser-capture',
    canHandle(url) {
      try {
        const key = new URL(url).toString()
        const entry = captured.get(key)
        if (!entry) return false
        if (entry.expiresAt < Date.now()) {
          captured.delete(key)
          return false
        }
        return true
      } catch {
        return false
      }
    },
    report({ sourceUrl, mediaUrl, title = '捕获视频', referer = '', userAgent = '', cookie = '' }) {
      let source
      try {
        source = new URL(sourceUrl)
        if (source.protocol !== 'http:' && source.protocol !== 'https:') throw new Error()
      } catch {
        throw new Error('源链接必须为 http/https')
      }
      const id = assets.set({
        url: mediaUrl,
        headers: {
          // Cookie/Referer 用于服务端下载（job.headers）与流式代理交付；
          // redirect 直链交付不使用这些头（浏览器直连拿不到）。
          ...(referer ? { Referer: referer } : {}),
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
          ...(cookie ? { Cookie: cookie } : {})
        },
        expiresAt: Date.now() + 10 * 60 * 1000
      })
      captured.set(source.toString(), { assetId: id, title, expiresAt: Date.now() + 10 * 60 * 1000 })
      return { ok: true }
    },
    async resolve(sourceUrl) {
      const key = new URL(sourceUrl).toString()
      const entry = captured.get(key)
      if (!entry) throw new AppError('PROVIDER_FAILED', '没有捕获到该链接的媒体', false)
      const registered = assets.get(entry.assetId)
      if (!registered) {
        captured.delete(key)
        throw new AppError('PROVIDER_FAILED', '捕获的媒体已过期，请重新捕获', false)
      }
      const asset = createAsset({ kind: 'video', label: '浏览器捕获 · 原画', ext: 'mp4', delivery: 'redirect' })
      asset.id = entry.assetId
      return createResolution({
        sourceUrl,
        provider: 'browser-capture',
        title: entry.title,
        kind: 'video',
        assets: [asset],
        actions: [createAction({ label: '浏览器捕获 · 原画 MP4', type: 'direct', assetIds: [entry.assetId] })],
        assetUrls: { [entry.assetId]: registered.url }
      })
    }
  }
}
