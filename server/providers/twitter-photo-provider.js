import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { AppError } from '../core/errors.js'

const STATUS_RE = /(?:twitter\.com|x\.com)\/(?:i\/web\/)?(?:status|[^/]+\/status)\/(\d{8,})/i

export function extractTwitterStatusId(url) {
  const match = String(url || '').match(STATUS_RE)
  return match ? match[1] : ''
}

export function createTwitterPhotoProvider({ fetchImpl = fetch } = {}) {
  return {
    id: 'twitter-photo',
    canHandle(url) {
      return Boolean(extractTwitterStatusId(url))
    },
    async resolve(sourceUrl) {
      const statusId = extractTwitterStatusId(sourceUrl)
      if (!statusId) {
        throw new AppError('URL_UNSUPPORTED', '不是有效的 X/Twitter 帖子链接', false)
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      let payload
      try {
        const res = await fetchImpl(`https://api.fxtwitter.com/status/${statusId}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'iKun-video-downloader' },
          signal: controller.signal
        })
        payload = await res.json().catch(() => null)
        if (!res.ok) {
          throw new AppError('PROVIDER_FAILED', `X 图文接口失败（${res.status}）`, true)
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        if (error.name === 'AbortError') throw new AppError('PROVIDER_FAILED', 'X 图文接口超时', true)
        throw new AppError('PROVIDER_FAILED', error.message || 'X 图文接口不可用', true)
      } finally {
        clearTimeout(timer)
      }

      const tweet = payload?.tweet || payload
      const media = tweet?.media || {}
      const videos = Array.isArray(media.videos) ? media.videos : []
      if (videos.length) {
        throw new AppError('PROVIDER_SKIP', '该帖含视频，交给 yt-dlp', true)
      }

      const photos = Array.isArray(media.photos)
        ? media.photos
        : Array.isArray(media.all)
          ? media.all.filter((item) => item?.type === 'photo' && item.url)
          : []
      if (!photos.length) {
        throw new AppError('PROVIDER_FAILED', '该帖没有可下载的图片或视频', true)
      }

      const assets = []
      const assetUrls = {}
      const imageAssetIds = []
      for (let i = 0; i < photos.length; i += 1) {
        const photo = photos[i]
        const url = String(photo.url || '').replace(/name=\w+$/, 'name=orig')
        if (!/^https?:\/\//i.test(url)) continue
        const asset = createAsset({
          kind: 'image',
          label: photos.length > 1 ? `第 ${i + 1} 张` : '原图',
          ext: 'jpg',
          protocol: 'https',
          width: photo.width,
          height: photo.height,
          delivery: 'redirect'
        })
        assets.push(asset)
        assetUrls[asset.id] = url
        imageAssetIds.push(asset.id)
      }
      if (!imageAssetIds.length) {
        throw new AppError('PROVIDER_FAILED', '该帖图片地址无效', true)
      }

      const actions = [
        createAction({
          label: photos.length > 1 ? `打包下载全部图片（${photos.length} 张）` : '下载图片',
          type: 'images-zip',
          assetIds: imageAssetIds,
          preferredExt: 'zip'
        })
      ]

      const author = tweet?.author?.screen_name || tweet?.author?.name || ''
      const title = String(tweet?.text || '').trim() || (author ? `@${author} 的图文帖` : 'X 图文帖')
      return createResolution({
        sourceUrl,
        provider: 'twitter-photo',
        platform: 'Twitter',
        title: title.slice(0, 180),
        thumbnail: photos[0]?.url,
        kind: 'images',
        assets,
        actions,
        assetUrls
      })
    }
  }
}
