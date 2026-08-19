import { spawn } from 'node:child_process'
import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '../core/errors.js'

export function createFfmpegProcessor({ spawnImpl = spawn, binDir = '' } = {}) {
  function bin() {
    const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
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

  function run(workDir, output, args, signal) {
    return new Promise((resolve, reject) => {
      const child = spawnImpl(bin(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: workDir })
      let stderr = ''
      child.stderr.on('data', (d) => { stderr += d })
      signal?.addEventListener('abort', () => killChild(child))
      child.on('close', (code) => {
        if (code === 0) {
          try {
            const st = statSync(output)
            if (st.size > 0) return resolve()
          } catch { /* fallthrough to error */ }
          reject(new AppError('DOWNLOAD_FAILED', 'FFmpeg 未产出有效输出文件', true))
        } else {
          reject(new AppError('DOWNLOAD_FAILED', `FFmpeg 退出码 ${code}：${stderr.slice(-200)}`, true))
        }
      })
      child.on('error', (err) => reject(new AppError('DOWNLOAD_FAILED', `FFmpeg 启动失败：${err.message}`, true)))
    })
  }

  return {
    async process(job, signal) {
      const workDir = job.workDir
      mkdirSync(workDir, { recursive: true })
      const filename = `output.${job.preferredExt || 'mp4'}`
      const output = join(workDir, filename)
      if (job.actionType === 'extract-audio') {
        await run(workDir, output, ['-i', job.files.audio || job.files.video, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', '-y', filename], signal)
      } else {
        await run(workDir, output, ['-i', job.files.video, '-i', job.files.audio, '-c', 'copy', '-movflags', '+faststart', '-y', filename], signal)
      }
      return { filepath: output, filename }
    }
  }
}
