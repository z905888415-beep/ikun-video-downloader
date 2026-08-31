import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTwitterPhotoProvider, extractTwitterStatusId } from '../providers/twitter-photo-provider.js'

test('extractTwitterStatusId 识别 x.com / twitter.com 帖子', () => {
  assert.equal(
    extractTwitterStatusId('https://x.com/cartidise/status/2094019607137051106?s=46'),
    '2094019607137051106'
  )
  assert.equal(
    extractTwitterStatusId('https://twitter.com/Cartidise/status/2094019607137051106/photo/1'),
    '2094019607137051106'
  )
  assert.equal(extractTwitterStatusId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), '')
})

test('TwitterPhotoProvider 将纯图帖解析为图集打包动作', async () => {
  const provider = createTwitterPhotoProvider({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        tweet: {
          text: 'macOS dynamic island with Liquid Glass',
          author: { screen_name: 'Cartidise' },
          media: {
            photos: [
              { type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg?name=small', width: 100, height: 80 },
              { type: 'photo', url: 'https://pbs.twimg.com/media/b.jpg?name=small', width: 200, height: 160 }
            ]
          }
        }
      })
    })
  })
  const res = await provider.resolve('https://x.com/cartidise/status/2094019607137051106')
  assert.equal(res.kind, 'images')
  assert.equal(res.platform, 'Twitter')
  assert.equal(res.assets.length, 2)
  assert.equal(res.actions[0].type, 'images-zip')
  assert.equal(res.assetUrls[res.assets[0].id], 'https://pbs.twimg.com/media/a.jpg?name=orig')
})

test('TwitterPhotoProvider 含视频时跳过，交给 yt-dlp', async () => {
  const provider = createTwitterPhotoProvider({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tweet: { media: { videos: [{ type: 'video', url: 'https://video.twimg.com/a.mp4' }], photos: [] } }
      })
    })
  })
  await assert.rejects(
    () => provider.resolve('https://x.com/user/status/1234567890'),
    (error) => error.code === 'PROVIDER_SKIP'
  )
})
