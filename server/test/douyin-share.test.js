import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDouyinProvider } from '../providers/douyin-provider.js'

function sharePageHtml(item) {
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: { 'video_7686493849836965120/page': { videoInfoRes: { item_list: [item] } } }
  })};</script></html>`
}

function sampleItem() {
  return {
    desc: '测试分享页解析',
    duration: 15000,
    video: {
      width: 1080,
      height: 1920,
      play_addr: { url_list: ['https://aweme.snssdk.com/aweme/v1/playwm/?video_id=v0d00fg10000'] }
    },
    music: { title: '测试原声', play_url: { url_list: ['https://sf3.douyinstatic.com/music.mp3'] } }
  }
}

function mockFetch(handlers) {
  return async (url) => {
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url)) return handler(url)
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
  }
}

test('DouyinProvider 走分享页 _ROUTER_DATA 解析出无水印直链', async () => {
  const fetchImpl = mockFetch([
    [/ttwid\.bytedance\.com/, async () => ({
      ok: true,
      json: async () => ({ redirect_url: 'https://www.ixigua.com/ttwid/union/register/callback/?ticket=x' })
    })],
    [/ixigua\.com|douyin\.com\/ttwid/, async () => ({
      ok: true,
      headers: { getSetCookie: () => ['ttwid=test-ttwid-value; Path=/; Domain=.douyin.com'] , get: () => ''},
      json: async () => ({}),
      text: async () => ''
    })],
    [/iesdouyin\.com\/share\//, async () => ({
      ok: true,
      text: async () => sharePageHtml(sampleItem())
    })]
  ])

  const provider = createDouyinProvider({ fetchImpl })
  const res = await provider.resolve('https://www.douyin.com/video/7686493849836965120')
  assert.equal(res.platform, '抖音')
  assert.equal(res.title, '测试分享页解析')
  const direct = res.actions.find((a) => a.type === 'direct')
  assert.ok(direct && direct.label.includes('无水印'))
  const videoAsset = res.assets[0]
  assert.equal(res.assetUrls[videoAsset.id], 'https://aweme.snssdk.com/aweme/v1/play/?video_id=v0d00fg10000')
  assert.ok(res.actions.some((a) => a.type === 'direct' && a.preferredExt === 'mp3'))
})

test('DouyinProvider 分享页失败时降级官方 detail 接口', async () => {
  const fetchImpl = mockFetch([
    [/ttwid\.bytedance\.com|ixigua\.com|douyin\.com\/ttwid/, async () => ({ ok: false, status: 503, json: async () => ({}), headers: { get: () => '' } })],
    [/iesdouyin\.com\/share\//, async () => ({ ok: false, status: 404, text: async () => '' })],
    [/aweme\/v1\/web\/aweme\/detail\//, async () => ({
      ok: true,
      json: async () => ({ aweme_detail: sampleItem() })
    })]
  ])

  const provider = createDouyinProvider({ fetchImpl })
  const res = await provider.resolve('https://www.douyin.com/video/7686493849836965120')
  assert.equal(res.title, '测试分享页解析')
  assert.ok(res.actions.some((a) => a.type === 'direct'))
})
