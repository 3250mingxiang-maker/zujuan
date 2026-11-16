// 验证「屏幕外有界面」是否两全：窗口不出现在桌面上，但页面正常、滑块还能自动拖。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'
import { detectSlider } from '../lib/slider.mjs'
import { ZujuanSite } from '../lib/site.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false })
await b.launch()

const bounds = async () => {
  try {
    const id = await b.windowId()
    const r = await b.ws.send('Browser.getWindowBounds', { windowId: id })
    return `${r.bounds.left},${r.bounds.top} ${r.bounds.width}x${r.bounds.height} ${r.bounds.windowState}`
  } catch (e) {
    return 'ERR ' + String(e).slice(0, 60)
  }
}
console.log('窗口初始位置:', await bounds())

const url = (kw) =>
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent(kw) + '&intent=question&b=13&urlSource=0&sourceType=0'
const KW = ['安培力', '洛伦兹力', '楞次定律', '法拉第电磁感应', '动量守恒', '电磁感应现象']

await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 1500 })
let captcha = (await detectSlider(b)).present
let cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
console.log('首屏：captcha =', captcha, '｜cards =', cards, '｜title =', String(await b.title()).slice(0, 22))

// 连点逼验证（屏幕外也要能正常渲染/解析）
for (let i = 0; i < 30 && !captcha; i++) {
  await b.goto(url(KW[i % KW.length]), { waitMs: 700 })
  captcha = (await detectSlider(b)).present
  cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
  console.log(`nav${i + 1} captcha=${captcha} cards=${cards}`)
  if (!captcha) await new Promise((r) => setTimeout(r, 120 + Math.random() * 80))
}

if (!captcha) {
  console.log('没触发验证（profile 干净）；普通页面在屏幕外照样能读卡片 → OK')
  console.log('窗口位置:', await bounds())
  b.close()
  process.exit(0)
}

const solved = await new ZujuanSite(b, { autoCaptcha: true, hideWindow: true, log: (s) => console.log('  [site]', s) }).passCaptcha({
  attempts: 2,
  navTo: url('安培力'),
})
console.log('自动拖拽:', JSON.stringify({ ok: solved.ok, attempts: solved.attempts, reason: solved.reason }))
console.log('窗口位置（拖完）:', await bounds())

await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 1800 })
console.log('复访：captcha =', (await detectSlider(b)).present, '｜cards =', await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1))
b.close()
process.exit(0)
