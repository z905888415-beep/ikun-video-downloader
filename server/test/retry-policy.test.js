import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRetryPolicy } from '../core/retry-policy.js'

test('可重试错误返回延迟并递增尝试次数', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry({ status: 429 }, 1)
  assert.equal(r.ok, true)
  assert.ok(r.delayMs >= 1000)
})

test('达到最大尝试次数后不再重试', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry({ status: 429 }, 3)
  assert.equal(r.ok, false)
})

test('退避按 1/3/8 秒递增', () => {
  const p = createRetryPolicy({ maxAttempts: 5 })
  assert.equal(p.shouldRetry({ status: 503 }, 1).delayMs, 1000)
  assert.equal(p.shouldRetry({ status: 503 }, 2).delayMs, 3000)
  assert.equal(p.shouldRetry({ status: 503 }, 3).delayMs, 8000)
})

test('不可重试错误直接终止', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry({ code: 'AUTH_REQUIRED' }, 1)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'AUTH_REQUIRED')
})

test('ASSET_EXPIRED 标记需要重新解析', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry({ code: 'ASSET_EXPIRED' }, 1)
  assert.equal(r.ok, true)
  assert.equal(r.refreshResolution, true)
})

test('网络错误可重试', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry({ name: 'TypeError', message: 'fetch failed' }, 1)
  assert.equal(r.ok, true)
})

test('PROVIDER_FAILED 等可重试 code 进入退避重试', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  for (const code of ['PROVIDER_FAILED', 'DOWNLOAD_FAILED', 'RATE_LIMITED']) {
    const r = p.shouldRetry({ code }, 1)
    assert.equal(r.ok, true, `${code} 应可重试`)
    assert.equal(r.delayMs, 1000)
  }
})

test('未知错误终止且 reason 为 UNKNOWN', () => {
  const p = createRetryPolicy({ maxAttempts: 3 })
  const r = p.shouldRetry(new Error('weird'), 1)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'UNKNOWN')
})
