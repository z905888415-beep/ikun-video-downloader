import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createYtdlpProvider } from '../providers/ytdlp-provider.js'

function sampleDumpJson() {
  return JSON.stringify({
    id: 'vid1',
    title: '测试视频',
    duration: 120,
    thumbnail: 'https://img.example.com/t.jpg',
    formats: [
      { format_id: '137', ext: 'mp4', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', filesize: 1000000, url: 'https://cdn.example.com/137.mp4', protocol: 'https' },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 50000, url: 'https://cdn.example.com/140.m4a', protocol: 'https' },
      { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a', filesize: 300000, url: 'https://cdn.example.com/18.mp4', protocol: 'https' }
    ]
  })
}

test('YtdlpProvider 输出统一 Resolution 与直链动作', async () => {
  const p = createYtdlpProvider({ execFileImpl: async () => ({ stdout: sampleDumpJson(), stderr: '' }), binDir: 'fake-bin' })
  const resolution = await p.resolve('https://example.com/watch?v=vid1')

  assert.equal(resolution.provider, 'ytdlp')
  assert.equal(resolution.title, '测试视频')
  assert.equal(resolution.kind, 'video')
  assert.equal(resolution.assets.length, 3)
  assert.ok(resolution.actions.some((action) => action.type === 'merge'))
  assert.ok(resolution.actions.some((action) => action.type === 'extract-audio'))
  assert.ok(resolution.actions.some((action) => action.type === 'direct' && action.label.includes('360')))
})

test('YtdlpProvider 将网络配置映射为 yt-dlp 参数', async () => {
  let capturedArgs = []
  const provider = createYtdlpProvider({
    binDir: 'fake-bin',
    retries: 7,
    fragmentConcurrency: 3,
    proxy: 'http://127.0.0.1:7890',
    customHeaders: 'Referer: https://example.com\nX-Test: enabled',
    execFileImpl: async (_bin, args) => {
      capturedArgs = args
      return { stdout: sampleDumpJson(), stderr: '' }
    }
  })

  await provider.resolve('https://example.com/video')
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--retries'), capturedArgs.indexOf('--retries') + 2), ['--retries', '7'])
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--fragment-retries'), capturedArgs.indexOf('--fragment-retries') + 2), ['--fragment-retries', '7'])
  assert.deepEqual(capturedArgs.slice(capturedArgs.indexOf('--concurrent-fragments'), capturedArgs.indexOf('--concurrent-fragments') + 2), ['--concurrent-fragments', '3'])
  assert.ok(capturedArgs.includes('http://127.0.0.1:7890'))
  assert.ok(capturedArgs.includes('Referer:https://example.com'))
  assert.ok(capturedArgs.includes('X-Test:enabled'))
})

test('YtdlpProvider 将 Cookie 需求映射为不可重试错误', async () => {
  const provider = createYtdlpProvider({
    execFileImpl: async () => { throw Object.assign(new Error('exit 1'), { stderr: 'ERROR: Fresh cookies needed' }) },
    binDir: 'fake-bin'
  })
  await assert.rejects(() => provider.resolve('https://example.com/video'), (error) => error.code === 'AUTH_REQUIRED' && error.retryable === false)
})

test('YtdlpProvider 丢弃非 HTTP 媒体地址', async () => {
  const dump = JSON.stringify({
    id: 'vid3', title: '协议过滤', formats: [
      { format_id: 'x1', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a', url: 'blob:https://example.com/xxx', protocol: 'https' },
      { format_id: 'x2', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'mp4a', url: 'https://cdn.example.com/ok.mp4', protocol: 'https' }
    ]
  })
  const provider = createYtdlpProvider({ execFileImpl: async () => ({ stdout: dump, stderr: '' }), binDir: 'fake-bin' })
  const resolution = await provider.resolve('https://example.com/video')
  assert.equal(resolution.assets.length, 1)
  assert.equal(resolution.assets[0].height, 1080)
})
