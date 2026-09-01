// iOS Safari 15+ 的 Web Share API Level 2：
// fetch 文件 → File → navigator.share({ files }) → 系统分享面板「存储视频/图像」直接进相册。
// 其它平台或桌面浏览器返回 false，调用方不渲染按钮，维持原有下载行为。

export function isAppleMobile(): boolean {
  const ua = navigator.userAgent
  const iOSLike = /iPad|iPhone|iPod/.test(ua)
  // iPadOS 13+ 桌面版 UA，用触摸点数识别
  const iPadOSAsMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
  return iOSLike || iPadOSAsMac
}

export function canShareFilesToAlbum(): boolean {
  if (!isAppleMobile()) return false
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  return typeof nav.share === 'function' && typeof nav.canShare === 'function'
}

export function normalizeMediaName(name: string, fallbackExt = 'mp4'): string {
  const base = (name || '').trim() || `ikun-${Date.now()}`
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${fallbackExt}`
}

function mimeFromName(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'application/octet-stream'
}

export type SaveAlbumResult = 'saved' | 'cancelled'

export async function saveUrlToAlbum(url: string, filename: string): Promise<SaveAlbumResult> {
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean }
  if (typeof nav.share !== 'function') {
    throw new Error('此浏览器不支持直接存入相册')
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`获取文件失败（HTTP ${res.status}）`)
  const blob = await res.blob()
  const name = normalizeMediaName(filename)
  const file = new File([blob], name, { type: mimeFromName(name) || blob.type })
  if (typeof nav.canShare === 'function' && !nav.canShare({ files: [file] })) {
    throw new Error('系统不支持分享该文件类型')
  }
  try {
    await nav.share({ files: [file], title: name })
    return 'saved'
  } catch (error) {
    // 用户在分享面板点了取消，或未授权：不算失败
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NotAllowedError')) {
      return 'cancelled'
    }
    throw error
  }
}
