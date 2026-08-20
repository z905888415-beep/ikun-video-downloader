import { randomUUID } from 'node:crypto'

const JOB_STATUSES = ['RESOLVING', 'READY', 'DELIVERED', 'QUEUED', 'DOWNLOADING', 'PROCESSING', 'RETRY_WAIT', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']

export function createResolution({ sourceUrl, provider = '', platform, title, description, thumbnail, duration, kind = 'video', assets = [], actions = [], expiresAt, createdAt = Date.now(), assetUrls }) {
  return { id: `res_${randomUUID().slice(0, 12)}`, sourceUrl, provider, platform, title, description, thumbnail, duration, kind, assets, actions, expiresAt, createdAt, ...(assetUrls ? { assetUrls } : {}) }
}

export function createAsset({ kind, label, ext, protocol = 'https', width, height, fps, codec, bitrate, size, delivery = 'redirect', expiresAt, supportsRange }) {
  return { id: `as_${randomUUID().slice(0, 12)}`, kind, label, ext, protocol, width, height, fps, codec, bitrate, size, delivery, expiresAt, supportsRange }
}

export function createAction({ label, type, assetIds = [], requiresProcessing = false, preferredExt }) {
  return { id: `act_${randomUUID().slice(0, 12)}`, label, type, assetIds, requiresProcessing, preferredExt }
}

export function createJob({ clientId, controlToken = randomUUID(), resolutionId, sourceUrl, actionId, mode = 'auto' }) {
  return {
    id: `job_${randomUUID().slice(0, 12)}`,
    clientId,
    controlToken,
    resolutionId,
    sourceUrl,
    actionId,
    mode,
    status: 'RESOLVING',
    phase: 'resolve',
    percent: 0,
    speed: '',
    eta: '',
    attempts: 0,
    maxAttempts: 3,
    filepath: '',
    filename: '',
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export { JOB_STATUSES }
