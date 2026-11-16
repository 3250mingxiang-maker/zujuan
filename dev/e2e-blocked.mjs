// 端到端（blocked 状态直接验）：插件自己撞上滑块 → 自动过 → 等自回跳 → 继续取题。
import path from 'node:path'
import os from 'node:os'
import { Browser } from '../lib/cdp.mjs'
import { ZujuanSite } from '../lib/site.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false })
await b.launch()
const site = new ZujuanSite(b, {
  paceMs: 0,
  cacheDir: dataDir,
  useFetch: true,
  autoCaptcha: true,
  log: (...a) => console.log('  [site]', ...a),
})

// 1) 先正常导航到站内（此时是验证页）
const nav = await site.go('https://zujuan.xkw.com/gzwl/')
console.log('go →', JSON.stringify({ ok: nav.ok, captcha: Boolean(nav.captcha), viaCaptcha: Boolean(nav.viaCaptcha), title: String(nav.title || '').slice(0, 30), reason: nav.captchaAttempt || null }))

// 2) 紧接着（不再导航）用知识点检索走导航路径
const r1 = await site.search({ subject: '高中物理', knowledgeId: '41934', pages: 1 }).catch((e) => ({ ok: false, error: String(e) }))
console.log('search1 →', JSON.stringify({ ok: r1.ok, n: r1.questions?.length ?? 0, captcha: Boolean(r1.captcha), warning: r1.warning || r1.error || null }))

// 3) 关键词检索（页面内 fetch）
const r2 = await site.search({ subject: '高中物理', keyword: '洛伦兹力', pages: 1 }).catch((e) => ({ ok: false, error: String(e) }))
console.log('search2(fetch) →', JSON.stringify({ ok: r2.ok, n: r2.questions?.length ?? 0, captcha: Boolean(r2.captcha), warning: r2.warning || r2.error || null }))
console.log('captchaStats:', JSON.stringify(site.captchaStats))
b.close()
process.exit(0)
