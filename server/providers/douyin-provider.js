import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { AppError } from '../core/errors.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * 从输入 URL 中解析出 aweme_id (视频/图集 ID)
 */
export function extractAwemeId(urlStr) {
  if (!urlStr) return ''
  const str = String(urlStr).trim()
  
  // 匹配 /video/7412345678901234567 或 /note/7412345678901234567
  const match = str.match(/\/(?:video|note)\/(\d{15,22})/i)
  if (match) return match[1]

  // 匹配 query parameter: modal_id=7412345678901234567
  const queryMatch = str.match(/[?&](?:modal_id|aweme_id)=(\d{15,22})/i)
  if (queryMatch) return queryMatch[1]

  return ''
}

/**
 * 抖音专用解析 Provider
 * 支持：无水印视频、阶梯比特率最高画质、高清多图图集、音频原声提取
 * 失败或非官方接口可直接降级到 yt-dlp
 */
export function createDouyinProvider({
  fetchImpl = globalThis.fetch,
  cookies = ''
} = {}) {
  return {
    id: 'douyin',
    canHandle(url) {
      return /(?:douyin\.com|iesdouyin\.com)/i.test(url)
    },
    async resolve(sourceUrl) {
      let targetUrl = sourceUrl
      let awemeId = extractAwemeId(targetUrl)

      // 1. 如果是短链 (v.douyin.com)，先跟随 302 重定向获取真实 URL
      if (!awemeId && /v\.douyin\.com/i.test(targetUrl)) {
        try {
          const headRes = await fetchImpl(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'User-Agent': UA }
          })
          targetUrl = headRes.url || targetUrl
          awemeId = extractAwemeId(targetUrl)
        } catch {
          // 短链解析重定向失败，留给后续或降级
        }
      }

      if (!awemeId) {
        throw new AppError('PROVIDER_FAILED', '未能从抖音链接中提取出作品 ID', true)
      }

      // 2. 依次使用 aid 候选池请求官方接口（6383 适合图文/图集，1128 适合单视频）
      const aids = ['6383', '1128']
      let awemeDetail = null

      for (const aid of aids) {
        const apiUrl = `https://www.iesdouyin.com/aweme/v1/web/aweme/detail/?aweme_id=${awemeId}&aid=${aid}&device_platform=webapp&channel=channel_pc_web`
        try {
          const res = await fetchImpl(apiUrl, {
            headers: {
              'User-Agent': UA,
              'Referer': 'https://www.douyin.com/',
              'Accept': 'application/json',
              ...(cookies ? { Cookie: cookies } : {})
            }
          })
          if (!res.ok) continue
          const data = await res.json()
          if (data && data.aweme_detail) {
            awemeDetail = data.aweme_detail
            break
          }
        } catch {
          // 继续尝试下一个 aid
        }
      }

      if (!awemeDetail) {
        throw new AppError('PROVIDER_FAILED', '抖音官方接口未返回有效数据，请检查链接或稍后重试', true)
      }

      // 3. 构建统一数据结构
      const title = (awemeDetail.desc || '').trim() || '抖音作品'
      const thumbnail = awemeDetail.video?.cover?.url_list?.[0] || awemeDetail.images?.[0]?.url_list?.[0] || ''
      const duration = awemeDetail.duration ? Math.round(awemeDetail.duration / 1000) : (awemeDetail.video?.duration ? Math.round(awemeDetail.video.duration / 1000) : 0)

      const assets = []
      const actions = []
      const assetUrls = {}

      // A. 判断是否为图集 (images 存在且非空)
      const isGallery = Array.isArray(awemeDetail.images) && awemeDetail.images.length > 0
      if (isGallery) {
        const imageAssetIds = []
        for (let i = 0; i < awemeDetail.images.length; i++) {
          const imgItem = awemeDetail.images[i]
          const imgUrl = (imgItem.url_list || [])[0]
          if (!imgUrl) continue

          const asset = createAsset({
            kind: 'image',
            label: `第 ${i + 1} 张高清图片`,
            ext: 'jpg',
            protocol: 'https',
            width: imgItem.width,
            height: imgItem.height,
            delivery: 'redirect'
          })
          assets.push(asset)
          assetUrls[asset.id] = imgUrl
          imageAssetIds.push(asset.id)
        }

        // 提供一键打包下载全部图集
        if (imageAssetIds.length > 0) {
          actions.push(createAction({
            label: `打包下载全部图片 (${imageAssetIds.length} 张)`,
            type: 'images-zip',
            assetIds: imageAssetIds,
            requiresProcessing: false,
            preferredExt: 'zip'
          }))
        }
      } else {
        // B. 视频模式：优先无水印与最高比特率直链
        let playUrl = ''
        const bitRates = awemeDetail.video?.bit_rate || []
        if (bitRates.length > 0) {
          // 挑选最高比特率
          const bestBitrate = [...bitRates].sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0]
          playUrl = bestBitrate.play_addr?.url_list?.[0] || ''
        }
        if (!playUrl) {
          playUrl = awemeDetail.video?.play_addr?.url_list?.[0] || ''
        }

        // 抖音无水印处理：替换 wm 标记或 playwm -> play
        if (playUrl) {
          playUrl = playUrl.replace('playwm', 'play')
          const videoAsset = createAsset({
            kind: 'video',
            label: '1080P/原画 · MP4 (无水印)',
            ext: 'mp4',
            protocol: 'https',
            width: awemeDetail.video?.width,
            height: awemeDetail.video?.height,
            delivery: 'redirect'
          })
          assets.push(videoAsset)
          assetUrls[videoAsset.id] = playUrl
          actions.push(createAction({
            label: '直接下载 · MP4 (无水印)',
            type: 'direct',
            assetIds: [videoAsset.id]
          }))
        }
      }

      // C. 原声提取 (music)
      const musicUrl = awemeDetail.music?.play_url?.url_list?.[0]
      if (musicUrl) {
        const audioAsset = createAsset({
          kind: 'audio',
          label: awemeDetail.music?.title || '背景原声 · MP3',
          ext: 'mp3',
          protocol: 'https',
          delivery: 'redirect'
        })
        assets.push(audioAsset)
        assetUrls[audioAsset.id] = musicUrl
        actions.push(createAction({
          label: `仅原声音频 · MP3`,
          type: 'direct',
          assetIds: [audioAsset.id],
          preferredExt: 'mp3'
        }))
      }

      if (!assets.length && !actions.length) {
        throw new AppError('PROVIDER_FAILED', '抖音未解析到可下载的媒体资源', true)
      }

      return createResolution({
        sourceUrl,
        provider: 'douyin',
        platform: '抖音',
        title,
        thumbnail,
        duration,
        kind: isGallery ? 'gallery' : 'video',
        assets,
        actions,
        assetUrls
      })
    }
  }
}
