// 抖音游客 cookie：通过 ttwid 注册接口 + 回调链取得游客态（无需登录）。
// 抖音分享页用它作基础 cookie；失效自动重注册，TTL 12 小时。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

const cache = { cookie: '', expires: 0 }

export async function getDouyinGuestCookie(fetchImpl = globalThis.fetch) {
  if (cache.cookie && Date.now() < cache.expires) return cache.cookie
  try {
    const regRes = await fetchImpl('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        region: 'cn', aid: 1768, needFid: false, service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' }, cbUrlProtocol: 'https', union: true
      })
    })
    const reg = await regRes.json()
    let url = typeof reg?.redirect_url === 'string' ? reg.redirect_url : ''
    let ttwid = ''
    for (let hop = 0; hop < 5 && url && !ttwid; hop += 1) {
      const res = await fetchImpl(url, { redirect: 'manual', headers: { 'User-Agent': UA } })
      const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      for (const c of setCookies) {
        const m = /ttwid=([^;]+)/.exec(c)
        if (m) ttwid = m[1]
      }
      url = hop < 4 ? (res.headers?.get('location') || '') : ''
    }
    if (ttwid) {
      cache.cookie = `ttwid=${ttwid}`
      cache.expires = Date.now() + 12 * 3600 * 1000
    }
  } catch {
    /* 拿不到游客 cookie 时返回空串，由调用方决定降级 */
  }
  return cache.cookie
}
