// profile 净化：删掉阿里云风控 Cookie + 清站点 storage，让下一次请求重新走干净的 JS 挑战。
// 只删风控类，不动登录态（user_token / UT1 / UT2 / TGC / refresh_token 等）。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'
import { isCaptchaPage } from '../lib/site.mjs'

const RISK = /^(alicfw|acw_|aliyungf|_c_WBKFRo|__jsl|Hm_|HMACCOUNT|_nb_|acw_sc|captcha)/i
const KEEP = /^(user_token|xkw-device-id|xkw-fs-id|bankId|bankname|zj-device-id|ip2ProvinceId|__RequestVerificationToken|UT1|UT2|TGC|__Host-refresh_token)/i

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false, diag: true })
await b.launch()

const SITES = ['https://zujuan.xkw.com/', 'https://sso.zxxk.com/', 'https://staticzujuan.xkw.com/', 'https://imzujuan.xkw.com/']
const list = async () => b.cookies().catch(() => [])

await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 1200 })
const before = await list()
console.log(`净化前 Cookie ${before.length} 个：`, before.map((c) => c.name).join(', ').slice(0, 400))

let removed = 0
for (const c of before) {
  if (!RISK.test(c.name)) continue
  if (KEEP.test(c.name)) continue
  try {
    await b.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' })
    removed += 1
  } catch {}
}
// 站点 storage 一起清（有的风险标记放在 localStorage）
try {
  await b.evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch (e) {} return true })()`)
} catch {}

// 重新访问，看还拦不拦
await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 2000 })
const title = String(await b.title().catch(() => ''))
const cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item, .ques-item').length`).catch(() => -1)
const stillCaptcha = isCaptchaPage(title, '')
const after = await list()
console.log(`删了 ${removed} 个风控 Cookie；净化后 Cookie ${after.length} 个`)
console.log(`复访：title=${title.slice(0, 30)} cards=${cards} captcha=${stillCaptcha}`)
if (stillCaptcha) console.log('仍然被拦：说明判定已经落在服务端（IP/设备），换网络（手机热点）或等一会儿最省事。')
b.close()
process.exit(0)
