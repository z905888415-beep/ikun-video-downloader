import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createJobScheduler } from '../core/job-scheduler.js'
import { createRetryPolicy } from '../core/retry-policy.js'
import { createJob } from '../core/contracts.js'

function makeStore() {
  const jobs = new Map()
  return {
    save: (j) => jobs.set(j.id, j),
    update: (id, patch) => { const j = jobs.get(id); if (j) { Object.assign(j, patch); return j } return null },
    load: (id) => jobs.get(id) ? { ...jobs.get(id) } : null,
    list: (cid) => [...jobs.values()].filter((j) => !j.clientId || j.clientId === cid),
    remove: (id) => jobs.delete(id),
    recoverInterrupted: () => []
  }
}

test('并发限制为 concurrency', async () => {
  const store = makeStore()
  let active = 0
  let maxActive = 0
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 1 }),
    concurrency: 2,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: { download: async (job) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active-- } },
    processor: { process: async () => {} }
  })
  const jobs = Array.from({ length: 4 }, () => {
    const j = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
    store.save(j)
    return j
  })
  scheduler.schedule(jobs[0]); scheduler.schedule(jobs[1]); scheduler.schedule(jobs[2]); scheduler.schedule(jobs[3])
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(maxActive, 2, `maxActive=${maxActive}`)
})

test('取消任务终止执行并标记 CANCELLED', async () => {
  const store = makeStore()
  let aborted = false
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 1 }),
    concurrency: 2,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: {
      download: async (job, assetUrl, signal) => {
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
        })
      }
    },
    processor: { process: async () => {} }
  })
  const job = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
  store.save(job)
  scheduler.schedule(job)
  await new Promise((r) => setTimeout(r, 30))
  scheduler.cancel(job.id)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(aborted, true)
  assert.equal(store.load(job.id).status, 'CANCELLED')
})

test('可重试错误进入 RETRY_WAIT 并最终成功', async () => {
  const store = makeStore()
  let calls = 0
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 3 }),
    concurrency: 2,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: {
      download: async (job) => {
        calls++
        if (calls < 2) throw Object.assign(new Error('temp'), { status: 503 })
      }
    },
    processor: { process: async (job) => ({ filepath: '/tmp/out.mp4', filename: 'out.mp4' }) }
  })
  const job = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
  store.save(job)
  scheduler.schedule(job)
  await new Promise((r) => setTimeout(r, 1800))
  const final = store.load(job.id)
  assert.equal(final.status, 'COMPLETED')
  assert.equal(final.attempts, 1)
})

test('不可重试错误标记 FAILED', async () => {
  const store = makeStore()
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 3 }),
    concurrency: 2,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: {
      download: async () => { throw Object.assign(new Error('no auth'), { code: 'AUTH_REQUIRED' }) }
    },
    processor: { process: async () => {} }
  })
  const job = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
  store.save(job)
  scheduler.schedule(job)
  await new Promise((r) => setTimeout(r, 50))
  const final = store.load(job.id)
  assert.equal(final.status, 'FAILED')
  assert.equal(final.error.code, 'AUTH_REQUIRED')
})

test('RETRY_WAIT 期间取消任务不会复活', async () => {
  const store = makeStore()
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 3 }),
    concurrency: 1,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: {
      download: async () => { throw Object.assign(new Error('temp'), { status: 503 }) }
    },
    processor: { process: async () => {} }
  })
  const job = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
  store.save(job)
  scheduler.schedule(job)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(store.load(job.id).status, 'RETRY_WAIT', '首次失败应进入 RETRY_WAIT')
  scheduler.cancel(job.id)
  await new Promise((r) => setTimeout(r, 1500))
  assert.equal(store.load(job.id).status, 'CANCELLED', '取消后任务必须保持 CANCELLED')
})

test('retry 把失败任务重新入队', async () => {
  const store = makeStore()
  let calls = 0
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 1 }),
    concurrency: 1,
    resolver: { resolve: async (url) => ({ id: 'res_x' }) },
    mediaDownloader: {
      download: async () => { calls++; if (calls < 2) throw Object.assign(new Error('x'), { status: 500 }) }
    },
    processor: { process: async (job) => ({ filepath: '/tmp/o.mp4', filename: 'o.mp4' }) }
  })
  const job = createJob({ clientId: 'c1', resolutionId: 'r', sourceUrl: 'https://e.com/v', actionId: 'a' })
  store.save(job)
  scheduler.schedule(job)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(store.load(job.id).status, 'FAILED')
  scheduler.retry(job.id)
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(store.load(job.id).status, 'COMPLETED')
})
