// 滑块自动通过的实测脚本：逼出验证 → 自动拖 → 再访问，看是否放行。
// 用法：node dev/slider-solve.mjs [轮数]
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { Browser } from '../lib/cdp.mjs'
import { detectSlider, solveSlider } from '../lib/slider.mjs'

const rounds = Math.max(1, Number(process.argv[2]) || 3)
const dataDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
const profileDir = path.join(dataDir, 'chrome-profile')
const outDir = path.join(dataDir, 'logs')
await mkdir(outDir, { recursive: true })

const url =
  'https://zujuan.xkw.com/quessearch?keyword=' + encodeURIComponent('洛伦兹力') + '&intent=question&b=13&urlSource=0&sourceType=0'

const b = new Browser({ userDataDir: profileDir, headless: false })
await b.launch()

const probe = async () => {
  const s = await detectSlider(b)
  const cards = await b.evaluate(`document.querySelectorAll('.tk-quest-item').length`).catch(() => -1)
  const title = await b.title().catch(() => '')
  return { slider: s.present, cards, title: String(title) }
}

const report = { rounds: [], startedAt: new Date().toISOString() }

for (let r = 1; r <= rounds; r++) {
  const row = { round: r, steps: [] }
  // 故意连点，逼出滑块
  let st = await probe()
  let tries = 0
  while (!st.slider && tries < 6) {
    await b.goto(url, { waitMs: 1500 })
    st = await probe()
    tries += 1
    if (st.cards > 0) break
    await new Promise((res) => setTimeout(res, 900 + Math.random() * 1200))
  }
  row.steps.push({ phase: 'trigger', ...st })

  if (st.slider) {
    const t0 = Date.now()
    const solved = await solveSlider({
      browser: b,
      attempts: 3,
      log: (s) => console.log(`[r${r}] ${s}`),
    })
    row.solve = { ok: solved.ok, attempts: solved.attempts, reason: solved.reason, ms: Date.now() - t0 }
    console.log(`[r${r}] 拖拽结果 ok=${solved.ok} attempts=${solved.attempts} ${solved.reason} (${Date.now() - t0}ms)`)

    // 通过后再访问原页，确认真的放行
    await b.goto(url, { waitMs: 1800 })
    const after = await probe()
    row.steps.push({ phase: 'after', ...after })
    console.log(`[r${r}] 复访：slider=${after.slider} cards=${after.cards} title=${after.title}`)
    const shot = path.join(outDir, `slider-after-${Date.now()}.png`)
    await b.screenshot(shot).catch(() => {})
    row.shot = shot
    if (!solved.ok) break // 没通过就别继续糟蹋 profile
  } else {
    row.steps.push({ phase: 'no-captcha', note: '本轮没触发滑块' })
    console.log(`[r${r}] 没触发滑块（cards=${st.cards}）`)
    if (st.cards > 0) break
  }
  report.rounds.push(row)
  await new Promise((res) => setTimeout(res, 1500 + Math.random() * 1500))
}

report.endedAt = new Date().toISOString()
const file = path.join(outDir, `slider-solve-${Date.now()}.json`)
await writeFile(file, JSON.stringify(report, null, 1), 'utf8')
console.log('报告', file)
b.close()
process.exit(0)
