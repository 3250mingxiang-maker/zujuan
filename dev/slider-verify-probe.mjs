// 抓 VerifyCaptchaV2 的回包 + 它实际提交的轨迹参数，搞清楚"验证失败"的判定依据。
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'
import { detectSlider, dragOnce } from '../lib/slider.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const profileDir = path.join(dataDir, 'chrome-profile')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })
const stamp = Date.now()

const url =
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('楞次定律') + '&intent=question&b=13&urlSource=0&sourceType=0'

const b = new Browser({ userDataDir: profileDir, headless: false, diag: true })
await b.launch()
await b.goto(url, { waitMs: 2000 })

// 页面里装一个探针：记录真实 DOM 事件序列（含 pointer），拖完把记录取出来
const INSTALL_PROBE = `(() => {
  if (window.__probe) return 'already';
  window.__probe = { events: [], marks: [] };
  const rec = (name) => (ev) => {
    const t = window.__probe;
    if (t.events.length > 4000) return;
    t.events.push({ n: name, x: Math.round(ev.clientX * 10) / 10, y: Math.round(ev.clientY * 10) / 10, t: Math.round(ev.timeStamp), trusted: ev.isTrusted, btns: ev.buttons, pt: ev.pointerType || '', target: (ev.target && (ev.target.id || ev.target.className || ev.target.tagName)) + '' });
  };
  for (const name of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup','touchstart','touchmove','touchend']) {
    window.addEventListener(name, rec(name), true);
  }
  return 'installed';
})()`

let st = await detectSlider(b)
for (let i = 0; i < 4 && !st.present; i++) {
  await b.goto(url, { waitMs: 1500 })
  await new Promise((r) => setTimeout(r, 900))
  st = await detectSlider(b)
}
console.log('滑块 present =', st.present)
if (!st.present) {
  console.log('没逼出来，退出')
  b.close()
  process.exit(0)
}
await b.evaluate(INSTALL_PROBE)

b.responses.length = 0
b.requests.length = 0
b.console.length = 0

const r = await dragOnce(b, (s) => console.log('  drag:', s))
console.log('dragOnce:', r.ok, r.reason)
await new Promise((res) => setTimeout(res, 1200))

// 取 verify 回包正文
const verifyResp = b.responses.filter((x) => /verify/i.test(x.url))
const bodies = []
for (const v of verifyResp.slice(-3)) {
  try {
    const body = await b.send('Network.getResponseBody', { requestId: v.requestId })
    bodies.push({ url: v.url.slice(0, 120), status: v.status, body: (body.body || '').slice(0, 3000) })
  } catch (e) {
    bodies.push({ url: v.url.slice(0, 120), status: v.status, error: String(e).slice(0, 120) })
  }
}
console.log('— verify 回包 —')
for (const x of bodies) console.log(JSON.stringify(x).slice(0, 1200))

// 取请求体里的 CaptchaVerifyParam 并解码
const post = b.requests.filter((x) => x.postData && /verify/i.test(x.url)).slice(-1)[0]
let decoded = null
if (post) {
  const m = String(post.postData).match(/CaptchaVerifyParam=([^&]+)/)
  if (m) {
    try {
      decoded = decodeURIComponent(m[1])
      if (decoded.startsWith('%7B') || decoded.startsWith('{')) {
        // 有的版本里参数本身还是 URL 编码的一层
      }
    } catch {}
  }
}
console.log('— CaptchaVerifyParam（解码后前 2500 字）—')
console.log(String(decoded).slice(0, 2500))

// 取页面探针记录：我们自己发的鼠标事件，页面收到了什么
const probe = await b.evaluate(`(() => {
  const p = window.__probe || { events: [] };
  const ev = p.events;
  const first = ev.slice(0, 12);
  const last = ev.slice(-8);
  const counts = {};
  for (const e of ev) counts[e.n] = (counts[e.n] || 0) + 1;
  const untrusted = ev.filter((e) => !e.trusted).length;
  return { total: ev.length, counts, untrusted, first, last };
})()`)
console.log('— 页面收到的事件统计 —')
console.log(JSON.stringify(probe).slice(0, 2500))

const file = path.join(outDir, `slider-verify-${stamp}.json`)
await writeFile(file, JSON.stringify({ stamp, url, drag: { ok: r.ok, reason: r.reason }, bodies, decodedParam: decoded, probe }, null, 1), 'utf8')
console.log('报告', file)
b.close()
process.exit(0)
