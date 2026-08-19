import { createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../core/errors.js'

export function createMediaDownloader({ fetchImpl = fetch } = {}) {
  return {
    async download(job, assetUrl, signal, onProgress = () => {}) {
      const workDir = job.workDir || join(process.cwd(), 'web', 'downloads', job.id)
      mkdirSync(workDir, { recursive: true })
      const filepath = join(workDir, 'source.bin')
      let upstream
      try {
        upstream = await fetchImpl(assetUrl, {
          headers: job.headers || {},
          signal: signal || AbortSignal.timeout(120000)
        })
      } catch (error) {
        if (signal?.aborted) throw new AppError('DOWNLOAD_FAILED', '已取消', false)
        throw new AppError('DOWNLOAD_FAILED', `请求媒体失败：${error.message}`, true)
      }
      if (!upstream.ok) {
        throw new AppError('DOWNLOAD_FAILED', `媒体 HTTP ${upstream.status}`, true, { status: upstream.status })
      }
      const total = Number(upstream.headers.get('content-length') || 0)
      let received = 0
      const stream = createWriteStream(filepath)
      try {
        for await (const chunk of upstream.body) {
          received += chunk.length
          if (!stream.write(chunk)) {
            await new Promise((resolve) => stream.once('drain', resolve))
          }
          if (total) onProgress({ percent: Math.min(99, Math.round((received / total) * 100)), received, total })
        }
        stream.end()
        await new Promise((resolve, reject) => {
          stream.on('finish', resolve)
          stream.on('error', reject)
        })
      } catch (error) {
        stream.destroy()
        try { unlinkSync(filepath) } catch { /* ignore */ }
        if (signal?.aborted) throw new AppError('DOWNLOAD_FAILED', '已取消', false)
        throw new AppError('DOWNLOAD_FAILED', `写入失败：${error.message}`, true)
      }
      onProgress({ percent: 100, received, total })
      return filepath
    }
  }
}
