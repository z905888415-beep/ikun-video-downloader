import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { createProviderRegistry } from './providers/provider-registry.js'
import { createDouyinProvider } from './providers/douyin-provider.js'
import { createYtdlpProvider } from './providers/ytdlp-provider.js'
import { createTwitterPhotoProvider } from './providers/twitter-photo-provider.js'
import { createResolutionService } from './core/resolution-service.js'
import { createAssetRegistry } from './core/asset-registry.js'
import { createJobStore } from './core/job-store.js'
import { createRetryPolicy } from './core/retry-policy.js'
import { createJobScheduler } from './core/job-scheduler.js'
import { createMediaDownloader } from './processing/media-downloader.js'
import { createFfmpegProcessor } from './processing/ffmpeg-processor.js'
import { createYtdlpFallback } from './processing/ytdlp-fallback.js'
import { createDirectDelivery, createStreamDelivery } from './delivery/direct-delivery.js'
import { createFileDelivery } from './delivery/file-delivery.js'
import { createHlsDelivery } from './delivery/hls-delivery.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = resolve(__dirname, '..')
// 兼容两种目录结构：
//   A. GitHub 仓库布局：<root>/server/compose.js + <root>/resources/bin
//   B. 旧开发布局：<root>/web/server/compose.js + <root>/resources/bin
const BIN_DIR = existsSync(join(resolve(__dirname, '..'), 'resources', 'bin'))
  ? join(resolve(__dirname, '..'), 'resources', 'bin')
  : join(__dirname, '..', '..', 'resources', 'bin')
const DOWNLOADS_DIR = join(WEB_ROOT, 'downloads')
const DATA_DIR = join(WEB_ROOT, 'data')

export function composeApp({ settings = {} } = {}) {
  const registry = createProviderRegistry()
  const assets = createAssetRegistry()
  // 注册抖音专属解析引擎（优先尝试，支持图集/最高画质无水印，失败自动降级到 yt-dlp）
  registry.register(createDouyinProvider({
    cookies: settings.douyinCookies || ''
  }))
  registry.register(createTwitterPhotoProvider())
  registry.register(createYtdlpProvider({
    binDir: BIN_DIR,
    cookiesFile: settings.cookiesFile,
    proxy: settings.proxy,
    retries: settings.retries,
    fragmentConcurrency: settings.fragmentConcurrency,
    customHeaders: settings.customHeaders
  }))
  const resolutions = createResolutionService({ registry, assets })
  const store = createJobStore({ filePath: join(DATA_DIR, 'jobs.json') })
  const retry = createRetryPolicy({ maxAttempts: settings.maxAttempts ?? 3 })

  const mediaDownloader = createMediaDownloader({})
  const processor = {
    async process(job, signal) {
      if (job.actionType === 'extract-audio' || job.actionType === 'merge') {
        const ffmpeg = createFfmpegProcessor({ binDir: BIN_DIR })
        return ffmpeg.process(job, signal)
      }
      return { filepath: job.filepath, filename: job.filename }
    }
  }

  const scheduler = createJobScheduler({
    store,
    retry,
    concurrency: settings.concurrency || 2,
    resolver: resolutions,
    mediaDownloader,
    processor,
    fallback: createYtdlpFallback({ binDir: BIN_DIR }),
    onCompleted(job) {
      if (job.filepath && job.filename) {
        // 注册文件交付资产：assetId = job.id，filename 为相对 downloads 的路径
        assets.set({
          id: job.id,
          delivery: 'file',
          filename: `${job.id}/${job.filename}`,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000
        })
      }
    }
  })

  const deliveries = {
    direct: createDirectDelivery({ assets }),
    stream: createStreamDelivery({ assets }),
    file: createFileDelivery({ downloadsDir: DOWNLOADS_DIR, assets }),
    hls: createHlsDelivery({ assets })
  }

  function applySettings(next) {
    scheduler.setConcurrency(next.concurrency || 2)
    registry.replace('ytdlp', createYtdlpProvider({
      binDir: BIN_DIR,
      cookiesFile: next.cookiesFile,
      proxy: next.proxy,
      retries: next.retries,
      fragmentConcurrency: next.fragmentConcurrency,
      customHeaders: next.customHeaders
    }))
  }

  return { resolutions, assets, store, scheduler, deliveries, registry, applySettings }
}
