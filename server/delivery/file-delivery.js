import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, resolve, join } from 'node:path'

export function createFileDelivery({ downloadsDir, assets }) {
  return {
    kind: 'file',
    async handle(assetId, { headers = {} } = {}) {
      const entry = assets.get(assetId)
      if (!entry || entry.delivery !== 'file' || !entry.filename) {
        return { type: 'error', code: 'ASSET_EXPIRED', message: '文件不存在或已清理' }
      }
      const filepath = resolve(join(downloadsDir, entry.filename))
      if (!filepath.startsWith(resolve(downloadsDir)) || !existsSync(filepath)) {
        return { type: 'error', code: 'ASSET_EXPIRED', message: '文件不存在或已清理' }
      }
      const stat = statSync(filepath)
      const range = headers.range
      let start = 0
      let end = stat.size - 1
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range)
        if (m) {
          start = m[1] ? Number(m[1]) : 0
          end = m[2] ? Number(m[2]) : stat.size - 1
        }
      }
      const chunked = Boolean(range) && start <= end && end < stat.size && start < stat.size
      return {
        type: 'file',
        filepath,
        status: chunked ? 206 : 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunked ? String(end - start + 1) : String(stat.size),
          'Accept-Ranges': 'bytes',
          ...(chunked ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(filepath))}`,
          'Cache-Control': 'private, no-store'
        },
        start,
        end
      }
    }
  }
}
