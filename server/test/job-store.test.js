import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJobStore } from '../core/job-store.js'
import { createJob } from '../core/contracts.js'

test('保存与加载任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const job = createJob({ clientId: 'c1', resolutionId: 'res_1', sourceUrl: 'https://e.com/v', actionId: 'act_1' })
  store.save(job)
  const loaded = store.load(job.id)
  assert.equal(loaded.status, 'RESOLVING')
  assert.equal(loaded.sourceUrl, 'https://e.com/v')
  rmSync(dir, { recursive: true, force: true })
})

test('更新后重新加载是最新状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const job = createJob({ clientId: 'c1', resolutionId: 'res_1', sourceUrl: 'https://e.com/v', actionId: 'act_1' })
  store.save(job)
  store.update(job.id, { status: 'DOWNLOADING', percent: 42 })
  const loaded = store.load(job.id)
  assert.equal(loaded.status, 'DOWNLOADING')
  assert.equal(loaded.percent, 42)
  rmSync(dir, { recursive: true, force: true })
})

test('控制令牌仅列出对应匿名任务且按创建时间倒序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const older = createJob({ controlToken: 'token-a', resolutionId: 'r1', sourceUrl: 'https://e.com/1', actionId: 'a1' })
  const newer = createJob({ controlToken: 'token-a', resolutionId: 'r2', sourceUrl: 'https://e.com/2', actionId: 'a2' })
  const other = createJob({ controlToken: 'token-b', resolutionId: 'r3', sourceUrl: 'https://e.com/3', actionId: 'a3' })
  older.createdAt = 1
  newer.createdAt = 2
  other.createdAt = 3
  store.save(older); store.save(newer); store.save(other)
  const jobs = store.listByControlTokens(['token-a'])
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0].id, newer.id)
  assert.equal(jobs.every((job) => job.controlToken === 'token-a'), true)
  rmSync(dir, { recursive: true, force: true })
})

test('中断任务恢复为 RETRY_WAIT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const job = createJob({ clientId: 'c1', resolutionId: 'r1', sourceUrl: 'https://e.com/1', actionId: 'a1' })
  store.save(job)
  store.update(job.id, { status: 'DOWNLOADING', phase: 'download' })
  const recovered = store.recoverInterrupted()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].status, 'RETRY_WAIT')
  rmSync(dir, { recursive: true, force: true })
})

test('remove 删除任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const job = createJob({ clientId: 'c1', resolutionId: 'r1', sourceUrl: 'https://e.com/1', actionId: 'a1' })
  store.save(job)
  store.remove(job.id)
  assert.equal(store.load(job.id), null)
  rmSync(dir, { recursive: true, force: true })
})

test('损坏的 JSON 文件回退为空数据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  writeFileSync(join(dir, 'jobs.json'), '{broken', 'utf8')
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  assert.equal(store.list('c1').length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('写盘后新实例可读回任务（跨实例持久化）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const filePath = join(dir, 'jobs.json')
  const storeA = createJobStore({ filePath })
  const job = createJob({ clientId: 'c1', resolutionId: 'res_1', sourceUrl: 'https://e.com/v', actionId: 'act_1' })
  storeA.save(job)
  storeA.update(job.id, { status: 'QUEUED', percent: 10 })
  const storeB = createJobStore({ filePath })
  const loaded = storeB.load(job.id)
  assert.equal(loaded.status, 'QUEUED')
  assert.equal(loaded.percent, 10)
  rmSync(dir, { recursive: true, force: true })
})

test('pruneExpired 清理过期终态并保留进行中任务', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-test-'))
  const store = createJobStore({ filePath: join(dir, 'jobs.json') })
  const oldDone = createJob({ clientId: 'c1', resolutionId: 'r1', sourceUrl: 'https://e.com/1', actionId: 'a1' })
  oldDone.status = 'COMPLETED'
  oldDone.updatedAt = Date.now() - 48 * 3600 * 1000
  const freshDone = createJob({ clientId: 'c1', resolutionId: 'r2', sourceUrl: 'https://e.com/2', actionId: 'a2' })
  freshDone.status = 'COMPLETED'
  freshDone.updatedAt = Date.now()
  const running = createJob({ clientId: 'c1', resolutionId: 'r3', sourceUrl: 'https://e.com/3', actionId: 'a3' })
  running.status = 'DOWNLOADING'
  const ready = createJob({ clientId: 'c1', resolutionId: 'r4', sourceUrl: 'https://e.com/4', actionId: 'a4' })
  ready.status = 'READY'
  ready.updatedAt = Date.now() - 48 * 3600 * 1000
  store.save(oldDone); store.save(freshDone); store.save(running); store.save(ready)
  const removed = store.pruneExpired(Date.now() - 24 * 3600 * 1000)
  assert.equal(removed, 2)
  assert.equal(store.load(oldDone.id), null)
  assert.ok(store.load(freshDone.id))
  assert.ok(store.load(running.id))
  assert.equal(store.load(ready.id), null)
  rmSync(dir, { recursive: true, force: true })
})
