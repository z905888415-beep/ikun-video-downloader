import { randomUUID } from 'node:crypto'

const IPV4_PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

function validateAssetUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('媒体地址无效')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议媒体地址')
  }
  let host = parsed.hostname.toLowerCase()
  if (host.includes(':')) {
    throw new Error('拒绝 IPv6 字面量地址')
  }
  if (host === 'localhost' || host === 'localhost.' || host.endsWith('.localhost') || IPV4_PRIVATE.test(host)) {
    throw new Error('禁止私有地址')
  }
  return parsed.toString()
}

export function createAssetRegistry() {
  const assets = new Map()

  return {
    set({ id, url = '', headers = {}, expiresAt = Date.now() + 30 * 60 * 1000, delivery = 'redirect', filename }) {
      if (delivery !== 'file') {
        url = validateAssetUrl(url)
      }
      const assetId = id || `as_${randomUUID().slice(0, 12)}`
      assets.set(assetId, { url, headers: { ...headers }, expiresAt, delivery, filename, createdAt: Date.now() })
      return assetId
    },
    get(id) {
      const entry = assets.get(id)
      if (!entry) return null
      if (entry.expiresAt < Date.now()) {
        assets.delete(id)
        return null
      }
      return { ...entry, headers: { ...entry.headers } }
    },
    delete(id) {
      return assets.delete(id)
    },
    sweep(now = Date.now()) {
      let removed = 0
      for (const [id, entry] of assets) {
        if (entry.expiresAt < now) {
          assets.delete(id)
          removed++
        }
      }
      return removed
    },
    size() {
      return assets.size
    }
  }
}

export { validateAssetUrl }
