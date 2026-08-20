import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// 模块级 __dirname 推导：web/server/core → 仓库 web 根 → data
const WEB_ROOT = resolve(__dirname, '..', '..')
const DEFAULT_SETTINGS_PATH = join(WEB_ROOT, 'data', 'settings.json')

export function defaultSettings() {
  return {
    concurrency: 2,
    fragmentConcurrency: 4,
    maxAttempts: 3,
    directFirst: true,
    rateLimit: '',
    retries: 10,
    proxy: '',
    cookiesFile: '',
    customHeaders: '',
    writeSubs: false,
    embedMetadata: true,
    writeThumbnail: false,
    autoCleanupEnabled: true,
    retentionHours: 24,
    maxDownloadSizeGB: 5,
    historyLimit: 30
  }
}

export function createSettingsStore({ filePath = DEFAULT_SETTINGS_PATH } = {}) {
  let settings = { ...defaultSettings() }
  if (existsSync(filePath)) {
    try {
      // 容错 PowerShell 等工具写入的 UTF-8 BOM（Node readFileSync 不自动剥离）
      const raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
      settings = { ...defaultSettings(), ...JSON.parse(raw) }
    } catch { /* 保持默认 */ }
  }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8')
    renameSync(tmp, filePath)
  }

  return {
    get() {
      return { ...settings }
    },
    set(partial = {}) {
      const next = { ...settings }
      if (partial.concurrency != null) next.concurrency = Math.min(8, Math.max(1, Number(partial.concurrency) || 1))
      if (partial.fragmentConcurrency != null) next.fragmentConcurrency = Math.min(8, Math.max(1, Number(partial.fragmentConcurrency) || 1))
      if (partial.maxAttempts != null) next.maxAttempts = Math.min(10, Math.max(0, Number(partial.maxAttempts) || 0))
      if (partial.directFirst != null) next.directFirst = Boolean(partial.directFirst)
      if (partial.rateLimit != null) next.rateLimit = String(partial.rateLimit || '')
      if (partial.retries != null) next.retries = Math.min(100, Math.max(0, Number(partial.retries) || 0))
      if (partial.proxy != null) next.proxy = String(partial.proxy || '')
      if (partial.cookiesFile != null) next.cookiesFile = String(partial.cookiesFile || '')
      if (partial.customHeaders != null) next.customHeaders = String(partial.customHeaders || '')
      if (partial.writeSubs != null) next.writeSubs = Boolean(partial.writeSubs)
      if (partial.embedMetadata != null) next.embedMetadata = Boolean(partial.embedMetadata)
      if (partial.writeThumbnail != null) next.writeThumbnail = Boolean(partial.writeThumbnail)
      if (partial.autoCleanupEnabled != null) next.autoCleanupEnabled = Boolean(partial.autoCleanupEnabled)
      if (partial.retentionHours != null) {
        next.retentionHours = Math.min(24 * 30, Math.max(1, Number(partial.retentionHours) || 24))
      }
      if (partial.maxDownloadSizeGB != null) {
        next.maxDownloadSizeGB = Math.min(100, Math.max(1, Number(partial.maxDownloadSizeGB) || 5))
      }
      if (partial.historyLimit != null) {
        next.historyLimit = Math.min(500, Math.max(5, Number(partial.historyLimit) || 30))
      }
      settings = next
      persist()
      return this.get()
    }
  }
}
