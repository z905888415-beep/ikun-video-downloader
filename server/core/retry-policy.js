const BACKOFFS = [1000, 3000, 8000]

export function createRetryPolicy({ maxAttempts = 3 } = {}) {
  const nonRetryable = new Set(['VALIDATION_ERROR', 'URL_UNSUPPORTED', 'AUTH_REQUIRED', 'UNSUPPORTED_DRM', 'JOB_NOT_FOUND', 'INTERNAL_ERROR'])

  return {
    shouldRetry(error, attempt) {
      if (attempt >= maxAttempts) {
        return { ok: false, reason: 'MAX_ATTEMPTS' }
      }
      const code = error?.code
      if (code && nonRetryable.has(code)) {
        return { ok: false, reason: code }
      }
      const delay = () => BACKOFFS[Math.min(attempt - 1, BACKOFFS.length - 1)]
      if (code && ['PROVIDER_FAILED', 'DOWNLOAD_FAILED', 'RATE_LIMITED'].includes(code)) {
        return { ok: true, delayMs: delay() }
      }
      if (code === 'ASSET_EXPIRED' || code === 'RESOLUTION_EXPIRED') {
        return { ok: true, delayMs: delay(), refreshResolution: true }
      }
      if (error?.status === 408 || error?.status === 429 || (Number.isInteger(error?.status) && error.status >= 500)) {
        return { ok: true, delayMs: delay() }
      }
      if (error?.name === 'TypeError' && /fetch failed|network/i.test(String(error.message))) {
        return { ok: true, delayMs: delay() }
      }
      return { ok: false, reason: 'UNKNOWN' }
    }
  }
}
