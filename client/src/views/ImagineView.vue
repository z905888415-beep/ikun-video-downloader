<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import Icon from '../components/Icon.vue'
import { generateImage, generateImageEdit } from '../lib/image-generate'

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

interface RefItem {
  key: string
  name: string
  url: string
  file: File
}

const REFS_MAX = 4
const refs = ref<RefItem[]>([])
let refSeq = 0

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

function addRefFiles(files: Array<File | null | undefined>): void {
  for (const file of files) {
    if (!file) continue
    if (!file.type.startsWith('image/')) {
      errorMsg.value = '请选择图片文件作为参考图'
      continue
    }
    if (file.size > 10 * 1024 * 1024) {
      errorMsg.value = '参考图不能超过 10MB'
      continue
    }
    if (refs.value.length >= REFS_MAX) {
      errorMsg.value = `最多添加 ${REFS_MAX} 张参考图`
      break
    }
    errorMsg.value = ''
    refSeq += 1
    refs.value = [...refs.value, {
      key: `ref_${Date.now()}_${refSeq}`,
      name: file.name || `参考图${refs.value.length + 1}`,
      url: URL.createObjectURL(file),
      file
    }]
  }
}

function onRefInput(e: Event): void {
  addRefFiles([...((e.target as HTMLInputElement).files || [])])
  ;(e.target as HTMLInputElement).value = ''
}

function onRefDrop(e: DragEvent): void {
  addRefFiles([...(e.dataTransfer?.files || [])])
}

function removeRef(key: string): void {
  const item = refs.value.find((r) => r.key === key)
  if (item?.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
  refs.value = refs.value.filter((r) => r.key !== key)
}

function addRefFromUrl(url: string, name: string): void {
  if (refs.value.length >= REFS_MAX) {
    errorMsg.value = `参考图已满 ${REFS_MAX} 张，已替换最后一张`
    removeRef(refs.value[refs.value.length - 1].key)
  }
  refSeq += 1
  refs.value = [...refs.value, { key: `ref_${Date.now()}_${refSeq}`, name, url, file: null as unknown as File }]
}

async function resolveRefFile(item: RefItem): Promise<File> {
  if (item.file && item.file.size > 0) return item.file
  const blob = await (await fetch(item.url)).blob()
  const file = new File([blob], item.name, { type: blob.type || 'image/png' })
  item.file = file
  return file
}

async function setRefFromUrl(url: string): Promise<void> {
  try {
    const blob = await (await fetch(url)).blob()
    const file = new File([blob], 'generated.png', { type: blob.type || 'image/png' })
    addRefFiles([file])
    mode.value = 'image'
    statusText.value = `已添加为 图${refs.value.length}，可用 @图${refs.value.length} 指代它`
  } catch {
    errorMsg.value = '参考图获取失败'
  }
}

function maxMentionedRef(promptText: string): number {
  const matches = [...promptText.matchAll(/@图\s*(\d{1,2})/g)].map((m) => Number(m[1]))
  return matches.length ? Math.max(...matches) : 0
}

/* ---------- @ 提及选择器：输入 @ 弹出参考图预览 ---------- */
const promptEl = ref<HTMLTextAreaElement | null>(null)
const mention = ref<{ start: number; query: string } | null>(null)
let mentionBlurTimer: number | null = null

const mentionFiltered = computed(() => {
  const m = mention.value
  if (!m) return []
  return refs.value
    .map((r, i) => ({ r, idx: i + 1 }))
    .filter(({ idx }) => !m.query || String(idx).startsWith(m.query))
})

function updateMention(): void {
  if (mode.value !== 'image' || !refs.value.length || !promptEl.value) {
    mention.value = null
    return
  }
  const pos = promptEl.value.selectionStart ?? prompt.value.length
  const before = prompt.value.slice(0, pos)
  const m = /@(?:图)?(\d{0,2})$/.exec(before)
  mention.value = m ? { start: pos - m[0].length, query: m[1] || '' } : null
}

function pickMention(idx: number): void {
  const m = mention.value
  if (!m) return
  const token = `@图${idx} `
  const caretEnd = promptEl.value?.selectionStart ?? prompt.value.length
  prompt.value = prompt.value.slice(0, m.start) + token + prompt.value.slice(caretEnd)
  mention.value = null
  void nextTick(() => {
    const el = promptEl.value
    if (!el) return
    el.focus()
    const caret = m.start + token.length
    el.setSelectionRange(caret, caret)
  })
}

function closeMention(): void {
  mention.value = null
}

function onPromptBlur(): void {
  mentionBlurTimer = window.setTimeout(() => {
    mention.value = null
    mentionBlurTimer = null
  }, 150)
}

function onPromptFocus(): void {
  if (mentionBlurTimer != null) {
    window.clearTimeout(mentionBlurTimer)
    mentionBlurTimer = null
  }
}

async function generate(): Promise<void> {
  if (generating.value) return
  errorMsg.value = ''
  if (!prompt.value.trim()) {
    errorMsg.value = '请先描述你想创造的画面'
    return
  }
  if (mode.value === 'image' && !refs.value.length) {
    errorMsg.value = '图生图需要先添加参考图'
    return
  }
  const mentioned = maxMentionedRef(prompt.value)
  if (mode.value === 'image' && mentioned > refs.value.length) {
    errorMsg.value = `提示词里引用了 @图${mentioned}，但只添加了 ${refs.value.length} 张参考图`
    return
  }
  // 发送前把 @图N 替换成模型更易理解的「第N张参考图」
  const sentPrompt = prompt.value.replace(/@图\s*(\d{1,2})/g, '第$1张参考图')
  generating.value = true
  progress.value = 4
  statusText.value = '正在提交生图任务…'
  resultUrl.value = ''
  abortController = new AbortController()
  try {
    const onProgress = (p: number): void => {
      progress.value = p
      statusText.value = p >= 100 ? '生成完成' : `生成中 ${Math.round(p)}%`
    }
    let url: string
    if (mode.value === 'image') {
      const files = []
      for (const item of refs.value) files.push(await resolveRefFile(item))
      url = await generateImageEdit({
        prompt: sentPrompt,
        size: size.value,
        files,
        signal: abortController.signal,
        onProgress
      })
    } else {
      url = await generateImage({
        prompt: prompt.value,
        size: size.value,
        signal: abortController.signal,
        onProgress
      })
    }
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
  if (mentionBlurTimer != null) window.clearTimeout(mentionBlurTimer)
  for (const item of refs.value) {
    if (item.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
  }
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
              ref="promptEl"
              v-model="prompt"
              class="prompt-input"
              maxlength="4000"
              aria-label="提示词"
              :placeholder="mode === 'image' ? '描述画面，输入 @ 选择参考图…' : '描述你想创造的画面…'"
              @input="updateMention"
              @click="updateMention"
              @keyup="updateMention"
              @focus="onPromptFocus"
              @blur="onPromptBlur"
              @keydown.esc.prevent="closeMention"
            />
            <span class="counter">{{ prompt.length }}/4000</span>
            <div v-if="mention && mentionFiltered.length" class="mention-pop" role="listbox" aria-label="选择参考图">
              <button
                v-for="{ r, idx } in mentionFiltered"
                :key="r.key"
                class="mention-item"
                type="button"
                role="option"
                :aria-selected="false"
                @mousedown.prevent
                @click="pickMention(idx)"
              >
                <img :src="r.url" alt="" />
                <span class="mention-tag">图{{ idx }}</span>
                <span class="mention-name">{{ r.name }}</span>
              </button>
            </div>
          </div>
        </div>

        <div v-if="mode === 'image'" class="block">
          <span class="block-label">参考图 · 最多 {{ REFS_MAX }} 张，用 @图1 @图2 指代</span>
          <div class="ref-grid" @dragover.prevent @drop.prevent="onRefDrop">
            <div v-for="(r, i) in refs" :key="r.key" class="ref-item" :title="r.name">
              <img :src="r.url" :alt="`参考图${i + 1}`" />
              <span class="ref-badge">图{{ i + 1 }}</span>
              <button class="ref-del" type="button" aria-label="移除参考图" @click="removeRef(r.key)">
                <Icon name="x" :size="12" />
              </button>
            </div>
            <label v-if="refs.length < REFS_MAX" class="ref-add">
              <input type="file" accept="image/jpeg,image/png,image/webp" multiple @change="onRefInput" />
              <Icon name="plus" :size="20" />
              <span>添加</span>
            </label>
          </div>
          <small class="ref-hint">拖拽或点击添加；在提示词里用 @图1 @图2 指代对应参考图</small>
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

.mention-pop {
  position: absolute;
  left: 10px;
  right: 10px;
  top: calc(100% + 6px);
  z-index: 40;
  padding: 5px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(13, 20, 32, 0.97);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: var(--shadow-pop);
  max-height: 250px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border-radius: 9px;
  text-align: left;
  transition: background 0.14s var(--ease);
}

.mention-item:hover {
  background: rgba(62, 123, 250, 0.12);
}

.mention-item img {
  width: 38px;
  height: 38px;
  object-fit: cover;
  border-radius: 8px;
  flex-shrink: 0;
  border: 1px solid var(--border);
}

.mention-tag {
  padding: 1px 8px;
  border-radius: var(--r-full);
  font-size: 11px;
  font-weight: 700;
  color: var(--on-grad);
  background: var(--grad-cta);
  flex-shrink: 0;
}

.mention-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ref-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.ref-item {
  position: relative;
  width: 84px;
  height: 84px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--surface-input);
}

.ref-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.ref-badge {
  position: absolute;
  left: 6px;
  top: 6px;
  padding: 1px 7px;
  border-radius: var(--r-full);
  font-size: 10.5px;
  font-weight: 700;
  color: var(--on-grad);
  background: var(--grad-cta);
  box-shadow: 0 2px 8px rgba(46, 107, 246, 0.45);
}

.ref-del {
  position: absolute;
  right: 5px;
  top: 5px;
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

.ref-item:hover .ref-del {
  opacity: 1;
}

.ref-add {
  width: 84px;
  height: 84px;
  border-radius: 12px;
  border: 1.5px dashed var(--border-strong);
  background: rgba(11, 17, 33, 0.4);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  color: var(--accent-hover);
  font-size: 11.5px;
  font-weight: 600;
}

.ref-add input {
  display: none;
}

.ref-add:hover {
  border-color: var(--accent);
  background: rgba(62, 123, 250, 0.05);
}

.ref-hint {
  color: var(--text-3);
  font-size: 12px;
  line-height: 1.6;
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
