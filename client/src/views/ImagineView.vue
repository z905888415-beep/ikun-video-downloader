<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { generateImage } from '../lib/image-generate'

interface Work {
  id: string
  prompt: string
  imageUrl: string
  createdAt: number
}

const WORKS_KEY = 'ikun_imagine_works'
const WORKS_MAX = 24

const mode = ref<'text' | 'image'>('text')
const prompt = ref('')
const size = ref('1024x1024')
const refUrl = ref('')
const refName = ref('')
let refFile: File | null = null

const generating = ref(false)
const progress = ref(0)
const statusText = ref('')
const errorMsg = ref('')
const resultUrl = ref('')
let abortController: AbortController | null = null

const works = ref<Work[]>(loadWorks())

function loadWorks(): Work[] {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKS_KEY) || '[]') as Work[]
    return Array.isArray(raw) ? raw.filter((w) => /^https?:\/\//.test(w.imageUrl)).slice(0, WORKS_MAX) : []
  } catch {
    return []
  }
}

function persistWorks(): void {
  try {
    localStorage.setItem(WORKS_KEY, JSON.stringify(works.value.slice(0, WORKS_MAX)))
  } catch {
    /* 配额满则放弃持久化，会话内仍可见 */
  }
}

function onPickRef(file?: File | null): void {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMsg.value = '请选择图片文件作为参考图'
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    errorMsg.value = '参考图不能超过 10MB'
    return
  }
  errorMsg.value = ''
  if (refUrl.value) URL.revokeObjectURL(refUrl.value)
  refFile = file
  refUrl.value = URL.createObjectURL(file)
  refName.value = file.name
}

function onRefInput(e: Event): void {
  onPickRef((e.target as HTMLInputElement).files?.[0])
}

function onRefDrop(e: DragEvent): void {
  onPickRef(e.dataTransfer?.files?.[0])
}

function clearRef(): void {
  if (refUrl.value) URL.revokeObjectURL(refUrl.value)
  refFile = null
  refUrl.value = ''
  refName.value = ''
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取参考图失败'))
    reader.readAsDataURL(file)
  })
}

async function setRefFromUrl(url: string): Promise<void> {
  try {
    if (url.startsWith('data:')) {
      refFile = new File([], 'generated.png', { type: 'image/png' })
      refUrl.value = url
      refName.value = '上一次生成'
      return
    }
    const blob = await (await fetch(url)).blob()
    refFile = new File([blob], 'generated.png', { type: blob.type || 'image/png' })
    if (refUrl.value) URL.revokeObjectURL(refUrl.value)
    refUrl.value = URL.createObjectURL(blob)
    refName.value = '上一次生成'
    mode.value = 'image'
    statusText.value = '已设为参考图，改改提示词再生成'
  } catch {
    errorMsg.value = '参考图获取失败'
  }
}

async function generate(): Promise<void> {
  if (generating.value) return
  errorMsg.value = ''
  if (!prompt.value.trim()) {
    errorMsg.value = '请先描述你想创造的画面'
    return
  }
  if (mode.value === 'image' && !refFile) {
    errorMsg.value = '图生图需要先添加参考图'
    return
  }
  generating.value = true
  progress.value = 4
  statusText.value = '正在提交生图任务…'
  resultUrl.value = ''
  abortController = new AbortController()
  try {
    let imageDataUrl = ''
    if (mode.value === 'image' && refFile && refFile.size) {
      imageDataUrl = await fileToDataUrl(refFile)
    }
    const url = await generateImage({
      prompt: prompt.value,
      size: size.value,
      imageDataUrl: imageDataUrl || undefined,
      signal: abortController.signal,
      onProgress: (p) => {
        progress.value = p
        statusText.value = p >= 100 ? '生成完成' : `生成中 ${Math.round(p)}%`
      }
    })
    resultUrl.value = url
    progress.value = 100
    statusText.value = '图片已就绪'
    const work: Work = {
      id: `w_${Date.now()}`,
      prompt: prompt.value.trim(),
      imageUrl: url,
      createdAt: Date.now()
    }
    works.value = [work, ...works.value].slice(0, WORKS_MAX)
    persistWorks()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      statusText.value = '已取消'
    } else {
      errorMsg.value = error instanceof Error ? error.message : String(error)
      statusText.value = ''
    }
  } finally {
    generating.value = false
    abortController = null
  }
}

function cancel(): void {
  abortController?.abort()
}

function openWork(work: Work): void {
  resultUrl.value = work.imageUrl
  prompt.value = work.prompt
  statusText.value = '已打开历史作品'
  errorMsg.value = ''
}

function removeWork(work: Work): void {
  works.value = works.value.filter((w) => w.id !== work.id)
  persistWorks()
  if (resultUrl.value === work.imageUrl) {
    resultUrl.value = ''
    statusText.value = ''
  }
}

function download(): void {
  if (!resultUrl.value) return
  const a = document.createElement('a')
  a.href = resultUrl.value
  a.download = `ikun-${Date.now()}.png`
  a.rel = 'noopener'
  a.click()
}

onBeforeUnmount(() => {
  abortController?.abort()
  if (refUrl.value) URL.revokeObjectURL(refUrl.value)
})
</script>

<template>
  <div class="imagine-view">
    <div class="page-head">
      <h2>AI 生图</h2>
      <p>文生图与图生图 · 生成约需 1–3 分钟</p>
    </div>

    <div class="imagine-grid">
      <!-- 左：控制面板 -->
      <section class="card card-pad panel-left">
        <div class="seg" role="tablist" aria-label="生图模式">
          <button class="seg-btn" :class="{ active: mode === 'text' }" type="button" role="tab" :aria-selected="mode === 'text'" @click="mode = 'text'">
            文生图
          </button>
          <button class="seg-btn" :class="{ active: mode === 'image' }" type="button" role="tab" :aria-selected="mode === 'image'" @click="mode = 'image'">
            图生图
          </button>
        </div>

        <div class="block prompt-block">
          <span class="block-label">提示词</span>
          <div class="prompt-wrap">
            <textarea
              v-model="prompt"
              class="prompt-input"
              maxlength="4000"
              aria-label="提示词"
              placeholder="描述你想创造的画面…"
            />
            <span class="counter">{{ prompt.length }}/4000</span>
          </div>
        </div>

        <div v-if="mode === 'image'" class="block">
          <label
            class="ref-slot"
            :class="{ filled: !!refUrl }"
            @dragover.prevent
            @drop.prevent="onRefDrop"
          >
            <input type="file" accept="image/jpeg,image/png,image/webp" @change="onRefInput" />
            <template v-if="refUrl">
              <img :src="refUrl" alt="参考图" />
              <div class="ref-copy">
                <strong>{{ refName }}</strong>
                <small>点击或拖拽替换</small>
              </div>
              <button class="btn btn-ghost btn-sm" type="button" @click.stop.prevent="clearRef">移除</button>
            </template>
            <template v-else>
              <span class="ref-plus"><Icon name="plus" :size="18" /></span>
              <div class="ref-copy">
                <strong>添加参考图</strong>
                <small>拖拽或点击，按参考图重绘</small>
              </div>
            </template>
          </label>
        </div>

        <div class="block">
          <span class="block-label">画幅</span>
          <div class="size-chips" role="radiogroup" aria-label="画幅">
            <button
              v-for="s in [
                { id: '1024x1024', ratio: '1:1', w: 20, h: 20 },
                { id: '1536x864', ratio: '16:9', w: 26, h: 15 },
                { id: '864x1536', ratio: '9:16', w: 15, h: 26 },
                { id: '1536x1024', ratio: '3:2', w: 25, h: 17 },
                { id: '1024x1536', ratio: '2:3', w: 17, h: 25 }
              ]"
              :key="s.id"
              class="size-chip"
              :class="{ active: size === s.id }"
              type="button"
              role="radio"
              :aria-checked="size === s.id"
              @click="size = s.id"
            >
              <i class="size-box" :style="{ width: s.w + 'px', height: s.h + 'px' }" />
              {{ s.ratio }}
            </button>
          </div>
        </div>

        <div class="gen-row">
          <button class="btn btn-primary btn-block" type="button" :disabled="generating || !prompt.trim()" @click="generate">
            <span v-if="generating" class="spinner" />
            <Icon v-else name="sparkles" :size="15" />
            {{ generating ? `生成中 ${Math.round(progress)}%` : '生成图片' }}
          </button>
          <button v-if="generating" class="btn btn-ghost" type="button" @click="cancel">取消</button>
        </div>

        <p v-if="errorMsg" class="imagine-error" role="alert">{{ errorMsg }}</p>
        <p v-else-if="statusText" class="imagine-status" aria-live="polite">{{ statusText }}</p>
      </section>

      <!-- 右：结果面板 -->
      <section class="card card-pad panel-right">
        <div class="right-head">
          <h3 class="card-title">{{ resultUrl ? '你的图片已就绪' : '生成结果' }}</h3>
          <span class="right-sub">{{ generating ? '请保持页面打开' : '生成约需 1–3 分钟' }}</span>
        </div>

        <div class="stage" :class="{ filled: !!resultUrl }">
          <img v-if="resultUrl" :src="resultUrl" alt="生成结果" />
          <div v-else-if="generating" class="stage-state">
            <span class="spinner stage-spinner" />
            <span class="stage-text">{{ Math.round(progress) }}%</span>
            <div class="pbar stage-bar"><i :style="{ width: `${progress}%` }" /></div>
          </div>
          <div v-else class="stage-state">
            <Icon name="image" :size="44" />
            <span class="stage-text">生成的图片会显示在这里</span>
          </div>
        </div>

        <div v-if="resultUrl" class="right-actions">
          <button class="btn btn-light" type="button" @click="download">
            <Icon name="download" :size="15" />下载图片
          </button>
          <button class="btn btn-ghost" type="button" @click="setRefFromUrl(resultUrl)">
            <Icon name="image" :size="15" />设为参考图
          </button>
        </div>

        <div class="works">
          <div class="works-head">
            <strong>我的作品</strong>
            <span>{{ works.length }}/{{ 24 }} · 仅存本机</span>
          </div>
          <div v-if="works.length" class="works-strip">
            <div v-for="w in works" :key="w.id" class="work">
              <button class="work-thumb" type="button" :title="w.prompt" @click="openWork(w)">
                <img :src="w.imageUrl" alt="作品" loading="lazy" />
              </button>
              <button class="work-del" type="button" aria-label="删除作品" @click="removeWork(w)">
                <Icon name="x" :size="12" />
              </button>
            </div>
          </div>
          <p v-else class="works-empty">暂无作品，生成后自动保存在本机</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.imagine-grid {
  display: grid;
  grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

/* ---------- 左：控制 ---------- */
.seg {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 4px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(3, 7, 17, 0.45);
  margin-bottom: 18px;
}

.seg-btn {
  padding: 8px 0;
  border-radius: 9px;
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  transition: background 0.16s var(--ease), color 0.16s var(--ease);
}

.seg-btn.active {
  color: var(--on-grad);
  background: var(--grad-cta);
  box-shadow: 0 4px 14px rgba(46, 107, 246, 0.35);
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

.prompt-block {
  margin-bottom: 4px;
}

.prompt-wrap {
  position: relative;
}

.prompt-input {
  width: 100%;
  min-height: 128px;
  resize: vertical;
  padding: 13px 14px 26px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-input);
  color: var(--text);
  font-size: 14.5px;
  line-height: 1.65;
  box-shadow: inset 0 1px 3px rgba(1, 3, 9, 0.35);
}

.prompt-input::placeholder {
  color: var(--text-3);
}

.prompt-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3.5px var(--accent-glow);
}

.counter {
  position: absolute;
  right: 12px;
  bottom: 9px;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

.ref-slot {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 12px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: rgba(11, 17, 33, 0.4);
  cursor: pointer;
  color: var(--text-2);
}

.ref-slot input {
  display: none;
}

.ref-slot:hover,
.ref-slot.filled {
  border-color: var(--accent-border);
  background: rgba(62, 123, 250, 0.05);
}

.ref-slot img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 10px;
  flex-shrink: 0;
}

.ref-plus {
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

.ref-copy {
  flex: 1;
  min-width: 0;
}

.ref-copy strong {
  display: block;
  font-size: 13.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-copy small {
  color: var(--text-3);
  font-size: 12px;
}

.size-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.size-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 6px 12px 6px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(3, 7, 17, 0.4);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}

.size-chip:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.size-chip.active {
  color: #fff;
  border-color: transparent;
  background: var(--grad-cta);
  box-shadow: 0 4px 16px rgba(46, 107, 246, 0.35);
}

.size-box {
  display: block;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  opacity: 0.85;
  flex-shrink: 0;
}

.gen-row {
  display: flex;
  gap: 8px;
  margin-top: 18px;
}

.imagine-error {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--danger);
}

.imagine-status {
  margin: 12px 0 0;
  font-size: 12.5px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* ---------- 右：结果 ---------- */
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
  padding: 0;
  background: rgba(3, 7, 17, 0.6);
}

.stage img {
  width: 100%;
  max-height: 560px;
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

.stage-bar {
  width: min(280px, 70%);
  margin-top: 2px;
}

.right-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 14px;
}

/* ---------- 我的作品 ---------- */
.works {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.works-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.works-head strong {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text);
}

.works-head span {
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.works-strip {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 6px;
  scrollbar-width: thin;
}

.work {
  position: relative;
  flex-shrink: 0;
}

.work-thumb {
  display: block;
  width: 92px;
  height: 92px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface-input);
  padding: 0;
}

.work-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.work-thumb:hover {
  border-color: var(--accent-border);
}

.work-del {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  background: rgba(4, 10, 22, 0.72);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(163, 190, 255, 0.16);
  opacity: 0;
  transition: opacity 0.15s var(--ease);
}

.work:hover .work-del {
  opacity: 1;
}

.works-empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
}

/* ---------- 响应式 ---------- */
@media (max-width: 960px) {
  .imagine-grid {
    grid-template-columns: 1fr;
  }

  .stage {
    min-height: 240px;
  }
}
</style>
