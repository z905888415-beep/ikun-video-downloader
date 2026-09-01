const CFG_MODEL = 'ikun_image_model'

// 端点与密钥由 iKun 服务端内置（/etc/ikun-web.env 的 IMAGE_API_*）。
// 模型与分辨率不在前端暴露：模型固定走服务端分组可用值，分辨率由上游档位决定。

export function loadImageGenModel(): string {
  return localStorage.getItem(CFG_MODEL) || 'gpt-image-2'
}

export interface ImageGenRequest {
  prompt: string
  size: string
  resolution?: string
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

function errorMessage(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback
  const obj = payload as Record<string, unknown>
  if (typeof obj.error === 'string') return obj.error
  if (obj.error && typeof obj.error === 'object' && typeof (obj.error as { message?: string }).message === 'string') {
    return (obj.error as { message: string }).message
  }
  if (typeof obj.message === 'string') return obj.message
  return fallback
}

function extractImageUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const data = root.data
  const first = Array.isArray(data) ? data[0] : data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  if (!first || typeof first !== 'object') return null
  const item = first as Record<string, unknown>
  let url = item.url
  if (Array.isArray(url)) url = url[0]
  if (typeof url === 'string' && url) return url
  if (typeof item.b64_json === 'string' && item.b64_json) return `data:image/png;base64,${item.b64_json}`
  return null
}

function extractTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const data = root.data
  const first = Array.isArray(data) ? data[0] : data && typeof data === 'object' ? (data as Record<string, unknown>) : null
  if (!first || typeof first !== 'object') return null
  const id = (first as Record<string, unknown>).task_id
  return typeof id === 'string' && id ? id : null
}

async function pollTask(taskId: string, onProgress?: (n: number) => void, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError')
    const res = await fetch(`/api/ai/images/tasks?taskId=${encodeURIComponent(taskId)}`, { signal })
    const payload = await res.json().catch(() => ({}))
    if (!res.ok) continue
    const task = (payload as { data?: Record<string, unknown> }).data
    if (!task) continue
    const progress = Number(task.progress) || 0
    onProgress?.(Math.max(4, Math.min(99, progress)))
    if (task.status === 'completed') {
      const images = (task.result as { images?: Array<{ url?: string | string[] }> } | undefined)?.images
      const raw = images?.[0]?.url
      const url = Array.isArray(raw) ? raw[0] : raw
      if (!url) throw new Error('任务完成，但没有返回图片')
      return url
    }
    if (task.status === 'failed') {
      const err = task.error as { message?: string } | undefined
      throw new Error(err?.message || '图片生成失败')
    }
  }
  throw new Error('生成超时，请稍后重试')
}

export interface ImageEditRequest {
  prompt: string
  size: string
  file: File
  signal?: AbortSignal
  onProgress?: (percent: number) => void
}

// 图生图：参考图必须走服务端 /v1/images/edits multipart（上游 generations 不认 image_urls）
export async function generateImageEdit(req: ImageEditRequest): Promise<string> {
  const prompt = req.prompt.trim()
  if (!prompt) throw new Error('请先描述你想创造的画面')
  if (!req.file || !req.file.size) throw new Error('图生图需要先添加参考图')

  req.onProgress?.(8)
  const form = new FormData()
  form.append('image', req.file)
  form.append('model', loadImageGenModel())
  form.append('prompt', prompt)
  form.append('n', '1')
  if (req.size) form.append('size', req.size)

  const res = await fetch('/api/ai/images/edits', {
    method: 'POST',
    body: form,
    signal: req.signal
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorMessage(payload, `API 请求失败（${res.status}）`))

  const direct = extractImageUrl(payload)
  if (direct) {
    req.onProgress?.(100)
    return direct
  }
  const taskId = extractTaskId(payload)
  if (taskId) {
    req.onProgress?.(12)
    const url = await pollTask(taskId, req.onProgress, req.signal)
    req.onProgress?.(100)
    return url
  }
  throw new Error(errorMessage(payload, 'API 没有返回图片'))
}

export async function generateImage(req: ImageGenRequest): Promise<string> {
  const prompt = req.prompt.trim()
  if (!prompt) throw new Error('请先描述你想创造的画面')

  req.onProgress?.(8)
  const body: Record<string, unknown> = {
    model: loadImageGenModel(),
    prompt,
    n: 1,
    size: req.size
  }
  if (req.resolution) body.resolution = req.resolution

  const res = await fetch('/api/ai/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(errorMessage(payload, `API 请求失败（${res.status}）`))

  const direct = extractImageUrl(payload)
  if (direct) {
    req.onProgress?.(100)
    return direct
  }
  const taskId = extractTaskId(payload)
  if (taskId) {
    req.onProgress?.(12)
    const url = await pollTask(taskId, req.onProgress, req.signal)
    req.onProgress?.(100)
    return url
  }
  throw new Error(errorMessage(payload, 'API 没有返回图片'))
}
