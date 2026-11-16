// 快速看当前 profile 在站点上是什么状态（正常 / 阻断 / 验证 / 登录）。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false })
await b.launch()

const urls = [
  'https://zujuan.xkw.com/gzwl/',
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('楞次定律') + '&intent=question&b=13&urlSource=0&sourceType=0',
  'https://zujuan.xkw.com/13p2438857.html',
]

for (const u of urls) {
  await b.goto(u, { waitMs: 2400 })
  const title = String(await b.title().catch(() => ''))
  const info = await b
    .evaluate(`(() => ({
      text: document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220) : '',
      cards: document.querySelectorAll('.tk-quest-item').length,
      captcha: [...document.querySelectorAll('[id*=aptcha],[id*=sliding],[class*=captcha]')].map((e) => e.id || String(e.className)).slice(0, 8),
      login: /登录/.test(document.body ? document.body.innerText.slice(0, 200) : ''),
    }))()`)
    .catch((e) => ({ error: String(e).slice(0, 120) }))
  console.log(`${u.slice(0, 70)}\n   title=${title.slice(0, 30)} :: ${JSON.stringify(info).slice(0, 380)}`)
  await new Promise((r) => setTimeout(r, 1400))
}
b.close()
process.exit(0)
