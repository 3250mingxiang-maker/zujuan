// 纯 CDP 鼠标自测：本地空白页上放一个条，看 mousePressed/Released 能不能真的进页面。
// 用来区分「我们的 CDP 客户端写错」和「页面/焦点导致事件被内核丢弃」。
import path from 'node:path'
import os from 'node:os'
import { writeFile, mkdir } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'

const tmp = path.join(os.tmpdir(), 'mouse-selftest')
await mkdir(tmp, { recursive: true })
const html = path.join(tmp, 'index.html')
await writeFile(
  html,
  `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div id="track" style="position:absolute;left:100px;top:100px;width:320px;height:40px;background:#eee">
  <div id="handle" style="position:absolute;left:0;top:0;width:40px;height:40px;background:#f60"></div>
</div>
<script>
window.__ev = [];
for (const n of ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup']) {
  window.addEventListener(n, (ev) => {
    window.__ev.push({ n, x: Math.round(ev.clientX), y: Math.round(ev.clientY), trusted: ev.isTrusted, buttons: ev.buttons, button: ev.button, pt: ev.pointerType || '' });
  }, true);
}
const h = document.getElementById('handle');
let dragging = false, startX = 0;
h.addEventListener('pointerdown', (e) => { dragging = true; startX = e.clientX; });
window.addEventListener('pointermove', (e) => { if (dragging) h.style.left = Math.max(0, Math.min(280, e.clientX - 120)) + 'px'; });
window.addEventListener('pointerup', () => { dragging = false; });
</script></body>`,
  'utf8',
)

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(tmp, 'profile'), headless: false })
await b.launch()
await b.goto('file:///' + html.replace(/\\/g, '/'), { waitMs: 400 })

const report = []
const step = async (label, fn) => {
  let ret
  try {
    ret = await fn()
  } catch (e) {
    ret = 'ERR ' + String(e).slice(0, 160)
  }
  await new Promise((r) => setTimeout(r, 120))
  const evs = await b.evaluate('window.__ev.slice()').catch(() => [])
  report.push({ label, ret, events: evs.slice(-4), handleLeft: await b.evaluate(`document.getElementById('handle').style.left`).catch(() => '') })
  console.log(label, '→ ret=', JSON.stringify(ret), '｜最后事件=', JSON.stringify(evs.slice(-2)))
}

await b.bringToFront()
await step('A: 等回执 press (button left, buttons 1, clickCount 1)', () =>
  b.mouse('mousePressed', 120, 120, { button: 'left', buttons: 1, clickCount: 1 }),
)
await step('B: move x+40', () => b.mouse('mouseMoved', 160, 120, { button: 'left', buttons: 1 }))
await step('C: release', () => b.mouse('mouseReleased', 160, 120, { button: 'left', buttons: 0, clickCount: 1 }))
await step('D: 不等回执 press', () => b.mouseFire('mousePressed', 120, 120, { button: 'left', buttons: 1, clickCount: 1 }))
await step('E: fire move x+80', () => b.mouseFire('mouseMoved', 200, 120, { button: 'left', buttons: 1 }))
await step('F: fire release', () => b.mouseFire('mouseReleased', 200, 120, { button: 'left', buttons: 0, clickCount: 1 }))
await step('G: 显式 pointerType=none 的 press', async () => {
  const payload = { type: 'mousePressed', x: 120, y: 120, button: 'left', buttons: 1, clickCount: 1,
    pointerType: 'mouse', force: 1, tangentialPressure: 0, tiltX: 0, tiltY: 0 }
  return b.send('Input.dispatchMouseEvent', payload)
})
await step('H: 打开 DevTools 输入分发 Input.setIgnoreInputEvents(false) 后再 press', async () => {
  await b.send('Input.setIgnoreInputEvents', { ignore: false }).catch(() => {})
  return b.mouse('mousePressed', 120, 120, { button: 'left', buttons: 1, clickCount: 1 })
})

const final = await b.evaluate(`(() => {
  const counts = {};
  for (const e of window.__ev) counts[e.n] = (counts[e.n] || 0) + 1;
  return { counts, total: window.__ev.length, handleLeft: document.getElementById('handle').style.left };
})()`)
console.log('汇总:', JSON.stringify(final))
await writeFile(path.join(tmp, 'report.json'), JSON.stringify(report, null, 1), 'utf8')
b.close()
process.exit(0)
