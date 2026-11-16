// 滑块现场勘探：用真实 profile（有登录态）快速连点检索页，逼出阿里云「访问验证」，
// 然后把验证页的 DOM 结构（iframe / 滑块元素 / 轨道几何）dump 成 JSON，供 lib/slider.mjs 写选择器。
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const profileDir = path.join(dataDir, 'chrome-profile')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })

const url =
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('安培力') + '&intent=question&b=13&urlSource=0&sourceType=0'

const b = new Browser({ userDataDir: profileDir, headless: false })
await b.launch()

const isCaptcha = async () => {
  try {
    const title = await b.title()
    const text = await b.evaluate('document.body ? document.body.innerText.slice(0, 400) : ""')
    return /滑动验证|访问验证/.test(String(title) + String(text))
  } catch {
    return false
  }
}

let hit = false
for (let i = 1; i <= 12 && !hit; i++) {
  await b.goto(url, { waitMs: 1600 })
  hit = await isCaptcha()
  const cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
  console.log(`try ${i}: captcha=${hit} cards=${cards}`)
  if (hit) break
  await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1500))
}

if (!hit) {
  console.log('没有逼出滑块（说明当前 profile/IP 还干净），改成直接 dump 当前页做对照')
}

const dump = await b.evaluate(`(() => {
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const pick = (el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    cls: (el.className && String(el.className)) || '',
    text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
    ...box(el),
  });
  const all = [...document.querySelectorAll('body *')];
  const interesting = all.filter((el) => {
    const s = (el.id + ' ' + String(el.className || '') + ' ' + el.tagName).toLowerCase();
    return /captcha|slide|slider|nc_|verify|btn|drag|track|aliyun|acw|puzzle/.test(s);
  }).slice(0, 80).map(pick);
  const iframes = [...document.querySelectorAll('iframe')].map((f) => ({ src: f.src, id: f.id, ...box(f) }));
  const canvases = [...document.querySelectorAll('canvas')].map((c) => ({ id: c.id, cls: String(c.className || ''), ...box(c) }));
  return {
    title: document.title,
    href: location.href,
    bodyText: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300) : '',
    iframes,
    canvases,
    interesting,
    bodyHtmlHead: document.body ? document.body.innerHTML.slice(0, 4000) : '',
  };
})()`)

const file = path.join(outDir, `slider-probe-${Date.now()}.json`)
await writeFile(file, JSON.stringify(dump, null, 1), 'utf8')
const shot = path.join(outDir, `slider-probe-${Date.now()}.png`)
await b.screenshot(shot).catch(() => {})
console.log('title=', dump.title, '| href=', dump.href)
console.log('iframes=', JSON.stringify(dump.iframes))
console.log('canvases=', JSON.stringify(dump.canvases))
console.log('interesting:')
for (const i of dump.interesting) console.log('  ', JSON.stringify(i))
console.log('saved', file, shot)
await new Promise((r) => setTimeout(r, 200))
b.close()
process.exit(0)
