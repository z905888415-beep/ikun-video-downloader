import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createRateLimiter } from '../core/rate-limit.js'

let now = 1_000

function startApp() {
  const app = express()
  app.set('trust proxy', true)
  app.get('/limited', createRateLimiter({ windowMs: 60_000, max: 2, now: () => now }), (_req, res) => res.json({ ok: true }))
  const server = app.listen(0)
  return new Promise((resolve) => server.once('listening', () => resolve(server)))
}

test('限流器按客户端 IP 拒绝超额请求，并在窗口后恢复', async () => {
  const server = await startApp()
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const options = { headers: { 'X-Forwarded-For': '203.0.113.7' } }
    assert.equal((await fetch(`${base}/limited`, options)).status, 200)
    assert.equal((await fetch(`${base}/limited`, options)).status, 200)
    const blocked = await fetch(`${base}/limited`, options)
    assert.equal(blocked.status, 429)
    assert.equal(blocked.headers.get('retry-after'), '60')

    now += 60_000
    assert.equal((await fetch(`${base}/limited`, options)).status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
