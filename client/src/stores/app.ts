import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  apiV2,
  type AppSettings,
  type BinaryStatus,
  type DownloadStats,
  type V2Job,
  type V2Resolution
} from '../api/client'

export type PageId = 'home' | 'imagine' | 'tools' | 'history' | 'settings'

export function extractUrl(value: string): string {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  // 1. 优先匹配 http:// 或 https:// 开头的 URL
  const httpMatch = trimmed.match(/https?:\/\/[^\s\u4e00-\u9fa5<>'"()[\]{}]+/i)
  if (httpMatch) {
    let candidate = httpMatch[0]
    candidate = candidate.replace(/[.,;!?:'"`\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u3008\u3009\u300a\u300b]+$/, '')
    return candidate
  }

  // 2. 如果包含其它明确协议头（如 ftp:// 等），原样返回
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed
  }

  // 3. 匹配没有写协议前缀的常见短链或域名
  const domainMatch = trimmed.match(/(?:[a-zA-Z0-9-]+\.)+(?:com|tv|cn|net|org|cc|me|app|be|link|site|top|xyz|co|io)\/[^\s\u4e00-\u9fa5<>'"()[\]{}]*/i)
  if (domainMatch) {
    let candidate = domainMatch[0]
    candidate = candidate.replace(/[.,;!?:'"`\u3002\uff0c\uff01\uff1f\uff1b\uff1a\u201c\u201d\u2018\u2019\u3010\u3011\uff08\uff09\u3008\u3009\u300a\u300b]+$/, '')
    return `https://${candidate}`
  }

  return trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useAppStore = defineStore('app', () => {
  const page = ref<PageId>('home')
  const settings = ref<AppSettings | null>(null)
  const binary = ref<BinaryStatus | null>(null)
  const version = ref('')
  const url = ref('')
  const v2Resolution = ref<V2Resolution | null>(null)
  const v2Probing = ref(false)
  const v2Error = ref('')
  const v2Jobs = ref<V2Job[]>([])
  const downloadStats = ref<DownloadStats | null>(null)
  const apiOnline = ref(false)
  const globalError = ref('')
  const notice = ref('')
  const urlError = ref('')
  let v2PollTimer: number | null = null
  let noticeTimer: number | null = null
  let probeController: AbortController | null = null

  const v2RunningCount = computed(
    () =>
      v2Jobs.value.filter((j) =>
        ['QUEUED', 'DOWNLOADING', 'PROCESSING', 'RETRY_WAIT', 'RESOLVING'].includes(j.status)
      ).length
  )

  async function init(): Promise<void> {
    try {
      const health = await api.health()
      version.value = health.version || ''
      apiOnline.value = true
      await loadAppData()
    } catch (e) {
      apiOnline.value = false
      globalError.value = '无法连接服务，请确认网站服务已启动'
      if (e instanceof Error && e.message !== '无法连接服务，请确认网站服务已启动') {
        globalError.value = errorMessage(e) || globalError.value
      }
    }
  }

  async function loadAppData(): Promise<void> {
    const [nextSettings, nextBinary] = await Promise.all([api.getSettings(), api.binaries()])
    settings.value = nextSettings
    binary.value = nextBinary
  }

  async function doResolveV2(targetUrl?: string): Promise<void> {
    const raw = (targetUrl ?? url.value).trim()
    if (!raw) { v2Error.value = '请输入视频链接'; return }
    const cleaned = extractUrl(raw)
    if (cleaned && cleaned !== url.value) {
      url.value = cleaned
    }
    const u = cleaned || raw
    probeController?.abort()
    probeController = new AbortController()
    v2Probing.value = true
    v2Error.value = ''
    v2Resolution.value = null
    const timer = window.setTimeout(() => probeController?.abort(), 60000)
    try {
      v2Resolution.value = await apiV2.resolve(u.startsWith('http') ? u : `https://${u}`, probeController.signal)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        v2Error.value = '解析超时，请重试'
      } else {
        v2Error.value = e instanceof Error ? e.message : String(e)
      }
    } finally {
      window.clearTimeout(timer)
      probeController = null
      v2Probing.value = false
    }
  }

  function saveBlob(blob: Blob, filename: string): void {
    const anchor = document.createElement('a')
    anchor.href = URL.createObjectURL(blob)
    anchor.download = filename
    anchor.style.display = 'none'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(anchor.href), 30000)
  }

  async function downloadAsset(assetId: string, filename: string, onProgress?: (p: number) => void): Promise<void> {
    const res = await fetch(apiV2.assetProxyUrl(assetId))
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length') || 0)
    const reader = res.body?.getReader()
    if (!reader) {
      const blob = await res.blob()
      onProgress?.(100)
      saveBlob(blob, filename)
      return
    }
    const chunks: BlobPart[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        chunks.push(value as BlobPart)
        received += value.length
        if (total) onProgress?.(Math.min(99, Math.round((received / total) * 100)))
      }
    }
    onProgress?.(100)
    const blob = new Blob(chunks)
    saveBlob(blob, filename)
  }

  function startV2Polling(): void {
    if (v2PollTimer != null) return
    v2PollTimer = window.setInterval(async () => {
      if (document.hidden) return
      try {
        v2Jobs.value = await apiV2.listDownloads()
      } catch {
        // 服务不可用时不打断轮询
      }
    }, 5000)
  }

  async function enqueueV2Action(actionId: string): Promise<V2Job | null> {
    if (!v2Resolution.value) return null
    try {
      const job = await apiV2.createDownload(v2Resolution.value.id, actionId)
      v2Jobs.value = await apiV2.listDownloads()
      startV2Polling()
      setNotice(job.status === 'READY' ? '已开始下载' : `已加入队列：${job.status}`)
      return job
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
      return null
    }
  }

  async function cancelV2Job(id: string): Promise<void> {
    try {
      await apiV2.cancelDownload(id)
      v2Jobs.value = await apiV2.listDownloads()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function retryV2Job(id: string): Promise<void> {
    try {
      await apiV2.retryDownload(id)
      v2Jobs.value = await apiV2.listDownloads()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e))
    }
  }

  async function refreshV2Jobs(): Promise<void> {
    v2Jobs.value = await apiV2.listDownloads()
  }

  async function refreshDownloadStats(): Promise<void> {
    try {
      downloadStats.value = await api.downloadsStats()
    } catch {
      // 统计接口失败不阻塞页面
    }
  }

  function setNotice(msg: string): void {
    notice.value = msg
    if (noticeTimer != null) window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      notice.value = ''
      noticeTimer = null
    }, 3200)
  }

  async function refreshBinary(): Promise<void> {
    binary.value = await api.binaries()
  }

  async function pasteFromClipboard(): Promise<void> {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text) {
        const cleaned = extractUrl(text)
        url.value = cleaned || text
        urlError.value = ''
      }
    } catch {
      urlError.value = '无法读取剪贴板，请手动粘贴链接'
    }
  }

  return {
    page,
    settings,
    binary,
    version,
    url,
    v2Resolution,
    v2Probing,
    v2Error,
    v2Jobs,
    downloadStats,
    apiOnline,
    globalError,
    notice,
    urlError,
    v2RunningCount,
    init,
    doResolveV2,
    downloadAsset,
    setNotice,
    startV2Polling,
    enqueueV2Action,
    cancelV2Job,
    retryV2Job,
    refreshV2Jobs,
    refreshDownloadStats,
    refreshBinary,
    pasteFromClipboard
  }
})
