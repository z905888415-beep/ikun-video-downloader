<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import Icon from '../components/Icon.vue'
import { REFS_MAX, useImagineStore } from '../stores/imagine'

// 生成状态与作品缓存都常驻 Pinia store：切换页面不打断生成，返回即见进度与结果
const store = useImagineStore()
const { mode, prompt, size, refs, generating, progress, statusText, errorMsg, resultUrl, works } = storeToRefs(store)

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

function onRefInput(e: Event): void {
  store.addRefFiles([...((e.target as HTMLInputElement).files || [])])
  ;(e.target as HTMLInputElement).value = ''
}

function onRefDrop(e: DragEvent): void {
  store.addRefFiles([...(e.dataTransfer?.files || [])])
}

function removeRef(key: string): void {
  store.removeRef(key)
}

function setRefFromUrl(url: string): void {
  void store.setRefFromUrl(url)
}

function generate(): void {
  void store.generate()
}

function cancel(): void {
  store.cancel()
}

function openWork(work: { id: string; prompt: string; imageUrl: string }): void {
  store.openWork(work)
}

function removeWork(work: { id: string; imageUrl: string }): void {
  void store.removeWork(work)
}

function download(): void {
  store.downloadResult()
}

onMounted(() => {
  void store.initWorks()
})

onBeforeUnmount(() => {
  // 不中止生成：store 常驻，切页后继续跑，返回即见进度/结果
  if (mentionBlurTimer != null) window.clearTimeout(mentionBlurTimer)
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
            <span>{{ works.length }}/10 · 仅存本机</span>
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
          <p v-else class="works-empty">暂无作品 · 保留最近 10 次生成，存本机</p>
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
