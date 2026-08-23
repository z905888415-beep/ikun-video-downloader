import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProviderRegistry } from '../providers/provider-registry.js'
import { createResolutionService, extractUrl, normalizeUrl } from '../core/resolution-service.js'
import { createAssetRegistry } from '../core/asset-registry.js'
import { createResolution, createAsset, createAction } from '../core/contracts.js'

function fakeProvider(id, canHandle) {
  return {
    id,
    canHandle,
    resolve: async (url) => createResolution({
      sourceUrl: url,
      provider: id,
      title: `from-${id}`,
      assets: [createAsset({ kind: 'video', label: 'x', ext: 'mp4' })],
      actions: [createAction({ label: 'x', type: 'direct', assetIds: [] })]
    })
  }
}

test('registry 按 canHandle 顺序选择 provider', async () => {
  const registry = createProviderRegistry()
  registry.register(fakeProvider('a', () => false))
  registry.register(fakeProvider('b', () => true))
  registry.register(fakeProvider('c', () => true))
  const p = registry.pick('https://x.com/v')
  assert.equal(p.id, 'b')
})

test('registry 拒绝不完整 provider', () => {
  const registry = createProviderRegistry()
  assert.throws(() => registry.register({ id: 'bad' }), /Provider 必须实现/)
})

test('resolve 依次尝试 provider，失败则降级', async () => {
  const registry = createProviderRegistry()
  const fail = { id: 'fail', canHandle: () => true, resolve: async () => { throw new Error('boom') } }
  const ok = fakeProvider('ok', () => true)
  registry.register(fail)
  registry.register(ok)
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const r = await svc.resolve('https://x.com/v')
  assert.equal(r.provider, 'ok')
  assert.equal(r.title, 'from-ok')
})

test('降级不尝试 canHandle 为 false 的 provider', async () => {
  const registry = createProviderRegistry()
  const fail = { id: 'fail', canHandle: () => true, resolve: async () => { throw new Error('boom') } }
  const unrelated = { id: 'other', canHandle: () => false, resolve: async () => { throw new Error('不该被调用') } }
  const ok = fakeProvider('ok', () => true)
  registry.register(fail)
  registry.register(unrelated)
  registry.register(ok)
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const r = await svc.resolve('https://x.com/v')
  assert.equal(r.provider, 'ok')
})

test('resolve 结果缓存命中不重复调用 provider', async () => {
  let calls = 0
  const registry = createProviderRegistry()
  registry.register({
    id: 'p1', canHandle: () => true,
    resolve: async (url) => { calls++; return createResolution({ sourceUrl: url, provider: 'p1', title: 't', assets: [createAsset({ kind: 'video', label: 'x', ext: 'mp4' })], actions: [] }) }
  })
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets, cacheTtlMs: 60000 })
  await svc.resolve('https://x.com/v')
  await svc.resolve('https://x.com/v')
  assert.equal(calls, 1)
})

test('assetUrls 写入 AssetRegistry 且不出现在返回的 Resolution 中', async () => {
  const registry = createProviderRegistry()
  const provider = {
    id: 'p1', canHandle: () => true,
    resolve: async (url) => {
      const a = createAsset({ kind: 'video', label: 'x', ext: 'mp4' })
      return createResolution({ sourceUrl: url, provider: 'p1', title: 't', assets: [a], actions: [createAction({ label: 'x', type: 'direct', assetIds: [a.id] })], assetUrls: { [a.id]: 'https://cdn.example.com/v.mp4' } })
    }
  }
  registry.register(provider)
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const r = await svc.resolve('https://x.com/v')
  assert.ok(!Object.hasOwn(r, 'assetUrls'), 'assetUrls 不得出现在公开 Resolution')
  assert.ok(assets.get(r.assets[0].id), '资产 id 应在注册表中')
  const entry = assets.get(r.assets[0].id)
  assert.equal(entry.url, 'https://cdn.example.com/v.mp4')
})

test('actions 的 assetIds 与剥离后的资产 id 一致（不被注册表替换）', async () => {
  const registry = createProviderRegistry()
  const provider = {
    id: 'p1', canHandle: () => true,
    resolve: async (url) => {
      const a = createAsset({ kind: 'video', label: 'x', ext: 'mp4' })
      return createResolution({ sourceUrl: url, provider: 'p1', title: 't', assets: [a], actions: [createAction({ label: 'x', type: 'direct', assetIds: [a.id] })], assetUrls: { [a.id]: 'https://cdn.example.com/v.mp4' } })
    }
  }
  registry.register(provider)
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const r = await svc.resolve('https://x.com/v')
  const actionAssetId = r.actions[0].assetIds[0]
  assert.equal(actionAssetId, r.assets[0].id, 'action 引用的资产 id 必须等于资产自身的 id')
  assert.ok(assets.get(actionAssetId), 'action 引用的 id 必须在注册表中可查询')
})

test('无效 URL 抛出 VALIDATION_ERROR', async () => {
  const registry = createProviderRegistry()
  registry.register(fakeProvider('a', () => true))
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  await assert.rejects(() => svc.resolve('not-a-url'), (e) => e.code === 'VALIDATION_ERROR')
  await assert.rejects(() => svc.resolve('ftp://x.com/v'), (e) => e.code === 'VALIDATION_ERROR')
})

test('没有可用 provider 时抛出 URL_UNSUPPORTED', async () => {
  const registry = createProviderRegistry()
  registry.register(fakeProvider('a', () => false))
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  await assert.rejects(() => svc.resolve('https://x.com/v'), (e) => e.code === 'URL_UNSUPPORTED')
})

test('provider 返回空结果时按 PROVIDER_FAILED 处理', async () => {
  const registry = createProviderRegistry()
  registry.register({
    id: 'empty', canHandle: () => true,
    resolve: async () => createResolution({ sourceUrl: 'https://x.com/v', provider: 'empty', title: 't', assets: [], actions: [] })
  })
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  await assert.rejects(() => svc.resolve('https://x.com/v'), (e) => e.code === 'PROVIDER_FAILED')
})

test('返回的 Resolution 是副本，修改不影响缓存', async () => {
  const registry = createProviderRegistry()
  const provider = {
    id: 'p1', canHandle: () => true,
    resolve: async (url) => {
      const a = createAsset({ kind: 'video', label: 'x', ext: 'mp4' })
      return createResolution({ sourceUrl: url, provider: 'p1', title: 't', assets: [a], actions: [], assetUrls: { [a.id]: 'https://cdn.example.com/v.mp4' } })
    }
  }
  registry.register(provider)
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const first = await svc.resolve('https://x.com/v')
  first.title = 'hacked'
  first.assets[0].label = 'hacked'
  const second = await svc.resolve('https://x.com/v')
  assert.equal(second.title, 't')
  assert.equal(second.assets[0].label, 'x')
})

test('getCached 过期返回 null', async () => {
  const registry = createProviderRegistry()
  registry.register(fakeProvider('a', () => true))
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets, cacheTtlMs: 10 })
  const r = await svc.resolve('https://x.com/v')
  assert.ok(svc.getCached(r.id))
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(svc.getCached(r.id), null)
})

test('资产缺少媒体地址时抛出 PROVIDER_FAILED', async () => {
  const registry = createProviderRegistry()
  registry.register({
    id: 'bad', canHandle: () => true,
    resolve: async (url) => {
      const a = createAsset({ kind: 'video', label: 'x', ext: 'mp4' })
      return createResolution({ sourceUrl: url, provider: 'bad', title: 't', assets: [a], actions: [createAction({ label: 'x', type: 'direct', assetIds: [a.id] })], assetUrls: {} })
    }
  })
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  await assert.rejects(() => svc.resolve('https://x.com/v'), (e) => e.code === 'PROVIDER_FAILED')
})

test('智能提取手机端分享文案中的真实网址 (抖音/小红书/快手/B站/带标点)', async () => {
  // 1. 抖音分享口令
  const douyin = '7.32 e@q.ck 03/29 ... 复制此链接，打开Douyin搜索，直接观看视频！ https://v.douyin.com/iJabcdef/ 精彩内容'
  assert.equal(extractUrl(douyin), 'https://v.douyin.com/iJabcdef/')
  assert.equal(normalizeUrl(douyin), 'https://v.douyin.com/iJabcdef/')

  // 2. 带有中文句号、逗号、括号粘连
  const withPunctuation = '赶紧来看看：【https://www.xiaohongshu.com/explore/64a93821000000001300xxxx?xsec_token=123】。'
  assert.equal(extractUrl(withPunctuation), 'https://www.xiaohongshu.com/explore/64a93821000000001300xxxx?xsec_token=123')
  assert.equal(normalizeUrl(withPunctuation), 'https://www.xiaohongshu.com/explore/64a93821000000001300xxxx?xsec_token=123')

  // 3. 裸域名短链格式
  const bareShortLink = '分享一个好视频 v.douyin.com/xyz123/ 来看'
  assert.equal(extractUrl(bareShortLink), 'https://v.douyin.com/xyz123/')
  assert.equal(normalizeUrl(bareShortLink), 'https://v.douyin.com/xyz123/')

  // 4. 服务端 resolve 直接支持带文案的输入
  const registry = createProviderRegistry()
  registry.register(fakeProvider('ytdlp', () => true))
  const assets = createAssetRegistry()
  const svc = createResolutionService({ registry, assets })
  const r = await svc.resolve(douyin)
  assert.equal(r.provider, 'ytdlp')
})

