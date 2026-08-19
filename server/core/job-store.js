import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function createJobStore({ filePath = join(process.cwd(), 'web', 'data', 'jobs.json') } = {}) {
  let data = { jobs: [] }

  function persist() {
    mkdirSync(dirname(filePath), { recursive: true })
    const tmp = `${filePath}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, filePath)
  }

  if (existsSync(filePath)) {
    try {
      data = JSON.parse(readFileSync(filePath, 'utf8'))
      if (!Array.isArray(data.jobs)) data.jobs = []
    } catch {
      data = { jobs: [] }
    }
  }

  return {
    save(job) {
      const existing = data.jobs.findIndex((j) => j.id === job.id)
      if (existing >= 0) data.jobs[existing] = job
      else data.jobs.push(job)
      persist()
      return job
    },
    update(id, patch) {
      const job = data.jobs.find((j) => j.id === id)
      if (!job) return null
      Object.assign(job, patch, { updatedAt: Date.now() })
      persist()
      return job
    },
    load(id) {
      const job = data.jobs.find((j) => j.id === id)
      return job ? { ...job } : null
    },
    list(clientId) {
      return data.jobs.filter((j) => !j.clientId || j.clientId === clientId).sort((a, b) => b.createdAt - a.createdAt)
    },
    all() {
      return data.jobs.map((j) => ({ ...j }))
    },
    remove(id) {
      data.jobs = data.jobs.filter((j) => j.id !== id)
      persist()
    },
    pruneExpired(cutoff) {
      // READY/DELIVERED：直链任务视为可清理终态（与 SSE 终态集合一致）
      const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'READY', 'DELIVERED'])
      const before = data.jobs.length
      data.jobs = data.jobs.filter((j) => !(terminal.has(j.status) && (j.updatedAt || 0) < cutoff))
      if (data.jobs.length !== before) persist()
      return before - data.jobs.length
    },
    enforceHistoryLimit(limit) {
      // 历史记录缓存上限：仅对终态任务生效，保留最近 limit 条，其余从记录中移除（不动下载文件）
      const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'READY', 'DELIVERED'])
      const terminalJobs = data.jobs
        .filter((j) => terminal.has(j.status))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      if (terminalJobs.length <= limit) return 0
      const keep = new Set(terminalJobs.slice(0, limit).map((j) => j.id))
      const before = data.jobs.length
      data.jobs = data.jobs.filter((j) => !terminal.has(j.status) || keep.has(j.id))
      if (data.jobs.length !== before) persist()
      return before - data.jobs.length
    },
    recoverInterrupted() {
      const recovered = []
      for (const job of data.jobs) {
        if (['RESOLVING', 'DOWNLOADING', 'PROCESSING'].includes(job.status)) {
          job.status = 'RETRY_WAIT'
          job.error = { code: 'INTERRUPTED', message: '服务重启，任务已暂停，可重试', retryable: true }
          job.updatedAt = Date.now()
          recovered.push(job)
        }
      }
      if (recovered.length) persist()
      return recovered
    }
  }
}
