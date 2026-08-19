import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createMediaDownloader } from '../processing/media-downloader.js'
import { createFfmpegProcessor } from '../processing/ffmpeg-processor.js'

test('mediaDownloader 流式写入文件并支持进度回调', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-dl-'))
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { 'Content-Length': '5' } })
  const dl = createMediaDownloader({ fetchImpl })
  const job = { id: 'job_1', workDir: dir }
  const progress = []
  const filepath = await dl.download(job, 'https://cdn.example.com/v.mp4', null, (p) => progress.push(p))
  const buf = readFileSync(filepath)
  assert.deepEqual([...buf], [1, 2, 3, 4, 5])
  assert.ok(progress.length > 0)
  assert.equal(progress.at(-1).percent, 100)
  rmSync(dir, { recursive: true, force: true })
})

test('mediaDownloader fetch 阶段被取消标记不可重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-dl-'))
  const dl = createMediaDownloader({
    fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) }
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => dl.download({ id: 'job_1', workDir: dir }, 'https://cdn.example.com/v.mp4', controller.signal),
    (e) => e.code === 'DOWNLOAD_FAILED' && e.retryable === false
  )
  rmSync(dir, { recursive: true, force: true })
})

test('mediaDownloader 上游失败抛 DOWNLOAD_FAILED 可重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-dl-'))
  const dl = createMediaDownloader({ fetchImpl: async () => new Response('err', { status: 403 }) })
  await assert.rejects(
    () => dl.download({ id: 'job_1', workDir: dir }, 'https://cdn.example.com/v.mp4'),
    (e) => e.code === 'DOWNLOAD_FAILED' && e.retryable === true && e.details.status === 403
  )
  rmSync(dir, { recursive: true, force: true })
})

test('ffmpegProcessor 调用 ffmpeg 合并音视频', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-ff-'))
  const calls = []
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => {
      if (args.includes('output.mp4')) {
        writeFileSync(join(dir, 'output.mp4'), 'fake-mp4')
      }
      child.emit('close', 0)
    })
    return child
  }
  const proc = createFfmpegProcessor({ spawnImpl, binDir: dir })
  const job = {
    id: 'job_1',
    files: { video: join(dir, 'v.mp4'), audio: join(dir, 'a.m4a') },
    workDir: dir,
    actionType: 'merge',
    preferredExt: 'mp4'
  }
  const out = await proc.process(job)
  assert.ok(existsSync(out.filepath))
  assert.equal(calls[0].bin, join(dir, 'ffmpeg.exe'))
  rmSync(dir, { recursive: true, force: true })
})

test('ffmpegProcessor 非零退出码抛 DOWNLOAD_FAILED', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-ff-'))
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('No such file'))
      child.emit('close', 1)
    })
    return child
  }
  const proc = createFfmpegProcessor({ spawnImpl, binDir: dir })
  await assert.rejects(
    () => proc.process({ id: 'job_1', files: { video: 'v.mp4', audio: 'a.m4a' }, workDir: dir, actionType: 'merge', preferredExt: 'mp4' }),
    (e) => e.code === 'DOWNLOAD_FAILED' && e.retryable === true
  )
  rmSync(dir, { recursive: true, force: true })
})

test('ytdlpFallback 调用 yt-dlp 下载', async () => {
  const { createYtdlpFallback } = await import('../processing/ytdlp-fallback.js')
  const dir = mkdtempSync(join(tmpdir(), 'ikun-fb-'))
  const calls = []
  const spawnImpl = (bin, args) => {
    calls.push({ bin, args })
    const child = new EventEmitter()
    process.nextTick(() => {
      writeFileSync(join(dir, 'output.mp4'), 'fake')
      child.emit('close', 0)
    })
    return child
  }
  const fb = createYtdlpFallback({ binDir: dir, spawnImpl })
  const out = await fb.download({ id: 'job_1', workDir: dir, sourceUrl: 'https://example.com/v' })
  assert.equal(calls[0].bin, join(dir, 'yt-dlp.exe'))
  assert.ok(existsSync(out.filepath))
  rmSync(dir, { recursive: true, force: true })
})

test('mediaDownloader 流式中途取消清理半截文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-dl-'))
  const { existsSync: exists, readdirSync } = await import('node:fs')
  const controller = new AbortController()
  const dl = createMediaDownloader({
    fetchImpl: async () => {
      const { Readable } = await import('node:stream')
      return new Response(Readable.from(async function* () {
        yield new Uint8Array(1024)
        await new Promise((r) => setTimeout(r, 20))
        controller.abort()
        throw new Error('aborted by test')
      }()), { status: 200 })
    }
  })
  await assert.rejects(
    () => dl.download({ id: 'job_1', workDir: dir }, 'https://cdn.example.com/v.mp4', controller.signal),
    (e) => e.code === 'DOWNLOAD_FAILED'
  )
  assert.equal(readdirSync(dir).length, 0, '取消后不应残留半截文件')
  rmSync(dir, { recursive: true, force: true })
})

test('ffmpegProcessor 退出码 0 但无输出文件时仍报错', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ikun-ff-'))
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    process.nextTick(() => child.emit('close', 0))
    return child
  }
  const proc = createFfmpegProcessor({ spawnImpl, binDir: dir })
  await assert.rejects(
    () => proc.process({ id: 'job_1', files: { video: 'v.mp4', audio: 'a.m4a' }, workDir: dir, actionType: 'merge', preferredExt: 'mp4' }),
    (e) => e.code === 'DOWNLOAD_FAILED'
  )
  rmSync(dir, { recursive: true, force: true })
})
