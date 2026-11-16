// 验收：窗口只留一条窄边在屏幕边（人看不到），且长时间空闲后 CDP 不冻结、检索照常。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'
import { ZujuanSite } from '../lib/site.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false })
await b.launch()
const site = new ZujuanSite(b, { paceMs: 0, cacheDir: dataDir, useFetch: true, hideWindow: true, log: (s) => console.log('  [site]', s) })

const bounds = async () => {
  try {
    const id = await b.windowId()
    const r = await b.ws.send('Browser.getWindowBounds', { windowId: id })
    const { left, top, width, height } = r.bounds
    return `${left},${top} ${width}x${height}`
  } catch (e) {
    return 'ERR ' + String(e).slice(0, 50)
  }
}

console.log('窗口位置:', await bounds())

const t0 = Date.now()
const r1 = await site.search({ subject: '高中物理', keyword: '安培力', pages: 1 }).catch((e) => ({ ok: false, error: String(e) }))
console.log(`检索1 ${Date.now() - t0}ms → ok=${r1.ok} n=${r1.questions?.length ?? 0} captcha=${Boolean(r1.captcha)}`)

console.log('空闲 45 秒（模拟"窗口躺在屏幕外边"）…')
await new Promise((r) => setTimeout(r, 45_000))
const ping = await b.ping({ timeoutMs: 5000 })
console.log('空闲后 CDP ping:', ping)

const t1 = Date.now()
const r2 = await site.search({ subject: '高中物理', keyword: '洛伦兹力', pages: 1 }).catch((e) => ({ ok: false, error: String(e) }))
console.log(`检索2 ${Date.now() - t1}ms → ok=${r2.ok} n=${r2.questions?.length ?? 0} captcha=${Boolean(r2.captcha)}`)
console.log('窗口位置:', await bounds())
b.close()
process.exit(0)
