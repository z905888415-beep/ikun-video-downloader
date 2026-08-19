import { AppError } from './errors.js'

const MAX_CACHE = 200

function cloneResolution(r) {
  return { ...r, assets: r.assets.map((a) => ({ ...a })), actions: r.actions.map((a) => ({ ...a })) }
}

function normalizeUrl(value) {
  let url
  try {
    url = new URL(String(value || '').trim())
  } catch {
    throw new AppError('VALIDATION_ERROR', '链接无效', false)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('VALIDATION_ERROR', '仅支持 http/https 链接', false)
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
