<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const iframe = ref<HTMLIFrameElement | null>(null)
const frameHeight = ref(680)
let resizeTimer: number | null = null

const THEME_VARS: Record<string, string> = {
  '--background': '#f5f5f7',
  '--foreground': '#1d1d1f',
  '--card': '#ffffff',
  '--card-foreground': '#1d1d1f',
  '--primary': '#0071e3',
  '--primary-foreground': '#ffffff',
  '--secondary': 'rgba(120, 120, 128, 0.08)',
  '--secondary-foreground': '#1d1d1f',
  '--muted': 'rgba(120, 120, 128, 0.1)',
  '--muted-foreground': '#6e6e73',
  '--border': 'rgba(0, 0, 0, 0.08)',
  '--ring': 'rgba(0, 113, 227, 0.35)'
}

function pushTheme(): void {
  const win = iframe.value?.contentWindow
  if (!win) return
  win.postMessage({ type: 'ikun:embedded' }, window.location.origin)
  win.postMessage({ type: 'ikun:theme', vars: THEME_VARS }, window.location.origin)
}

function onMessage(event: MessageEvent): void {
  if (event.origin !== window.location.origin) return
  const data = event.data
  if (!data || typeof data !== 'object' || data.type !== 'ikun:resize') return
  const h = Number(data.height)
  if (Number.isFinite(h) && h > 0) frameHeight.value = Math.ceil(h) + 20
}

function onFrameLoad(): void {
  pushTheme()
}

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  if (resizeTimer != null) window.clearTimeout(resizeTimer)
})
</script>

<template>
  <div class="suanle-view">
    <iframe
      ref="iframe"
      class="suanle-frame"
      src="/suanle/tools/?embedded=1"
      title="算了么命理工具箱"
      :style="{ height: frameHeight + 'px' }"
      @load="onFrameLoad"
    />
  </div>
</template>

<style scoped>
.suanle-view {
  display: flex;
  flex-direction: column;
}

.suanle-frame {
  display: block;
  width: 100%;
  min-height: 480px;
  border: 0;
  background: var(--bg);
}
</style>
