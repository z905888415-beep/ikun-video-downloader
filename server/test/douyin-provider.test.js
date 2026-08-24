import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDouyinProvider, extractAwemeId } from '../providers/douyin-provider.js'

test('extractAwemeId 正确从不同格式的抖音 URL 中提取作品 ID', () => {
  assert.equal(extractAwemeId('https://www.douyin.com/video/7408712345678901234'), '7408712345678901234')
  assert.equal(extractAwemeId('https://www.douyin.com/note/7408712345678901234'), '7408712345678901234')
  assert.equal(extractAwemeId('https://www.douyin.com/discover?modal_id=7408712345678901234'), '7408712345678901234')
  assert.equal(extractAwemeId('https://www.iesdouyin.com/share/video/7408712345678901234/'), '7408712345678901234')
})

test('createDouyinProvider canHandle 仅匹配抖音域名', () => {
  const p = createDouyinProvider()
  assert.equal(p.canHandle('https://v.douyin.com/iJabcdef/'), true)
  assert.equal(p.canHandle('https://www.douyin.com/video/7408712345678901234'), true)
  assert.equal(p.canHandle('https://www.iesdouyin.com/share/video/7408712345678901234'), true)
  assert.equal(p.canHandle('https://www.bilibili.com/video/BV1xx411c7mD'), false)
  assert.equal(p.canHandle('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), false)
})

test('DouyinProvider 成功解析无水印单视频并提取原声', async () => {
  const fakeDetail = {
    aweme_id: '7408712345678901234',
    desc: '超燃跑车声浪视频 #超跑',
    duration: 15000,
    video: {
      width: 1080,
      height: 1920,
      cover: { url_list: ['https://p3.douyinpic.com/cover.jpg'] },
      bit_rate: [
        { bit_rate: 1500000, play_addr: { url_list: ['https://aweme.snssdk.com/playwm/v1.mp4'] } },
        { bit_rate: 3200000, play_addr: { url_list: ['https://aweme.snssdk.com/playwm/v2_high.mp4'] } }
      ]
    },
    music: {
      title: '原声 - 超跑俱乐部',
      play_url: { url_list: ['https://sf3-cdn-tos.douyinstatic.com/music.mp3'] }
    }
  }

  const mockFetch = async (url) => {
    return {
      ok: true,
      json: async () => ({ aweme_detail: fakeDetail })
    }
  }

  const provider = createDouyinProvider({ fetchImpl: mockFetch })
  const res = await provider.resolve('https://www.douyin.com/video/7408712345678901234')

  assert.equal(res.provider, 'douyin')
  assert.equal(res.platform, '抖音')
  assert.equal(res.title, '超燃跑车声浪视频 #超跑')
  assert.equal(res.kind, 'video')
  assert.equal(res.thumbnail, 'https://p3.douyinpic.com/cover.jpg')
  assert.equal(res.duration, 15)

  // 验证视频资产：最高比特率 + 无水印 (playwm -> play)
  const videoAsset = res.assets.find((a) => a.kind === 'video')
  assert.ok(videoAsset)
  assert.equal(res.assetUrls[videoAsset.id], 'https://aweme.snssdk.com/play/v2_high.mp4')

  // 验证音频资产
  const audioAsset = res.assets.find((a) => a.kind === 'audio')
  assert.ok(audioAsset)
  assert.equal(res.assetUrls[audioAsset.id], 'https://sf3-cdn-tos.douyinstatic.com/music.mp3')

  // 验证动作
  assert.ok(res.actions.some((a) => a.type === 'direct' && a.label.includes('无水印')))
  assert.ok(res.actions.some((a) => a.type === 'direct' && a.label.includes('音频')))
})

test('DouyinProvider 成功解析高清图集作品并生成打包动作', async () => {
  const fakeGalleryDetail = {
    aweme_id: '7408712345678901234',
    desc: '今日穿搭分享 4P',
    images: [
      { width: 1080, height: 1440, url_list: ['https://p3.douyinpic.com/img1.jpg'] },
      { width: 1080, height: 1440, url_list: ['https://p3.douyinpic.com/img2.jpg'] },
      { width: 1080, height: 1440, url_list: ['https://p3.douyinpic.com/img3.jpg'] }
    ],
    music: {
      title: '轻快背景音',
      play_url: { url_list: ['https://sf3-cdn-tos.douyinstatic.com/bgm.mp3'] }
    }
  }

  const mockFetch = async () => ({
    ok: true,
    json: async () => ({ aweme_detail: fakeGalleryDetail })
  })

  const provider = createDouyinProvider({ fetchImpl: mockFetch })
  const res = await provider.resolve('https://www.douyin.com/note/7408712345678901234')

  assert.equal(res.kind, 'gallery')
  assert.equal(res.assets.filter((a) => a.kind === 'image').length, 3)

  const zipAction = res.actions.find((a) => a.type === 'images-zip')
  assert.ok(zipAction)
  assert.equal(zipAction.assetIds.length, 3)
  assert.equal(zipAction.label, '打包下载全部图片 (3 张)')
})

test('短链 (v.douyin.com) 自动追踪重定向并解析', async () => {
  const fakeDetail = {
    aweme_id: '7408712345678901234',
    desc: '短链视频',
    video: {
      play_addr: { url_list: ['https://aweme.snssdk.com/play/v.mp4'] }
    }
  }

  const mockFetch = async (url) => {
    if (url.includes('v.douyin.com')) {
      return {
        ok: true,
        url: 'https://www.douyin.com/video/7408712345678901234'
      }
    }
    return {
      ok: true,
      json: async () => ({ aweme_detail: fakeDetail })
    }
  }

  const provider = createDouyinProvider({ fetchImpl: mockFetch })
  const res = await provider.resolve('https://v.douyin.com/iJabcdef/')
  assert.equal(res.title, '短链视频')
})
