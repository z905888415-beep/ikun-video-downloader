import { defineStore } from 'pinia'
import { generateImage, generateImageEdit } from '../lib/image-generate'

export const REFS_MAX = 4
export const WORKS_MAX = 10

interface RefItem {
  key: string
  name: string
  url: string
  file: File | null
}

export interface Work {
  id: string
  prompt: string
  imageUrl: string
  createdAt: number
}

interface PersistedWork {
  id: string
  prompt: string
  createdAt: number
  url?: string
  blob?: Blob
}

const WORKS_DB = 'ikun_imagine'
const WORKS_STORE = 'works'
const WORKS_LEGACY_KEY = 'ikun_imagine_works'

function openWorksDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WORKS_DB, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(WORKS_STORE)) {
        req.result.createObjectStore(WORKS_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, rec: PersistedWork): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKS_STORE, 'readwrite')
    tx.objectStore(WORKS_STORE).put(rec)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function idbAll(db: IDBDatabase): Promise<PersistedWork[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(WORKS_STORE, 'readonly').objectStore(WORKS_STORE).getAll()
    req.onsuccess = () => resolve((req.result || []) as PersistedWork[])
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WORKS_STORE, 'readwrite')
    tx.objectStore(WORKS_STORE).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

let refSeq = 0

export const useImagineStore = defineStore('imagine', {
  state: () => ({
    mode: 'text' as 'text' | 'image',
    prompt: '',
    size: '1024x1024',
    refs: [] as RefItem[],
    generating: false,
    progress: 0,
    statusText: '',
    errorMsg: '',
    resultUrl: '',
    works: [] as Work[],
    worksLoaded: false
  }),
  getters: {
    runningCount(state): number {
      return state.generating ? 1 : 0
    }
  },
  actions: {
    /* ---------- 参考图 ---------- */
    addRefFiles(files: Array<File | null | undefined>): void {
      for (const file of files) {
        if (!file) continue
        if (!file.type.startsWith('image/')) {
          this.errorMsg = '请选择图片文件作为参考图'
          continue
        }
        if (file.size > 10 * 1024 * 1024) {
          this.errorMsg = '参考图不能超过 10MB'
          continue
        }
        if (this.refs.length >= REFS_MAX) {
          this.errorMsg = `最多添加 ${REFS_MAX} 张参考图`
          break
        }
        this.errorMsg = ''
        refSeq += 1
        this.refs = [...this.refs, {
          key: `ref_${Date.now()}_${refSeq}`,
          name: file.name || `参考图${this.refs.length + 1}`,
          url: URL.createObjectURL(file),
          file
        }]
      }
    },

    addRefFromBlob(blob: Blob, name: string): void {
      if (this.refs.length >= REFS_MAX) {
        this.errorMsg = `参考图已满 ${REFS_MAX} 张，已替换最后一张`
        this.removeRef(this.refs[this.refs.length - 1].key)
      }
      refSeq += 1
      this.refs = [...this.refs, {
        key: `ref_${Date.now()}_${refSeq}`,
        name,
        url: URL.createObjectURL(blob),
        file: new File([blob], name, { type: blob.type || 'image/png' })
      }]
    },

    removeRef(key: string): void {
      const item = this.refs.find((r) => r.key === key)
      if (item?.url.startsWith('blob:')) URL.revokeObjectURL(item.url)
      this.refs = this.refs.filter((r) => r.key !== key)
    },

    async setRefFromUrl(url: string): Promise<void> {
      try {
        const blob = await (await fetch(url)).blob()
        this.addRefFromBlob(blob, 'generated.png')
        this.mode = 'image'
        this.statusText = `已添加为 图${this.refs.length}，可用 @图${this.refs.length} 指代它`
      } catch {
        this.errorMsg = '参考图获取失败'
      }
    },

    /* ---------- 生成（状态常驻，切页不中断） ---------- */
    async generate(): Promise<void> {
      if (this.generating) return
      this.errorMsg = ''
      if (!this.prompt.trim()) {
        this.errorMsg = '请先描述你想创造的画面'
        return
      }
      if (this.mode === 'image' && !this.refs.length) {
        this.errorMsg = '图生图需要先添加参考图'
        return
      }
      const matches = [...this.prompt.matchAll(/@图\s*(\d{1,2})/g)].map((m) => Number(m[1]))
      const mentioned = matches.length ? Math.max(...matches) : 0
      if (this.mode === 'image' && mentioned > this.refs.length) {
        this.errorMsg = `提示词里引用了 @图${mentioned}，但只添加了 ${this.refs.length} 张参考图`
        return
      }
      const sentPrompt = this.prompt.replace(/@图\s*(\d{1,2})/g, '第$1张参考图')
      this.generating = true
      this.progress = 4
      this.statusText = '正在提交生图任务…'
      this.resultUrl = ''
      const controller = new AbortController()
      setImagineAbort(controller)
      try {
        const onProgress = (p: number): void => {
          this.progress = p
          this.statusText = p >= 100 ? '生成完成' : `生成中 ${Math.round(p)}%`
        }
        let url: string
        if (this.mode === 'image') {
          const files: File[] = []
          for (const item of this.refs) {
            if (item.file && item.file.size > 0) {
              files.push(item.file)
            } else {
              const blob = await (await fetch(item.url)).blob()
              const file = new File([blob], item.name, { type: blob.type || 'image/png' })
              item.file = file
              files.push(file)
            }
          }
          url = await generateImageEdit({
            prompt: sentPrompt,
            size: this.size,
            files,
            signal: controller.signal,
            onProgress
          })
        } else {
          url = await generateImage({
            prompt: this.prompt,
            size: this.size,
            signal: controller.signal,
            onProgress
          })
        }
        this.resultUrl = url
        this.progress = 100
        this.statusText = '图片已就绪'
        const work: Work = {
          id: `w_${Date.now()}`,
          prompt: this.prompt.trim(),
          imageUrl: url,
          createdAt: Date.now()
        }
        this.works = [work, ...this.works].slice(0, WORKS_MAX)
        void this.persistWork(work)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          this.statusText = '已取消'
        } else {
          this.errorMsg = error instanceof Error ? error.message : String(error)
          this.statusText = ''
        }
      } finally {
        this.generating = false
        if (getImagineAbort() === controller) setImagineAbort(null)
      }
    },

    cancel(): void {
      getImagineAbort()?.abort()
    },

    /* ---------- 我的作品：IndexedDB 缓存最近 10 次 ---------- */
    async initWorks(): Promise<void> {
      if (this.worksLoaded) return
      this.worksLoaded = true
      try {
        const db = await openWorksDb()
        // 旧版 localStorage 里的 http 作品迁移一次
        try {
          const legacy = JSON.parse(localStorage.getItem(WORKS_LEGACY_KEY) || '[]') as Work[]
          for (const w of legacy.filter((x) => /^https?:\/\//.test(x.imageUrl)).slice(0, WORKS_MAX)) {
            await idbPut(db, { id: w.id, prompt: w.prompt, createdAt: w.createdAt, url: w.imageUrl })
          }
          localStorage.removeItem(WORKS_LEGACY_KEY)
        } catch {
          /* 无旧数据 */
        }
        const all = (await idbAll(db)).sort((a, b) => b.createdAt - a.createdAt).slice(0, WORKS_MAX)
        this.works = all.map((r) => ({
          id: r.id,
          prompt: r.prompt,
          imageUrl: r.url || URL.createObjectURL(r.blob as Blob),
          createdAt: r.createdAt
        }))
      } catch {
        /* IndexedDB 不可用时退化为会话内可见 */
      }
    },

    async persistWork(work: Work): Promise<void> {
      try {
        const db = await openWorksDb()
        const rec: PersistedWork = { id: work.id, prompt: work.prompt, createdAt: work.createdAt }
        if (/^https?:\/\//.test(work.imageUrl)) {
          rec.url = work.imageUrl
        } else {
          rec.blob = await (await fetch(work.imageUrl)).blob()
        }
        await idbPut(db, rec)
        const all = (await idbAll(db)).sort((a, b) => b.createdAt - a.createdAt)
        for (const r of all.slice(WORKS_MAX)) await idbDelete(db, r.id)
      } catch {
        /* 持久化失败不影响会话内展示 */
      }
    },

    openWork(work: Work): void {
      this.resultUrl = work.imageUrl
      this.prompt = work.prompt
      this.statusText = '已打开历史作品'
      this.errorMsg = ''
    },

    removeWork(work: Work): void {
      this.works = this.works.filter((w) => w.id !== work.id)
      try {
        const db = openWorksDb()
        void db.then((d) => idbDelete(d, work.id).then(() => d.close()))
      } catch {
        /* ignore */
      }
      if (this.resultUrl === work.imageUrl) {
        this.resultUrl = ''
        this.statusText = ''
      }
    },

    downloadResult(): void {
      if (!this.resultUrl) return
      const a = document.createElement('a')
      a.href = this.resultUrl
      a.download = `ikun-${Date.now()}.png`
      a.rel = 'noopener'
      a.click()
    }
  }
})

// AbortController 不放进响应式 state，存模块级运行时
const imagineRuntime: { abortController: AbortController | null } = { abortController: null }

export function setImagineAbort(controller: AbortController | null): void {
  imagineRuntime.abortController = controller
}

export function getImagineAbort(): AbortController | null {
  return imagineRuntime.abortController
}
