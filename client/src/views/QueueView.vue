<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { apiV2, type V2Job } from '../api/client'
import { useAppStore } from '../stores/app'
import Icon from '../components/Icon.vue'

const store = useAppStore()

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

function statusLabel(status: string): string {
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
</script>

<template>
  <div class="queue-view">
    <div class="page-head">
      <h2>下载队列</h2>
      <p>
        {{ store.v2Jobs.length }} 个任务
        <template v-if="runningCount"> · {{ runningCount }} 进行中</template>
        <template v-if="store.settings"> · 并发 {{ store.settings.concurrency }}</template>
      </p>
    </div>

    <div v-if="!store.v2Jobs.length" class="card empty-card">
      <div class="empty-orb"><Icon name="layers" :size="34" /></div>
      <div class="empty-title">暂无下载任务</div>
      <div class="empty-desc">在「解析下载」中粘贴链接，解析完成后开始下载</div>
      <div class="state-actions">
        <button class="btn btn-primary btn-sm" type="button" @click="store.page = 'home'">
          <Icon name="sparkles" :size="14" />
          去解析
        </button>
      </div>
    </div>

    <div v-else class="queue-sections">
      <!-- 进行中 -->
      <template v-if="activeTasks.length">
        <div class="group-label"><span class="group-dot live" />进行中 · {{ activeTasks.length }}</div>
        <div class="stagger">
          <div v-for="j in activeTasks" :key="j.id" class="card task-card">
            <div class="task-thumb">
              <Icon name="video" :size="22" />
            </div>
            <div class="task-main">
              <div class="task-head">
                <div class="task-title">{{ jobTitle(j) }}</div>
                <span class="status-pill" :class="j.status">{{ statusLabel(j.status) }}</span>
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

      <!-- 等待中 -->
      <template v-if="queuedTasks.length">
        <div class="group-label"><span class="group-dot wait" />等待中 · {{ queuedTasks.length }}</div>
        <div class="stagger">
          <div v-for="j in queuedTasks" :key="j.id" class="card task-card">
            <div class="task-thumb">
              <Icon name="video" :size="22" />
            </div>
            <div class="task-main">
              <div class="task-head">
                <div class="task-title">{{ jobTitle(j) }}</div>
                <span class="status-pill queued">{{ statusLabel(j.status) }}</span>
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

      <!-- 已结束 -->
      <template v-if="finishedTasks.length">
        <div class="group-label"><span class="group-dot done" />已结束 · {{ finishedTasks.length }}</div>
        <div class="stagger">
          <div v-for="j in finishedTasks" :key="j.id" class="card task-card dim">
            <div class="task-thumb">
              <Icon name="video" :size="22" />
            </div>
            <div class="task-main">
              <div class="task-head">
                <div class="task-title">{{ jobTitle(j) }}</div>
                <span class="status-pill" :class="j.status">{{ statusLabel(j.status) }}</span>
              </div>
              <div class="task-sub">
                {{ jobSub(j) }}
                <template v-if="j.filename"> · {{ j.filename }}</template>
              </div>
              <div v-if="j.error" class="task-meta"><span class="task-error">{{ j.error.message }}</span></div>
            </div>
            <div class="task-actions">
              <a
                v-if="j.status === 'COMPLETED' && j.filepath"
                class="btn btn-primary btn-sm"
                :href="apiV2.fileUrl(j.id)"
                download
              >
                <Icon name="download" :size="13" />
                保存文件
              </a>
              <button
                v-if="j.status === 'FAILED' || j.status === 'RETRY_WAIT' || j.status === 'CANCELLED'"
                class="btn btn-ghost btn-sm"
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
</template>

<style scoped>
.queue-sections {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.group-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
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
  background: var(--blue);
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
  padding: 12px 16px;
  transition: border-color 0.15s;
}

.task-card:hover {
  border-color: var(--border-strong);
}

.task-card.dim {
  opacity: 0.8;
}

.task-thumb {
  width: 80px;
  height: 50px;
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
  gap: 4px;
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
  color: var(--text);
  font-weight: 700;
}

.task-error {
  color: var(--danger);
}

.task-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex-shrink: 0;
}

.state-actions {
  margin-top: 16px;
}

@media (max-width: 640px) {
  .task-thumb {
    display: none;
  }

  .task-actions {
    flex-direction: row;
  }
}
</style>
