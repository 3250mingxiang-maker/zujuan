// 端到端：先逼出滑块，再让插件自己的 search() 撞上它 → 自动通过 → 继续出题。
// 判据：captchaStats.passed + 最终 questions.length > 0
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'
import { ZujuanSite } from '../lib/site.mjs'

const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })
const stamp = Date.now()

const b = new Browser({ userDataDir: path.join(dataDir, 'chrome-profile'), headless: false })
await b.launch()
const site = new ZujuanSite(b, {
  paceMs: 0,
  cacheDir: dataDir,
  useFetch: true,
  autoCaptcha: true,
  log: (...a) => console.log('  [site]', ...a),
})

const KP = [41934, 41935, 41936, 41937, 41938, 41939, 41940, 41941, 41942, 41943]
const report = { stamp, steps: [] }

// 1) 高压连发，逼出滑块
await b.goto('https://zujuan.xkw.com/gzwl/', { waitMs: 1200 })
let hit = false
for (let i = 1; i <= 60 && !hit; i++) {
  const res = await site.search({ subject: '高中物理', knowledgeId: String(KP[i % KP.length]), pages: 1 }).catch((e) => ({ ok: false, error: String(e) }))
  console.log(`hammer#${i} ok=${res.ok} n=${res.questions?.length ?? 0} captcha=${Boolean(res.captcha)} ${res.warning || ''}`)
  report.steps.push({ phase: 'hammer', i, ok: res.ok, n: res.questions?.length ?? 0, captcha: Boolean(res.captcha), warning: res.warning || null })
  if (res.captcha && !res.questions?.length) {
    // 自动通过成功的话这里其实会有题；没有才算"没救回来"
    hit = true
    break
  }
  if (site.captchaStats.tried > 0) {
    hit = true
    break
  }
  await new Promise((r) => setTimeout(r, 150))
}

// 2) 关键一步：再走一次真实检索，看是否顺滑（此时若还有验证，go() 会自己过）
const final = await site.search({ subject: '高中物理', knowledgeId: '41934', pages: 1, difficulty: '适中' }).catch((e) => ({ ok: false, error: String(e) }))
console.log('最终检索：', JSON.stringify({ ok: final.ok, n: final.questions?.length ?? 0, captcha: Boolean(final.captcha), warning: final.warning || null }))
report.final = { ok: final.ok, n: final.questions?.length ?? 0, captcha: Boolean(final.captcha), warning: final.warning || null }
report.captchaStats = site.captchaStats
report.sample = (final.questions || []).slice(0, 3).map((q) => ({ id: q.id, type: q.type, difficulty: q.difficulty, stem: String(q.stemText || '').slice(0, 50) }))

const shot = path.join(outDir, `e2e-${stamp}.png`)
await b.screenshot(shot).catch(() => {})
report.shot = shot
const file = path.join(outDir, `e2e-${stamp}.json`)
await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
console.log('captchaStats:', JSON.stringify(site.captchaStats))
console.log('报告', file)
b.close()
process.exit(0)
