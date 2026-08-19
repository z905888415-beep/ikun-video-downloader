import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAssetRegistry } from '../core/asset-registry.js'

function makeRegistry() {
  return createAssetRegistry()
}

test('set 后可按 assetId 取回 url 与请求头', () => {
  const reg = makeRegistry()
  const id = reg.set({ url: 'https://cdn.example.com/v.mp4', headers: { Referer: 'https://e.com' }, expiresAt: Date.now() + 60000 })
  const entry = reg.get(id)
  assert.equal(entry.url, 'https://cdn.example.com/v.mp4')
  assert.equal(entry.headers.Referer, 'https://e.com')
})

test('返回的副本与内部存储隔离', () => {
  const reg = makeRegistry()
  const id = reg.set({ url: 'https://cdn.example.com/v.mp4', headers: { Referer: 'https://e.com' } })
  const entry = reg.get(id)
  entry.headers.Referer = 'https://evil.com'
  entry.url = 'https://evil.com/x.mp4'
  const again = reg.get(id)
  assert.equal(again.url, 'https://cdn.example.com/v.mp4')
  assert.equal(again.headers.Referer, 'https://e.com')
})

test('过期资产不可取回', () => {
  const reg = makeRegistry()
  const id = reg.set({ url: 'https://x.com/v.mp4', expiresAt: Date.now() - 1000 })
  assert.equal(reg.get(id), null)
})

test('sweep 清理过期资产', () => {
  const reg = makeRegistry()
  const id = reg.set({ url: 'https://x.com/v.mp4', expiresAt: Date.now() - 1000 })
  reg.set({ url: 'https://x.com/b.mp4', expiresAt: Date.now() + 60000 })
  const removed = reg.sweep(Date.now())
  assert.equal(removed, 1)
  assert.equal(reg.get(id), null)
})

test('安全校验拒绝私有地址', () => {
  const reg = makeRegistry()
  assert.throws(() => reg.set({ url: 'http://127.0.0.1/x.mp4' }), /私有地址/)
  assert.throws(() => reg.set({ url: 'file:///C:/x.mp4' }), /协议/)
})

test('拒绝 IPv6 回环与云元数据地址', () => {
  const reg = makeRegistry()
  assert.throws(() => reg.set({ url: 'http://[::1]/x.mp4' }), /拒绝 IPv6 字面量地址/)
  assert.throws(() => reg.set({ url: 'http://[::ffff:127.0.0.1]/x.mp4' }), /拒绝 IPv6 字面量地址/)
  assert.throws(() => reg.set({ url: 'http://169.254.169.254/latest/meta-data' }), /禁止私有地址/)
  assert.throws(() => reg.set({ url: 'http://100.100.100.200/x.mp4' }), /禁止私有地址/)
  assert.throws(() => reg.set({ url: 'http://localhost./x.mp4' }), /禁止私有地址/)
})

test('100.64.0.0/10 共享地址段边界', () => {
  const reg = makeRegistry()
  assert.throws(() => reg.set({ url: 'http://100.64.0.0/x.mp4' }), /禁止私有地址/)
  assert.throws(() => reg.set({ url: 'http://100.127.255.255/x.mp4' }), /禁止私有地址/)
  assert.ok(reg.set({ url: 'http://100.63.255.255/x.mp4' }))
  assert.ok(reg.set({ url: 'http://100.128.0.0/x.mp4' }))
})
