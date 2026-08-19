import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createResolution, createAsset, createAction, createJob } from '../core/contracts.js'

test('createResolution 生成 id 并保留元数据', () => {
  const r = createResolution({ sourceUrl: 'https://example.com/v', title: 'T' })
  assert.ok(r.id.startsWith('res_'))
  assert.equal(r.kind, 'video')
  assert.equal(r.title, 'T')
})

test('createAsset 默认 delivery=redirect', () => {
  const a = createAsset({ kind: 'video', label: '1080p', ext: 'mp4' })
  assert.equal(a.delivery, 'redirect')
  assert.ok(a.id.startsWith('as_'))
})

test('createAction 绑定资产', () => {
  const a = createAction({ label: '最高质量', type: 'direct', assetIds: ['as_1'] })
  assert.deepEqual(a.assetIds, ['as_1'])
  assert.equal(a.requiresProcessing, false)
})

test('createJob 初始状态为 RESOLVING', () => {
  const j = createJob({ clientId: 'c1', resolutionId: 'res_1', sourceUrl: 'https://e.com/v', actionId: 'act_1' })
  assert.equal(j.status, 'RESOLVING')
  assert.equal(j.attempts, 0)
  assert.equal(j.maxAttempts, 3)
})
