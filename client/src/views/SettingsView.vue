<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'

const store = useAppStore()

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let value = bytes
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

onMounted(() => {
  void store.refreshDownloadStats()
})
</script>

<template>
  <div class="settings-view">
    <div class="page-head">
      <h2>服务状态</h2>
      <p>这是公开网站。运行参数由服务器管理员配置，访客无需登录即可使用。</p>
    </div>

    <div class="settings-grid stagger">
      <section class="card card-pad span-2">
        <div class="section-header">
          <h3 class="card-title">核心组件</h3>
          <button class="btn btn-ghost btn-sm" type="button" @click="store.refreshBinary()">
            <Icon name="refresh" :size="13" />刷新状态
          </button>
        </div>
        <div class="binary-box">
          <div class="binary-item" :class="store.binary?.ytdlpOk ? 'ok' : 'bad'">
            <strong>yt-dlp</strong>
            <span class="binary-state">{{ store.binary?.ytdlpOk ? '正常' : '缺失' }}</span>
            <small>{{ store.binary?.version || '-' }}</small>
          </div>
          <div class="binary-item" :class="store.binary?.ffmpegOk ? 'ok' : 'bad'">
            <strong>FFmpeg</strong>
            <span class="binary-state">{{ store.binary?.ffmpegOk ? '正常' : '缺失' }}</span>
            <small>{{ store.binary?.ffmpeg || '-' }}</small>
          </div>
        </div>
      </section>

      <section class="card card-pad span-2">
        <h3 class="card-title">存储与清理</h3>
        <div class="meter-row">
          <div class="meter"><i :style="{ width: Math.min(100, store.downloadStats?.usedPercent ?? 0) + '%' }" /></div>
          <strong>{{ formatBytes(store.downloadStats?.usedBytes ?? 0) }}/{{ formatBytes(store.downloadStats?.maxBytes ?? 0) }}</strong>
        </div>
        <p class="hint">历史记录：{{ store.downloadStats?.historyCount ?? 0 }}/{{ store.downloadStats?.historyLimit ?? 0 }}。过期文件和超过容量的旧任务由服务器自动清理。</p>
      </section>

      <section class="card card-pad span-2">
        <h3 class="card-title">公开站点保护</h3>
        <ul class="hint list">
          <li>无需登录；解析、创建下载任务和 AI 抠图均按访问 IP 限流。</li>
          <li>yt-dlp 的 Cookies、代理、并发和重试参数只在服务器的设置文件或环境变量中维护，不会暴露给访问者。</li>
          <li>如需变更运行参数，请联系站点管理员；网页端不提供敏感配置写入。</li>
        </ul>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.span-2 { grid-column: span 2; }
.section-header, .meter-row { display: flex; align-items: center; gap: 12px; }
.section-header { justify-content: space-between; margin-bottom: 18px; }
.binary-box { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.binary-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background:
    linear-gradient(180deg, rgba(151, 184, 255, 0.05), rgba(151, 184, 255, 0.015) 42%),
    rgba(11, 17, 33, 0.55);
}
.binary-item strong { font-family: var(--font-mono); letter-spacing: -0.01em; }
.binary-item small { grid-column: 1 / -1; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.binary-item.ok { border-color: var(--success-border); box-shadow: inset 0 0 24px rgba(74, 222, 128, 0.05); }
.binary-item.bad { border-color: var(--danger-border); box-shadow: inset 0 0 24px rgba(255, 138, 122, 0.05); }
.binary-state { font-size: 12px; font-weight: 650; color: var(--text-2); }
.binary-item.ok .binary-state { color: var(--success); }
.binary-item.bad .binary-state { color: var(--danger); }
.meter { flex: 1; height: 8px; border-radius: var(--r-full); overflow: hidden; background: rgba(148, 180, 255, 0.12); }
.meter i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #5b8fff, #2e6bf6); box-shadow: 0 0 10px rgba(62, 123, 250, 0.4); }
.hint { color: var(--text-2); line-height: 1.7; }
.list { margin: 8px 0 0; padding-left: 20px; }
.list li::marker { color: var(--accent); }
@media (max-width: 720px) { .settings-grid, .binary-box { grid-template-columns: 1fr; } .span-2 { grid-column: span 1; } }
</style>
