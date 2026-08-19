import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../core/errors.js'

export function createYtdlpFallback({ binDir = '', spawnImpl = spawn } = {}) {
  function bin() {
    const name = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    return join(binDir, name)
  }

  function killChild(child) {
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      } catch { /* ignore */ }
    } else {
      child.kill('SIGTERM')
    }
  }

  return {
    async download(job, signal) {
      const workDir = job.workDir
      mkdirSync(workDir, { recursive: true })
      const filepath = join(workDir, 'output.mp4')
      const args = [
        '--no-playlist', '--no-warnings', '--encoding', 'utf-8',
        '-f', 'bv*+ba/b', '-o', join(workDir, 'output.%(ext)s'),
        '--merge-output-format', 'mp4', '--newline', '--progress',
        job.sourceUrl
      ]
      return new Promise((resolve, reject) => {
        const child = spawnImpl(bin(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: workDir })
        let stderr = ''
        child.stderr?.on('data', (d) => { stderr += d })
        signal?.addEventListener('abort', () => killChild(child))
        child.on('close', (code) => {
          if (code === 0) {
            try {
              const st = statSync(filepath)
              if (st.size > 0) return resolve({ filepath, filename: 'output.mp4' })
            } catch { /* fallthrough to error */ }
            reject(new AppError('DOWNLOAD_FAILED', `yt-dlp 未产出有效输出文件：${stderr.slice(-200)}`, true))
          } else {
            reject(new AppError('DOWNLOAD_FAILED', `yt-dlp 退出码 ${code}：${stderr.slice(-200)}`, true))
          }
        })
        child.on('error', (err) => reject(new AppError('DOWNLOAD_FAILED', `yt-dlp 启动失败：${err.message}`, true)))
      })
    }
  }
}
