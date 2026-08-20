const BASE = '/api'
const CLIENT_KEY = 'ikun_web_client_id'
const JOB_TOKENS_KEY = 'ikun_web_job_tokens'

type JobTokenMap = Record<string, string>

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_KEY, id)
  }
  return id
}

function loadJobTokens(): JobTokenMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(JOB_TOKENS_KEY) || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([id, token]) => typeof id === 'string' && typeof token === 'string' && token.length > 0))
  } catch {
    return {}
  }
}

function saveJobToken(jobId: string, token: string): void {
  if (!jobId || !token) return
  const tokens = loadJobTokens()
  tokens[jobId] = token
  const kept = Object.entries(tokens).slice(-100)
  localStorage.setItem(JOB_TOKENS_KEY, JSON.stringify(Object.fromEntries(kept)))
}

function jobHeaders(jobId?: string): Record<string, string> {
  const tokens = loadJobTokens()
  if (jobId) return tokens[jobId] ? { 'X-Job-Token': tokens[jobId] } : {}
  const values = Object.values(tokens).slice(-100)
  return values.length ? { 'X-Job-Tokens': values.join(',') } : {}
}

export class ApiError extends Error {
  code?: string
  status: number
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function jsonHeaders(init?: RequestInit): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
    ...((init?.headers as Record<string, string>) || {})
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: jsonHeaders(init) })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const statusFallback: Record<number, string> = {
      400: '请求无效', 403: '无权访问', 404: '未找到', 429: '请求过于频繁', 500: '服务器内部错误'
    }
    throw new ApiError(data.error || statusFallback[res.status] || '请求失败', res.status, data.code)
  }
  return data as T
}

export interface BinaryStatus {
  ytdlp: string
  ytdlpOk: boolean
  version?: string
  ffmpeg?: string
  ffmpegOk: boolean
}

export interface AppSettings {
  concurrency: number
  fragmentConcurrency: number
  maxAttempts: number
  retries: number
  autoCleanupEnabled?: boolean
  retentionHours?: number
  maxDownloadSizeGB?: number
  historyLimit?: number
}

export interface DownloadStats {
  usedBytes: number
  maxBytes: number
  usedPercent: number
  historyCount: number
  historyLimit: number
}

export const api = {
  health: () => request<{ ok: boolean; version?: string; public?: boolean }>('/health'),
  binaries: () => request<BinaryStatus>('/binaries'),
  getSettings: () => request<AppSettings>('/settings'),
  downloadsStats: () => request<DownloadStats>('/downloads/stats'),
  aiStatus: () => request<{ ok: boolean; status?: number; baseUrl: string; remote: boolean; upstream?: Record<string, unknown>; error?: string }>('/ai/status'),
  removeBackground: async (file: File, profile: 'sharp' | 'fur' = 'sharp') => {
    const form = new FormData()
    form.append('file', file, file.name || 'image.png')
    const res = await fetch(`${BASE}/ai/remove-background?profile=${encodeURIComponent(profile)}`, {
      method: 'POST', headers: { 'X-Client-Id': getClientId() }, body: form
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({} as { error?: string; code?: string }))
      throw new ApiError(data.error || (res.status === 429 ? 'AI 服务繁忙或额度用尽' : 'AI 抠图失败'), res.status, data.code)
    }
    return res.blob()
  }
}

export interface V2MediaAsset {
  id: string
  kind: 'video' | 'audio' | 'image' | 'hls'
  label: string
  ext: string
  width?: number
  height?: number
  fps?: number
  codec?: string
  bitrate?: number
  size?: number
}

export interface V2MediaAction {
  id: string
  label: string
  type: 'direct' | 'merge' | 'extract-audio' | 'hls' | 'images-zip'
  assetIds: string[]
  requiresProcessing: boolean
  preferredExt?: string
}

export interface V2Resolution {
  id: string
  sourceUrl: string
  provider: string
  platform?: string
  title: string
  thumbnail?: string
  duration?: number
  kind: 'video' | 'playlist' | 'images' | 'audio'
  assets: V2MediaAsset[]
  actions: V2MediaAction[]
  createdAt: number
}

export type V2JobStatus = 'RESOLVING' | 'READY' | 'DELIVERED' | 'QUEUED' | 'DOWNLOADING' | 'PROCESSING' | 'RETRY_WAIT' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'EXPIRED'

export interface V2Job {
  id: string
  resolutionId: string
  sourceUrl: string
  actionId: string
  mode: string
  status: V2JobStatus
  phase: string
  percent: number
  speed?: string
  eta?: string
  attempts: number
  maxAttempts: number
  filepath?: string
  filename?: string
  error?: { code: string; message: string; retryable: boolean }
  createdAt: number
  updatedAt: number
}

async function v2Request<T>(path: string, init?: RequestInit, jobId?: string): Promise<T> {
  const res = await fetch(`/api/v2${path}`, { ...init, headers: { ...jsonHeaders(init), ...jobHeaders(jobId) } })
  const body = ((await res.json().catch(() => ({}))) as Record<string, unknown>) || {}
  if (!res.ok) {
    const err = body.error as { message?: string; code?: string } | undefined
    throw new ApiError(err?.message || '请求失败', res.status, err?.code)
  }
  const data = body.data as T
  const issuedJobToken = res.headers.get('X-Job-Token')
  if (issuedJobToken && data && typeof data === 'object' && 'id' in data && typeof (data as { id?: unknown }).id === 'string') {
    saveJobToken((data as { id: string }).id, issuedJobToken)
  }
  return data
}

export const apiV2 = {
  resolve: (url: string, signal?: AbortSignal) => v2Request<V2Resolution>('/resolutions', { method: 'POST', body: JSON.stringify({ url }), signal }),
  assetContentUrl: (assetId: string) => `/api/v2/assets/${assetId}/content`,
  assetProxyUrl: (assetId: string) => `/api/v2/assets/${assetId}/proxy`,
  createDownload: (resolutionId: string, actionId: string, mode = 'auto') => v2Request<V2Job>('/downloads', { method: 'POST', body: JSON.stringify({ resolutionId, actionId, mode }) }),
  listDownloads: () => v2Request<V2Job[]>('/downloads'),
  getDownload: (id: string) => v2Request<V2Job>(`/downloads/${id}`, undefined, id),
  retryDownload: (id: string) => v2Request<V2Job>(`/downloads/${id}/retry`, { method: 'POST' }, id),
  cancelDownload: (id: string) => v2Request<{ ok: boolean }>(`/downloads/${id}`, { method: 'DELETE' }, id),
  fileUrl: (jobId: string) => {
    const token = loadJobTokens()[jobId]
    return token ? `/api/v2/assets/${jobId}/content?token=${encodeURIComponent(token)}` : `/api/v2/assets/${jobId}/content`
  }
}
