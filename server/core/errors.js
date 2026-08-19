const CODE_MAP = {
  VALIDATION_ERROR: { retryable: false },
  URL_UNSUPPORTED: { retryable: false },
  PROVIDER_FAILED: { retryable: true },
  RESOLUTION_EXPIRED: { retryable: true },
  ASSET_EXPIRED: { retryable: true },
  JOB_NOT_FOUND: { retryable: false },
  RATE_LIMITED: { retryable: true },
  AUTH_REQUIRED: { retryable: false },
  AUTH_EXPIRED: { retryable: false },
  UNSUPPORTED_DRM: { retryable: false },
  DOWNLOAD_FAILED: { retryable: true },
  AI_RATE_LIMIT: { retryable: true },
  AI_TIMEOUT: { retryable: true },
  AI_PROXY_ERROR: { retryable: true },
  INTERNAL_ERROR: { retryable: false }
}

export class AppError extends Error {
  constructor(code, message, retryable, details = {}) {
    super(message)
    this.code = code
    this.retryable = retryable ?? CODE_MAP[code]?.retryable ?? false
    this.details = details
  }
}

export function toErrorResponse(error, requestId = '') {
  if (error instanceof AppError) {
    return { error: { code: error.code, message: error.message, retryable: error.retryable }, requestId }
  }
  const msg = error?.message ? String(error.message) : '服务器内部错误'
  return { error: { code: 'INTERNAL_ERROR', message: msg.slice(0, 300), retryable: isRetryable(error) }, requestId }
}

export function isRetryable(error) {
  if (!error) return false
  if (error instanceof AppError) return error.retryable
  if (Number.isInteger(error.status)) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  if (error.name === 'TypeError' && /fetch failed|network/i.test(String(error.message))) return true
  if (error.name === 'AbortError') return true
  return false
}
