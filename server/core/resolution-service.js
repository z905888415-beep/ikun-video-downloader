import { AppError } from './errors.js'

const MAX_CACHE = 200

function cloneResolution(r) {
  return { ...r, assets: r.assets.map((a) => ({ ...a })), actions: r.actions.map((a) => ({ ...a })) }
}

export function extractUrl(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  // 1. 优先匹配 http:// 或 https:// 开头的 URL
  const httpMatch = trimmed.match(/https?:\/\/[^\s\u4e00-\u9fa5<>'"()[\]{}]+/i)
  if (httpMatch) {
    let candidate = httpMatch[0]
    candidate = candidate.replace(/[.,;!?:'"`\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u3008\u3009\u300a\u300b]+$/, '')
    return candidate
  }

  // 2. 如果包含其它非 http/https 协议头（如 ftp://, file:// 等），原样返回以便被协议校验拒绝
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }

  // 3. 匹配没有写协议前缀的短链或域名
  const domainMatch = trimmed.match(/(?:[a-zA-Z0-9-]+\.)+(?:com|tv|cn|net|org|cc|me|app|be|link|site|top|xyz|co|io)\/[^\s\u4e00-\u9fa5<>'"()[\]{}]*/i)
  if (domainMatch) {
    let candidate = domainMatch[0]
    candidate = candidate.replace(/[.,;!?:'"`\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u3008\u3009\u300a\u300b]+$/, '')
    return `https://${candidate}`
  }

  return trimmed
}

export function normalizeUrl(value) {
  const extracted = extractUrl(value)
  if (!extracted) {
    throw new AppError('VALIDATION_ERROR', '请提供视频链接或分享文本', false)
  }
  let url
  try {
    let candidate = extracted
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(candidate)) {
      // 已带协议头（http/https/ftp等）
    } else {
      // 裸域名或短链
      candidate = `https://${candidate}`
    }
    url = new URL(candidate)
  } catch {
    throw new AppError('VALIDATION_ERROR', '链接无效，请粘贴有效的视频网址或分享文本', false)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION_ERROR', '仅支持 http/https 链接', false)
  }
  if (!url.hostname || !url.hostname.includes('.') || url.hostname.endsWith('.')) {
    throw new AppError('VALIDATION_ERROR', '链接无效，请包含有效的域名', false)
  }
  return url.toString()
}

export function createResolutionService({ registry, assets, cacheTtlMs = 5 * 60 * 1000 }) {
  const cache = new Map()

  function cachedKey(url) {
    return url
  }

  async function resolveOnce(sourceUrl) {
    const key = cachedKey(sourceUrl)
    const hit = cache.get(key)
    if (hit && hit.expiresAt > Date.now()) return cloneResolution(hit.resolution)
    if (hit && hit.expiresAt <= Date.now()) cache.delete(key)

    const provider = registry.pick(sourceUrl)
    if (!provider) {
      throw new AppError('URL_UNSUPPORTED', '没有可用的解析器处理该链接', false)
    }

    let resolution
    const failures = []
    for (const candidate of [provider, ...registry.all().filter((p) => p.id !== provider.id && p.canHandle(sourceUrl))]) {
      try {
        resolution = await candidate.resolve(sourceUrl)
        if (resolution?.assets?.length || resolution?.actions?.length) break
      } catch (error) {
        failures.push(`${candidate.id}: ${String(error.message).slice(0, 60)}`)
      }
    }
    if (!resolution || (!resolution.assets?.length && !resolution.actions?.length)) {
      throw new AppError('PROVIDER_FAILED', `所有解析器均失败：${failures.join(' | ')}`, true)
    }

    // 把内部 assetUrls 写入 AssetRegistry，并从公开 Resolution 剥离。
    // 关键：保留 provider 生成的 asset.id（actions 的 assetIds 引用它），
    // 注册时显式传入该 id，避免替换 id 导致 action.assetIds 失联。
    // 契约：被 action.assetIds 引用的资产必须提供媒体地址，缺失即 fail fast。
    // 已注册的资产（如浏览器捕获上报）不覆盖，保留其 headers。
    const referencedIds = new Set((resolution.actions || []).flatMap((a) => a.assetIds || []))
    for (const asset of resolution.assets) {
      const raw = resolution.assetUrls?.[asset.id]
      if (referencedIds.has(asset.id) && !raw) {
        throw new AppError('PROVIDER_FAILED', `Provider 返回的资产缺少媒体地址：${asset.id}`, true)
      }
      if (raw && !assets.get(asset.id)) {
        assets.set({ id: asset.id, url: raw, delivery: asset.delivery, expiresAt: Date.now() + 30 * 60 * 1000 })
      }
    }
    delete resolution.assetUrls

    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    cache.set(key, { resolution, expiresAt: Date.now() + cacheTtlMs })
    return cloneResolution(resolution)
  }

  return {
    async resolve(inputUrl) {
      const url = normalizeUrl(inputUrl)
      return resolveOnce(url)
    },
    getCached(resolutionId) {
      for (const [key, entry] of cache) {
        if (entry.resolution.id === resolutionId) {
          if (entry.expiresAt <= Date.now()) {
            cache.delete(key)
            return null
          }
          return cloneResolution(entry.resolution)
        }
      }
      return null
    }
  }
}
