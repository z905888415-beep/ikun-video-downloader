<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { api } from '../api/client'

const profile = ref<'sharp' | 'fur'>('sharp')
const file = ref<File | null>(null)
const sourceUrl = ref('')
const previewUrl = ref('')
const cutoutBlob = ref<Blob | null>(null)
const cutoutName = ref('cutout.png')
const busy = ref(false)
const statusText = ref('')
const errorMsg = ref('')
const aiStatusText = ref('')

const ACCEPT = 'image/jpeg,image/png,image/webp'

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30000)
}

function clearResult(): void {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  cutoutBlob.value = null
}

function clearFile(): void {
  file.value = null
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  sourceUrl.value = ''
  clearResult()
  statusText.value = ''
  errorMsg.value = ''
}

function setFile(next?: File | null): void {
  if (!next) return
  if (!next.type.startsWith('image/')) {
    errorMsg.value = '请选择 JPG / PNG / WebP 图片'
    return
  }
  errorMsg.value = ''
  file.value = next
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  sourceUrl.value = URL.createObjectURL(next)
  clearResult()
  statusText.value = ''
}

function onInput(e: Event): void {
  setFile((e.target as HTMLInputElement).files?.[0])
}

function onDrop(e: DragEvent): void {
  setFile(e.dataTransfer?.files?.[0])
}

async function refreshAiStatus(): Promise<void> {
  try {
    const s = await api.aiStatus()
    if (s.ok) {
      const ready = s.upstream && (s.upstream as { model_ready?: boolean }).model_ready
      aiStatusText.value = s.remote
        ? `远程 AI 在线${ready === false ? '（模型未就绪）' : ''}`
        : `自建 AI 在线 · ${s.baseUrl}`
    } else {
      aiStatusText.value = s.error || 'AI 服务不可用'
    }
  } catch (error) {
    aiStatusText.value = error instanceof Error ? error.message : 'AI 状态探测失败'
  }
}

async function compressForCutout(target: File): Promise<File> {
  const maxDim = 2048
  const maxPixels = 2048 * 2048
  if (!target.type.startsWith('image/')) throw new Error('请选择 JPG / PNG / WebP 图片')
  const url = URL.createObjectURL(target)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解析失败'))
      el.src = url
    })
    let w = img.naturalWidth || img.width
    let h = img.naturalHeight || img.height
    if (!w || !h) throw new Error('图片尺寸无效')
    const scale = Math.min(1, maxDim / w, maxDim / h, Math.sqrt(maxPixels / (w * h)))
    if (scale >= 1 && target.size <= 500 * 1024) return target
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 Canvas')
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.95))
    if (!blob) throw new Error('图片压缩失败')
    const base = (target.name || 'image').replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.webp`, { type: 'image/webp' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function runCutout(): Promise<void> {
  if (!file.value || busy.value) return
  busy.value = true
  errorMsg.value = ''
  statusText.value = '正在准备图片…'
  clearResult()
  try {
    statusText.value = '正在压缩图片…'
    const prepared = await compressForCutout(file.value)
    statusText.value = profile.value === 'fur' ? 'AI 细腻抠图中（毛发模式，稍慢）…' : 'AI 快速抠图中…'
    const blob = await api.removeBackground(prepared, profile.value)
    cutoutBlob.value = blob
    previewUrl.value = URL.createObjectURL(blob)
    const base = (file.value.name || 'image').replace(/\.[^.]+$/, '')
    cutoutName.value = `${base}-cutout.png`
    statusText.value = `抠图完成 · ${base}-cutout.png`
  } catch (error) {
    errorMsg.value = error instanceof Error ? error.message : String(error)
    statusText.value = ''
  } finally {
    busy.value = false
  }
}

function downloadCutout(): void {
  if (!cutoutBlob.value) return
  saveBlob(cutoutBlob.value, cutoutName.value)
}

refreshAiStatus()

onBeforeUnmount(() => {
  if (sourceUrl.value) URL.revokeObjectURL(sourceUrl.value)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
})
</script>

<template>
  <div class="cutout-view">
    <div class="page-head">
      <h2>AI 抠图</h2>
      <p>上传图片，一键抠出主体，导出透明 PNG · 经服务器转发远程 miaoCut</p>
    </div>

    <div class="cutout-grid">
      <!-- 左：控制 -->
      <section class="card card-pad panel-left">
        <div class="block">
          <span class="block-label">抠图模式</span>
          <div class="preset-pills" role="radiogroup" aria-label="抠图模式">
            <button
              class="preset-pill"
              :class="{ active: profile === 'sharp' }"
              type="button"
              role="radio"
              :aria-checked="profile === 'sharp'"
              @click="profile = 'sharp'"
            >
              快速 · 锐利边缘
            </button>
            <button
              class="preset-pill"
              :class="{ active: profile === 'fur' }"
              type="button"
              role="radio"
              :aria-checked="profile === 'fur'"
              @click="profile = 'fur'"
            >
              细腻 · 毛发发丝
            </button>
          </div>
        </div>

        <label class="drop-slot" :class="{ filled: !!sourceUrl }" @dragover.prevent @drop.prevent="onDrop">
          <input type="file" :accept="ACCEPT" @change="onInput" />
          <template v-if="sourceUrl">
            <img :src="sourceUrl" alt="原图" />
            <div class="drop-copy">
              <strong>{{ file?.name }}</strong>
              <small>点击或拖拽替换</small>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" @click.stop.prevent="clearFile">移除</button>
          </template>
          <template v-else>
            <span class="drop-plus"><Icon name="plus" :size="18" /></span>
            <div class="drop-copy">
              <strong>上传图片</strong>
              <small>拖拽或点击 · JPG / PNG / WebP</small>
            </div>
          </template>
        </label>

        <div class="actions">
          <button class="btn btn-primary" type="button" :disabled="busy || !file" @click="runCutout">
            <span v-if="busy" class="spinner" />
            <Icon v-else name="sparkles" :size="15" />
            {{ busy ? '抠图中…' : '开始抠图' }}
          </button>
          <button class="btn btn-light" type="button" :disabled="!cutoutBlob" @click="downloadCutout">
            <Icon name="download" :size="15" />下载 PNG
          </button>
          <button class="btn btn-ghost" type="button" :disabled="busy" @click="refreshAiStatus">检测 AI</button>
        </div>

        <p v-if="errorMsg" class="cutout-error" role="alert">{{ errorMsg }}</p>
        <p v-else-if="statusText" class="cutout-status" aria-live="polite">{{ statusText }}</p>
        <p v-if="aiStatusText" class="ai-line">{{ aiStatusText }}</p>
      </section>

      <!-- 右：结果 -->
      <section class="card card-pad panel-right">
        <div class="right-head">
          <h3 class="card-title">{{ cutoutBlob ? '抠图完成' : '抠图结果' }}</h3>
          <span class="right-sub">{{ busy ? '正在处理，请稍候' : '透明区域以棋盘格显示' }}</span>
        </div>

        <div class="stage" :class="{ filled: !!previewUrl }">
          <img v-if="previewUrl" class="checker" :src="previewUrl" alt="抠图结果" />
          <div v-else-if="busy" class="stage-state">
            <span class="spinner stage-spinner" />
            <span class="stage-text">AI 正在抠图…</span>
          </div>
          <div v-else class="stage-state">
            <Icon name="image" :size="44" />
            <span class="stage-text">抠图结果会显示在这里</span>
          </div>
        </div>

        <div v-if="sourceUrl || previewUrl" class="compare">
          <div v-if="sourceUrl" class="compare-pane">
            <span>原图</span>
            <img :src="sourceUrl" alt="原图" />
          </div>
          <div v-if="previewUrl" class="compare-pane">
            <span>抠图后</span>
            <img class="checker" :src="previewUrl" alt="抠图后" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.cutout-grid {
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.block {
  margin-bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.block-label {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-3);
}

.drop-slot {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 84px;
  padding: 14px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: rgba(11, 17, 33, 0.4);
  cursor: pointer;
  color: var(--text-2);
}

.drop-slot input {
  display: none;
}

.drop-slot:hover,
.drop-slot.filled {
  border-color: var(--accent-border);
  background: rgba(62, 123, 250, 0.05);
}

.drop-slot img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 10px;
  flex-shrink: 0;
}

.drop-plus {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: var(--accent-hover);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  flex-shrink: 0;
}

.drop-copy {
  flex: 1;
  min-width: 0;
}

.drop-copy strong {
  display: block;
  font-size: 13.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drop-copy small {
  color: var(--text-3);
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 18px;
}

.cutout-error {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.cutout-status {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
}

.ai-line {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
}

.right-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.right-sub {
  font-size: 12px;
  color: var(--text-3);
}

.stage {
  min-height: 320px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background:
    radial-gradient(60% 60% at 50% 40%, rgba(35, 62, 120, 0.18), transparent 75%),
    rgba(3, 7, 17, 0.5);
  display: grid;
  place-items: center;
  overflow: hidden;
  padding: 12px;
}

.stage.filled {
  padding: 10px;
  background-color: #141b28;
  background-image:
    linear-gradient(45deg, #1d2636 25%, transparent 25%),
    linear-gradient(-45deg, #1d2636 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #1d2636 75%),
    linear-gradient(-45deg, transparent 75%, #1d2636 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
}

.stage img {
  max-width: 100%;
  max-height: 520px;
  object-fit: contain;
  display: block;
}

.stage-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-3);
}

.stage-text {
  font-size: 13px;
  color: var(--text-2);
}

.stage-spinner {
  width: 26px;
  height: 26px;
  border-width: 3px;
}

.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-top: 14px;
}

.compare-pane {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: rgba(3, 7, 17, 0.45);
}

.compare-pane span {
  color: var(--text-3);
  font-size: 12px;
}

.compare-pane img {
  width: 100%;
  max-height: 180px;
  object-fit: contain;
  border-radius: var(--r-sm);
  background: #111;
}

.compare-pane img.checker {
  background-color: #1a1a1a;
  background-image:
    linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
    linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
  background-size: 14px 14px;
  background-position: 0 0, 0 7px, 7px -7px, -7px 0;
}

@media (max-width: 960px) {
  .cutout-grid {
    grid-template-columns: 1fr;
  }

  .stage {
    min-height: 240px;
  }

  .compare {
    grid-template-columns: 1fr;
  }
}
</style>
