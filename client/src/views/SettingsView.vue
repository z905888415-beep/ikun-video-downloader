<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'

const store = useAppStore()
const saved = ref(false)

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

onMounted(() => {
  void store.refreshDownloadStats()
})

const form = reactive({
  concurrency: 2,
  maxAttempts: 3,
  retries: 10,
  autoCleanupEnabled: true,
  retentionHours: 24,
  maxDownloadSizeGB: 5,
  historyLimit: 30,
  redfoxApiKey: '',
  cookiesFile: '',
  proxy: ''
})

watch(
  () => store.settings,
  (s) => {
    if (!s) return
    form.concurrency = s.concurrency
    form.maxAttempts = s.maxAttempts ?? 3
    form.retries = s.retries
    form.autoCleanupEnabled = s.autoCleanupEnabled !== false
    form.retentionHours = s.retentionHours || 24
    form.maxDownloadSizeGB = s.maxDownloadSizeGB || 5
    form.historyLimit = s.historyLimit || 30
    form.redfoxApiKey = s.redfoxApiKey || ''
    form.cookiesFile = s.cookiesFile || ''
    form.proxy = s.proxy || ''
  },
  { immediate: true }
)

async function save(): Promise<void> {
  await store.saveSettings({ ...form })
  saved.value = true
  setTimeout(() => { saved.value = false }, 2000)
}

async function refresh(): Promise<void> {
  await store.refreshBinary()
}
</script>

<template>
  <div class="settings-view">
    <div class="page-head">
      <h2>设置</h2>
      <p>核心组件状态、下载参数与存储清理</p>
    </div>

    <div class="settings-grid stagger">
      <!-- 核心组件 -->
      <div class="card card-pad span-2">
        <div class="section-header" style="margin-bottom: 18px">
          <h3 class="card-title">核心组件</h3>
          <button class="btn btn-ghost btn-sm" type="button" @click="refresh">
            <Icon name="refresh" :size="13" />
            刷新状态
          </button>
        </div>
        <div class="binary-box">
          <div class="binary-item" :class="store.binary?.ytdlpOk ? 'ok' : 'bad'">
            <div class="binary-top">
              <Icon name="cpu" :size="16" />
              <strong>yt-dlp</strong>
              <span class="binary-state">{{ store.binary?.ytdlpOk ? '正常' : '缺失' }}</span>
            </div>
            <span class="binary-path">{{ store.binary?.version || store.binary?.ytdlp || '-' }}</span>
          </div>
          <div class="binary-item" :class="store.binary?.ffmpegOk ? 'ok' : 'bad'">
            <div class="binary-top">
              <Icon name="cpu" :size="16" />
              <strong>FFmpeg</strong>
              <span class="binary-state">{{ store.binary?.ffmpegOk ? '正常' : '缺失' }}</span>
            </div>
            <span class="binary-path">{{ store.binary?.ffmpeg || '-' }}</span>
          </div>
        </div>
        <p class="hint">
          <Icon name="folder" :size="13" style="vertical-align: -2px; margin-right: 5px" />
          下载文件保存在：web/downloads（服务器本地，过期自动清理）
        </p>
      </div>

      <!-- 下载参数 -->
      <div class="card card-pad span-2">
        <h3 class="card-title" style="margin-bottom: 18px">下载参数</h3>
        <div class="fields-grid">
          <div class="field" style="margin-bottom: 0">
            <label>任务并发数（1-8）</label>
            <input v-model.number="form.concurrency" class="input" type="number" min="1" max="8" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>最大重试次数</label>
            <input v-model.number="form.maxAttempts" class="input" type="number" min="0" max="10" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>网络重试次数</label>
            <input v-model.number="form.retries" class="input" type="number" min="0" max="100" />
          </div>
        </div>

        <div class="save-row">
          <button class="btn btn-primary" type="button" @click="save">
            <Icon v-if="saved" name="check" :size="15" />
            <Icon v-else name="download" :size="15" />
            {{ saved ? '已保存' : '保存设置' }}
          </button>
        </div>
        <p class="hint" style="margin: 6px 0 0">
          任务并发数即时生效；最大重试次数重启服务后生效。
        </p>
      </div>

      <!-- 自动清理 -->
      <div class="card card-pad span-2">
        <h3 class="card-title" style="margin-bottom: 6px">自动清理</h3>
        <p class="hint" style="margin-top: 0; margin-bottom: 10px">
          过期文件与已结束任务按保留时长自动删除（每 30 分钟检查一次），小硬盘服务器建议开启
        </p>
        <div class="toggle-row">
          <div>
            <strong>启用自动清理</strong>
            <small>清理下载目录中的过期文件</small>
          </div>
          <label class="switch">
            <input v-model="form.autoCleanupEnabled" type="checkbox" />
            <span />
          </label>
        </div>
        <div class="field" style="margin-top: 14px; margin-bottom: 0">
          <label>保留时长（小时，1-720）</label>
          <input v-model.number="form.retentionHours" class="input" type="number" min="1" max="720" />
        </div>
        <div class="save-row">
          <button class="btn btn-primary" type="button" @click="save">
            <Icon v-if="saved" name="check" :size="15" />
            {{ saved ? '已保存' : '保存清理设置' }}
          </button>
        </div>
        <p class="hint" style="margin-bottom: 0">
          系统每 30 分钟自动清理一次过期文件与已结束任务，无需手动触发
        </p>
      </div>

      <!-- 容量管理 -->
      <div class="card card-pad span-2">
        <h3 class="card-title" style="margin-bottom: 6px">容量管理</h3>
        <p class="hint" style="margin-top: 0; margin-bottom: 10px">
          下载目录超限时自动删除最旧的任务文件；历史记录最多缓存指定条数，超出自动清理最早的记录
        </p>
        <div class="storage-usage">
          <div class="meter-row">
            <div class="meter">
              <div
                class="meter-fill"
                :class="{ warn: (store.downloadStats?.usedPercent ?? 0) >= 80 }"
                :style="{ width: Math.min(100, store.downloadStats?.usedPercent ?? 0) + '%' }"
              />
            </div>
            <span class="usage-text">
              {{ formatBytes(store.downloadStats?.usedBytes ?? 0) }}/{{
                formatBytes(store.downloadStats?.maxBytes ?? 0)
              }}
            </span>
          </div>
        </div>
        <div class="fields-grid" style="margin-top: 14px">
          <div class="field" style="margin-bottom: 0">
            <label>下载目录容量上限（GB，1-100）</label>
            <input v-model.number="form.maxDownloadSizeGB" class="input" type="number" min="1" max="100" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>历史记录保留条数（5-500）</label>
            <input v-model.number="form.historyLimit" class="input" type="number" min="5" max="500" />
          </div>
        </div>
        <div class="save-row">
          <button class="btn btn-primary" type="button" @click="save">
            <Icon v-if="saved" name="check" :size="15" />
            <Icon v-else name="download" :size="15" />
            {{ saved ? '已保存' : '保存容量设置' }}
          </button>
        </div>
        <p class="hint" style="margin-bottom: 0">
          历史记录达到上限后，最早的完成/失败记录会被自动移除，下载文件本身不受影响（文件按时间与容量清理）
        </p>
      </div>

      <!-- 高级 -->
      <div class="card card-pad span-2">
        <h3 class="card-title" style="margin-bottom: 18px">高级</h3>
        <div class="fields-grid">
          <div class="field" style="margin-bottom: 0">
            <label>Redfox API Key</label>
            <input v-model="form.redfoxApiKey" class="input" type="text" placeholder="redfox.hk 注册后获取（抖音/小红书等无水印解析）" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>代理地址（可选）</label>
            <input v-model="form.proxy" class="input" type="text" placeholder="http://127.0.0.1:7890" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>Cookies 文件路径</label>
            <input v-model="form.cookiesFile" class="input" type="text" placeholder="需要登录的站点填写 cookies.txt 路径" />
          </div>
        </div>
        <div class="save-row">
          <button class="btn btn-primary" type="button" @click="save">
            <Icon v-if="saved" name="check" :size="15" />
            {{ saved ? '已保存' : '保存高级设置' }}
          </button>
        </div>
        <p class="hint" style="margin: 6px 0 0">
          Redfox Key、Cookies 与代理重启服务后生效。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.span-2 {
  grid-column: span 2;
}

.binary-box {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.binary-item {
  padding: 13px 15px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--bg);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.binary-item.ok {
  border-color: var(--success-border);
}

.binary-item.bad {
  border-color: var(--danger-border);
}

.binary-top {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
}

.binary-state {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--r-full);
}

.binary-item.ok .binary-state {
  color: var(--success);
  background: var(--success-bg);
}

.binary-item.bad .binary-state {
  color: var(--danger);
  background: var(--danger-bg);
}

.binary-path {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fields-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.save-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.storage-usage {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
}

.meter-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.meter {
  flex: 1;
  height: 8px;
  border-radius: var(--r-full);
  background: var(--surface);
  overflow: hidden;
}

.meter-fill {
  height: 100%;
  border-radius: var(--r-full);
  background: var(--success);
  transition: width 0.4s ease;
}

.meter-fill.warn {
  background: var(--warning);
}

.usage-text {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

@media (max-width: 720px) {
  .settings-grid {
    grid-template-columns: 1fr;
  }

  .span-2 {
    grid-column: span 1;
  }

  .binary-box,
  .fields-grid {
    grid-template-columns: 1fr;
  }
}
</style>
