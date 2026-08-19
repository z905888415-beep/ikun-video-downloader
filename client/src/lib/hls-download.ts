const RETRYABLE = new Set([408, 425, 429])
const RETRY_DELAYS = [500, 1000, 2000]

async function fetchWithRetry(url: string, attempt = 0): Promise<Blob> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
    return await res.blob()
  } catch (error) {
    const status = (error as { status?: number }).status
    if (attempt < RETRY_DELAYS.length && (status === undefined || RETRYABLE.has(status!) || (status! >= 500))) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]))
      return fetchWithRetry(url, attempt + 1)
    }
    throw error
  }
}

export async function downloadHls(masterUrl: string, onProgress: (p: number) => void, concurrency = 8): Promise<Blob> {
  // 服务端交付/代理的都是已重写为站内代理地址的播放列表（master 或媒体列表）
  const master = await (await fetch(masterUrl)).text()
  if (master.includes('#EXT-X-STREAM-INF')) {
    // master 列表：取第一个变体（已是代理绝对地址），递归获取媒体列表
    const variantLine = master.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))
    if (!variantLine) throw new Error('未找到可下载的变体')
    return downloadHls(variantLine.trim(), onProgress, concurrency)
  }
  // 媒体列表：所有非注释行即分片（代理绝对地址）
  const segmentUrls = master
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
  if (!segmentUrls.length) throw new Error('播放列表没有分片')

  const parts = new Array<Blob>(segmentUrls.length)
  let done = 0
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, segmentUrls.length) }, async () => {
    while (next < segmentUrls.length) {
      const i = next++
      const blob = await fetchWithRetry(segmentUrls[i])
      parts[i] = blob
      done++
      onProgress(Math.round((done / segmentUrls.length) * 100))
    }
  })
  await Promise.all(workers)
  return new Blob(parts, { type: 'video/mp4' })
}
