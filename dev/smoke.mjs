// 不依赖 DSH 的插件冒烟测试：用假 ctx 跑 apply()，逐个调用工具。
// 用法：node dev/smoke.mjs [--network]
import path from 'node:path'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dataDir = path.join(root, '.smoke-data')
const withNetwork = process.argv.includes('--network')

const plugin = await import(new URL('../index.js', import.meta.url).href)

// ── 假 ctx ──
const tools = new Map()
const disposers = []
const ctx = {
  tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect: (fn) => {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get: () => undefined,
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
}

// ── 预置题库（用 fixtures 当种子，验证导出链路） ──
const fixtures = JSON.parse(await readFile(path.join(root, 'fixtures', 'sample-questions.json'), 'utf8'))
await mkdir(path.join(dataDir, 'library'), { recursive: true })
const seed = { version: 1, updatedAt: null, questions: {} }
for (const q of fixtures) seed.questions[q.id] = { ...q, tags: ['种子'] }
await writeFile(path.join(dataDir, 'library', 'physics-gz.json'), JSON.stringify(seed, null, 1), 'utf8')

const pass = []
const fail = []
const check = (name, cond, detail = '') => {
  ;(cond ? pass : fail).push(`${name}${detail ? ` :: ${detail}` : ''}`)
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`)
}

await plugin.apply(ctx, { headless: true, dataDir, paceMs: 1200 })

// 1) 工具注册
const expected = ['zujuan_status', 'zujuan_login', 'zujuan_search', 'zujuan_question', 'zujuan_paper', 'zujuan_library', 'zujuan_knowledge', 'zujuan_dom']
check('注册 8 个工具', expected.every((n) => tools.has(n)), [...tools.keys()].join(','))
for (const [n, def] of tools) {
  const properties = def.parameters?.properties
  const shapeOk =
    typeof def.description === 'string' &&
    def.parameters?.type === 'object' &&
    properties &&
    typeof properties === 'object' &&
    def.output?.schema &&
    typeof def.execute === 'function'
  check(`工具结构合法 ${n}`, shapeOk)
  check(
    `参数符合 DeepSeek JSON Schema ${n}`,
    Object.values(properties || {}).every((schema) => schema.required === undefined) &&
      (def.parameters.required === undefined || Array.isArray(def.parameters.required)),
  )
}
check(
  '必填参数提升为 required 数组',
  tools.get('zujuan_library').parameters.required.includes('action') &&
    tools.get('zujuan_question').parameters.required.includes('ids') &&
    tools.get('zujuan_dom').parameters.required.includes('url'),
)

// 2) status（浏览器未启动）
const st = await tools.get('zujuan_status').execute({}, {})
check('status 返回 summary', typeof st.summary === 'string' && st.summary.length > 10)
check('status 提示未登录/未启动', /未启动|未登录/.test(st.summary), st.summary.split('\n')[0])

// 3) library
const stats = await tools.get('zujuan_library').execute({ action: 'stats' }, {})
check('题库统计读到 3 道种子题', /共 3 题/.test(stats.summary), stats.summary.split('\n')[0])
const search = await tools.get('zujuan_library').execute({ action: 'search', text: '动量' }, {})
check('题库全文检索命中', search.questions.length >= 1, `命中 ${search.questions.length}`)
const tagRes = await tools.get('zujuan_library').execute({ action: 'tag', ids: ['36527119'], tags: ['随堂练'] }, {})
check('打标签', /1 道题/.test(tagRes.summary), tagRes.summary)

// 4) 导出（含 PDF，走内置 Chrome）
const ids = fixtures.map((q) => q.id)
const paper = await tools.get('zujuan_paper').execute(
  { ids, title: '动量守恒 随堂练', subtitle: '高二物理·动量守恒（3 题）', formats: ['html', 'doc', 'md', 'pdf'], withAnswer: false },
  {},
)
console.log(paper.summary)
check('导出返回文件列表', Array.isArray(paper.files) && paper.files.length >= 6, `${paper.files?.length} 个文件`)
const sizes = []
for (const f of paper.files || []) {
  try {
    const s = await stat(f)
    sizes.push(`${path.basename(f)}=${s.size}B`)
  } catch {
    sizes.push(`${path.basename(f)}=MISSING`)
  }
}
console.log('文件：' + sizes.join('  '))
check('所有导出文件非空', sizes.every((s) => !/=0B|MISSING/.test(s)), sizes.join(' '))
const pdfOk = (paper.files || []).some((f) => f.endsWith('.pdf'))
check('生成 PDF', pdfOk)
if (pdfOk) {
  const pdfFile = paper.files.find((f) => f.endsWith('.pdf'))
  const buf = await readFile(pdfFile)
  check('PDF 头为 %PDF', buf.subarray(0, 4).toString() === '%PDF', buf.subarray(0, 8).toString())
}

// 5) 可选：真实网络（选择题库检索）
if (withNetwork) {
  const r = await tools.get('zujuan_search').execute({ keyword: '动量守恒', limit: 5, save: false }, {})
  console.log('\n--- zujuan_search ---\n' + (r.summary || '').slice(0, 800))
  check('检索有明确结果或滑块提示', r.ok === true || /滑块/.test(r.summary || ''), r.ok ? 'ok' : 'captcha')
}

// 收尾：触发插件卸载清理
for (const d of disposers.reverse()) {
  try {
    await d()
  } catch {}
}

console.log(`\n通过 ${pass.length} 项，失败 ${fail.length} 项`)
if (fail.length) {
  console.log(fail.map((f) => '  ✗ ' + f).join('\n'))
  process.exit(1)
}
process.exit(0)
