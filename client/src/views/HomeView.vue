<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'
import { downloadHls } from '../lib/hls-download'
import { downloadImagesAsZip } from '../lib/images-zip'
import { apiV2 } from '../api/client'

const store = useAppStore()

const hlsBusy = ref(false)
const zipBusy = ref(false)

const activeDownload = ref<{
  label: string
  kind: 'direct' | 'task' | 'hls' | 'zip'
  percent: number
  status: string
  actionId: string
  jobId?: string
  filename?: string
} | null>(null)

const STATUS_TEXT: Record<string, string> = {
  RESOLVING: '解析中', READY: '准备下载', QUEUED: '排队中', DOWNLOADING: '下载中',
  PROCESSING: '处理中', RETRY_WAIT: '等待重试', COMPLETED: '已完成', FAILED: '失败',
  CANCELLED: '已取消', EXPIRED: '已过期'
}

function statusText(dl: { kind: string; status: string; percent: number }): string {
  if (dl.status === 'done') return '完成'
  if (dl.status === 'error') return '失败'
  if (dl.status === 'downloading') return `下载中 ${dl.percent}%`
  if (dl.status === 'queued') return '排队中'
  return STATUS_TEXT[dl.status] || dl.status
}

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30000)
}

async function runHlsDownload(action: { id: string; assetIds: string[]; label: string }): Promise<void> {
  hlsBusy.value = true
  activeDownload.value = { label: action.label, kind: 'hls', percent: 0, status: 'downloading', actionId: action.id }
  try {
    const assetId = action.assetIds[0]
    const url = apiV2.assetContentUrl(assetId)
    const blob = await downloadHls(url, (p) => {
      if (activeDownload.value?.kind === 'hls') activeDownload.value.percent = p
    })
    saveBlob(blob, 'video.mp4')
    if (activeDownload.value?.kind === 'hls') { activeDownload.value.percent = 100; activeDownload.value.status = 'done' }
    store.setNotice('HLS 下载完成')
  } catch (e) {
    if (activeDownload.value?.kind === 'hls') activeDownload.value.status = 'error'
    store.setNotice(e instanceof Error ? `HLS 下载失败：${e.message}` : 'HLS 下载失败')
  } finally {
    hlsBusy.value = false
  }
}

async function runImagesZip(action: { id: string; assetIds: string[]; label: string }): Promise<void> {
  zipBusy.value = true
  activeDownload.value = { label: action.label, kind: 'zip', percent: 0, status: 'downloading', actionId: action.id }
  try {
    const urls = action.assetIds.map((id) => apiV2.assetContentUrl(id))
    const blob = await downloadImagesAsZip(urls, (p) => {
      if (activeDownload.value?.kind === 'zip') activeDownload.value.percent = p
    })
    saveBlob(blob, 'images.zip')
    if (activeDownload.value?.kind === 'zip') { activeDownload.value.percent = 100; activeDownload.value.status = 'done' }
    store.setNotice('图片打包完成')
  } catch (e) {
    if (activeDownload.value?.kind === 'zip') activeDownload.value.status = 'error'
    store.setNotice(e instanceof Error ? `打包失败：${e.message}` : '打包失败')
  } finally {
    zipBusy.value = false
  }
}

function handleAction(a: { id: string; type: string; assetIds: string[]; label: string; requiresProcessing: boolean }): void {
  if (a.type === 'hls') {
    void runHlsDownload(a)
  } else if (a.type === 'images-zip') {
    void runImagesZip(a)
  } else if (a.requiresProcessing) {
    void startTaskDownload(a)
  } else {
    void startDirectDownload(a)
  }
}

async function startDirectDownload(a: { id: string; type: string; assetIds: string[]; label: string }): Promise<void> {
  const filename = safeFilename(store.v2Resolution?.title || 'video', a)
  activeDownload.value = { label: a.label, kind: 'direct', percent: 0, status: 'downloading', filename, actionId: a.id }
  try {
    await store.downloadAsset(a.assetIds[0], filename, (p) => {
      if (activeDownload.value?.kind === 'direct') activeDownload.value.percent = p
    })
    if (activeDownload.value?.kind === 'direct') {
      activeDownload.value.percent = 100
      activeDownload.value.status = 'done'
    }
    store.setNotice('下载完成')
  } catch (e) {
    if (activeDownload.value?.kind === 'direct') activeDownload.value.status = 'error'
    store.setNotice(e instanceof Error ? `下载失败：${e.message}` : '下载失败')
  }
}

async function startTaskDownload(a: { id: string; type: string; assetIds: string[]; label: string }): Promise<void> {
  const job = await store.enqueueV2Action(a.id)
  if (!job) return
  activeDownload.value = { label: a.label, kind: 'task', percent: 0, status: 'queued', jobId: job.id, filename: job.filename, actionId: a.id }
}

function retryActive(): void {
  const dl = activeDownload.value
  if (!dl) return
  const action = store.v2Resolution?.actions.find((a) => a.id === dl.actionId)
  if (!action) {
    store.setNotice('动作已失效，请重新解析')
    return
  }
  if (dl.kind === 'task') {
    if (dl.jobId) void store.retryV2Job(dl.jobId)
  } else if (dl.kind === 'direct') {
    void startDirectDownload(action)
  } else if (dl.kind === 'hls') {
    void runHlsDownload(action)
  } else if (dl.kind === 'zip') {
    void runImagesZip(action)
  }
}

watch(() => store.v2Resolution, () => {
  activeDownload.value = null
})

watch(() => store.v2Jobs, (jobs) => {
  const dl = activeDownload.value
  if (!dl || dl.kind !== 'task' || !dl.jobId) return
  const job = jobs.find((j) => j.id === dl.jobId)
  if (!job) return
  const prevStatus = dl.status
  dl.percent = job.percent
  dl.filename = job.filename
  if (job.status === 'COMPLETED' && prevStatus !== 'done') {
    dl.percent = 100
    dl.status = 'done'
    store.setNotice('下载完成')
  } else if ((job.status === 'FAILED' || job.status === 'CANCELLED') && prevStatus !== 'error') {
    dl.status = 'error'
  } else {
    dl.status = job.status
  }
})

const SITES = [
  'YouTube',
  'Bilibili',
  '抖音',
  '快手',
  '小红书',
  '西瓜视频',
  'Twitter / X',
  'TikTok',
  'Instagram',
  '微信视频号',
  'Threads',
  'Facebook',
  'Twitch',
  'Vimeo',
  '微博'
]

function onEnter(e: KeyboardEvent): void {
  if (e.key === 'Enter') void store.doResolveV2()
}

function safeFilename(title: string, action: { preferredExt?: string; assetIds: string[] }): string {
  const base = (title || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || 'video'
  const asset = store.v2Resolution?.assets.find((x) => x.id === action.assetIds[0])
  const ext = action.preferredExt || asset?.ext || 'mp4'
  return `${base}.${ext}`
}

function fmtDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
</script>

<template>
  <div class="home-view">
    <!-- Hero -->
    <section class="hero">
      <h1 class="hero-title">全网视频，<span class="hero-grad">一触即取</span></h1>
      <p class="hero-sub">粘贴链接，解析画质，高速下载。电脑与手机浏览器均可使用。</p>

      <!-- 解析输入 -->
      <div class="beam" :class="{ probing: store.v2Probing }">
        <div class="beam-inner">
          <Icon class="beam-icon" name="link" :size="18" />
          <input
            v-model="store.url"
            class="beam-input"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="粘贴视频链接，回车解析…"
            @keydown="onEnter"
          />
          <button class="btn btn-ghost btn-sm beam-paste" type="button" @click="store.pasteFromClipboard()">
            <Icon name="clipboard" :size="13" />
            粘贴
          </button>
          <button
            class="btn btn-primary beam-go"
            type="button"
            :disabled="store.v2Probing || !store.url.trim()"
            @click="store.doResolveV2()"
          >
            <span v-if="store.v2Probing" class="spinner" />
            {{ store.v2Probing ? '解析中' : '解析' }}
          </button>
        </div>
      </div>

      <p v-if="store.urlError" class="beam-error">
        <Icon name="alert" :size="14" />
        {{ store.urlError }}
      </p>

      <!-- 支持站点 -->
      <div class="sites-row">
        <span class="sites-label">支持站点</span>
        <span v-for="s in SITES" :key="s" class="site-chip">{{ s }}</span>
        <span class="site-chip more">等 1800+</span>
      </div>

      <p v-if="store.binary && !store.binary.ytdlpOk" class="alert" style="margin-top: 18px">
        <Icon name="alert" :size="17" />
        <span>
          <strong>未检测到 yt-dlp</strong>
          <p>请确认项目 resources/bin 下存在 yt-dlp，并重新启动 web 服务。</p>
        </span>
      </p>
    </section>

    <!-- 解析失败 -->
    <div v-if="store.v2Error" class="card card-pad state-card rise-in">
      <div class="empty-orb"><Icon name="alert" :size="24" /></div>
      <div class="empty-title">解析失败</div>
      <div class="empty-desc">{{ store.v2Error }}</div>
      <div class="state-actions">
        <button class="btn btn-ghost btn-sm" type="button" @click="store.doResolveV2()">
          <Icon name="refresh" :size="13" />
          重试
        </button>
        <button class="btn btn-ghost btn-sm" type="button" @click="store.page = 'settings'">
          <Icon name="sliders" :size="13" />
          检查设置
        </button>
      </div>
    </div>

    <!-- 解析中 -->
    <div v-else-if="store.v2Probing" class="card card-pad state-card rise-in">
      <div class="empty-orb"><Icon name="sparkles" :size="24" /></div>
      <div class="empty-title">正在解析视频信息</div>
      <div class="empty-desc">调用本地解析器获取标题、时长与可用媒体</div>
      <div class="loading-track"><i /></div>
    </div>

    <!-- 解析结果 -->
    <div v-else-if="store.v2Resolution" class="card result-card rise-in">
      <div class="result-grid">
        <div class="thumb-frame">
          <img v-if="store.v2Resolution.thumbnail" :src="store.v2Resolution.thumbnail" :alt="store.v2Resolution.title" />
          <div v-else class="thumb-fallback">
            <Icon name="play" :size="32" />
          </div>
          <span v-if="store.v2Resolution.duration" class="thumb-duration">{{ fmtDuration(store.v2Resolution.duration) }}</span>
        </div>
        <div class="result-info">
          <h2 class="result-title">{{ store.v2Resolution.title }}</h2>
          <div class="meta-row">
            <span class="chip">{{ store.v2Resolution.platform || store.v2Resolution.provider }}</span>
          </div>
          <div class="format-block">
            <div class="format-head"><span>下载</span></div>
            <div class="preset-pills">
              <button
                v-for="a in store.v2Resolution.actions"
                :key="a.id"
                class="preset-pill"
                type="button"
                :disabled="(a.type === 'hls' && hlsBusy) || (a.type === 'images-zip' && zipBusy)"
                @click="handleAction(a)"
              >
                {{ a.label }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="card card-pad state-card">
      <div class="empty-orb"><Icon name="play" :size="24" /></div>
      <div class="empty-title">等待解析</div>
      <div class="empty-desc">粘贴视频链接后回车，将显示标题、时长、缩略图与可选画质</div>
    </div>

    <!-- 下载进度 -->
    <div v-if="activeDownload" class="card card-pad dl-progress rise-in">
      <div class="dl-head">
        <strong>{{ activeDownload.label }}</strong>
        <span class="dl-status">{{ statusText(activeDownload) }}</span>
      </div>
      <div class="pbar"><i :style="{ width: `${activeDownload.percent}%` }" /></div>
      <div class="dl-foot">
        <span v-if="activeDownload.kind === 'task' && activeDownload.status !== 'done' && activeDownload.status !== 'error'">
          任务 {{ activeDownload.percent }}%
        </span>
        <span v-else-if="activeDownload.status === 'done'">
          <template v-if="activeDownload.kind === 'task'">
            处理完成 · 点击「保存文件」下载到本地
          </template>
          <template v-else>
            已保存到浏览器下载目录
          </template>
        </span>
        <span v-else-if="activeDownload.status === 'error'">下载失败，请重试</span>
        <span v-else>{{ activeDownload.percent }}%</span>
        <button v-if="activeDownload.status === 'error'" class="btn btn-ghost btn-sm" type="button" @click="retryActive()">
          <Icon name="refresh" :size="13" />重试
        </button>
        <a
          v-if="activeDownload.kind === 'task' && activeDownload.status === 'done' && activeDownload.jobId"
          class="btn btn-primary btn-sm"
          :href="apiV2.fileUrl(activeDownload.jobId)"
          download
        >
          <Icon name="download" :size="13" />保存文件
        </a>
      </div>
    </div>

  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- Hero ---------- */
.hero {
  padding: clamp(20px, 4vw, 40px) 0 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.hero-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(28px, 5vw, 42px);
  font-weight: 720;
  line-height: 1.12;
  letter-spacing: -0.035em;
}

/* 高亮 · Apple Intelligence 渐变 */
.hero-grad {
  background: linear-gradient(96deg, #0a84ff 12%, #5e5ce6 58%, #bf5af2 96%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}

.hero-sub {
  margin: 10px 0 24px;
  color: var(--text-2);
  font-size: 14px;
}

.beam-error {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 10px 0 0;
  color: var(--danger);
  font-size: 12px;
  font-weight: 500;
}

/* ---------- 解析输入 · 聚光搜索框 ---------- */
.beam {
  width: min(680px, 100%);
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 8px 24px rgba(0, 0, 0, 0.05);
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}

.beam:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3.5px var(--accent-glow), 0 8px 28px rgba(0, 0, 0, 0.07);
}

.beam.probing {
  border-color: var(--accent);
}

.beam-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 16px;
}

.beam-icon {
  color: var(--text-3);
  flex-shrink: 0;
}

.beam-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 15px;
  padding: 8px 0;
}

.beam-input::placeholder {
  color: var(--text-3);
}

.beam-paste {
  flex-shrink: 0;
}

.beam-go {
  flex-shrink: 0;
  min-width: 92px;
  border-radius: var(--r-full);
}

/* ---------- 支持站点 ---------- */
.sites-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 18px;
}

.sites-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  margin-right: 2px;
}

.site-chip {
  padding: 2px 9px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
}

.site-chip.more {
  color: var(--text-3);
  background: none;
}

/* ---------- 状态卡 ---------- */
.state-card {
  text-align: center;
  align-items: center;
  display: flex;
  flex-direction: column;
}

.state-actions {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.loading-track {
  margin-top: 18px;
  width: 200px;
  height: 3px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
}

.loading-track i {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: inherit;
  background: var(--accent);
  animation: loading-slide 1.15s ease-in-out infinite;
}

@keyframes loading-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(260%); }
}

/* ---------- 结果卡 ---------- */
.result-card {
  overflow: hidden;
}

.result-grid {
  display: grid;
  grid-template-columns: minmax(0, 42%) minmax(0, 58%);
}

.thumb-frame {
  position: relative;
  min-height: 100%;
  background: var(--surface-2);
}

.thumb-frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  position: absolute;
  inset: 0;
}

.thumb-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
  background: var(--surface-2);
}

.thumb-duration {
  position: absolute;
  right: 10px;
  bottom: 10px;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: rgba(24, 24, 27, 0.82);
  color: #fff;
  font-size: 11.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.result-info {
  padding: clamp(18px, 3vw, 26px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}

.result-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(16px, 2.2vw, 19px);
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* ---------- 画质选择 ---------- */
.format-block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.format-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-2);
}

.preset-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.preset-pill {
  padding: 6px 13px;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 500;
  transition: all 0.15s;
}

.preset-pill:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.preset-pill.active {
  color: #fff;
  background: var(--accent);
  border-color: var(--accent);
}

/* ---------- 下载进度 ---------- */
.dl-progress {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.dl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13.5px;
}

.dl-head strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-status {
  font-size: 12px;
  color: var(--text-3);
  font-weight: 500;
  flex-shrink: 0;
}

.pbar {
  height: 8px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
}

.pbar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.25s ease;
}

.dl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
}

@media (max-width: 720px) {
  .result-grid {
    grid-template-columns: 1fr;
  }

  .thumb-frame {
    min-height: 190px;
    aspect-ratio: 16 / 9;
  }

  .hero {
    padding-top: 12px;
  }
}
</style>
