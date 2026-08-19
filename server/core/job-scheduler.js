export function createJobScheduler({ store, retry, concurrency: initialConcurrency = 2, resolver, mediaDownloader, processor, fallback = null, onCompleted = null }) {
  let concurrency = Math.min(8, Math.max(1, Number(initialConcurrency) || 2))
  const queue = []
  const running = new Map()
  const controllers = new Map()
  const retryTimers = new Map()

  function safeUpdate(id, patch) {
    try { return store.update(id, patch) } catch { return null }
  }

  function pump() {
    while (running.size < concurrency && queue.length) {
      const job = queue.shift()
      if (job.status === 'CANCELLED') continue
      run(job)
    }
  }

  async function run(job) {
    const controller = new AbortController()
    try {
      controllers.set(job.id, controller)
      running.set(job.id, job)
      store.update(job.id, { status: 'DOWNLOADING', phase: 'download', error: null })

      if (job.requiresResolve) {
        await resolver.resolve(job.sourceUrl)
      }
      const files = {}
      const urls = Array.isArray(job.assetUrls) && job.assetUrls.length ? job.assetUrls : []
      // 进度写盘节流：状态转换立即写，进度类更新每 500ms 最多一次
      let lastProgressWrite = 0
      const onProgress = (p) => {
        const now = Date.now()
        if (now - lastProgressWrite >= 500) {
          lastProgressWrite = now
          store.update(job.id, p)
        }
      }
      if (urls.length === 0) {
        let result
        if (fallback) {
          result = await fallback.download(job, controller.signal)
        } else {
          result = await mediaDownloader.download(job, job.sourceUrl || '', controller.signal, onProgress)
        }
        files.video = typeof result === 'string' ? result : result?.filepath || ''
        store.update(job.id, { percent: 95, message: fallback ? '正在通过兜底通道下载…' : '正在下载…' })
      } else {
        for (let i = 0; i < urls.length; i++) {
          const filepath = await mediaDownloader.download(job, urls[i], controller.signal, onProgress)
          files[i === 0 ? 'video' : 'audio'] = filepath
        }
      }
      // 阶段边界取消检查：下载完成后、进入 PROCESSING 前
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      job.files = files
      store.update(job.id, { status: 'PROCESSING', phase: 'process', percent: 99 })
      const result = await processor.process(job, controller.signal)
      // 阶段边界取消检查：处理完成后、进入 COMPLETED 前
      if (controller.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      store.update(job.id, { status: 'COMPLETED', phase: 'deliver', percent: 100, filename: result.filename, filepath: result.filepath })
      try {
        onCompleted?.(store.load(job.id))
      } catch (hookError) {
        console.error(`[scheduler] onCompleted hook failed for ${job.id}:`, hookError)
      }
    } catch (error) {
      if (controller.signal.aborted) {
        safeUpdate(job.id, { status: 'CANCELLED', error: { code: 'CANCELLED', message: '已取消', retryable: false } })
      } else {
        try {
          const decision = retry.shouldRetry(error, job.attempts + 1)
          if (decision.ok) {
            job.attempts += 1
            safeUpdate(job.id, { status: 'RETRY_WAIT', attempts: job.attempts, error: { code: error.code || 'DOWNLOAD_FAILED', message: error.message, retryable: true } })
            const timer = setTimeout(() => {
              retryTimers.delete(job.id)
              try {
                const current = store.load(job.id)
                // 仅当仍处于 RETRY_WAIT 时才重新入队（cancel/retry 会清掉定时器，双保险）
                if (current && current.status === 'RETRY_WAIT') {
                  store.update(job.id, { status: 'QUEUED' })
                  queue.push(store.load(job.id))
                  pump()
                }
              } catch { /* store 不可用，放弃本次重试 */ }
            }, decision.delayMs)
            retryTimers.set(job.id, timer)
          } else {
            safeUpdate(job.id, { status: 'FAILED', error: { code: error.code || 'DOWNLOAD_FAILED', message: error.message || '下载失败', retryable: decision.refreshResolution || false } })
          }
        } catch {
          // store/retry 自身故障：无法落盘，仅清理运行槽位
        }
      }
    } finally {
      running.delete(job.id)
      controllers.delete(job.id)
      pump()
    }
  }

  return {
    schedule(job) {
      if (running.has(job.id) || queue.some((q) => q.id === job.id)) return
      store.update(job.id, { status: 'QUEUED', phase: 'download' })
      queue.push(job)
      pump()
    },
    cancel(id) {
      const timer = retryTimers.get(id)
      if (timer) { clearTimeout(timer); retryTimers.delete(id) }
      const controller = controllers.get(id)
      if (controller) controller.abort()
      const queued = queue.findIndex((q) => q.id === id)
      if (queued >= 0) queue.splice(queued, 1)
      safeUpdate(id, { status: 'CANCELLED', error: { code: 'CANCELLED', message: '已取消', retryable: false } })
      return true
    },
    retry(id) {
      const timer = retryTimers.get(id)
      if (timer) { clearTimeout(timer); retryTimers.delete(id) }
      const job = store.load(id)
      if (!job || !['FAILED', 'RETRY_WAIT', 'CANCELLED'].includes(job.status)) return null
      store.update(id, { status: 'QUEUED', attempts: 0, error: null, percent: 0 })
      queue.push(store.load(id))
      pump()
      return store.load(id)
    },
    setConcurrency(value) {
      const next = Math.min(8, Math.max(1, Number(value) || 1))
      if (next !== concurrency) {
        concurrency = next
        pump()
      }
    },
    activeCount() {
      return running.size
    },
    dispose() {
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      queue.length = 0
    }
  }
}
