<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const iframe = ref<HTMLIFrameElement | null>(null)
const frameHeight = ref(680)
let themeTimers: number[] = []

const THEME_VARS: Record<string, string> = {
  '--background': '#0b1120',
  '--foreground': '#eef3ff',
  '--card': '#111a2e',
  '--card-foreground': '#eef3ff',
  '--primary': '#3e7bfa',
  '--primary-foreground': '#ffffff',
  '--secondary': 'rgba(148, 180, 255, 0.1)',
  '--secondary-foreground': '#eef3ff',
  '--muted': 'rgba(148, 180, 255, 0.12)',
  '--muted-foreground': 'rgba(233, 240, 255, 0.62)',
  '--border': 'rgba(163, 190, 255, 0.14)',
  '--ring': 'rgba(62, 123, 250, 0.45)'
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
  if (!data || typeof data !== 'object') return
  if (data.type === 'ikun:resize') {
    // 收到 resize 说明子应用监听器已就绪，补发主题（load 时机可能早于水合完成）
    pushTheme()
    const h = Number(data.height)
    if (Number.isFinite(h) && h > 0) frameHeight.value = Math.ceil(h) + 20
  }
}

function onFrameLoad(): void {
  pushTheme()
  themeTimers.forEach((t) => window.clearTimeout(t))
  themeTimers = [300, 800, 1600, 3000, 5000].map((d) => window.setTimeout(pushTheme, d))
}

onMounted(() => {
  window.addEventListener('message', onMessage)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage)
  themeTimers.forEach((t) => window.clearTimeout(t))
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
  border-radius: var(--r-lg);
  background: #0b1120;
}
</style>
