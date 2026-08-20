import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import express from 'express'
import { createApiV2Router } from '../api-v2.js'
import { createProviderRegistry } from '../providers/provider-registry.js'
import { createResolutionService } from '../core/resolution-service.js'
import { createAssetRegistry } from '../core/asset-registry.js'
import { createJobStore } from '../core/job-store.js'
import { createRetryPolicy } from '../core/retry-policy.js'
import { createJobScheduler } from '../core/job-scheduler.js'
import { createResolution, createAsset, createAction } from '../core/contracts.js'
import { createDirectDelivery, createStreamDelivery } from '../delivery/direct-delivery.js'
import { createFileDelivery } from '../delivery/file-delivery.js'

let server
let base
const tmpJobs = join(process.cwd(), 'test', 'tmp-jobs.json')
const downloadsDir = join(process.cwd(), 'test', 'tmp-files')

function makeApp() {
  const registry = createProviderRegistry()
  const assets = createAssetRegistry()
  registry.register({
    id: 'fake', canHandle: () => true,
    resolve: async (url) => {
      const v = createAsset({ kind: 'video', label: '1080p', ext: 'mp4' })
      const a = createAsset({ kind: 'audio', label: '128k', ext: 'm4a' })
      return createResolution({
        sourceUrl: url, provider: 'fake', title: '测试',
        assets: [v, a],
        actions: [
          createAction({ label: '1080p MP4', type: 'direct', assetIds: [v.id] }),
          createAction({ label: '合并', type: 'merge', assetIds: [v.id, a.id], requiresProcessing: true, preferredExt: 'mp4' })
        ],
        assetUrls: { [v.id]: 'https://cdn.example.com/v.mp4', [a.id]: 'https://cdn.example.com/a.m4a' }
      })
    }
  })
  const resolutions = createResolutionService({ registry, assets })
  const store = createJobStore({ filePath: tmpJobs })
  const scheduler = createJobScheduler({
    store,
    retry: createRetryPolicy({ maxAttempts: 3 }),
    concurrency: 2,
    resolver: resolutions,
    mediaDownloader: {
      download: async (job, assetUrl) => {
        mkdirSync(join(downloadsDir, job.id), { recursive: true })
        writeFileSync(join(downloadsDir, job.id, 'source.bin'), Buffer.from('media-data'))
        return join(downloadsDir, job.id, 'source.bin')
      }
    },
    processor: {
      process: async (job) => {
        mkdirSync(join(downloadsDir, job.id), { recursive: true })
        const out = join(downloadsDir, job.id, 'output.mp4')
        writeFileSync(out, Buffer.from('merged-file-content'))
        return { filepath: out, filename: 'output.mp4' }
      }
    },
    onCompleted(job) {
      if (job.filepath && job.filename) {
        assets.set({ id: job.id, delivery: 'file', filename: `${job.id}/${job.filename}`, expiresAt: Date.now() + 86400000 })
      }
    }
  })
  const app = express()
  app.use(express.json())
  app.use('/api/v2', createApiV2Router({
    resolutions,
    assets,
    scheduler,
    store,
    deliveries: {
      direct: createDirectDelivery({ assets }),
      stream: createStreamDelivery({ assets }),
      file: createFileDelivery({ downloadsDir, assets })
    }
  }))
  return app
}

before(async () => {
  const app = makeApp()
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server?.close()
  rmSync(tmpJobs, { force: true })
  rmSync(downloadsDir, { recursive: true, force: true })
})

test('POST /api/v2/resolutions 返回统一结构且不含 assetUrls', async () => {
  const res = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ url: 'https://example.com/v' })
  })
  assert.equal(res.status, 201)
  const body = await res.json()
  assert.equal(body.data.provider, 'fake')
  assert.ok(body.data.assets[0].id.startsWith('as_'))
  assert.ok(!('assetUrls' in body.data))
})

test('无效 URL 返回 422 结构化错误', async () => {
  const res = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ url: 'not-a-url' })
  })
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'VALIDATION_ERROR')
})

test('GET /api/v2/assets/:id/content 返回 302 到媒体地址', async () => {
  const res = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ url: 'https://example.com/v' })
  })
  const body = await res.json()
  const assetId = body.data.assets[0].id
  const assetRes = await fetch(`${base}/api/v2/assets/${assetId}/content`, { redirect: 'manual', headers: { 'X-Client-Id': 'c1' } })
  assert.equal(assetRes.status, 302)
  assert.equal(assetRes.headers.get('location'), 'https://cdn.example.com/v.mp4')
})

test('未知资产返回 ASSET_EXPIRED 错误', async () => {
  const res = await fetch(`${base}/api/v2/assets/as_unknown/content`, { headers: { 'X-Client-Id': 'c1' } })
  const body = await res.json()
  assert.equal(body.error.code, 'ASSET_EXPIRED')
})

test('创建直链任务返回 READY 且不执行下载', async () => {
  const res = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ url: 'https://example.com/v' })
  })
  const body = await res.json()
  const resolutionId = body.data.id
  const directAction = body.data.actions.find((a) => a.type === 'direct')
  const dlRes = await fetch(`${base}/api/v2/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ resolutionId, actionId: directAction.id, mode: 'auto' })
  })
  assert.equal(dlRes.status, 201)
  const dl = await dlRes.json()
  assert.equal(dl.data.status, 'READY')
})

test('不存在的任务返回 JOB_NOT_FOUND', async () => {
  const res = await fetch(`${base}/api/v2/downloads/job_unknown`)
  assert.equal(res.status, 422)
  const body = await res.json()
  assert.equal(body.error.code, 'JOB_NOT_FOUND')
})

test('合并任务执行完成且文件可交付', async () => {
  const res = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ url: 'https://example.com/v' })
  })
  const body = await res.json()
  const resolutionId = body.data.id
  const mergeAction = body.data.actions.find((a) => a.type === 'merge')
  const dlRes = await fetch(`${base}/api/v2/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'c1' },
    body: JSON.stringify({ resolutionId, actionId: mergeAction.id, mode: 'auto' })
  })
  const dl = await dlRes.json()
  const jobId = dl.data.id
  const jobToken = dlRes.headers.get('x-job-token')
  assert.ok(jobToken)
  // 轮询直到 COMPLETED（fake 立即完成）
  let status = ''
  for (let i = 0; i < 20; i++) {
    const poll = await (await fetch(`${base}/api/v2/downloads/${jobId}`, { headers: { 'X-Client-Id': 'c1', 'X-Job-Token': jobToken } })).json()
    status = poll.data.status
    if (status === 'COMPLETED' || status === 'FAILED') break
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(status, 'COMPLETED')
  const fileRes = await fetch(`${base}/api/v2/assets/${jobId}/content`, { headers: { 'X-Client-Id': 'c1', 'X-Job-Token': jobToken } })
  assert.equal(fileRes.status, 200)
  const text = await fileRes.text()
  assert.equal(text, 'merged-file-content')
})

test('匿名任务仅能由持有控制令牌的浏览器查询和操作', async () => {
  const resolutionRes = await fetch(`${base}/api/v2/resolutions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'owner' },
    body: JSON.stringify({ url: 'https://example.com/protected' })
  })
  const resolution = await resolutionRes.json()
  const directAction = resolution.data.actions.find((action) => action.type === 'direct')
  const createRes = await fetch(`${base}/api/v2/downloads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'owner' },
    body: JSON.stringify({ resolutionId: resolution.data.id, actionId: directAction.id, mode: 'auto' })
  })
  assert.equal(createRes.status, 201)
  const created = await createRes.json()
  const token = createRes.headers.get('x-job-token')
  assert.ok(token)

  const untrusted = await fetch(`${base}/api/v2/downloads/${created.data.id}`)
  assert.equal(untrusted.status, 422)

  const trusted = await fetch(`${base}/api/v2/downloads/${created.data.id}`, { headers: { 'X-Job-Token': token } })
  assert.equal(trusted.status, 200)

  const emptyList = await fetch(`${base}/api/v2/downloads`)
  assert.deepEqual((await emptyList.json()).data, [])
  const ownList = await fetch(`${base}/api/v2/downloads`, { headers: { 'X-Job-Tokens': token } })
  const ownJobs = (await ownList.json()).data
  assert.equal(ownJobs.some((job) => job.id === created.data.id), true)
})

test('浏览器捕获上报端点已移除', async () => {
  const res = await fetch(`${base}/api/v2/capture/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceUrl: 'https://example.com/v', mediaUrl: 'https://cdn.example.com/cap.mp4' })
  })
  assert.equal(res.status, 404)
})
