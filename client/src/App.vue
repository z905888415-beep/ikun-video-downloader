<script setup lang="ts">
import { onMounted } from 'vue'
import { useAppStore, type PageId } from './stores/app'
import Icon from './components/Icon.vue'
import HomeView from './views/HomeView.vue'
import ImagineView from './views/ImagineView.vue'
import ToolboxView from './views/ToolboxView.vue'
import HistoryView from './views/HistoryView.vue'
import SettingsView from './views/SettingsView.vue'

const store = useAppStore()

const pages: { id: PageId; label: string; short: string; icon: string }[] = [
  { id: 'home', label: '解析与下载', short: '解析', icon: 'sparkles' },
  { id: 'imagine', label: 'AI 生图', short: '生图', icon: 'image' },
  { id: 'tools', label: '工具箱', short: '工具', icon: 'grid' },
  { id: 'history', label: '历史记录', short: '历史', icon: 'clock' },
  { id: 'settings', label: '服务状态', short: '状态', icon: 'sliders' }
]

onMounted(() => {
  void store.init()
})
</script>

<template>
  <div class="app-shell">
    <header class="topnav">
      <button class="brand" type="button" @click="store.page = 'home'">
        <span class="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 22 22" fill="none">
            <circle cx="11" cy="11" r="8.5" stroke="currentColor" stroke-width="2.4" />
            <line x1="3.5" y1="18.5" x2="18.5" y2="3.5" stroke="currentColor" stroke-width="2.4" />
          </svg>
        </span>
        <span class="brand-name">iKun</span>
        <span v-if="store.version" class="brand-version">v{{ store.version }}</span>
      </button>

      <nav class="nav-links" aria-label="主导航">
        <button
          v-for="p in pages"
          :key="p.id"
          class="nav-link"
          :class="{ active: store.page === p.id }"
          type="button"
          @click="store.page = p.id"
        >
          {{ p.label }}
          <span v-if="p.id === 'home' && store.v2RunningCount" class="nav-badge">
            {{ store.v2RunningCount }}
          </span>
        </button>
      </nav>

      <div class="topnav-right">
        <span class="nav-status" :class="{ on: store.apiOnline, off: !store.apiOnline }">
          <span class="dot" />
          <span class="nav-status-text">{{ store.apiOnline ? '服务在线' : '服务离线' }}</span>
        </span>
      </div>
    </header>

    <main class="page-body">
      <div class="container">
        <div v-if="store.globalError && !store.apiOnline" class="alert" style="margin-bottom: 18px">
          <Icon name="alert" :size="18" />
          <div>
            <strong>服务未连接</strong>
            <p>{{ store.globalError }}</p>
          </div>
        </div>

        <Transition name="page" mode="out-in">
          <HomeView v-if="store.page === 'home'" key="home" />
          <ImagineView v-else-if="store.page === 'imagine'" key="imagine" />
          <ToolboxView v-else-if="store.page === 'tools'" key="tools" />
          <HistoryView v-else-if="store.page === 'history'" key="history" />
          <SettingsView v-else key="settings" />
        </Transition>
      </div>
    </main>

    <nav class="tabbar" aria-label="移动端导航">
      <button
        v-for="p in pages"
        :key="p.id"
        class="tab"
        :class="{ active: store.page === p.id }"
        type="button"
        @click="store.page = p.id"
      >
        <span v-if="p.id === 'home' && store.v2RunningCount" class="nav-badge">
          {{ store.v2RunningCount }}
        </span>
        <Icon :name="(p.icon as any)" :size="19" />
        <span>{{ p.short }}</span>
      </button>
    </nav>

    <Transition name="toast">
      <div v-if="store.notice" class="toast" role="status">
        <Icon name="check" :size="15" />
        <span>{{ store.notice }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.brand {
  cursor: pointer;
}

.topnav-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
