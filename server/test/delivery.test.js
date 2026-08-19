import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDirectDelivery, createStreamDelivery } from '../delivery/direct-delivery.js'
import { createAssetRegistry } from '../core/asset-registry.js'

test('direct 302 到注册的媒体地址', async () => {
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/v.mp4' })
  const deliver = createDirectDelivery({ assets })
  const result = await deliver.handle(id)
  assert.equal(result.type, 'redirect')
  assert.equal(result.location, 'https://cdn.example.com/v.mp4')
})

test('过期资产交付返回 ASSET_EXPIRED', async () => {
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/v.mp4', expiresAt: Date.now() - 1000 })
  const deliver = createDirectDelivery({ assets })
  const result = await deliver.handle(id)
  assert.equal(result.type, 'error')
  assert.equal(result.code, 'ASSET_EXPIRED')
})

test('stream 代理透传 Range 与请求头', async () => {
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/v.mp4', headers: { Referer: 'https://e.com' } })
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://cdn.example.com/v.mp4')
    const h = init.headers || {}
    assert.equal(h.Referer, 'https://e.com')
    assert.equal(h.range || h.Range, 'bytes=0-1023', 'Range 头应透传（大小写兼容）')
    return new Response('partial', { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1023/2048' } })
  }
  const deliver = createStreamDelivery({ assets, fetchImpl })
  const result = await deliver.handle(id, { headers: { range: 'bytes=0-1023' } })
  assert.equal(result.type, 'stream')
  assert.equal(result.status, 206)
  assert.equal(result.headers['content-range'], 'bytes 0-1023/2048')
})

test('stream 上游失败返回 DOWNLOAD_FAILED', async () => {
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/v.mp4' })
  const deliver = createStreamDelivery({ assets, fetchImpl: async () => { throw new Error('boom') } })
  const result = await deliver.handle(id)
  assert.equal(result.type, 'error')
  assert.equal(result.code, 'DOWNLOAD_FAILED')
})

test('hls 播放列表被重写为站内代理地址且保留标签', async () => {
  const { createHlsDelivery } = await import('../delivery/hls-delivery.js')
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/master.m3u8' })
  const fetchImpl = async () => new Response('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:5,\nseg1.ts\n#EXTINF:5,\nseg2.ts\n', { status: 200 })
  const hls = createHlsDelivery({ assets, fetchImpl })
  const result = await hls.handle(id)
  assert.equal(result.type, 'text')
  assert.ok(result.body.startsWith('#EXTM3U'), '必须保留 #EXTM3U')
  assert.ok(result.body.includes('#EXT-X-VERSION:3'), '必须保留版本标签')
  assert.ok(result.body.includes('#EXTINF:5,'), '必须保留时长标签')
  assert.ok(result.body.includes('/api/v2/hls-proxy?url='), '分片必须重写为代理地址')
  assert.ok(result.body.includes('seg1.ts'), '分片文件名必须在代理 URL 中')
})

test('rewritePlaylist 保留标签并重写 URI 行', async () => {
  const { rewritePlaylist } = await import('../delivery/hls-delivery.js')
  const out = rewritePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nvar1.m3u8\n#EXTINF:5,\nseg1.ts\n', 'https://cdn.example.com/master.m3u8')
  assert.ok(out.startsWith('#EXTM3U'))
  assert.ok(out.includes('#EXT-X-STREAM-INF:BANDWIDTH=1280000'))
  assert.ok(out.includes('/api/v2/hls-proxy?url=https%3A%2F%2Fcdn.example.com%2Fvar1.m3u8'))
  assert.ok(out.includes('seg1.ts'))
})

test('hls 非播放列表返回 UNSUPPORTED_DRM', async () => {
  const { createHlsDelivery } = await import('../delivery/hls-delivery.js')
  const assets = createAssetRegistry()
  const id = assets.set({ url: 'https://cdn.example.com/x.m3u8' })
  const hls = createHlsDelivery({ assets, fetchImpl: async () => new Response('not a playlist', { status: 200 }) })
  const result = await hls.handle(id)
  assert.equal(result.type, 'error')
  assert.equal(result.code, 'UNSUPPORTED_DRM')
})
