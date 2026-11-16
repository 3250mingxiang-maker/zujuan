// 滑块实验台：先把验证逼出来，再自动拖，然后把"服务端到底怎么判的"抓全。
// 用法：
//   node dev/slider-lab.mjs                 # 默认最多 3 次尝试，跑 1 轮
//   node dev/slider-lab.mjs 2 10            # 3 次尝试 × 2 轮，每轮最多 10 次导航逼验证
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'
import { detectSlider, isCaptchaPage, solveSlider } from '../lib/slider.mjs'

const rounds = Math.max(1, Number(process.argv[2]) || 1)
const maxNav = Math.max(1, Number(process.argv[3]) || 12)
const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const profileDir = path.join(dataDir, 'chrome-profile')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })
const stamp = Date.now()

const KEYWORDS = ['安培力', '洛伦兹力', '楞次定律', '法拉第电磁感应', '动量守恒', '电磁感应现象']
// 触发手段要"多样且密"：不同页型（检索/章节/知识点/试卷）+ 不同关键词，间隔可调
const PAPER_IDS = ['13p2438857', '13p2389247', '13p2301098']
const GAP = Number(process.env.GAP || 650)
const JIT = Number(process.env.JIT || 500)

const b = new Browser({ userDataDir: profileDir, headless: false, diag: true })
await b.launch()

const urlFor = (kw) =>
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent(kw) + '&intent=question&b=13&urlSource=0&sourceType=0'

const urlAt = (i, r) => {
  const kw = KEYWORDS[(r * 3 + i) % KEYWORDS.length]
  switch (i % 4) {
    case 0:
      return urlFor(kw)
    case 1:
      return `https://zujuan.xkw.com/quessearch?keyword=${encodeURIComponent(kw)}&intent=question&b=13&urlSource=0&sourceType=0&page=${1 + (i % 5)}`
    case 2:
      return `https://zujuan.xkw.com/${PAPER_IDS[i % PAPER_IDS.length]}.html`
    default:
      return `https://zujuan.xkw.com/gzwl/zsd${41934 + (i % 40)}/`
  }
}

const report = { stamp, rounds: [] }

for (let r = 1; r <= rounds; r++) {
  const row = { round: r, nav: [], drags: [] }
  let st = await detectSlider(b)
  let loggedIn = true

  for (let i = 0; i < maxNav && !st.present; i++) {
    const target = urlAt(i, r)
    await b.goto(target, { waitMs: 700 })
    st = await detectSlider(b)
    const cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
    const title = String(await b.title().catch(() => ''))
    row.nav.push({ i: i + 1, url: target.slice(0, 90), captcha: st.present, cards, title: title.slice(0, 30) })
    console.log(`[r${r}] nav${i + 1} ${target.slice(30, 90)} → captcha=${st.present} cards=${cards} ${title.slice(0, 24)}`)
    if (st.present) break
    if (/登录/.test(title) && cards <= 0) {
      loggedIn = false
      break
    }
    await new Promise((res) => setTimeout(res, GAP + Math.random() * JIT))
  }

  if (!st.present) {
    row.skipped = loggedIn ? '本轮没逼出滑块（IP/profile 还干净）' : '未登录（需要先 zujuan_login）'
    console.log(`[r${r}] ${row.skipped}`)
    report.rounds.push(row)
    continue
  }

  // 现场：装事件探针，看页面到底收到什么样的鼠标事件
  await b.evaluate(`(() => {
    if (window.__probe) return 'already';
    window.__probe = { events: [] };
    const rec = (name) => (ev) => {
      const t = window.__probe;
      if (t.events.length > 6000) return;
      t.events.push({ n: name, x: Math.round(ev.clientX), y: Math.round(ev.clientY), ts: Math.round(ev.timeStamp), trusted: ev.isTrusted, buttons: ev.buttons, pt: ev.pointerType || '' });
    };
    for (const n of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup']) window.addEventListener(n, rec(n), true);
    return 'ok';
  })()`)

  b.responses.length = 0
  b.requests.length = 0
  b.console.length = 0

  const solved = await solveSlider({ browser: b, attempts: 3, log: (s) => console.log(`[r${r}] ${s}`) })
  row.solved = { ok: solved.ok, attempts: solved.attempts, reason: solved.reason }

  // ── 抓判定依据 ──
  const verifyIds = b.responses.filter((x) => /verify/i.test(x.url)).map((x) => x.requestId)
  const bodies = []
  for (const id of verifyIds.slice(-3)) {
    try {
      const body = await b.send('Network.getResponseBody', { requestId: id })
      bodies.push((body.body || '').slice(0, 1500))
    } catch (e) {
      bodies.push('ERR ' + String(e).slice(0, 80))
    }
  }
  row.verifyBodies = bodies

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
  row.captchaVerifyParam = param ? param.slice(0, 4000) : null

  const probe = await b
    .evaluate(`(() => {
      const ev = (window.__probe && window.__probe.events) || [];
      const counts = {};
      for (const e of ev) counts[e.n] = (counts[e.n] || 0) + 1;
      const untrusted = ev.filter((e) => !e.trusted).length;
      const dts = [];
      for (let i = 1; i < ev.length; i++) if (ev[i].n === 'pointermove' && ev[i - 1].n === 'pointermove') dts.push(ev[i].ts - ev[i - 1].ts);
      return { total: ev.length, counts, untrusted, first: ev.slice(0, 6), last: ev.slice(-4), dtSample: dts.slice(0, 40), dtAvg: dts.length ? Math.round(dts.reduce((a, b2) => a + b2, 0) / dts.length) : null };
    })()`)
    .catch((e) => ({ error: String(e).slice(0, 120) }))
  row.probe = probe

  // 拖完是否真的放行
  await b.goto(urlFor('安培力'), { waitMs: 2000 })
  const after = await detectSlider(b)
  const afterCards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
  row.after = { captcha: after.present, cards: afterCards, captchaPage: await isCaptchaPage(b) }
  console.log(`[r${r}] 结果 ok=${solved.ok}｜复访 captcha=${after.present} cards=${afterCards}`)
  console.log(`[r${r}] 事件统计 ${JSON.stringify({ total: probe.total, counts: probe.counts, untrusted: probe.untrusted, dtAvg: probe.dtAvg })}`)
  if (bodies.length) console.log(`[r${r}] verify 回包 ${JSON.stringify(bodies[0]).slice(0, 400)}`)
  report.rounds.push(row)

  if (!solved.ok) {
    console.log('未通过，先停在这里看现场（避免继续消耗 profile 信誉）')
    break
  }
  await new Promise((res) => setTimeout(res, 2000))
}

report.endedAt = new Date().toISOString()
const file = path.join(outDir, `slider-lab-${stamp}.json`)
await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
console.log('报告', file)
b.close()
process.exit(0)
