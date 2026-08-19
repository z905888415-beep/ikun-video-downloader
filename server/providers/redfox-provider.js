import { REDFOX_PLATFORM_PATTERNS, REDFOX_API_URL, PUBLIC_API_KEY } from '../redfox.js'
import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { AppError } from '../core/errors.js'

function isHttpUrl(value) {
  try {
    const protocol = new URL(String(value)).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function createRedfoxProvider({ fetchImpl = fetch, apiKey = '' } = {}) {
  const key = apiKey || PUBLIC_API_KEY

  return {
    id: 'redfox',
    canHandle(url) {
      try {
        return REDFOX_PLATFORM_PATTERNS.some((pattern) => pattern.test(new URL(url).toString()))
      } catch {
        return false
      }
    },
    async resolve(sourceUrl) {
      let response
      try {
        response = await fetchImpl(REDFOX_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
          body: JSON.stringify({ url: sourceUrl, source: 'ikun-web-v2' }),
          signal: AbortSignal.timeout(30000)
        })
      } catch (error) {
        throw new AppError('PROVIDER_FAILED', `Redfox 服务不可用：${error.message}`, true)
      }
      if (!response.ok) {
        throw new AppError('PROVIDER_FAILED', `Redfox 服务返回 HTTP ${response.status}`, false)
      }
      const payload = await response.json().catch(() => ({}))
      if (!String(payload?.code).startsWith('2')) {
        const msg = payload?.msg || `Redfox 解析失败 (${payload?.code})`
        if (/key/i.test(msg) && /禁用|无效|过期|invalid|expired|disabled|unauthorized|forbidden/i.test(msg)) {
          throw new AppError('PROVIDER_FAILED', 'Redfox API Key 无效或已禁用：请在「设置」中填写自己的 Key（redfox.hk 注册后获取）', false)
        }
        throw new AppError('PROVIDER_FAILED', msg, true)
      }
      const data = payload.data
      if (!data) throw new AppError('PROVIDER_FAILED', 'Redfox 返回空数据', true)

      if (data.awemeType === 'video' && data.videoUrl && isHttpUrl(data.videoUrl)) {
        const asset = createAsset({ kind: 'video', label: '无水印原画', ext: 'mp4', codec: 'H.264', delivery: 'redirect' })
        return createResolution({
          sourceUrl,
          provider: 'redfox',
          platform: data.platform || 'unknown',
          title: data.title || '视频',
          kind: 'video',
          assets: [asset],
          actions: [createAction({ label: '无水印原画 · MP4', type: 'direct', assetIds: [asset.id] })],
          assetUrls: { [asset.id]: data.videoUrl }
        })
      }

      if (data.awemeType === 'photo') {
        const imageUrls = (Array.isArray(data.imageUrls) ? data.imageUrls : []).filter(isHttpUrl)
        if (imageUrls.length) {
          const assets = imageUrls.map(() => createAsset({ kind: 'image', label: '图片', ext: 'jpg', delivery: 'redirect' }))
          return createResolution({
            sourceUrl,
            provider: 'redfox',
            platform: data.platform || 'unknown',
            title: data.title || '图文',
            kind: 'images',
            assets,
            actions: [createAction({ label: `下载全部图片（${assets.length} 张）`, type: 'images-zip', assetIds: assets.map((a) => a.id) })],
            assetUrls: Object.fromEntries(assets.map((a, i) => [a.id, imageUrls[i]]))
          })
        }
      }

      throw new AppError('PROVIDER_FAILED', 'Redfox 未返回可下载媒体', true)
    }
  }
}
