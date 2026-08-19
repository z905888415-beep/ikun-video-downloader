import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRedfoxProvider } from '../providers/redfox-provider.js'
import { createYtdlpProvider } from '../providers/ytdlp-provider.js'

function sampleDumpJson() {
  return JSON.stringify({
    id: 'vid1',
    title: '测试视频',
    duration: 120,
    thumbnail: 'https://img.example.com/t.jpg',
    uploader: 'UP',
    webpage_url: 'https://example.com/watch?v=vid1',
    is_live: false,
    formats: [
      { format_id: '137', ext: 'mp4', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', filesize: 1000000, url: 'https://cdn.example.com/137.mp4', protocol: 'https' },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 50000, url: 'https://cdn.example.com/140.m4a', protocol: 'https' },
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 300000, url: 'https://cdn.example.com/18.mp4', protocol: 'https' }
    ]
  })
}

test('RedfoxProvider 识别支持链接', () => {
  const p = createRedfoxProvider({ fetchImpl: () => { throw new Error('not used') } })
  assert.equal(p.canHandle('https://v.douyin.com/abc/'), true)
  assert.equal(p.canHandle('https://www.youtube.com/user/foo'), false)
})

test('RedfoxProvider 把解析结果转为统一 Resolution', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    code: '200',
    data: { awemeType: 'video', platform: 'douyin', title: '标题', videoUrl: 'https://v3-dy.ixigua.com/abc.mp4', imageUrls: [] }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const p = createRedfoxProvider({ fetchImpl, apiKey: 'test-key' })
  const r = await p.resolve('https://v.douyin.com/abc/')
  assert.equal(r.provider, 'redfox')
  assert.equal(r.platform, 'douyin')
  assert.equal(r.title, '标题')
  assert.equal(r.assets.length, 1)
  assert.equal(r.assets[0].delivery, 'redirect')
  assert.equal(r.assets[0].ext, 'mp4')
  assert.equal(r.actions[0].type, 'direct')
})

test('RedfoxProvider 图集转为 images 类型', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    code: '200',
    data: { awemeType: 'photo', platform: 'xiaohongshu', title: '图集', videoUrl: '', imageUrls: ['https://a.com/1.jpg', 'https://a.com/2.jpg'] }
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  const p = createRedfoxProvider({ fetchImpl, apiKey: 'test-key' })
  const r = await p.resolve('https://xhslink.com/x')
  assert.equal(r.kind, 'images')
  assert.equal(r.assets.length, 2)
  assert.equal(r.actions[0].type, 'images-zip')
})

test('RedfoxProvider 网络异常映射为 PROVIDER_FAILED 可重试', async () => {
  const fetchImpl = async () => { throw new Error('connect timeout') }
  const p = createRedfoxProvider({ fetchImpl })
  await assert.rejects(() => p.resolve('https://v.douyin.com/abc/'), (e) => e.code === 'PROVIDER_FAILED' && e.retryable === true)
})

test('RedfoxProvider HTTP 4xx 映射为不可重试', async () => {
  const fetchImpl = async () => new Response('<html>error</html>', { status: 403 })
  const p = createRedfoxProvider({ fetchImpl })
  await assert.rejects(() => p.resolve('https://v.douyin.com/abc/'), (e) => e.code === 'PROVIDER_FAILED' && e.retryable === false)
})

test('RedfoxProvider 空数据与未知类型抛 PROVIDER_FAILED', async () => {
  const empty = createRedfoxProvider({ fetchImpl: async () => new Response(JSON.stringify({ code: '200', data: null }), { status: 200 }) })
  await assert.rejects(() => empty.resolve('https://v.douyin.com/abc/'), (e) => e.code === 'PROVIDER_FAILED')
  const weird = createRedfoxProvider({ fetchImpl: async () => new Response(JSON.stringify({ code: '200', data: { awemeType: 'unknown' } }), { status: 200 }) })
  await assert.rejects(() => weird.resolve('https://v.douyin.com/abc/'), (e) => e.code === 'PROVIDER_FAILED')
})

test('RedfoxProvider 的 assetUrls 与资产一一对应', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    code: '200',
    data: { awemeType: 'video', platform: 'douyin', title: 'T', videoUrl: 'https://v3-dy.ixigua.com/abc.mp4', imageUrls: [] }
  }), { status: 200 })
  const p = createRedfoxProvider({ fetchImpl })
  const r = await p.resolve('https://v.douyin.com/abc/')
  assert.equal(r.assetUrls[r.assets[0].id], 'https://v3-dy.ixigua.com/abc.mp4')
})

test('YtdlpProvider 输出统一 Resolution 与直链动作', async () => {
  const execFileImpl = async () => ({ stdout: sampleDumpJson(), stderr: '' })
  const p = createYtdlpProvider({ execFileImpl, binDir: 'fake-bin' })
  const r = await p.resolve('https://example.com/watch?v=vid1')
  assert.equal(r.provider, 'ytdlp')
  assert.equal(r.title, '测试视频')
  assert.equal(r.kind, 'video')
  assert.equal(r.assets.length, 3)
  const videoAssets = r.assets.filter((a) => a.kind === 'video')
  assert.equal(videoAssets.length, 2)
  const merge = r.actions.find((a) => a.type === 'merge')
  assert.ok(merge, '应生成 merge 动作')
  assert.equal(merge.assetIds.length, 2)
  const [vId, aId] = merge.assetIds
  assert.equal(r.assets.find((a) => a.id === vId)?.kind, 'video')
  assert.equal(r.assets.find((a) => a.id === aId)?.kind, 'audio')
  const mp4 = r.actions.find((a) => a.type === 'direct' && a.label.includes('360'))
  assert.ok(mp4, '应生成 360p 直链动作')
  assert.ok(r.assetUrls[mp4.assetIds[0]], '直链动作的资产应有对应 URL')
})

test('YtdlpProvider 处理分离音视频动作', async () => {
  const execFileImpl = async () => ({ stdout: sampleDumpJson(), stderr: '' })
  const p = createYtdlpProvider({ execFileImpl, binDir: 'fake-bin' })
  const r = await p.resolve('https://www.youtube.com/watch?v=vid1')
  assert.ok(r.actions.some((a) => a.type === 'merge'))
  assert.ok(r.actions.some((a) => a.type === 'extract-audio'))
})

test('YtdlpProvider 解析失败抛出 PROVIDER_FAILED', async () => {
  const execFileImpl = async () => { throw new Error('HTTP Error 403') }
  const p = createYtdlpProvider({ execFileImpl, binDir: 'fake-bin' })
  await assert.rejects(() => p.resolve('https://example.com/v'), (e) => e.code === 'PROVIDER_FAILED')
})

test('YtdlpProvider 登录需求映射为 AUTH_REQUIRED 不可重试', async () => {
  const execFileImpl = async () => { throw Object.assign(new Error('exit 1'), { stderr: 'ERROR: Sign in to confirm you are not a bot' }) }
  const p = createYtdlpProvider({ execFileImpl, binDir: 'fake-bin' })
  await assert.rejects(() => p.resolve('https://example.com/v'), (e) => e.code === 'AUTH_REQUIRED' && e.retryable === false)
})

test('YtdlpProvider 格式选择取最高质量', async () => {
  const dump = JSON.stringify({
    id: 'vid2', title: '选择测试', formats: [
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 1000000, url: 'https://cdn.example.com/137.mp4', protocol: 'https' },
      { format_id: '136', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'none', filesize: 500000, url: 'https://cdn.example.com/136.mp4', protocol: 'https' },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', tbr: 128, filesize: 50000, url: 'https://cdn.example.com/140.m4a', protocol: 'https' },
      { format_id: '139', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', tbr: 48, filesize: 20000, url: 'https://cdn.example.com/139.m4a', protocol: 'https' },
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 300000, url: 'https://cdn.example.com/18.mp4', protocol: 'https' },
      { format_id: '22', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', filesize: 600000, url: 'https://cdn.example.com/22.mp4', protocol: 'https' }
    ]
  })
  const p = createYtdlpProvider({ execFileImpl: async () => ({ stdout: dump, stderr: '' }), binDir: 'fake-bin' })
  const r = await p.resolve('https://example.com/watch?v=vid2')
  const merge = r.actions.find((a) => a.type === 'merge')
  const mergeVideo = r.assets.find((a) => a.id === merge.assetIds[0])
  const mergeAudio = r.assets.find((a) => a.id === merge.assetIds[1])
  assert.equal(mergeVideo.height, 1080, 'merge 应选 1080p 视频')
  assert.equal(mergeAudio.bitrate, 128, 'merge 应选 128k 音频')
  const extract = r.actions.find((a) => a.type === 'extract-audio')
  const extractAsset = r.assets.find((a) => a.id === extract.assetIds[0])
  assert.equal(extractAsset.bitrate, 128, 'extract-audio 也应选 128k 音频')
  const directs = r.actions.filter((a) => a.type === 'direct')
  assert.equal(directs.length, 2, '两个合流格式各生成一个 direct')
})

test('YtdlpProvider 非对象 JSON 抛出 PROVIDER_FAILED', async () => {
  const p = createYtdlpProvider({ execFileImpl: async () => ({ stdout: 'null', stderr: '' }), binDir: 'fake-bin' })
  await assert.rejects(() => p.resolve('https://example.com/v'), (e) => e.code === 'PROVIDER_FAILED')
})

test('YtdlpProvider 丢弃非 http 协议格式', async () => {
  const dump = JSON.stringify({
    id: 'vid3', title: '协议过滤', formats: [
      { format_id: 'x1', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', url: 'blob:https://example.com/xxx', protocol: 'https' },
      { format_id: 'x2', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'mp4a', url: 'https://cdn.example.com/ok.mp4', protocol: 'https' }
    ]
  })
  const p = createYtdlpProvider({ execFileImpl: async () => ({ stdout: dump, stderr: '' }), binDir: 'fake-bin' })
  const r = await p.resolve('https://example.com/v')
  assert.equal(r.assets.length, 1)
  assert.equal(r.assets[0].height, 1080)
})
