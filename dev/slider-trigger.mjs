// 用插件真实的调用形态（页面内 fetch 连发检索）逼出滑块，然后自动拖 + 抓判定依据。
// 用法：node dev/slider-trigger.mjs [最多检索次数] [间隔ms]
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'
import { ZujuanSite } from '../lib/site.mjs'
import { detectSlider, isCaptchaPage, solveSlider } from '../lib/slider.mjs'

const maxRounds = Math.max(1, Number(process.argv[2]) || 30)
const gap = Math.max(0, Number(process.argv[3]) || 250)
const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const profileDir = path.join(dataDir, 'chrome-profile')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })
const stamp = Date.now()

const KP = [41934, 41935, 41936, 41937, 41938, 41939, 41940, 41941, 41942, 41943]

const b = new Browser({ userDataDir: profileDir, headless: false, diag: true })
await b.launch()
const site = new ZujuanSite(b, { paceMs: 0, cacheDir: dataDir, useFetch: true, log: () => {} })

const report = { stamp, rounds: [], trigger: null }
let hit = false

// 1) 先落到站内（页面内 fetch 需要同源文档）
await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 1500 })

for (let i = 1; i <= maxRounds && !hit; i++) {
  const kp = KP[i % KP.length]
  const page = 1 + (i % 4)
  const t0 = Date.now()
  const res = await site
    .search({ subject: '高中物理', knowledgeId: String(kp), pages: 2, page })
    .catch((e) => ({ ok: false, error: String(e) }))
  const ms = Date.now() - t0
  console.log(`#${i} kp=${kp} p=${page} → ok=${res.ok} n=${res.questions?.length ?? 0} captcha=${Boolean(res.captcha)} ${ms}ms ${res.warning || res.error || ''}`)
  report.rounds.push({ i, kp, page, ok: res.ok, n: res.questions?.length ?? 0, captcha: Boolean(res.captcha), ms, warning: res.warning || res.error || '' })
  if (res.captcha) {
    hit = true
    break
  }
  await new Promise((r) => setTimeout(r, gap + Math.random() * 200))
}

if (!hit) {
  console.log('连发也没逼出滑块；当前 IP/profile 仍是干净的。')
  report.trigger = 'none'
  const file = path.join(outDir, `slider-trigger-${stamp}.json`)
  await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
  console.log('报告', file)
  b.close()
  process.exit(0)
}

// 2) 触发了：导航一次把验证页渲染出来
report.trigger = 'captcha'
await b.goto('https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('安培力') + '&intent=question&b=13&urlSource=0&sourceType=0', { waitMs: 1800 })
let st = await detectSlider(b)
console.log('验证页渲染：present =', st.present, '｜title =', String(await b.title().catch(() => '')))
if (!st.present) {
  // 换页型再试
  for (const u of ['https://zujuan.xkw.com/gzwl/', 'https://zujuan.xkw.com/13p2438857.html']) {
    await b.goto(u, { waitMs: 1500 })
    st = await detectSlider(b)
    if (st.present) break
  }
}
if (!st.present) {
  console.log('有 captcha 标记但没渲染出滑动组件（可能是别的拦截页），退出')
  const file = path.join(outDir, `slider-trigger-${stamp}.json`)
  await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
  b.close()
  process.exit(0)
}

// 3) 装事件探针 + 开始拖
await b.evaluate(`(() => {
  if (window.__probe) return 'already';
  window.__probe = { events: [] };
  const rec = (n) => (ev) => {
    const t = window.__probe;
    if (t.events.length > 8000) return;
    t.events.push({ n, x: Math.round(ev.clientX), y: Math.round(ev.clientY), ts: Math.round(ev.timeStamp), trusted: ev.isTrusted, buttons: ev.buttons, pt: ev.pointerType || '' });
  };
  for (const n of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup']) window.addEventListener(n, rec(n), true);
  return 'ok';
})()`)

b.responses.length = 0
b.requests.length = 0
b.console.length = 0

const solved = await solveSlider({ browser: b, attempts: 3, log: (s) => console.log('  ' + s) })
console.log('solve →', JSON.stringify({ ok: solved.ok, attempts: solved.attempts, reason: solved.reason }))

// 4) 判定依据
const bodies = []
for (const v of b.responses.filter((x) => /verify/i.test(x.url)).slice(-3)) {
  try {
    const body = await b.send('Network.getResponseBody', { requestId: v.requestId })
    bodies.push({ url: v.url.slice(0, 100), status: v.status, body: (body.body || '').slice(0, 2000) })
  } catch (e) {
    bodies.push({ url: v.url.slice(0, 100), status: v.status, error: String(e).slice(0, 100) })
  }
}
const post = b.requests.filter((x) => x.postData && /verify/i.test(x.url)).slice(-1)[0]
let param = null
if (post) {
  const m = String(post.postData).match(/CaptchaVerifyParam=([^&]+)/)
  if (m) {
    try {
      param = decodeURIComponent(m[1])
    } catch {
      param = m[1]
    }
  }
}
const probe = await b
  .evaluate(`(() => {
    const ev = (window.__probe && window.__probe.events) || [];
    const counts = {};
    for (const e of ev) counts[e.n] = (counts[e.n] || 0) + 1;
    const dts = [];
    for (let i = 1; i < ev.length; i++) if (ev[i].n === 'pointermove' && ev[i - 1].n === 'pointermove') dts.push(ev[i].ts - ev[i - 1].ts);
    return { total: ev.length, counts, untrusted: ev.filter((e) => !e.trusted).length, dtAvg: dts.length ? Math.round(dts.reduce((a, c) => a + c, 0) / dts.length) : null, first: ev.slice(0, 5), last: ev.slice(-3) };
  })()`)
  .catch((e) => ({ error: String(e) }))

console.log('— verify 回包 —')
for (const x of bodies) console.log(JSON.stringify(x).slice(0, 800))
console.log('— CaptchaVerifyParam —')
console.log(String(param).slice(0, 3000))
console.log('— 页面事件 —', JSON.stringify(probe).slice(0, 1200))

// 5) 放行确认
await b.goto('https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('安培力') + '&intent=question&b=13&urlSource=0&sourceType=0', { waitMs: 1800 })
const after = { captcha: (await detectSlider(b)).present, captchaPage: await isCaptchaPage(b), cards: await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1) }
console.log('复访：', JSON.stringify(after))

report.solve = { ok: solved.ok, attempts: solved.attempts, reason: solved.reason, log: solved.log }
report.verifyBodies = bodies
report.captchaVerifyParam = param
report.probe = probe
report.after = after
const file = path.join(outDir, `slider-trigger-${stamp}.json`)
await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
console.log('报告', file)
b.close()
process.exit(0)
