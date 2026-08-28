<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { extractUrl, useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'
import { downloadHls } from '../lib/hls-download'
import { downloadImagesAsZip } from '../lib/images-zip'
import { apiV2, type V2Job, type V2MediaAction, type V2Resolution } from '../api/client'

const store = useAppStore()

const hlsBusy = ref(false)
const zipBusy = ref(false)
const queueExpanded = ref(false)

const activeDownload = ref<{
  label: string
  kind: 'direct' | 'task' | 'hls' | 'zip'
  percent: number
  status: string
  actionId: string
  jobId?: string
  filename?: string
  auto?: boolean
} | null>(null)

const STATUS_TEXT: Record<string, string> = {
  RESOLVING: '解析中',
  READY: '准备下载',
  DELIVERED: '已交付',
  QUEUED: '排队中',
  DOWNLOADING: '下载中',
  PROCESSING: '处理中',
  RETRY_WAIT: '等待重试',
  COMPLETED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
  EXPIRED: '已过期'
}

const ACTIVE_STATUS = ['RESOLVING', 'DOWNLOADING', 'PROCESSING', 'DELIVERED']
const WAIT_STATUS = ['READY', 'QUEUED', 'RETRY_WAIT']
const FINAL_STATUS = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']

const activeTasks = computed(() => store.v2Jobs.filter((j) => ACTIVE_STATUS.includes(j.status)))
const queuedTasks = computed(() => store.v2Jobs.filter((j) => WAIT_STATUS.includes(j.status)))
const finishedTasks = computed(() => store.v2Jobs.filter((j) => FINAL_STATUS.includes(j.status)))
const runningCount = computed(() => store.v2Jobs.filter((j) => !FINAL_STATUS.includes(j.status)).length)

onMounted(() => {
  store.startV2Polling()
  void store.refreshV2Jobs()
})

function statusText(dl: { kind: string; status: string; percent: number }): string {
  if (dl.status === 'done') return '完成'
  if (dl.status === 'error') return '失败'
  if (dl.status === 'downloading') return `下载中 ${dl.percent}%`
  if (dl.status === 'queued') return '排队中'
  return STATUS_TEXT[dl.status] || dl.status
}

function jobStatusLabel(status: string): string {
  return STATUS_TEXT[status] || status
}

function jobTitle(job: V2Job): string {
  return job.filename || job.sourceUrl
}

function jobSub(job: V2Job): string {
  const parts = [job.actionId]
  if (job.mode && job.mode !== 'auto') parts.push(job.mode)
  return parts.join(' · ')
}

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30000)
}

function triggerAnchorDownload(url: string, filename: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
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
    if (dl.auto && dl.jobId) {
      triggerAnchorDownload(apiV2.fileUrl(dl.jobId), job.filename || dl.filename || 'video.mp4')
      store.setNotice('已开始下载')
    } else {
      store.setNotice('下载完成')
    }
  } else if ((job.status === 'FAILED' || job.status === 'CANCELLED') && prevStatus !== 'error') {
    dl.status = 'error'
  } else {
    dl.status = job.status
  }
})

function onEnter(e: KeyboardEvent): void {
  if (e.key === 'Enter') void store.doResolveV2()
}

function onPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text') || ''
  if (!text) return
  const cleaned = extractUrl(text)
  if (!cleaned) return
  // 统一接管赋值（必须在 paste 事件内同步写入，供自动链路做输入变更守卫）
  e.preventDefault()
  store.url = cleaned
  store.urlError = ''
  // 单个合法 http(s) 链接才自动执行粘贴-解析-下载；多链接或纯文本仅填充输入框
  const urlCount = (text.match(/https?:\/\/[^\s]+/gi) || []).length
  if (urlCount === 1 && /^https?:\/\//i.test(cleaned)) {
    void autoResolveAndDownload(cleaned)
  }
}

async function pasteFromClipboardAndGo(): Promise<void> {
  await store.pasteFromClipboard()
  const u = store.url.trim()
  if (/^https?:\/\//i.test(u) && (u.match(/https?:\/\//gi) || []).length === 1) {
    void autoResolveAndDownload(u)
  }
}

/* ---------- 粘贴-解析-下载 自动链路 ---------- */

function isDirectAction(a: V2MediaAction): boolean {
  return a.type === 'direct' && !a.requiresProcessing
}

function actionHeight(res: V2Resolution, a: V2MediaAction): number {
  const asset = res.assets.find((x) => x.id === a.assetIds[0])
  if (asset?.height) return asset.height
  const m = a.label.match(/(\d{3,4})\s*P/i)
  return m ? Number(m[1]) : 0
}

function pickAutoAction(res: V2Resolution): V2MediaAction | null {
  const { actions, kind } = res
  if (!actions.length) return null
  if (kind === 'images') {
    return actions.find((a) => a.type === 'images-zip') || null
  }
  if (kind === 'audio') {
    return actions.find((a) => a.type === 'extract-audio' || a.type === 'direct') || actions[0]
  }
  // 优先免处理的视频直链：先挑 ≤1080p 里最高的，否则取最高画质的直链
  const direct = actions.filter(isDirectAction)
  if (direct.length) {
    const within1080 = direct.filter((a) => {
      const h = actionHeight(res, a)
      return h > 0 && h <= 1080
    })
    if (within1080.length) {
      return within1080.reduce((best, a) => (actionHeight(res, a) > actionHeight(res, best) ? a : best))
    }
    const withHeight = direct.filter((a) => actionHeight(res, a) > 0)
    if (withHeight.length) {
      return withHeight.reduce((best, a) => (actionHeight(res, a) > actionHeight(res, best) ? a : best))
    }
    return direct[0]
  }
  return actions.find((a) => a.type === 'merge') || actions.find((a) => a.type === 'hls') || actions[0]
}

async function autoResolveAndDownload(rawUrl: string): Promise<void> {
  if (store.v2Probing) return
  const before = store.url
  await store.doResolveV2(rawUrl)
  // 解析期间用户改动了输入，或解析失败：不自动下载
  if (store.url !== before || !store.v2Resolution) return
  const action = pickAutoAction(store.v2Resolution)
  if (!action) return
  if (isDirectAction(action)) {
    void autoSaveDirect(action)
  } else if (action.type === 'images-zip') {
    void runImagesZip(action)
  } else if (action.type === 'hls') {
    void runHlsDownload(action)
  } else {
    await autoStartTask(action)
  }
}

/* Chromium 下直接弹系统保存窗口；缺少用户激活或其它浏览器回退为浏览器接管下载 */
async function autoSaveDirect(action: V2MediaAction): Promise<void> {
  const filename = safeFilename(store.v2Resolution?.title || 'video', action)
  const url = apiV2.assetProxyUrl(action.assetIds[0])
  activeDownload.value = { label: filename, kind: 'direct', percent: 0, status: 'downloading', filename, actionId: action.id, auto: true }
  const picker = (window as { showSaveFilePicker?: (opts: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(window, { suggestedName: filename })
      const res = await fetch(url)
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      const writable = await (handle as FileSystemFileHandle).createWritable()
      await res.body.pipeTo(writable)
      if (activeDownload.value?.actionId === action.id) {
        activeDownload.value.percent = 100
        activeDownload.value.status = 'done'
      }
      store.setNotice('已保存')
      return
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        activeDownload.value = null
        return
      }
      // NotAllowedError（缺少用户激活）等 → 回退为浏览器接管下载
    }
  }
  triggerAnchorDownload(url, filename)
  if (activeDownload.value?.actionId === action.id) {
    activeDownload.value.percent = 100
    activeDownload.value.status = 'done'
  }
}

async function autoStartTask(action: V2MediaAction): Promise<void> {
  const job = await store.enqueueV2Action(action.id)
  if (!job) return
  activeDownload.value = { label: action.label, kind: 'task', percent: 0, status: 'queued', jobId: job.id, filename: job.filename, actionId: action.id, auto: true }
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
    <!-- 中央下载面板：输入行 + 原位状态区 -->
    <section class="hero" :class="{ tight: store.v2Jobs.length > 0 }">
      <div class="panel rise-in" :class="{ probing: store.v2Probing }">
        <div class="panel-input">
          <span class="panel-orb" aria-hidden="true"><Icon name="link" :size="17" /></span>
          <input
            v-model="store.url"
            class="panel-field"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="粘贴短视频分享链接，回车解析…"
            aria-label="视频链接"
            @keydown="onEnter"
            @paste="onPaste"
          />
          <button class="btn btn-ghost btn-sm panel-paste" type="button" @click="pasteFromClipboardAndGo()">
            <Icon name="clipboard" :size="13" />
            粘贴
          </button>
          <button
            class="btn btn-primary panel-go"
            type="button"
            :disabled="store.v2Probing || !store.url.trim()"
            @click="store.doResolveV2()"
          >
            <span v-if="store.v2Probing" class="spinner" />
            {{ store.v2Probing ? '解析中' : '解析' }}
          </button>
        </div>

        <p v-if="store.urlError" class="panel-error">
          <Icon name="alert" :size="14" />
          {{ store.urlError }}
        </p>

        <div v-if="store.binary && !store.binary.ytdlpOk" class="panel-alert">
          <Icon name="alert" :size="17" />
          <div>
            <strong>未检测到 yt-dlp</strong>
            <p>请确认项目 resources/bin 下存在 yt-dlp，并重新启动 web 服务。</p>
          </div>
        </div>

        <!-- 状态区：解析 / 结果 / 进度都在面板内原位出现 -->
        <div v-if="store.v2Error || store.v2Probing || store.v2Resolution || activeDownload" class="panel-body">
          <div v-if="store.v2Error" class="panel-state">
            <span class="state-ico error"><Icon name="alert" :size="19" /></span>
            <div class="state-text">
              <strong>解析失败</strong>
              <span>{{ store.v2Error }}</span>
            </div>
            <div class="state-actions">
              <button class="btn btn-sm" type="button" @click="store.doResolveV2()">
                <Icon name="refresh" :size="13" />
                重试
              </button>
              <button class="btn btn-ghost btn-sm" type="button" @click="store.page = 'settings'">
                检查状态
              </button>
            </div>
          </div>

          <div v-else-if="store.v2Probing" class="panel-state">
            <span class="state-ico"><span class="spinner" /></span>
            <div class="state-text">
              <strong>正在解析视频</strong>
              <span>正在读取标题与可用画质</span>
            </div>
            <div class="loading-track"><i /></div>
          </div>

          <div v-else-if="store.v2Resolution" class="panel-state state-result">
            <div class="result-thumb">
              <img v-if="store.v2Resolution.thumbnail" :src="store.v2Resolution.thumbnail" :alt="store.v2Resolution.title" />
              <span v-else class="result-thumb-fallback"><Icon name="play" :size="22" /></span>
              <em v-if="store.v2Resolution.duration" class="result-duration">{{ fmtDuration(store.v2Resolution.duration) }}</em>
            </div>
            <div class="result-main">
              <h2 class="result-title">{{ store.v2Resolution.title }}</h2>
              <div class="meta-row">
                <span class="chip">{{ store.v2Resolution.platform || store.v2Resolution.provider }}</span>
              </div>
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

          <div v-if="activeDownload" class="panel-state state-dl">
            <div class="dl-head">
              <strong>{{ activeDownload.label }}</strong>
              <span class="dl-status">{{ statusText(activeDownload) }}</span>
            </div>
            <div class="pbar"><i :style="{ width: `${activeDownload.percent}%` }" /></div>
            <div class="dl-foot">
              <span v-if="activeDownload.kind === 'task' && activeDownload.status !== 'done' && activeDownload.status !== 'error'">
                任务进度 {{ activeDownload.percent }}%
              </span>
              <span v-else-if="activeDownload.status === 'done'">
                <template v-if="activeDownload.kind === 'task'">
                  {{ activeDownload.auto ? '处理完成 · 已开始下载到你的设备' : '处理完成 · 点击「保存文件」下载到本地' }}
                </template>
                <template v-else-if="activeDownload.auto">已开始下载 · 保存位置由浏览器设置决定</template>
                <template v-else>已保存到浏览器下载目录</template>
              </span>
              <span v-else-if="activeDownload.status === 'error'">下载遇到问题，请重试</span>
              <span v-else>{{ activeDownload.percent > 0 ? `${activeDownload.percent}%` : '传输中…' }}</span>
              <div class="dl-actions">
                <button v-if="activeDownload.status === 'error'" class="btn btn-sm" type="button" @click="retryActive()">
                  <Icon name="refresh" :size="13" />重试
                </button>
                <a
                  v-if="activeDownload.kind === 'task' && activeDownload.status === 'done' && activeDownload.jobId"
                  class="btn btn-light btn-sm"
                  :href="apiV2.fileUrl(activeDownload.jobId)"
                  download
                >
                  <Icon name="download" :size="13" />保存文件
                </a>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="panel-space" aria-hidden="true"></div>
      </div>
    </section>

    <!-- ==================== 下载队列：默认收起，点击展开 ==================== -->
    <section v-if="store.v2Jobs.length" class="queue-section rise-in">
      <button class="queue-bar" type="button" :aria-expanded="queueExpanded" @click="queueExpanded = !queueExpanded">
        <span class="queue-bar-left">
          <Icon name="download" :size="16" />
          <strong>下载队列</strong>
          <span class="queue-bar-count">{{ store.v2Jobs.length }} 个任务</span>
          <span v-if="runningCount" class="queue-bar-live">{{ runningCount }} 进行中</span>
        </span>
        <Icon name="chevronDown" :size="16" class="queue-bar-chevron" :class="{ open: queueExpanded }" />
      </button>

      <div class="queue-collapse" :class="{ open: queueExpanded }">
        <div class="queue-collapse-inner">
          <div class="queue-expanded-top">
            <span class="queue-expanded-hint">完成或失败的任务会保留在「历史记录」</span>
            <button class="btn btn-ghost btn-sm" type="button" title="刷新队列状态" @click="store.refreshV2Jobs()">
              <Icon name="refresh" :size="13" />
              刷新
            </button>
          </div>
          <div class="queue-list-wrap">
        <!-- 进行中任务 -->
        <template v-if="activeTasks.length">
          <div class="group-label">
            <span class="group-dot live" />
            进行中 · {{ activeTasks.length }}
          </div>
          <div class="stagger queue-cards-grid">
            <div v-for="j in activeTasks" :key="j.id" class="card task-card active-card">
              <div class="task-thumb">
                <Icon name="video" :size="20" />
              </div>
              <div class="task-main">
                <div class="task-head">
                  <div class="task-title" :title="jobTitle(j)">{{ jobTitle(j) }}</div>
                  <span class="status-pill" :class="j.status">{{ jobStatusLabel(j.status) }}</span>
                </div>
                <div class="task-sub">{{ jobSub(j) }}</div>
                <div class="pbar task-pbar"><i :style="{ width: `${Math.min(100, j.percent || 0)}%` }" /></div>
                <div class="task-meta">
                  <span class="task-percent">{{ (j.percent || 0).toFixed(1) }}%</span>
                  <span v-if="j.phase">{{ j.phase }}</span>
                  <span v-if="j.speed">{{ j.speed }}</span>
                  <span v-if="j.eta">剩余 {{ j.eta }}</span>
                  <span v-if="j.error" class="task-error">{{ j.error.message }}</span>
                </div>
              </div>
              <div class="task-actions">
                <button class="btn btn-danger btn-sm" type="button" @click="store.cancelV2Job(j.id)">
                  <Icon name="x" :size="13" />
                  取消
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- 等待中任务 -->
        <template v-if="queuedTasks.length">
          <div class="group-label">
            <span class="group-dot wait" />
            等待中 · {{ queuedTasks.length }}
          </div>
          <div class="stagger queue-cards-grid">
            <div v-for="j in queuedTasks" :key="j.id" class="card task-card">
              <div class="task-thumb">
                <Icon name="video" :size="20" />
              </div>
              <div class="task-main">
                <div class="task-head">
                  <div class="task-title" :title="jobTitle(j)">{{ jobTitle(j) }}</div>
                  <span class="status-pill queued">{{ jobStatusLabel(j.status) }}</span>
                </div>
                <div class="task-sub">{{ jobSub(j) }}</div>
              </div>
              <div class="task-actions">
                <button class="btn btn-danger btn-sm" type="button" @click="store.cancelV2Job(j.id)">
                  <Icon name="x" :size="13" />
                  取消
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- 已结束任务 -->
        <template v-if="finishedTasks.length">
          <div class="group-label">
            <span class="group-dot done" />
            已结束 · {{ finishedTasks.length }}
          </div>
          <div class="stagger queue-cards-grid">
            <div v-for="j in finishedTasks" :key="j.id" class="card task-card dim">
              <div class="task-thumb">
                <Icon name="video" :size="20" />
              </div>
              <div class="task-main">
                <div class="task-head">
                  <div class="task-title" :title="jobTitle(j)">{{ jobTitle(j) }}</div>
                  <span class="status-pill" :class="j.status">{{ jobStatusLabel(j.status) }}</span>
                </div>
                <div class="task-sub">
                  {{ jobSub(j) }}
                  <template v-if="j.filename"> · {{ j.filename }}</template>
                </div>
                <div v-if="j.error" class="task-meta">
                  <span class="task-error">{{ j.error.message }}</span>
                </div>
              </div>
              <div class="task-actions">
                <a
                  v-if="j.status === 'COMPLETED' && j.filepath"
                  class="btn btn-light btn-sm"
                  :href="apiV2.fileUrl(j.id)"
                  download
                >
                  <Icon name="download" :size="13" />
                  保存文件
                </a>
                <button
                  v-if="j.status === 'FAILED' || j.status === 'RETRY_WAIT' || j.status === 'CANCELLED'"
                  class="btn btn-sm"
                  type="button"
                  @click="store.retryV2Job(j.id)"
                >
                  <Icon name="refresh" :size="13" />
                  重试
                </button>
              </div>
            </div>
          </div>
        </template>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 24px;
}

/* ---------- 中央面板 ---------- */
.hero {
  display: flex;
  justify-content: center;
  align-items: center;
  /* 面板在首屏垂直居中、中心略偏上（~40%），队列仍可留在首屏内 */
  min-height: max(220px, calc(100dvh - var(--nav-h) - 280px));
}

/* 队列存在时面板略上移，让队列条贴着面板出现在首屏内 */
.hero.tight {
  min-height: max(160px, calc(100dvh - var(--nav-h) - 460px));
}

.panel {
  width: 100%;
  border-radius: 22px;
  border: 1px solid rgba(163, 190, 255, 0.13);
  background:
    linear-gradient(180deg, rgba(151, 184, 255, 0.055), rgba(151, 184, 255, 0.015)),
    rgba(9, 13, 23, 0.72);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 30px 90px rgba(1, 3, 9, 0.5),
    0 0 70px rgba(46, 107, 246, 0.07);
  transition: border-color 0.2s var(--ease), box-shadow 0.2s var(--ease);
}

.panel:focus-within {
  border-color: var(--accent-border);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 0 0 4px var(--accent-glow),
    0 30px 90px rgba(1, 3, 9, 0.5),
    0 0 70px rgba(46, 107, 246, 0.1);
}

.panel.probing {
  border-color: var(--accent-border);
}

.panel-input {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px 12px 18px;
}

.panel-orb {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: var(--accent-hover);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  flex-shrink: 0;
}

.panel-field {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 15.5px;
  padding: 8px 0;
}

.panel-field::placeholder {
  color: var(--text-3);
}

.panel-paste {
  flex-shrink: 0;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
}

.panel-go {
  flex-shrink: 0;
  min-width: 88px;
  border-radius: 12px;
}

.panel-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0 20px 12px;
  color: var(--danger);
  font-size: 12px;
  font-weight: 500;
}

.panel-alert {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  margin: 0 14px 12px;
  padding: 11px 14px;
  border: 1px solid var(--warn-border);
  border-radius: var(--r-md);
  background: var(--warn-bg);
  color: var(--warn);
  font-size: 12.5px;
}

.panel-alert strong {
  color: var(--text);
}

.panel-alert p {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 12px;
}

/* 呼吸留白：等待输入时面板的 reserved 空间 */
.panel-space {
  height: 68px;
  border-top: 1px solid var(--border);
}

.panel-body {
  border-top: 1px solid var(--border);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel-state {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.panel-state + .panel-state {
  border-top: 1px solid var(--border);
  padding-top: 16px;
}

.state-ico {
  width: 36px;
  height: 36px;
  border-radius: 11px;
  display: grid;
  place-items: center;
  color: var(--accent-hover);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  flex-shrink: 0;
}

.state-ico.error {
  color: var(--danger);
  background: var(--danger-bg);
  border-color: var(--danger-border);
}

.state-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.state-text strong {
  font-size: 13.5px;
  font-weight: 650;
  color: var(--text);
}

.state-text span {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.loading-track {
  width: 140px;
  height: 3px;
  border-radius: var(--r-full);
  background: var(--surface-2);
  overflow: hidden;
  flex-shrink: 0;
}

.loading-track i {
  display: block;
  height: 100%;
  width: 40%;
  border-radius: inherit;
  background: var(--accent-hover);
  animation: loading-slide 1.15s ease-in-out infinite;
}

@keyframes loading-slide {
  0% { transform: translateX(-110%); }
  100% { transform: translateX(260%); }
}

/* ---------- 面板内解析结果 ---------- */
.state-result {
  align-items: flex-start;
}

.result-thumb {
  position: relative;
  width: 132px;
  aspect-ratio: 16 / 9;
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface-2);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.result-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.result-thumb-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
}

.result-duration {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 7px;
  border-radius: 7px;
  background: rgba(4, 10, 22, 0.74);
  border: 1px solid rgba(163, 190, 255, 0.16);
  color: #fff;
  font-size: 11px;
  font-style: normal;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.result-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.result-title {
  margin: 0;
  font-size: 15.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.4;
  color: var(--text);
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

/* 画质选择使用全局 .preset-pills */

/* ---------- 面板内即时下载进度 ---------- */
.state-dl {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
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

.dl-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-2);
}

.dl-foot > span:first-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dl-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ---------- 下载队列 · 收起/展开条 ---------- */
.queue-section {
  display: flex;
  flex-direction: column;
}

.queue-bar {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: rgba(10, 15, 26, 0.55);
  cursor: pointer;
  text-align: left;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease);
}

.queue-bar:hover {
  border-color: var(--border-strong);
  background: rgba(13, 19, 32, 0.7);
}

.queue-bar-left {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: 13.5px;
  color: var(--text);
}

.queue-bar-left > svg {
  color: var(--text-2);
  flex-shrink: 0;
}

.queue-bar-left strong {
  font-weight: 700;
  letter-spacing: -0.01em;
}

.queue-bar-count {
  padding: 2px 9px;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-2);
  font-size: 11.5px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.queue-bar-live {
  color: var(--accent-hover);
  font-size: 12px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.queue-bar-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  transition: transform 0.28s var(--ease);
}

.queue-bar-chevron.open {
  transform: rotate(180deg);
}

.queue-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.32s var(--ease);
}

.queue-collapse.open {
  grid-template-rows: 1fr;
}

.queue-collapse-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 0;
  transition: padding-top 0.32s var(--ease);
}

.queue-collapse.open .queue-collapse-inner {
  padding-top: 12px;
}

.queue-expanded-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 2px;
}

.queue-expanded-hint {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-list-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.queue-cards-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--text-2);
}

.group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.group-dot.live {
  background: var(--accent-hover);
  box-shadow: 0 0 8px rgba(62, 123, 250, 0.7);
  animation: pulse-dot 1.4s ease-in-out infinite;
}

.group-dot.wait {
  background: var(--warn);
}

.group-dot.done {
  background: var(--text-3);
}

.task-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 16px;
  transition: border-color 0.18s var(--ease), transform 0.18s var(--ease-spring);
}

.task-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-1px);
}

.task-card.dim {
  opacity: 0.85;
}

.task-card.active-card {
  border-color: rgba(62, 123, 250, 0.28);
  background:
    linear-gradient(180deg, rgba(62, 123, 250, 0.07), rgba(62, 123, 250, 0) 48%),
    linear-gradient(180deg, rgba(151, 184, 255, 0.04), rgba(151, 184, 255, 0.012) 42%),
    rgba(10, 15, 26, 0.6);
}

.task-thumb {
  width: 52px;
  height: 42px;
  border-radius: var(--r-sm);
  overflow: hidden;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
}

.task-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.task-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task-title {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-sub {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-pbar {
  margin-top: 3px;
}

.task-meta {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.task-percent {
  color: var(--accent-hover);
  font-weight: 700;
}

.task-error {
  color: var(--danger);
}

.task-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .hero {
    min-height: max(180px, calc(100dvh - var(--nav-h) - 320px));
  }

  .panel-input {
    flex-wrap: wrap;
    padding: 12px;
  }

  .panel-field {
    flex-basis: 100%;
    order: -1;
    padding-left: 2px;
  }

  .panel-orb {
    display: none;
  }

  .panel-paste {
    margin-left: auto;
  }

  .panel-body {
    padding: 14px;
  }

  .panel-state {
    flex-wrap: wrap;
  }

  .state-text {
    flex-basis: calc(100% - 50px);
  }

  .state-actions,
  .loading-track {
    margin-left: 50px;
  }

  .result-thumb {
    width: 100%;
  }

  .task-thumb {
    display: none;
  }

  .task-card {
    padding: 11px 12px;
  }

  .task-head {
    flex-wrap: wrap;
    gap: 4px 10px;
  }
}
</style>
