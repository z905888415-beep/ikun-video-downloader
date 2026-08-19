const BASE = '/api'
const TOKEN_KEY = 'ikun_web_token'
const CLIENT_KEY = 'ikun_web_client_id'

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_KEY)
  if (!id) {
    id = `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    localStorage.setItem(CLIENT_KEY, id)
  }
  return id
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) || ''
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
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

async function request<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
    ...((init?.headers as Record<string, string>) || {})
  }
  const needAuth = init?.auth !== false
  const token = getToken()
  if (needAuth && token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 401) {
      clearToken()
    }
    const statusFallback: Record<number, string> = {
      400: '请求无效',
      401: '未授权',
      403: '无权访问',
      404: '未找到',
      500: '服务器内部错误'
    }
    throw new ApiError(
      data.error || statusFallback[res.status] || '请求失败',
      res.status,
      data.code
    )
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
  directFirst: boolean
  rateLimit: string
  retries: number
  proxy: string
  cookiesFile: string
  customHeaders: string
  writeSubs: boolean
  embedMetadata: boolean
  writeThumbnail: boolean
  autoCleanupEnabled?: boolean
  retentionHours?: number
  maxDownloadSizeGB?: number
  historyLimit?: number
  redfoxApiKey?: string
}

export interface DownloadStats {
  usedBytes: number
  maxBytes: number
  usedPercent: number
  historyCount: number
  historyLimit: number
}

export interface ShareInfo {
  port: number
  host: string
  version?: string
  localUrl: string
  lanUrls: string[]
  authRequired: boolean
  passwordHint: string
  hasFrontend: boolean
}

export const api = {
  health: () => request<{ ok: boolean; shareable?: boolean; authRequired?: boolean }>('/health', { auth: false }),
  shareInfo: () => request<ShareInfo>('/share-info', { auth: false }),
  login: (password: string) =>
    request<{ token: string; expiresIn: number }>('/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
      auth: false
    }),
  me: () => request<{ ok: boolean; clientId: string }>('/me'),
  binaries: () => request<BinaryStatus>('/binaries'),
  getSettings: () => request<AppSettings>('/settings'),
  setSettings: (partial: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(partial) }),
  downloadsStats: () => request<DownloadStats>('/downloads/stats'),
  aiStatus: () =>
    request<{
      ok: boolean
      status?: number
      baseUrl: string
      remote: boolean
      upstream?: Record<string, unknown>
      error?: string
    }>('/ai/status'),
  removeBackground: async (file: File, profile: 'sharp' | 'fur' = 'sharp') => {
    const form = new FormData()
    form.append('file', file, file.name || 'image.png')
    const headers: Record<string, string> = {
      'X-Client-Id': getClientId()
    }
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${BASE}/ai/remove-background?profile=${encodeURIComponent(profile)}`, {
      method: 'POST',
      headers,
      body: form
    })
    if (!res.ok) {
      if (res.status === 401) clearToken()
      const data = await res.json().catch(() => ({} as { error?: string; code?: string }))
      throw new ApiError(
        data.error || (res.status === 429 ? 'AI 服务繁忙或额度用尽' : 'AI 抠图失败'),
        res.status,
        data.code
      )
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

export type V2JobStatus =
  | 'RESOLVING'
  | 'READY'
  | 'DELIVERED'
  | 'QUEUED'
  | 'DOWNLOADING'
  | 'PROCESSING'
  | 'RETRY_WAIT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'

export interface V2Job {
  id: string
  clientId: string
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

async function v2Request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
    ...((init?.headers as Record<string, string>) || {})
  }
  const res = await fetch(`/api/v2${path}`, { ...init, headers })
  const body = ((await res.json().catch(() => ({}))) as Record<string, unknown>) || {}
  if (!res.ok) {
    const err = body.error as { message?: string; code?: string } | undefined
    throw new ApiError(err?.message || '请求失败', res.status, err?.code)
  }
  return body.data as T
}

export const apiV2 = {
  resolve: (url: string, signal?: AbortSignal) =>
    v2Request<V2Resolution>('/resolutions', { method: 'POST', body: JSON.stringify({ url }), signal }),
  assetContentUrl: (assetId: string) => `/api/v2/assets/${assetId}/content`,
  assetProxyUrl: (assetId: string) => `/api/v2/assets/${assetId}/proxy`,
  createDownload: (resolutionId: string, actionId: string, mode = 'auto') =>
    v2Request<V2Job>('/downloads', { method: 'POST', body: JSON.stringify({ resolutionId, actionId, mode }) }),
  listDownloads: () => v2Request<V2Job[]>('/downloads'),
  getDownload: (id: string) => v2Request<V2Job>(`/downloads/${id}`),
  retryDownload: (id: string) => v2Request<V2Job>(`/downloads/${id}/retry`, { method: 'POST' }),
  cancelDownload: (id: string) => v2Request<{ ok: boolean }>(`/downloads/${id}`, { method: 'DELETE' }),
  fileUrl: (jobId: string) => `/api/v2/assets/${jobId}/content`
}
