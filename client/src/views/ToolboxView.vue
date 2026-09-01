<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import JSZip from 'jszip'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'
import { PDFDocument } from 'pdf-lib'
import { jsPDF } from 'jspdf'
import { Archive, ArchiveCompression, ArchiveFormat } from 'libarchive.js/dist/libarchive.js'
import Icon from '../components/Icon.vue'
import { api } from '../api/client'
import { generateImage, loadImageGenModel, saveImageGenModel, IMAGE_MODELS } from '../lib/image-generate'

type ToolMode = 'imagine' | 'cutout' | 'archive' | 'video' | 'gif' | 'image' | 'pdf'
type Preset = 'quality' | 'balanced' | 'tiny'

const mode = ref<ToolMode>('imagine')
const files = ref<File[]>([])
const busy = ref(false)
const progress = ref(0)
const message = ref('')
const password = ref('')
const volumeMb = ref(0)
const videoPreset = ref<Preset>('balanced')
const gifStart = ref(0)
const gifDuration = ref(3)
const gifFps = ref(12)
const gifWidth = ref(480)
const cropX = ref(0)
const cropY = ref(0)
const cropW = ref(0)
const cropH = ref(0)
const captionText = ref('')
const captionSize = ref(32)
const captionColor = ref('#ffffff')
const captionX = ref(50)
const captionY = ref(86)
const videoDuration = ref(0)
const draggingCaption = ref(false)
const previewVideo = ref<HTMLVideoElement | null>(null)
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const videoObjectUrl = ref('')
const imageType = ref('image/webp')
const imageQuality = ref(0.82)
const imageWidth = ref(0)
const pdfAction = ref<'merge' | 'split' | 'images-to-pdf' | 'pdf-to-images' | 'compress'>('merge')
const cutoutProfile = ref<'sharp' | 'fur'>('sharp')
const cutoutPreviewUrl = ref('')
const cutoutSourceUrl = ref('')
const cutoutBlob = ref<Blob | null>(null)
const cutoutName = ref('cutout.png')
const aiStatusText = ref('')
const imaginePrompt = ref('')
const imagineSize = ref('1024x1024')
const imagineResolution = ref('2K')
const imagineModel = ref(loadImageGenModel())
const imagineResultUrl = ref('')
const imagineRefName = ref('')
const imagineRefUrl = ref('')
let imagineAbort: AbortController | null = null

const imagineSizes = [
  { id: '1024x1024', ratio: '1:1', w: 22, h: 22 },
  { id: '1536x864', ratio: '16:9', w: 28, h: 16 },
  { id: '864x1536', ratio: '9:16', w: 16, h: 28 },
  { id: '1536x1024', ratio: '3:2', w: 27, h: 18 },
  { id: '1024x1536', ratio: '2:3', w: 18, h: 27 }
] as const
const imagineResolutions = ['1K', '2K', '4K'] as const

const maxGifStart = computed(() => Math.max(0, videoDuration.value - 0.5))
const maxGifDuration = computed(() => Math.min(30, Math.max(0.5, videoDuration.value ? videoDuration.value - gifStart.value : 30)))
const gifEnd = computed(() => Math.min(videoDuration.value || gifStart.value + gifDuration.value, gifStart.value + gifDuration.value))
const gifRangeText = computed(() => `${gifStart.value.toFixed(1)}s → ${gifEnd.value.toFixed(1)}s · ${gifDuration.value.toFixed(1)}s`)

let ffmpeg: FFmpeg | null = null
let archiveReady = false

const tabs = [
  { id: 'imagine' as const, title: 'AI 生图', sub: 'GPT-Image-2 · 文生图 / 图生图', icon: 'sparkles', wide: true },
  { id: 'cutout' as const, title: 'AI 抠图', sub: '远程 miaoCut · 透明 PNG', icon: 'image', wide: true },
  { id: 'archive' as const, title: '压缩包', sub: 'zip / 7z / rar / tar.gz', icon: 'archive', wide: true },
  { id: 'video' as const, title: '视频压缩', sub: 'ffmpeg.wasm 本地处理', icon: 'video', wide: false },
  { id: 'gif' as const, title: '视频转 GIF', sub: '裁剪时长 / 帧率 / 宽度', icon: 'play', wide: false },
  { id: 'image' as const, title: '图片转换', sub: 'jpg / png / webp / avif', icon: 'image', wide: false },
  { id: 'pdf' as const, title: 'PDF 工具', sub: '转换 / 合并 / 拆分', icon: 'fileText', wide: true }
] as const

const totalSize = computed(() => files.value.reduce((sum, file) => sum + file.size, 0))

function setFiles(next: File[]): void {
  files.value = next
  message.value = files.value.length ? `已选择 ${files.value.length} 个文件` : ''
  const video = files.value.find((file) => file.type.startsWith('video/'))
  if (videoObjectUrl.value) URL.revokeObjectURL(videoObjectUrl.value)
  videoDuration.value = 0
  videoObjectUrl.value = video ? URL.createObjectURL(video) : ''
  if (cutoutSourceUrl.value) URL.revokeObjectURL(cutoutSourceUrl.value)
  const image = files.value.find((file) => file.type.startsWith('image/'))
  cutoutSourceUrl.value = image ? URL.createObjectURL(image) : ''
  if (cutoutPreviewUrl.value) {
    URL.revokeObjectURL(cutoutPreviewUrl.value)
    cutoutPreviewUrl.value = ''
  }
  cutoutBlob.value = null
  void nextTick(drawPreview)
}

function pick(e: Event): void {
  setFiles([...((e.target as HTMLInputElement).files || [])])
}

function drop(e: DragEvent): void {
  setFiles([...(e.dataTransfer?.files || [])])
}

function fmt(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`
}

function saveBlob(blob: Blob, name: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 30000)
}

function saveParts(blob: Blob, name: string): void {
  const size = Math.floor(volumeMb.value * 1024 * 1024)
  if (!size || blob.size <= size) return saveBlob(blob, name)
  for (let start = 0, i = 1; start < blob.size; start += size, i++) {
    saveBlob(blob.slice(start, start + size), `${name}.part${String(i).padStart(3, '0')}`)
  }
}

async function ensureArchive(): Promise<void> {
  if (archiveReady) return
  Archive.init({ workerUrl: '/vendor/libarchive/worker-bundle.js' })
  archiveReady = true
}

async function createZip(): Promise<void> {
  if (!files.value.length) return
  busy.value = true; progress.value = 0; message.value = '正在压缩…'
  try {
    let blob: Blob
    if (password.value) {
      await ensureArchive()
      blob = await Archive.write({
        files: files.value.map((file) => ({ file, pathname: file.webkitRelativePath || file.name })) as any,
        outputFileName: 'ikun.zip',
        compression: ArchiveCompression.NONE,
        format: ArchiveFormat.ZIP,
        passphrase: password.value
      })
    } else {
      const zip = new JSZip()
      files.value.forEach((file) => zip.file(file.webkitRelativePath || file.name, file))
      blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, (m) => { progress.value = m.percent })
    }
    saveParts(blob, 'ikun.zip')
    message.value = `完成：${fmt(totalSize.value)} → ${fmt(blob.size)}`
  } finally {
    busy.value = false
  }
}

function flatten(obj: any, prefix = ''): File[] {
  return Object.entries(obj).flatMap(([name, value]) => value instanceof File ? [new File([value], prefix + name)] : flatten(value, `${prefix}${name}/`))
}

async function extractArchive(): Promise<void> {
  const file = files.value[0]
  if (!file) return
  busy.value = true; progress.value = 0; message.value = '正在解压…'
  try {
    await ensureArchive()
    const archive = await Archive.open(file)
    if (password.value) await archive.usePassword(password.value)
    const extracted = flatten(await archive.extractFiles())
    const zip = new JSZip()
    extracted.forEach((item) => zip.file(item.name, item))
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => { progress.value = m.percent })
    saveBlob(blob, `${file.name}.extracted.zip`)
    message.value = `已解出 ${extracted.length} 个文件，浏览器打包成 zip 下载`
  } finally {
    busy.value = false
  }
}

async function createTarGz(): Promise<void> {
  if (!files.value.length) return
  busy.value = true; message.value = '正在生成 tar.gz…'
  try {
    await ensureArchive()
    const tar = await Archive.write({
      files: files.value.map((file) => ({ file, pathname: file.webkitRelativePath || file.name })) as any,
      outputFileName: 'ikun.tar.gz',
      compression: ArchiveCompression.GZIP,
      format: ArchiveFormat.USTAR,
      passphrase: null
    })
    saveParts(tar, 'ikun.tar.gz')
    message.value = `完成：${fmt(tar.size)}`
  } finally { busy.value = false }
}

async function ensureFfmpeg(): Promise<FFmpeg> {
  if (ffmpeg?.loaded) return ffmpeg
  ffmpeg = new FFmpeg()
  ffmpeg.on('progress', ({ progress: p }) => { progress.value = Math.max(0, Math.min(100, p * 100)) })
  message.value = '首次加载 ffmpeg.wasm，约 30MB…'
  await ffmpeg.load({ coreURL: '/vendor/ffmpeg/ffmpeg-core.js', wasmURL: '/vendor/ffmpeg/ffmpeg-core.wasm' })
  return ffmpeg
}

function presetArgs(preset: Preset): string[] {
  if (preset === 'quality') return ['-vf', 'scale=-2:min(1080,ih)', '-b:v', '3500k', '-r', '30', '-preset', 'veryfast']
  if (preset === 'tiny') return ['-vf', 'scale=-2:min(480,ih)', '-b:v', '700k', '-r', '24', '-preset', 'veryfast']
  return ['-vf', 'scale=-2:min(720,ih)', '-b:v', '1600k', '-r', '30', '-preset', 'veryfast']
}

async function compressVideo(): Promise<void> {
  const file = files.value[0]
  if (!file) return
  busy.value = true; progress.value = 0; message.value = '正在压缩视频…'
  try {
    const f = await ensureFfmpeg()
    await f.writeFile('input', await fetchFile(file))
    await f.exec(['-i', 'input', ...presetArgs(videoPreset.value), '-c:a', 'aac', '-b:a', '128k', 'output.mp4'])
    const data = await f.readFile('output.mp4')
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'video/mp4' })
    saveBlob(blob, file.name.replace(/\.[^.]+$/, '') + '.compressed.mp4')
    message.value = `完成：${fmt(file.size)} → ${fmt(blob.size)}`
  } finally { busy.value = false }
}



function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(n) || 0))
}

function drawPreview(): void {
  const video = previewVideo.value
  const canvas = previewCanvas.value
  if (!video || !canvas || !video.videoWidth) return
  const sx = clamp(cropX.value, 0, video.videoWidth - 1)
  const sy = clamp(cropY.value, 0, video.videoHeight - 1)
  const sw = clamp(cropW.value || video.videoWidth - sx, 1, video.videoWidth - sx)
  const sh = clamp(cropH.value || video.videoHeight - sy, 1, video.videoHeight - sy)
  const width = Math.min(760, Math.max(240, gifWidth.value || 480))
  canvas.width = width
  canvas.height = Math.round(width * sh / sw)
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  if (captionText.value.trim()) {
    const fontSize = clamp(captionSize.value, 12, 96)
    ctx.font = `700 ${fontSize}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineWidth = Math.max(3, fontSize / 8)
    ctx.strokeStyle = 'rgba(0,0,0,.72)'
    ctx.fillStyle = captionColor.value || '#fff'
    const x = canvas.width * clamp(captionX.value, 0, 100) / 100
    const y = canvas.height * clamp(captionY.value, 0, 100) / 100
    ctx.strokeText(captionText.value, x, y)
    ctx.fillText(captionText.value, x, y)
  }
}

function syncPreviewTime(): void {
  const video = previewVideo.value
  if (!video) return
  video.currentTime = clamp(gifStart.value, 0, Math.max(0, video.duration || 0))
}

function onPreviewMetadata(): void {
  const video = previewVideo.value
  videoDuration.value = video?.duration && Number.isFinite(video.duration) ? video.duration : 0
  gifStart.value = clamp(gifStart.value, 0, maxGifStart.value)
  gifDuration.value = clamp(gifDuration.value, 0.5, maxGifDuration.value)
  syncPreviewTime()
}

function moveCaption(event: PointerEvent): void {
  const canvas = previewCanvas.value
  if (!canvas || !captionText.value.trim()) return
  const rect = canvas.getBoundingClientRect()
  captionX.value = clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
  captionY.value = clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100)
  drawPreview()
}

function startCaptionDrag(event: PointerEvent): void {
  draggingCaption.value = true
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  moveCaption(event)
}

function dragCaption(event: PointerEvent): void {
  if (draggingCaption.value) moveCaption(event)
}

function stopCaptionDrag(): void {
  draggingCaption.value = false
}

function ffmpegText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/\n/g, ' ')
}

watch([gifStart, gifDuration], () => {
  gifStart.value = clamp(gifStart.value, 0, maxGifStart.value)
  gifDuration.value = clamp(gifDuration.value, 0.5, maxGifDuration.value)
  syncPreviewTime()
  window.setTimeout(drawPreview, 80)
})

watch([cropX, cropY, cropW, cropH, gifWidth, captionText, captionSize, captionColor, captionX, captionY], () => {
  window.setTimeout(drawPreview, 80)
})

function persistImagineCfg(): void {
  saveImageGenModel(imagineModel.value)
}

function clearImagineRef(): void {
  if (imagineRefUrl.value) URL.revokeObjectURL(imagineRefUrl.value)
  imagineRefUrl.value = ''
  imagineRefName.value = ''
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取参考图失败'))
    reader.readAsDataURL(file)
  })
}

function onImagineRef(file?: File | null): void {
  if (!file) return
  if (!file.type.startsWith('image/')) {
    message.value = '请选择图片作为参考图'
    return
  }
  if (file.size > 10 * 1024 * 1024) {
    message.value = '参考图不能超过 10MB'
    return
  }
  if (imagineRefUrl.value) URL.revokeObjectURL(imagineRefUrl.value)
  imagineRefUrl.value = URL.createObjectURL(file)
  imagineRefName.value = file.name
}

function dropImagine(e: DragEvent): void {
  onImagineRef(e.dataTransfer?.files?.[0])
}

function pickImagine(e: Event): void {
  onImagineRef((e.target as HTMLInputElement).files?.[0])
}

function downloadImagine(): void {
  if (!imagineResultUrl.value) return
  const a = document.createElement('a')
  a.href = imagineResultUrl.value
  a.download = `ikun-${Date.now()}.png`
  a.rel = 'noopener'
  a.click()
}

async function runImagine(): Promise<void> {
  persistImagineCfg()
  imagineAbort?.abort()
  imagineAbort = new AbortController()
  busy.value = true
  progress.value = 4
  message.value = '正在提交生图任务…'
  imagineResultUrl.value = ''
  try {
    let imageDataUrl = ''
    if (imagineRefUrl.value) {
      const blob = await fetch(imagineRefUrl.value).then((r) => r.blob())
      const file = new File([blob], imagineRefName.value || 'ref.png', { type: blob.type || 'image/png' })
      imageDataUrl = await fileToDataUrl(file)
    }
    const url = await generateImage({
      model: imagineModel.value,
      prompt: imaginePrompt.value,
      size: imagineSize.value,
      resolution: imagineResolution.value,
      imageDataUrl: imageDataUrl || undefined,
      signal: imagineAbort.signal,
      onProgress: (p) => {
        progress.value = p
        message.value = p >= 100 ? '生成完成' : `生成中 ${Math.round(p)}%`
      }
    })
    imagineResultUrl.value = url
    progress.value = 100
    message.value = '生成完成'
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      message.value = '已取消'
    } else {
      message.value = error instanceof Error ? error.message : String(error)
      progress.value = 0
    }
  } finally {
    busy.value = false
    imagineAbort = null
  }
}

onBeforeUnmount(() => {
  imagineAbort?.abort()
  if (cutoutPreviewUrl.value) URL.revokeObjectURL(cutoutPreviewUrl.value)
  if (cutoutSourceUrl.value) URL.revokeObjectURL(cutoutSourceUrl.value)
  if (videoObjectUrl.value) URL.revokeObjectURL(videoObjectUrl.value)
  if (imagineRefUrl.value) URL.revokeObjectURL(imagineRefUrl.value)
})

async function videoToGif(): Promise<void> {
  const file = files.value[0]
  if (!file) return
  busy.value = true; progress.value = 0; message.value = '正在生成 GIF…'
  try {
    const f = await ensureFfmpeg()
    await f.writeFile('gif-input', await fetchFile(file))
    const fps = Math.min(24, Math.max(5, Number(gifFps.value) || 12))
    const width = Math.min(960, Math.max(160, Number(gifWidth.value) || 480))
    const duration = Math.min(30, Math.max(0.5, Number(gifDuration.value) || 3))
    const start = Math.max(0, Number(gifStart.value) || 0)
    const filters = []
    if (cropW.value > 0 && cropH.value > 0) filters.push(`crop=${Math.round(cropW.value)}:${Math.round(cropH.value)}:${Math.round(cropX.value)}:${Math.round(cropY.value)}`)
    filters.push(`fps=${fps}`, `scale=${width}:-1:flags=lanczos`)
    if (captionText.value.trim()) {
      const x = `(w-text_w)*${clamp(captionX.value, 0, 100) / 100}`
      const y = `(h-text_h)*${clamp(captionY.value, 0, 100) / 100}`
      filters.push(`drawtext=text='${ffmpegText(captionText.value)}':x=${x}:y=${y}:fontsize=${Math.min(96, Math.max(12, Number(captionSize.value) || 32))}:fontcolor=${captionColor.value.replace('#', '0x')}:borderw=3:bordercolor=black@0.72`)
    }
    const vf = `${filters.join(',')},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`
    await f.exec(['-ss', String(start), '-t', String(duration), '-i', 'gif-input', '-vf', vf, '-loop', '0', 'ikun.gif'])
    const data = await f.readFile('ikun.gif')
    const blob = new Blob([new Uint8Array(data as Uint8Array)], { type: 'image/gif' })
    saveBlob(blob, file.name.replace(/\.[^.]+$/, '') + '.gif')
    message.value = `GIF 完成：${fmt(file.size)} → ${fmt(blob.size)}`
  } finally { busy.value = false }
}


const ACCEPT_CUTOUT = 'image/jpeg,image/png,image/webp'

function clearCutoutResult(): void {
  if (cutoutPreviewUrl.value) URL.revokeObjectURL(cutoutPreviewUrl.value)
  cutoutPreviewUrl.value = ''
  cutoutBlob.value = null
}

async function refreshAiStatus(): Promise<void> {
  try {
    const s = await api.aiStatus()
    if (s.ok) {
      const ready = s.upstream && (s.upstream as { model_ready?: boolean }).model_ready
      aiStatusText.value = s.remote
        ? `远程 AI 在线${ready === false ? '（模型未就绪）' : ''}`
        : `自建 AI 在线 · ${s.baseUrl}`
    } else {
      aiStatusText.value = s.error || 'AI 服务不可用'
    }
  } catch (error) {
    aiStatusText.value = error instanceof Error ? error.message : 'AI 状态探测失败'
  }
}

async function compressForCutout(file: File): Promise<File> {
  const maxDim = 2048
  const maxPixels = 2048 * 2048
  if (!file.type.startsWith('image/')) throw new Error('请选择 JPG / PNG / WebP 图片')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('图片解析失败'))
      el.src = url
    })
    let w = img.naturalWidth || img.width
    let h = img.naturalHeight || img.height
    if (!w || !h) throw new Error('图片尺寸无效')
    const scale = Math.min(1, maxDim / w, maxDim / h, Math.sqrt(maxPixels / (w * h)))
    if (scale >= 1 && file.size <= 500 * 1024) return file
    w = Math.max(1, Math.round(w * scale))
    h = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('浏览器不支持 Canvas')
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.95))
    if (!blob) throw new Error('图片压缩失败')
    const base = (file.name || 'image').replace(/\.[^.]+$/, '')
    return new File([blob], `${base}.webp`, { type: 'image/webp' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function runCutout(): Promise<void> {
  const file = files.value.find((f) => f.type.startsWith('image/')) || files.value[0]
  if (!file) return
  busy.value = true
  progress.value = 8
  message.value = '正在准备图片…'
  clearCutoutResult()
  try {
    progress.value = 20
    const prepared = await compressForCutout(file)
    progress.value = 40
    message.value = cutoutProfile.value === 'fur' ? 'AI 细腻抠图中（毛发模式，稍慢）…' : 'AI 快速抠图中…'
    const blob = await api.removeBackground(prepared, cutoutProfile.value)
    cutoutBlob.value = blob
    cutoutPreviewUrl.value = URL.createObjectURL(blob)
    const base = (file.name || 'image').replace(/\.[^.]+$/, '')
    cutoutName.value = `${base}-cutout.png`
    progress.value = 100
    message.value = `完成：${fmt(file.size)} → ${fmt(blob.size)} 透明 PNG`
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error)
    progress.value = 0
  } finally {
    busy.value = false
  }
}

function downloadCutout(): void {
  if (!cutoutBlob.value) return
  saveBlob(cutoutBlob.value, cutoutName.value)
}

watch(mode, (next) => {
  if (next === 'cutout') void refreshAiStatus()
})

async function convertImages(): Promise<void> {
  if (!files.value.length) return
  busy.value = true; progress.value = 0; message.value = '正在转换图片…'
  try {
    const zip = new JSZip()
    for (const [i, file] of files.value.entries()) {
      const img = await createImageBitmap(file)
      const ratio = imageWidth.value > 0 ? imageWidth.value / img.width : 1
      const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * ratio), height: Math.round(img.height * ratio) })
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), imageType.value, imageQuality.value))
      zip.file(file.name.replace(/\.[^.]+$/, ext(imageType.value)), blob)
      progress.value = ((i + 1) / files.value.length) * 100
    }
    saveBlob(await zip.generateAsync({ type: 'blob' }), 'ikun-images.zip')
    message.value = `已转换 ${files.value.length} 张图片`
  } finally { busy.value = false }
}

function ext(type: string): string { return type === 'image/jpeg' ? '.jpg' : `.${type.split('/')[1]}` }

async function runPdf(): Promise<void> {
  if (!files.value.length) return
  busy.value = true; progress.value = 0; message.value = '正在处理 PDF…'
  try {
    if (pdfAction.value === 'images-to-pdf') {
      const doc = new jsPDF({ unit: 'px', format: 'a4' })
      for (const [i, file] of files.value.entries()) {
        if (i) doc.addPage()
        const img = await createImageBitmap(file)
        const url = URL.createObjectURL(file)
        const w = doc.internal.pageSize.getWidth(), h = Math.min(doc.internal.pageSize.getHeight(), w * img.height / img.width)
        doc.addImage(url, file.type.includes('png') ? 'PNG' : 'JPEG', 0, 0, w, h)
        URL.revokeObjectURL(url)
      }
      saveBlob(doc.output('blob'), 'ikun-images.pdf')
    } else if (pdfAction.value === 'merge' || pdfAction.value === 'compress') {
      const out = await PDFDocument.create()
      for (const file of files.value) {
        const src = await PDFDocument.load(await file.arrayBuffer())
        const pages = await out.copyPages(src, src.getPageIndices())
        pages.forEach((p) => out.addPage(p))
      }
      saveBlob(new Blob([new Uint8Array(await out.save({ useObjectStreams: true }))], { type: 'application/pdf' }), pdfAction.value === 'compress' ? 'ikun-compressed.pdf' : 'ikun-merged.pdf')
    } else if (pdfAction.value === 'split') {
      const src = await PDFDocument.load(await files.value[0].arrayBuffer())
      const zip = new JSZip()
      for (const i of src.getPageIndices()) {
        const out = await PDFDocument.create()
        const [page] = await out.copyPages(src, [i])
        out.addPage(page)
        zip.file(`page-${i + 1}.pdf`, await out.save())
      }
      saveBlob(await zip.generateAsync({ type: 'blob' }), 'ikun-pdf-pages.zip')
    } else {
      const pdfjs = await import('pdfjs-dist')
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString()
      const doc = await pdfjs.getDocument({ data: await files.value[0].arrayBuffer() }).promise
      const zip = new JSZip()
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale: 2 })
        const canvas = Object.assign(document.createElement('canvas'), { width: viewport.width, height: viewport.height })
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise
        const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
        zip.file(`page-${i}.png`, blob)
      }
      saveBlob(await zip.generateAsync({ type: 'blob' }), 'ikun-pdf-images.zip')
    }
    progress.value = 100; message.value = 'PDF 处理完成'
  } finally { busy.value = false }
}
</script>

<template>
  <div class="toolbox-view">
    <div class="page-head">
      <h2>工具箱</h2>
      <p>本地工具在浏览器内处理；AI 生图走你自己的中转 API；抠图经本机转发到远程 miaoCut。</p>
    </div>

    <!-- Bento 工具网格 -->
    <div class="bento stagger">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="bento-card"
        :class="{ active: mode === tab.id, wide: tab.wide }"
        type="button"
        @click="mode = tab.id"
      >
        <span class="bento-icon"><Icon :name="tab.icon" :size="24" /></span>
        <span class="bento-text">
          <strong>{{ tab.title }}</strong>
          <small>{{ tab.sub }}</small>
        </span>
        <span v-if="mode === tab.id" class="bento-check"><Icon name="check" :size="14" /></span>
      </button>
    </div>

    <!-- 文件拖拽区（生图工具用自己的参考图槽，不走通用拖拽） -->
    <label v-if="mode !== 'imagine'" class="drop-card" :class="{ filled: files.length }" @dragover.prevent @drop.prevent="drop">
      <input
        :multiple="mode !== 'cutout'"
        type="file"
        :accept="mode === 'cutout' ? ACCEPT_CUTOUT : undefined"
        @change="pick"
      />
      <span class="drop-icon"><Icon name="plus" :size="26" /></span>
      <strong>{{ files.length ? `已选 ${files.length} 个文件 · ${fmt(totalSize)}` : '拖拽文件到这里，或点击选择' }}</strong>
      <small>
        {{
          files.length
            ? files.map(f => f.name).slice(0, 3).join('、')
            : mode === 'cutout'
              ? '支持 JPG / PNG / WebP · 经服务器转发远程 AI'
              : '支持批量处理，本地工具不上传服务器'
        }}
      </small>
    </label>

    <!-- AI 生图 -->
    <section v-if="mode === 'imagine'" class="card card-pad tool-panel imagine-panel rise-in">
      <div class="imagine-head">
        <h3 class="card-title">AI 生图</h3>
        <span class="imagine-mode-tag">{{ imagineRefUrl ? '图生图' : '文生图' }} · {{ imagineResolution }}</span>
      </div>

      <textarea
        v-model="imaginePrompt"
        class="imagine-prompt"
        maxlength="4000"
        aria-label="描述画面"
        placeholder="描述你想创造的画面…"
      />

      <div class="imagine-row">
        <span class="imagine-label">画幅</span>
        <div class="imagine-sizes" role="radiogroup" aria-label="画幅">
          <button
            v-for="s in imagineSizes"
            :key="s.id"
            class="imagine-size"
            :class="{ active: imagineSize === s.id }"
            type="button"
            role="radio"
            :aria-checked="imagineSize === s.id"
            @click="imagineSize = s.id"
          >
            <i class="imagine-size-box" :style="{ width: s.w + 'px', height: s.h + 'px' }" />
            {{ s.ratio }}
          </button>
        </div>
      </div>

      <div class="imagine-row">
        <span class="imagine-label">清晰度</span>
        <div class="preset-pills">
          <button
            v-for="r in imagineResolutions"
            :key="r"
            class="preset-pill"
            :class="{ active: imagineResolution === r }"
            type="button"
            @click="imagineResolution = r"
          >
            {{ r }}
          </button>
        </div>
      </div>

      <label class="imagine-drop" :class="{ filled: !!imagineRefUrl }" @dragover.prevent @drop.prevent="dropImagine">
        <input type="file" accept="image/jpeg,image/png,image/webp" @change="pickImagine" />
        <template v-if="imagineRefUrl">
          <img :src="imagineRefUrl" alt="参考图" />
          <div class="imagine-drop-copy">
            <strong>{{ imagineRefName }}</strong>
            <small>点击或拖拽替换</small>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" @click.stop.prevent="clearImagineRef">移除</button>
        </template>
        <template v-else>
          <span class="imagine-drop-plus"><Icon name="plus" :size="18" /></span>
          <div class="imagine-drop-copy">
            <strong>添加参考图</strong>
            <small>可选 · 拖拽或点击，走图生图</small>
          </div>
        </template>
      </label>

      <div class="imagine-row">
        <span class="imagine-label">模型</span>
        <div class="preset-pills" role="radiogroup" aria-label="模型">
          <button
            v-for="m in IMAGE_MODELS"
            :key="m.id"
            class="preset-pill"
            :class="{ active: imagineModel === m.id }"
            type="button"
            role="radio"
            :aria-checked="imagineModel === m.id"
            @click="imagineModel = m.id; persistImagineCfg()"
          >
            {{ m.label }}
          </button>
        </div>
      </div>

      <div class="imagine-actions">
        <button class="btn btn-primary" type="button" :disabled="busy || !imaginePrompt.trim()" @click="runImagine">
          <Icon name="sparkles" :size="15" />
          {{ busy ? '生成中' : '生成图片' }}
        </button>
        <button v-if="busy" class="btn btn-ghost" type="button" @click="imagineAbort?.abort()">取消</button>
        <button v-if="imagineResultUrl" class="btn btn-light" type="button" @click="downloadImagine">
          <Icon name="download" :size="15" />下载
        </button>
      </div>

      <div v-if="imagineResultUrl" class="imagine-result">
        <img :src="imagineResultUrl" alt="生成结果" />
      </div>
    </section>

    <!-- AI 抠图 -->
    <section v-else-if="mode === 'cutout'" class="card card-pad tool-panel rise-in">
      <h3 class="card-title">AI 抠图 · 透明 PNG</h3>
      <div class="preset-pills" style="margin-top: 14px">
        <button
          class="preset-pill"
          :class="{ active: cutoutProfile === 'sharp' }"
          type="button"
          @click="cutoutProfile = 'sharp'"
        >
          快速（锐利边缘）
        </button>
        <button
          class="preset-pill"
          :class="{ active: cutoutProfile === 'fur' }"
          type="button"
          @click="cutoutProfile = 'fur'"
        >
          细腻（毛发 / 发丝）
        </button>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="runCutout">
          <Icon name="sparkles" :size="15" />开始抠图
        </button>
        <button class="btn btn-ghost" :disabled="!cutoutBlob" @click="downloadCutout">
          下载 PNG
        </button>
        <button class="btn btn-ghost" type="button" :disabled="busy" @click="refreshAiStatus">
          检测 AI
        </button>
      </div>
      <div v-if="cutoutSourceUrl || cutoutPreviewUrl" class="cutout-preview">
        <div v-if="cutoutSourceUrl" class="cutout-pane">
          <span>原图</span>
          <img :src="cutoutSourceUrl" alt="原图预览" />
        </div>
        <div v-if="cutoutPreviewUrl" class="cutout-pane">
          <span>抠图结果</span>
          <img class="checker" :src="cutoutPreviewUrl" alt="抠图结果" />
        </div>
      </div>
    </section>

    <!-- 压缩包 -->
    <section v-else-if="mode === 'archive'" class="card card-pad tool-panel rise-in">

      <h3 class="card-title">压缩包处理</h3>
      <div class="tool-grid">
        <label class="field" style="margin-bottom: 0">
          <span>密码（可选）</span>
          <input v-model="password" class="input" type="password" placeholder="zip/7z/rar 解压或加密 zip" />
        </label>
        <label class="field" style="margin-bottom: 0">
          <span>分卷大小 MB（0 不分卷）</span>
          <input v-model.number="volumeMb" class="input" type="number" min="0" />
        </label>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="createZip">
          <Icon name="archive" :size="15" />生成 ZIP
        </button>
        <button class="btn btn-ghost" :disabled="busy || !files.length" @click="createTarGz">生成 tar.gz</button>
        <button class="btn btn-ghost" :disabled="busy || !files.length" @click="extractArchive">解压为 ZIP</button>
      </div>
    </section>

    <!-- 视频 -->
    <section v-else-if="mode === 'video'" class="card card-pad tool-panel rise-in">
      <h3 class="card-title">视频压缩</h3>
      <div class="preset-pills" style="margin-top: 14px">
        <button
          v-for="p in [
            { id: 'quality', label: '高质量 1080P' },
            { id: 'balanced', label: '平衡 720P' },
            { id: 'tiny', label: '极限压缩 480P' }
          ]"
          :key="p.id"
          class="preset-pill"
          :class="{ active: videoPreset === p.id }"
          type="button"
          @click="videoPreset = p.id as Preset"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="compressVideo">
          <Icon name="video" :size="15" />开始压缩
        </button>
      </div>
    </section>


    <!-- GIF -->
    <section v-else-if="mode === 'gif'" class="card card-pad tool-panel rise-in">
      <h3 class="card-title">视频转 GIF</h3>
      <div v-if="videoObjectUrl" class="gif-preview">
        <video
          ref="previewVideo"
          :src="videoObjectUrl"
          muted
          playsinline
          preload="metadata"
          @loadedmetadata="onPreviewMetadata"
          @seeked="drawPreview"
        />
        <canvas
          ref="previewCanvas"
          :class="{ dragging: draggingCaption }"
          title="输入文字后，可直接拖动字幕位置"
          @pointerdown="startCaptionDrag"
          @pointermove="dragCaption"
          @pointerup="stopCaptionDrag"
          @pointercancel="stopCaptionDrag"
        />
      </div>
      <div v-if="videoObjectUrl" class="gif-timeline">
        <div class="timeline-head">
          <strong>裁剪进度条</strong>
          <span>{{ gifRangeText }}</span>
        </div>
        <label>
          <span>开始秒数</span>
          <input v-model.number="gifStart" type="range" min="0" :max="maxGifStart" step="0.1" />
        </label>
        <label>
          <span>截取时长</span>
          <input v-model.number="gifDuration" type="range" min="0.5" :max="maxGifDuration" step="0.1" />
        </label>
      </div>
      <div class="tool-grid" style="margin-top: 14px">
        <label class="field" style="margin-bottom: 0"><span>精确开始秒数</span><input v-model.number="gifStart" class="input" type="number" min="0" :max="maxGifStart" step="0.1" /></label>
        <label class="field" style="margin-bottom: 0"><span>精确时长（最多 30 秒）</span><input v-model.number="gifDuration" class="input" type="number" min="0.5" :max="maxGifDuration" step="0.1" /></label>
        <label class="field" style="margin-bottom: 0"><span>帧率（5 - 24）</span><input v-model.number="gifFps" class="input" type="number" min="5" max="24" /></label>
        <label class="field" style="margin-bottom: 0"><span>宽度 px（160 - 960）</span><input v-model.number="gifWidth" class="input" type="number" min="160" max="960" /></label>
        <label class="field" style="margin-bottom: 0"><span>裁剪 X</span><input v-model.number="cropX" class="input" type="number" min="0" /></label>
        <label class="field" style="margin-bottom: 0"><span>裁剪 Y</span><input v-model.number="cropY" class="input" type="number" min="0" /></label>
        <label class="field" style="margin-bottom: 0"><span>裁剪宽（0 为原宽）</span><input v-model.number="cropW" class="input" type="number" min="0" /></label>
        <label class="field" style="margin-bottom: 0"><span>裁剪高（0 为原高）</span><input v-model.number="cropH" class="input" type="number" min="0" /></label>
        <label class="field" style="margin-bottom: 0"><span>文字</span><input v-model="captionText" class="input" type="text" placeholder="可选，显示在 GIF 上" /></label>
        <label class="field" style="margin-bottom: 0"><span>字号</span><input v-model.number="captionSize" class="input" type="number" min="12" max="96" /></label>
        <label class="field" style="margin-bottom: 0"><span>文字颜色</span><input v-model="captionColor" class="input" type="color" /></label>
        <label class="field" style="margin-bottom: 0"><span>文字横向 %</span><input v-model.number="captionX" class="input" type="number" min="0" max="100" /></label>
        <label class="field" style="margin-bottom: 0"><span>文字纵向 %</span><input v-model.number="captionY" class="input" type="number" min="0" max="100" /></label>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="videoToGif">
          <Icon name="play" :size="15" />生成 GIF
        </button>
      </div>
    </section>

    <!-- 图片 -->
    <section v-else-if="mode === 'image'" class="card card-pad tool-panel rise-in">
      <h3 class="card-title">图片格式转换</h3>
      <div class="tool-grid" style="margin-top: 14px">
        <label class="field" style="margin-bottom: 0">
          <span>输出格式</span>
          <select v-model="imageType" class="select">
            <option value="image/webp">WebP</option>
            <option value="image/jpeg">JPG</option>
            <option value="image/png">PNG</option>
            <option value="image/avif">AVIF</option>
          </select>
        </label>
        <label class="field" style="margin-bottom: 0">
          <span>质量（0.1 - 1）</span>
          <input v-model.number="imageQuality" class="input" type="number" min="0.1" max="1" step="0.05" />
        </label>
        <label class="field" style="margin-bottom: 0">
          <span>宽度（0 保持原尺寸）</span>
          <input v-model.number="imageWidth" class="input" type="number" min="0" />
        </label>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="convertImages">
          <Icon name="image" :size="15" />批量转换
        </button>
      </div>
    </section>

    <!-- PDF -->
    <section v-else class="card card-pad tool-panel rise-in">
      <h3 class="card-title">PDF 工具</h3>
      <div class="preset-pills" style="margin-top: 14px">
        <button
          v-for="p in [
            { id: 'merge', label: 'PDF 合并' },
            { id: 'split', label: 'PDF 拆分' },
            { id: 'images-to-pdf', label: '多图转 PDF' },
            { id: 'pdf-to-images', label: 'PDF 转图片' },
            { id: 'compress', label: 'PDF 压缩' }
          ]"
          :key="p.id"
          class="preset-pill"
          :class="{ active: pdfAction === p.id }"
          type="button"
          @click="pdfAction = p.id as typeof pdfAction"
        >
          {{ p.label }}
        </button>
      </div>
      <div class="tool-actions">
        <button class="btn btn-primary" :disabled="busy || !files.length" @click="runPdf">
          <Icon name="fileText" :size="15" />开始处理
        </button>
      </div>
    </section>

    <!-- 进度 -->
    <div v-if="busy || message" class="card card-pad result-card rise-in" role="status">
      <div class="pbar"><i :style="{ width: `${Math.round(progress)}%` }" /></div>
      <p class="result-msg">{{ message }}</p>
    </div>
  </div>
</template>

<style scoped>
.toolbox-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}


.gif-preview {
  display: grid;
  place-items: center;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}

.gif-preview video {
  display: none;
}

.gif-preview canvas {
  max-width: 100%;
  border-radius: var(--r-md);
  background: #000;
  cursor: grab;
  touch-action: none;
}

.gif-preview canvas.dragging {
  cursor: grabbing;
}

.gif-timeline {
  display: grid;
  gap: 10px;
  margin-top: 14px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}

.timeline-head,
.gif-timeline label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.timeline-head span,
.gif-timeline label span {
  color: var(--text-3);
  font-size: 12px;
  white-space: nowrap;
}

.gif-timeline input[type='range'] {
  width: min(680px, 70%);
  accent-color: var(--accent);
}

/* ---------- 工具网格 ---------- */
.bento {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.bento-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--r-lg);
  border: 1px solid var(--border);
  background:
    linear-gradient(180deg, rgba(151, 184, 255, 0.05), rgba(151, 184, 255, 0.015) 42%),
    rgba(11, 17, 33, 0.55);
  text-align: left;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease), transform 0.18s var(--ease-spring), box-shadow 0.18s var(--ease);
}

.bento-card:hover {
  border-color: var(--border-strong);
  transform: translateY(-2px);
}

.bento-card.active {
  border-color: var(--accent-border);
  background:
    linear-gradient(180deg, rgba(62, 123, 250, 0.1), rgba(62, 123, 250, 0.02) 55%),
    rgba(11, 17, 33, 0.6);
  box-shadow: 0 0 0 1px rgba(62, 123, 250, 0.12), 0 10px 30px rgba(62, 123, 250, 0.14);
}

.bento-icon {
  width: 38px;
  height: 38px;
  border-radius: 12px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  color: var(--text-2);
  background: var(--surface-2);
  transition: all 0.15s;
}

.bento-card.active .bento-icon {
  color: var(--on-grad);
  background: var(--grad-cta);
  box-shadow: 0 6px 18px rgba(46, 107, 246, 0.4);
}

.bento-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.bento-text strong {
  font-family: var(--font-display);
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.bento-text small {
  color: var(--text-3);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bento-check {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--on-grad);
  background: var(--grad-cta);
  box-shadow: 0 4px 12px rgba(46, 107, 246, 0.45);
}

/* ---------- 拖拽区 · Upload 上传（虚线装备槽范式） ---------- */
.drop-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: clamp(26px, 5vw, 40px) 20px;
  border-radius: var(--r-lg);
  border: 1.5px dashed var(--border-strong);
  background: rgba(11, 17, 33, 0.4);
  cursor: pointer;
  text-align: center;
  transition: border-color 0.18s var(--ease), background 0.18s var(--ease), box-shadow 0.18s var(--ease);
}

.drop-card:hover {
  border-color: var(--accent);
  background: rgba(62, 123, 250, 0.05);
  box-shadow: 0 0 32px rgba(62, 123, 250, 0.1) inset;
}

.drop-card input {
  display: none;
}

.drop-icon {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1.5px dashed var(--accent-border);
}

.drop-card strong {
  font-size: 13.5px;
  font-weight: 600;
}

.drop-card small {
  color: var(--text-3);
  font-size: 12px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 面板 ---------- */
.tool-panel h3 {
  margin: 0;
}

.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  margin-top: 14px;
}

.tool-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

/* 规格选择使用全局 .preset-pills（Segmented 范式） */

.result-msg {
  margin: 10px 0 0;
  color: var(--text-2);
  font-size: 13px;
}

@media (max-width: 860px) {
  .bento {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 480px) {
  .bento {
    grid-template-columns: 1fr;
  }
}

.tool-note {
  margin: 8px 0 0;
  color: var(--text-3);
  font-size: 12.5px;
  line-height: 1.55;
}

.tool-note code {
  color: var(--accent);
  font-size: 12px;
}

.imagine-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}

.imagine-mode-tag {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.imagine-prompt {
  width: 100%;
  min-height: 132px;
  resize: vertical;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-input);
  color: var(--text);
  font-size: 15px;
  line-height: 1.65;
  box-shadow: inset 0 1px 3px rgba(1, 3, 9, 0.35);
}

.imagine-prompt::placeholder {
  color: var(--text-3);
}

.imagine-prompt:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3.5px var(--accent-glow);
}

.imagine-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 16px;
  flex-wrap: wrap;
}

.imagine-label {
  width: 48px;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-3);
}

.imagine-sizes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.imagine-size {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 6px 12px 6px 10px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: rgba(3, 7, 17, 0.4);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
}

.imagine-size:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.imagine-size.active {
  color: #fff;
  border-color: transparent;
  background: var(--grad-cta);
  box-shadow: 0 4px 16px rgba(46, 107, 246, 0.35);
}

.imagine-size-box {
  display: block;
  border: 1.5px solid currentColor;
  border-radius: 3px;
  opacity: 0.85;
  flex-shrink: 0;
}

.imagine-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 16px;
}

.imagine-drop {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  min-height: 72px;
  padding: 12px 16px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: rgba(11, 17, 33, 0.4);
  cursor: pointer;
  color: var(--text-2);
}

.imagine-drop input {
  display: none;
}

.imagine-drop:hover,
.imagine-drop.filled {
  border-color: var(--accent-border);
  background: rgba(62, 123, 250, 0.05);
}

.imagine-drop-plus {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  color: var(--accent-hover);
  background: var(--accent-soft);
  border: 1px solid var(--accent-border);
  flex-shrink: 0;
}

.imagine-drop img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 10px;
  flex-shrink: 0;
}

.imagine-drop-copy {
  flex: 1;
  min-width: 0;
}

.imagine-drop-copy strong {
  display: block;
  font-size: 13.5px;
  color: var(--text);
}

.imagine-drop-copy small {
  color: var(--text-3);
  font-size: 12px;
}

.imagine-result {
  margin-top: 16px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  overflow: hidden;
  background: rgba(3, 7, 17, 0.45);
}

.imagine-result img {
  width: 100%;
  max-height: 640px;
  object-fit: contain;
  display: block;
}

.cutout-preview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.cutout-pane {
  display: grid;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--r-lg);
  background: var(--surface-2);
}

.cutout-pane span {
  color: var(--text-3);
  font-size: 12px;
}

.cutout-pane img {
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  border-radius: var(--r-md);
  background: #111;
}

.cutout-pane img.checker {
  background-color: #1a1a1a;
  background-image:
    linear-gradient(45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(-45deg, #2a2a2a 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #2a2a2a 75%),
    linear-gradient(-45deg, transparent 75%, #2a2a2a 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
</style>
