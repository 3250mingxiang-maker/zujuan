// 端到端计时：预设情景 → 检索 → 抓题 → 出卷，输出各步耗时与回传体积
import path from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
// 用真实 profile（已登录、已有反爬 Cookie），否则全新 profile 会被挑战页挡住，测出来是假数据
const dataDir = process.env.ZUJUAN_BENCH_DIR || path.join(process.env.USERPROFILE || root, '.dsh', 'zujuan')

const plugin = await import(new URL('../index.js', import.meta.url).href)

const tools = new Map()
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect: (fn) => { const d = fn(); return d },
  get: () => undefined,
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}

await mkdir(path.join(dataDir, 'library'), { recursive: true })
await plugin.apply(ctx, { headless: true, dataDir, paceMs: 1200 })
const run = async (label, name, args) => {
  const t0 = Date.now()
  const res = await tools.get(name).execute(args, {})
  const ms = Date.now() - t0
  const bytes = Buffer.byteLength(JSON.stringify(res), 'utf8')
  console.log(`${label.padEnd(34)} ${String(ms).padStart(6)} ms  回传 ${(bytes / 1024).toFixed(1)} KB  ${res.ok === false ? 'FAIL: ' + (res.summary || '').slice(0, 80) : ''}`)
  return res
}

console.log('=== 预设情景：高三·电磁学·困难·12 题 ===')
const s1 = await run('① 检索（选必二 困难 高三 2 页）', 'zujuan_search', {
  chapterId: '150290', difficulty: '困难', grade: '高三', pages: 2, limit: 12,
})
const ids = (s1.questions || []).slice(0, 5).map((q) => q.id)
console.log('   拿到题号：', ids.join(','))

if (ids.length) {
  await run('② 抓题干（首次，走站点）', 'zujuan_question', { ids, withAnswer: false })
  await run('③ 抓题干（二次，应全部命中缓存）', 'zujuan_question', { ids, withAnswer: false })
}

const s2 = await run('④ 检索（必修三 困难 高三 1 页）', 'zujuan_search', {
  chapterId: '149884', difficulty: '困难', grade: '高三', limit: 7,
})
const ids2 = (s2.questions || []).map((q) => q.id)
if (ids2.length) await run('⑤ 抓题干（必修三 7 题）', 'zujuan_question', { ids: ids2, withAnswer: false })

const all = [...new Set([...ids, ...ids2])]
if (all.length >= 4) {
  await run('⑥ 出卷（html+md，无 PDF）', 'zujuan_paper', {
    ids: all, title: 'bench', formats: ['html', 'md'], mode: 'student', groupByType: true,
  })
  await run('⑦ 出卷（含 PDF 打印）', 'zujuan_paper', {
    ids: all, title: 'bench', formats: ['html', 'pdf'], mode: 'student',
  })
}

const status = await tools.get('zujuan_status').execute({}, {})
console.log('\n' + status.summary)
process.exit(0)
