/**
 * Redfox API integration module.
 * Uses redfox.hk API to parse and download watermark-free videos/images
 * from platforms like 抖音, 小红书, 快手, 视频号, B站, YouTube, Instagram, etc.
 */

import { writeFile } from 'node:fs/promises'

const REDFOX_API_URL = 'https://redfox.hk/story/api/parseWork/parse'
const PUBLIC_API_KEY = 'ak_b45b6a6881f4400fb321428947eb6661'

const REDFOX_PLATFORM_PATTERNS = [
  // 抖音 Douyin
  /^https?:\/\/(www\.)?v\.douyin\.com\//i,
  /^https?:\/\/(www\.)?douyin\.com\/(video|jingxuan|note|user)\//i,
  // 小红书 Xiaohongshu
  /^https?:\/\/(www\.)?xhslink\.(com|cn)\//i,
  /^https?:\/\/(www\.)?xiaohongshu\.com\//i,
  // 快手 Kuaishou
  /^https?:\/\/(www\.)?v\.kuaishou\.com\//i,
  /^https?:\/\/(www\.)?kuaishou\.com\//i,
  // 视频号 WeChat Channels
  /^https?:\/\/(www\.)?weixin\.qq\.com\/sph\//i,
  // B站 Bilibili
  /^https?:\/\/(www\.)?b23\.tv\//i,
  /^https?:\/\/(www\.)?bilibili\.com\/video\//i,
  // YouTube
  /^https?:\/\/(www\.)?youtu\.be\//i,
  /^https?:\/\/(www\.)?youtube\.com\/(watch|shorts)\b/i,
  // Instagram
  /^https?:\/\/(www\.)?instagram\.com\/(p|reel)\//i,
  // X / Twitter
  /^https?:\/\/(www\.)?(x|twitter)\.com\/\w+\/status\//i,
  // TikTok
  /^https?:\/\/(www\.)?tiktok\.com\/@/i,
  // Threads
  /^https?:\/\/(www\.)?threads\.net\/@/i,
  // Facebook
  /^https?:\/\/(www\.)?(facebook|fb)\.com\/.*\/videos\//i,
  // Vimeo
  /^https?:\/\/(www\.)?vimeo\.com\/\d+/i,
]

/**
 * Check if a URL is supported by the Redfox API.
 * @param {string} url
 * @returns {boolean}
 */
export function isRedfoxSupportedUrl(url) {
  try {
    const u = String(url || '').trim()
    if (!u) return false
    return REDFOX_PLATFORM_PATTERNS.some((pattern) => pattern.test(u))
  } catch {
    return false
  }
}

/**
 * Call the Redfox API to parse a video/image URL.
 * @param {string} url - The share URL to parse
 * @param {string} [apiKey] - Optional API key (falls back to public key)
 * @returns {Promise<{awemeType: string, platform: string, title: string, videoUrl: string, imageUrls: string[]}>}
 */
export async function redfoxParse(url, apiKey) {
  const key = apiKey || PUBLIC_API_KEY
  const response = await fetch(REDFOX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': key,
    },
    body: JSON.stringify({ url, source: 'ikun-web' }),
    signal: AbortSignal.timeout(30000),
  })

  const result = await response.json().catch(() => ({}))
  const code = result?.code
  if (!String(code).startsWith('2')) {
    const msg = result?.msg || `Redfox API error (code ${code})`
    throw new Error(msg)
  }

  const data = result?.data
  if (!data) throw new Error('Redfox API returned empty data')

  return {
    awemeType: data.awemeType || '',
    platform: data.platform || 'unknown',
    title: data.title || 'untitled',
    videoUrl: data.videoUrl || '',
    imageUrls: Array.isArray(data.imageUrls) ? data.imageUrls : [],
  }
}

/**
 * Sanitize a string for use as a filename.
 * @param {string} name
 * @returns {string|null}
 */
export function sanitizeFilename(name) {
  if (!name) return null
  let cleaned = String(name).replace(/[\\/*?:"<>|]/g, '')
  cleaned = cleaned.trim().replace(/\s+/g, '_')
  cleaned = cleaned.slice(0, 120)
  return cleaned || null
}

/**
 * Download a single image from a URL to a file path.
 * @param {string} url - Image URL
 * @param {string} filepath - Destination file path
 * @returns {Promise<number>} - Bytes written
 */
export async function downloadPhoto(url, filepath) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
    },
  })
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await writeFile(filepath, buffer)
  return buffer.length
}

export { REDFOX_PLATFORM_PATTERNS, REDFOX_API_URL, PUBLIC_API_KEY }
