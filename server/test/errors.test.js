import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AppError, toErrorResponse, isRetryable } from '../core/errors.js'

test('AppError 携带 code 与 retryable', () => {
  const e = new AppError('ASSET_EXPIRED', '过期', true)
  assert.equal(e.code, 'ASSET_EXPIRED')
  assert.equal(e.retryable, true)
})

test('AppError 省略 retryable 时回退 CODE_MAP', () => {
  const e = new AppError('RATE_LIMITED', '限流')
  assert.equal(e.retryable, true)
})

test('toErrorResponse 输出统一结构', () => {
  const resp = toErrorResponse(new AppError('VALIDATION_ERROR', '无效 URL', false), 'req_1')
  assert.deepEqual(resp.error, { code: 'VALIDATION_ERROR', message: '无效 URL', retryable: false })
  assert.equal(resp.requestId, 'req_1')
})

test('未知错误映射为 INTERNAL_ERROR 且不可重试', () => {
  const resp = toErrorResponse(new Error('boom'), 'req_2')
  assert.equal(resp.error.code, 'INTERNAL_ERROR')
  assert.equal(resp.error.retryable, false)
})

test('isRetryable 对 429/5xx/网络中断返回 true', () => {
  assert.equal(isRetryable({ status: 429 }), true)
  assert.equal(isRetryable({ status: 503 }), true)
  assert.equal(isRetryable({ name: 'TypeError', message: 'fetch failed' }), true)
  assert.equal(isRetryable({ status: 403 }), false)
  assert.equal(isRetryable({ name: 'AppError', code: 'AUTH_REQUIRED' }), false)
})
