// 逐事件验证：CDP 的 mousePressed/mouseReleased 到底有没有进到页面（等回执 vs 不等回执）。
// 需要页面上有滑块；没有就先连点逼出来。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'
import { detectSlider } from '../lib/slider.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false, diag: true })
await b.launch()

const PROBE = `(() => {
  window.__ev = [];
  const rec = (n) => (ev) => {
    if (window.__ev.length > 500) return;
    window.__ev.push({ n, x: Math.round(ev.clientX), y: Math.round(ev.clientY), trusted: ev.isTrusted, buttons: ev.buttons, button: ev.button, pt: ev.pointerType || '' });
  };
  for (const n of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup']) window.addEventListener(n, rec(n), true);
  return 'ok';
})()`

let st = await detectSlider(b)
if (!st.present) {
  const urls = [
    'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('安培力') + '&intent=question&b=13&urlSource=0&sourceType=0',
    'https://zujuan.xkw.com/13p2438857.html',
    'https://zujuan.xkw.com/gzwl/zsd41934/',
  ]
  for (let i = 0; i < 12 && !st.present; i++) {
    await b.goto(urls[i % urls.length], { waitMs: 500 })
    st = await detectSlider(b)
    await new Promise((r) => setTimeout(r, 150))
  }
}
console.log('slider present =', st.present)
if (!st.present) {
  console.log('没滑块，退出')
  b.close()
  process.exit(0)
}

await b.evaluate(PROBE)
const h = st.handle
console.log('把手中心', h.cx.toFixed(1), h.cy.toFixed(1))

// 1) 等回执地发一次 press
try {
  const r1 = await b.mouse('mousePressed', h.cx, h.cy, { buttons: 1, button: 'left', clickCount: 1 })
  console.log('awaited press 回执:', JSON.stringify(r1))
} catch (e) {
  console.log('awaited press 报错:', String(e).slice(0, 200))
}
await new Promise((r) => setTimeout(r, 150))
let ev = await b.evaluate('window.__ev.slice(-6)')
console.log('press 后页面收到:', JSON.stringify(ev))

// 2) 拖两下
for (let i = 1; i <= 3; i++) await b.mouse('mouseMoved', h.cx + i * 20, h.cy, { buttons: 1, button: 'left' })
await new Promise((r) => setTimeout(r, 120))
const filled = await b.evaluate(`(() => { const f = document.querySelector('#aliyunCaptcha-sliding-left'); return f ? Math.round(f.getBoundingClientRect().width) : -1; })()`)
console.log('拖 60px 后填充条宽度 =', filled, '｜文案 =', await b.evaluate(`(() => { const t = document.querySelector('#aliyunCaptcha-sliding-text'); return t ? t.innerText : ''; })()`))

// 3) 松手
try {
  const r2 = await b.mouse('mouseReleased', h.cx + 60, h.cy, { buttons: 0, button: 'left', clickCount: 1 })
  console.log('awaited release 回执:', JSON.stringify(r2))
} catch (e) {
  console.log('awaited release 报错:', String(e).slice(0, 200))
}
await new Promise((r) => setTimeout(r, 300))
ev = await b.evaluate('window.__ev')
const counts = {}
for (const e of ev) counts[e.n] = (counts[e.n] || 0) + 1
console.log('全部事件统计:', JSON.stringify({ total: ev.length, counts, sample: ev.slice(0, 10) }))

b.close()
process.exit(0)
