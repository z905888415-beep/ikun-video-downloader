<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiV2 } from '../api/client'
import { useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'
import { canShareFilesToAlbum, saveUrlToAlbum } from '../lib/save-to-album'

const store = useAppStore()
const query = ref('')
const albumSupported = canShareFilesToAlbum()
const albumBusy = ref<Record<string, boolean>>({})

async function saveItemToAlbum(item: { id: string; filename?: string }): Promise<void> {
  if (albumBusy.value[item.id]) return
  albumBusy.value = { ...albumBusy.value, [item.id]: true }
  try {
    const result = await saveUrlToAlbum(apiV2.fileUrl(item.id), item.filename || 'video')
    store.setNotice(result === 'saved' ? '已存入相册' : '已取消保存')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    store.setNotice(/NotAllowedError/i.test(msg) ? '文件较大或未授权，请用「下载文件」后到文件 App 存入相册' : msg)
  } finally {
    albumBusy.value = { ...albumBusy.value, [item.id]: false }
  }
}

onMounted(() => {
  store.startV2Polling()
  void store.refreshV2Jobs()
  void store.refreshDownloadStats()
})

const FINAL_STATUS = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']

const historyItems = computed(() => store.v2Jobs.filter((j) => FINAL_STATUS.includes(j.status)))

const historyFull = computed(
  () => !!store.downloadStats && store.downloadStats.historyCount >= store.downloadStats.historyLimit
)

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return historyItems.value
  return historyItems.value.filter(
    (item) =>
      (item.filename || '').toLowerCase().includes(q) || item.sourceUrl.toLowerCase().includes(q)
  )
})

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString()
  } catch {
    return String(ts)
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    COMPLETED: '已完成',
    FAILED: '失败',
    CANCELLED: '已取消',
    EXPIRED: '已过期'
  }
  return map[status] || status
}
</script>

<template>
  <div class="history-view">
    <div class="page-head">
      <h2>历史记录</h2>
      <p>本机 {{ historyItems.length }} 条记录 · 列表仅显示当前浏览器创建的任务</p>
    </div>

    <!-- 缓存与容量提示 -->
    <div class="stats-strip">
      <div class="stat-cell">
        <span class="stat-label">服务端缓存</span>
        <span class="stat-value">
          {{ store.downloadStats?.historyCount ?? historyItems.length }}/{{ store.downloadStats?.historyLimit ?? 30 }}
          <span v-if="historyFull" class="stat-warn">已满</span>
        </span>
      </div>
      <div class="stat-cell stat-cell-wide">
        <span class="stat-label">下载空间</span>
        <div class="meter-row">
          <div class="meter">
            <div
              class="meter-fill"
              :class="{ warn: (store.downloadStats?.usedPercent ?? 0) >= 80 }"
              :style="{ width: Math.min(100, store.downloadStats?.usedPercent ?? 0) + '%' }"
            />
          </div>
          <span class="stat-value">
            {{ formatBytes(store.downloadStats?.usedBytes ?? 0) }}/{{ formatBytes(store.downloadStats?.maxBytes ?? 0) }}
          </span>
        </div>
      </div>
    </div>
    <p class="history-hint">
      服务端缓存为所有访客共享，最多保留最近 {{ store.downloadStats?.historyLimit ?? 30 }} 条，超出后最早的记录将自动清理；
      下载目录超过容量上限时按最旧优先自动删除任务文件（每 30 分钟检查一次）。
    </p>

    <div v-if="historyItems.length" class="section-header">
      <div class="search-box">
        <Icon name="search" :size="15" />
        <input v-model="query" class="search-input" type="search" placeholder="搜索标题或链接…" />
      </div>
    </div>

    <div v-if="!historyItems.length" class="card empty-card">
      <div class="empty-orb"><Icon name="clock" :size="34" /></div>
      <div class="empty-title">暂无历史</div>
      <div class="empty-desc">完成或失败的任务会出现在这里</div>
    </div>

    <div v-else-if="!filtered.length" class="card empty-card">
      <div class="empty-orb"><Icon name="search" :size="34" /></div>
      <div class="empty-title">没有匹配的记录</div>
      <div class="empty-desc">换个关键词试试</div>
    </div>

    <div v-else class="history-list stagger">
      <div v-for="item in filtered" :key="item.id" class="card history-card">
        <div class="history-main">
          <div class="history-head">
            <div class="history-title">{{ item.filename || item.sourceUrl }}</div>
            <span class="status-pill" :class="item.status">
              {{ statusLabel(item.status) }}
            </span>
          </div>
          <div class="history-sub">{{ item.sourceUrl }}</div>
          <div class="history-time">{{ formatTime(item.updatedAt) }}</div>
          <div v-if="item.error" class="history-error">{{ item.error.message }}</div>
        </div>
        <div class="history-actions">
          <button
            v-if="albumSupported && item.status === 'COMPLETED' && item.filepath"
            class="btn btn-sm"
            type="button"
            :disabled="albumBusy[item.id]"
            @click="saveItemToAlbum(item)"
          >
            <Icon name="share" :size="13" />
            存入相册
          </button>
          <a
            v-if="item.status === 'COMPLETED' && item.filepath"
            class="btn btn-light btn-sm"
            :href="apiV2.fileUrl(item.id)"
            download
          >
            <Icon name="download" :size="13" />
            下载文件
          </a>
          <button
            v-if="item.status === 'FAILED'"
            class="btn btn-ghost btn-sm"
            type="button"
            @click="store.retryV2Job(item.id)"
          >
            <Icon name="refresh" :size="13" />
            重试
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- Statistic 统计数值卡（站酷参考「❙ 标签 + 大数字」） ---------- */
.stats-strip {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 12px;
  align-items: stretch;
  margin-bottom: 4px;
}

.stat-cell {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 150px;
  padding: 14px 18px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background:
    linear-gradient(180deg, rgba(151, 184, 255, 0.05), rgba(151, 184, 255, 0.015) 42%),
    rgba(11, 17, 33, 0.55);
}

.stat-cell-wide {
  min-width: 220px;
}

.stat-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
  color: var(--text-2);
}

.stat-label::before {
  content: '';
  width: 3px;
  height: 11px;
  border-radius: var(--r-full);
  background: linear-gradient(180deg, #5b8fff, #2e6bf6);
  box-shadow: 0 0 8px rgba(62, 123, 250, 0.55);
}

.stat-value {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.meter-row .stat-value {
  font-size: 13px;
  font-weight: 650;
}

.stat-warn {
  margin-left: 6px;
  padding: 1px 7px;
  border-radius: var(--r-full);
  font-size: 10.5px;
  font-weight: 650;
  color: var(--warn);
  background: var(--warn-bg);
  border: 1px solid var(--warn-border);
}

.meter-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.meter {
  flex: 1;
  height: 7px;
  border-radius: var(--r-full);
  background: rgba(148, 180, 255, 0.12);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  border-radius: var(--r-full);
  background: linear-gradient(90deg, #5b8fff, #2e6bf6);
  box-shadow: 0 0 10px rgba(62, 123, 250, 0.4);
  transition: width 0.4s var(--ease);
}

.meter-fill.warn {
  background: linear-gradient(90deg, var(--warn), var(--danger));
}

.history-hint {
  margin: 8px 2px 14px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 200px;
  max-width: 340px;
  padding: 0 14px;
  border-radius: var(--r-full);
  border: 1px solid var(--border);
  background: rgba(3, 7, 17, 0.45);
  color: var(--text-3);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3.5px var(--accent-glow);
}

.search-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 13px;
  padding: 8px 0;
}

.search-input::placeholder {
  color: var(--text-3);
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.history-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 13px 16px;
  transition: border-color 0.18s var(--ease), transform 0.18s var(--ease-spring);
}

.history-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.history-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.history-title {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-sub {
  font-size: 12px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-time {
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.history-error {
  font-size: 12px;
  color: var(--danger);
}

.history-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
}

@media (max-width: 560px) {
  .stats-strip {
    grid-template-columns: 1fr;
  }

  .history-card {
    flex-direction: column;
    align-items: stretch;
  }

  .history-actions {
    justify-content: flex-start;
  }
}
</style>
