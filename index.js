/**
 * 组卷网（zujuan.xkw.com）组卷插件
 *
 * 能力：登录 / 过滑块 / 净化 profile → 选题（关键词·知识点·章节·多路召回·同方法相似）
 *      → 抓题干与答案解析 → 按蓝图组卷（结构·分值·考点·难度逐项对齐）→ 导出教师版/学生版
 *
 * 站点有三层防护：alicfw JS 挑战、acw_sc__v2、阿里云滑块。实测结论：
 * 有界面（headed）+ 干净 profile 才能拿到正常页面；headless 会被直接判成"阻断页面"。
 */
import os from 'node:os'
import path from 'node:path'
import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises'

import { Browser } from './lib/cdp.mjs'
import { ZujuanSite, SUBJECTS } from './lib/site.mjs'
import { Library } from './lib/store.mjs'
import { buildPaperHtml, buildWordHtml, buildMarkdown, summarize } from './lib/render.mjs'

export const name = 'zujuan-tiku'
export const inject = ['tools']

const DEFAULTS = {
  headless: false, // 实测：headless 会被判"阻断页面"，必须要有界面
  chromePath: '',
  chromeProfile: '',
  dataDir: '',
  paceMs: 2200,
  subject: '高中物理',
  searchViaFetch: true,
  autoCaptcha: true, // 撞滑块时自动拟人拖拽一次（实测可通过）
  captchaAttempts: 3,
  idleCloseMs: 180_000,
  arkApiKey: '',
  arkImageModel: 'doubao-seedream-4-0-250828',
}

/** 工具输出契约：至少带 summary，其余字段自由 */
const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: { summary: { type: 'string', description: '给人/模型读的结果摘要' } },
  required: ['summary'],
}

/** 去掉 undefined 键，保证是可无损 JSON 往返的值 */
const prune = (value) => {
  if (Array.isArray(value)) return value.map(prune)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = prune(v)
    return out
  }
  return value
}

const ok = (extra) => ({ ok: true, ...prune(extra || {}) })
const fail = (summary, extra = {}) => ({ ok: false, summary, ...prune(extra) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 回给模型的精简题目视图：完整 HTML 留在本地题库，避免把会话撑爆 */
const brief = (q, stemChars = 200) => ({
  id: q.id,
  type: q.type,
  difficulty: q.difficulty,
  difficultyScore: q.difficultyScore ?? null,
  knowledge: (q.knowledge || []).slice(0, 6),
  source: q.source || null,
  stem: String(q.stemText || '').replace(/\s+/g, ' ').slice(0, stemChars),
  hasAnswer: Boolean(q.answerImage || q.answerText),
  url: q.url || null,
  tags: q.tags || [],
})

const TYPE_ORDER = ['单选题', '多选题', '填空题', '实验题', '作图题', '判断题', '综合题', '解答题', '计算题']
const rankOfType = (t) => {
  const i = TYPE_ORDER.findIndex((k) => String(t || '').includes(k.replace('题', '')))
  return i < 0 ? 99 : i
}

/** 难度系数 → 档位（与站点的 0.75/0.49 阈值一致） */
const diffBucket = (s) => (s == null ? null : s >= 0.75 ? '容易' : s >= 0.49 ? '适中' : '困难')

/** 能力/素养类标签不是考点，报告实际考点时要跳过 */
const ABILITY_RE = /能力$|素养$|^理解|^推理论证|^模型构建|^直观想象|^数学运算|^数学建模|^数据分析|^数学抽象|^实验探究/
const kpNamesOf = (q) => (q.knowledge || []).map((k) => String(k).replace(/解读$/, '').trim()).filter(Boolean)
const primaryKpOf = (q) => kpNamesOf(q).find((n) => !ABILITY_RE.test(n)) || '（站点未标注考点）'
const knowledgeHit = (q, target) => kpNamesOf(q).some((s) => s.includes(target) || target.includes(s))

/** 参数简写 → 标准 JSON Schema（对象级 required 数组） */
function toStandardParameters(parameters = {}) {
  if (parameters.type === 'object' && parameters.properties) return parameters
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(parameters)) {
    const { required: isRequired, ...propertySchema } = schema
    properties[key] = propertySchema
    if (isRequired === true) required.push(key)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false }
}

/** 中文名 → 题库文件名 */
function toSubjectKey(subject) {
  const map = { 高中物理: 'physics-gz', 初中物理: 'physics-cz' }
  return map[subject] || String(subject).replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'default'
}

export async function apply(ctx, config) {
  const conf = { ...DEFAULTS, ...(config || {}) }
  const dataDir = conf.dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'zujuan')
  const profileDir = conf.chromeProfile ? String(conf.chromeProfile) : path.join(dataDir, 'chrome-profile')
  const loginDir = path.join(dataDir, 'login')
  await mkdir(dataDir, { recursive: true })

  const state = { browser: null, site: null, launching: null }

  const lib = new Library(dataDir, toSubjectKey(conf.subject))
  await lib.load()

  // ── 答案解析的日额度计数（站点：普通账号 30 道/天）──
  const usageFile = path.join(dataDir, 'usage.json')
  const today = () => new Date().toISOString().slice(0, 10)
  async function readUsage() {
    try {
      const u = JSON.parse(await readFile(usageFile, 'utf8'))
      if (u && u.date === today()) return u
    } catch {}
    return { date: today(), answers: 0, questionsFetched: 0 }
  }
  async function bumpUsage({ answers = 0, questions = 0 } = {}) {
    const u = await readUsage()
    u.answers += answers
    u.questionsFetched += questions
    await writeFile(usageFile, JSON.stringify(u, null, 1), 'utf8')
    return u
  }

  const logger = (() => {
    try {
      return ctx.logger ? ctx.logger('zujuan') ?? console : console
    } catch {
      return console
    }
  })()

  async function ensureSite() {
    if (state.site && state.browser?.alive()) return state.site
    if (state.launching) return state.launching
    state.launching = (async () => {
      if (conf.chromePath) process.env.ZUJUAN_CHROME = conf.chromePath
      const browser = new Browser({ userDataDir: profileDir, headless: conf.headless })
      await browser.launch()
      state.browser = browser
      state.site = new ZujuanSite(browser, {
        paceMs: conf.paceMs,
        cacheDir: dataDir,
        useFetch: conf.searchViaFetch !== false,
        autoCaptcha: conf.autoCaptcha !== false,
        log: (...a) => logger.info?.(...a),
      })
      return state.site
    })()
    try {
      return await state.launching
    } finally {
      state.launching = null
    }
  }

  // 空闲自动关浏览器（有工具在跑就不关，否则会把正在导航的浏览器杀掉）
  const IDLE_MS = Math.max(30_000, Number(conf.idleCloseMs) || 180_000)
  let idleTimer = null
  let inflight = 0
  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (inflight > 0) {
        touchIdle()
        return
      }
      if (!state.browser) return
      try {
        state.browser.close()
      } catch {}
      state.browser = null
      state.site = null
      logger.info?.('zujuan: 空闲超时，已关闭 Chrome 释放内存')
    }, IDLE_MS)
    idleTimer.unref?.()
  }
  ctx.effect(() => () => {
    if (idleTimer) clearTimeout(idleTimer)
    try {
      state.browser?.close()
    } catch {}
  })

  const register = (definition) =>
    ctx.effect(() =>
      ctx.tools.register({
        ...definition,
        parameters: toStandardParameters(definition.parameters),
        execute: async (args, exec) => {
          inflight += 1
          touchIdle()
          try {
            return await definition.execute(args, exec)
          } finally {
            inflight -= 1
            touchIdle()
          }
        },
      }),
    )

  /** 撞滑块时把窗口拉到前台并截图 */
  async function captchaHint(site) {
    try {
      await site.browser.bringToFront()
      const shot = path.join(dataDir, 'logs', `captcha-${Date.now()}.png`)
      await site.browser.screenshot(shot)
      return shot
    } catch {
      return null
    }
  }

  const CAPTCHA_ADVICE =
    '插件会先自动拟人拖拽一次（zujuan_captcha 也是默认自动）；仍被拦再按这个顺序：' +
    '① zujuan_profile({action:"clean"}) 洗掉风控 Cookie；② 用 zujuan_captcha({human:true}) 手动拖一次；③ 重跑本工具。'

  // ═════════════════════════════ 蓝图选题引擎 ═════════════════════════════
  /**
   * 按蓝图自动选题。
   * 原则：题型结构是硬约束（先满足结构），考点允许近似但必须如实标注；
   *      先翻本地题库（kp:<考点> 标签）再上站点，站点请求按 blueprintSiteBudget 限额。
   */
  async function selectByBlueprint(args) {
    const site = await ensureSite()
    const subject = args.subject || conf.subject
    const want = Math.max(1, Math.min(40, Number(args.blueprintCount) || 0))
    const kpIds = [...new Set(args.blueprintKnowledgeIds || [])].map(String).filter(Boolean).slice(0, 6)
    const pages = Math.max(1, Math.min(3, Number(args.pages) || (want >= 12 ? 3 : 2)))
    const channelNotes = []

    /** @type {Map<string, any>} */
    const pool = new Map()

    // 1) 知识点池 / 章节池
    for (const kid of kpIds) {
      const res = await site
        .search({ subject, knowledgeId: kid, pages, grade: args.blueprintGrade })
        .catch((e) => ({ ok: false, error: String(e) }))
      if (!res.ok) {
        channelNotes.push(`知识点 ${kid} 抓取失败：${res.warning || res.error || '未知'}`)
        continue
      }
      let added = 0
      for (const q of res.questions || []) {
        if (pool.has(q.id)) continue
        pool.set(q.id, { ...q, __kp: kid })
        added += 1
      }
      channelNotes.push(`知识点 ${kid} 抓 ${res.questions?.length || 0}／新增 ${added}`)
    }
    if (args.blueprintChapterId) {
      const res = await site
        .search({ subject, chapterId: args.blueprintChapterId, pages, grade: args.blueprintGrade })
        .catch((e) => ({ ok: false, error: String(e) }))
      if (res.ok) {
        let added = 0
        for (const q of res.questions || []) {
          if (pool.has(q.id)) continue
          pool.set(q.id, q)
          added += 1
        }
        channelNotes.push(`章节 ${args.blueprintChapterId} 抓 ${res.questions?.length || 0}／新增 ${added}`)
      }
    }

    // 2) 排除近期用过的原题
    const days = Number(args.excludeUsedDays) || 0
    const cutoff = days > 0 ? new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10) : null
    const excluded = []
    const rebuildCandidates = () => {
      let list = [...pool.values()]
      if (cutoff) {
        list = list.filter((q) => {
          const used = (lib.get(q.id)?.usedAt || []).some((d) => d >= cutoff)
          if (used && !excluded.includes(q.id)) excluded.push(q.id)
          return !used
        })
      }
      return list
    }
    let candidates = rebuildCandidates()

    // 3) 题型配额
    const mix = []
    for (const pair of String(args.blueprintTypeMix || '').split(/[,，;]/)) {
      const m = pair.match(/^\s*([^=：:]+)[=：:]\s*(\d+)\s*$/)
      if (m) mix.push({ type: m[1].trim(), n: Number(m[2]) })
    }
    const matchType = (q, t) => String(q.type || '').includes(String(t).replace(/题$/, ''))

    // 4) 单一池子里某题型往往偏少（比如"中位数"几乎没有单选）：按题型各补一路，并往后翻页
    if (mix.length && kpIds.length) {
      for (const { type, n } of mix) {
        const have = () => [...pool.values()].filter((q) => matchType(q, type)).length
        for (let p = 1; p <= 3 && have() < n * 2; p++) {
          const res = await site
            .search({ subject, knowledgeId: kpIds[0], type, page: p, pages: 1, grade: args.blueprintGrade })
            .catch((e) => ({ ok: false, error: String(e) }))
          if (!res.ok) {
            channelNotes.push(`题型 ${type} 第 ${p} 页失败：${res.warning || res.error || '未知'}`)
            break
          }
          let added = 0
          for (const q of res.questions || []) {
            if (pool.has(q.id)) continue
            pool.set(q.id, { ...q, __kp: kpIds[0] })
            added += 1
          }
          channelNotes.push(`题型 ${type} p${p} 抓 ${res.questions?.length || 0}／新增 ${added}`)
          if (!res.questions?.length) break
        }
      }
      candidates = rebuildCandidates()
    }

    // 5) 年级过滤（有逐题考点序列时由每个通道自己带 grade，不在这里做）
    const gradeWant = String(args.blueprintGrade || '').trim()
    const seqProvided = String(args.blueprintKpSequence || '').trim().length > 0
    if (gradeWant && !seqProvided) {
      const others = ['高一', '高二', '高三', '七年级', '八年级', '九年级'].filter((g) => g !== gradeWant)
      const strict = candidates.filter((q) => {
        const src = String(q.source || '')
        if (src.includes(gradeWant)) return true
        return !others.some((g) => src.includes(g))
      })
      if (strict.length >= Math.max(6, Math.min(want, 19))) {
        channelNotes.push(`年级过滤：按「${gradeWant}」保留 ${strict.length} 道（原 ${candidates.length}）`)
        candidates = strict
      } else {
        channelNotes.push(`年级过滤：符合「${gradeWant}」的候选只有 ${strict.length} 道，未启用`)
      }
    }

    const diffRank = (q) => {
      const s = Number(q.difficultyScore)
      if (!Number.isFinite(s)) return 0.5
      const prefer = String(args.blueprintDifficulty || '').trim()
      if (prefer) return diffBucket(s) === prefer ? 0 : 1 + Math.abs(s - 0.65)
      return Math.abs(s - 0.7)
    }

    const picked = []
    const used = new Set()
    const positionNotes = []
    const positionMap = []
    let captchaHit = null
    const siteBudget = Math.max(0, Math.min(30, Number(args.blueprintSiteBudget ?? 8)))
    let siteUsed = 0

    // 6) 逐题考点序列：第 i 题锁定第 i 个考点
    //    每个题位可给多个候选考点（用 / 或 | 分隔：真卷 outline 的"每题备选考点"就是这种形状），
    //    按顺序试到能出题为止。
    const kpSeq = String(args.blueprintKpSequence || '')
      .split(/[,，;]/)
      .map((s) => s.trim())
      .filter(Boolean)
    const kpCandidates = kpSeq.map((s) =>
      String(s)
        // 候选分隔：| 或 ｜ 随便用；"/" 必须带空格才算分隔（考点名里本身有"绳/单层轨道模型"这种斜杠）
        .split(/\s*[|｜]\s*|\s+\/\s+/)
        .map((x) => x.trim())
        .filter(Boolean),
    )
    // 站点的关键词检索是按题干文字匹配的，**不认考点名**（实测：考点名当 keyword 一律 0 题）。
    // 所以名字类考点查空一次就记下来，后面不再重复烧站点配额；zsd 编号才走 knowledgeId。
    const zeroKp = new Set()

    // 6a) 仿卷模式：给一串"真卷题号"，逐题找平行题
    //     做法 = 读源题最具体知识点（knowledgeIds 最后一个）→ 同知识点池 → 同题型 + 邻近难度
    const seedIds = [...new Set((args.blueprintSeedIds || []).map(String))]
      .filter((s) => /^\d+$/.test(s))
      .slice(0, 40)

    if (seedIds.length) {
      for (let i = 0; i < seedIds.length && picked.length < want; i++) {
        if (captchaHit) break
        const seedId = seedIds[i]
        let seed = lib.get(seedId)
        if (!seed?.knowledgeIds?.length || !seed?.stemHtml) {
          if (siteUsed >= siteBudget) {
            positionNotes.push(`第 ${i + 1} 题：站点配额已用完，源题 ${seedId} 的详情没抓，跳过`)
            continue
          }
          siteUsed += 1
          await sleep(1600 + Math.random() * 1400)
          const fetched = await site.question({ id: seedId, bankId: seed?.bankId || '', withAnswer: false }).catch((e) => ({ ok: false, warning: String(e) }))
          if (!fetched.ok) {
            positionNotes.push(`第 ${i + 1} 题：源题 ${seedId} 抓取失败（${fetched.warning || '未知'}）`)
            continue
          }
          seed = { ...(seed || {}), ...fetched }
          lib.upsert({ ...fetched, detailFetchedAt: new Date().toISOString() }, ['详情'])
          await lib.save()
        }

        const kps = seed.knowledgeIds || []
        const anchor = kps[kps.length - 1] || kps[0]
        const kpNames = (seed.knowledge || []).filter(Boolean)
        const anchorName = anchor?.name || kpNames[0] || ''
        const wantType = seed.type || ''
        let cands = []
        if (siteUsed < siteBudget && (anchor?.id || anchorName)) {
          siteUsed += 1
          await sleep(1600 + Math.random() * 1400)
          const res = await site
            .search(
              anchor?.id
                ? { subject, knowledgeId: String(anchor.id), pages: 1, grade: args.blueprintGrade }
                : { subject, keyword: anchorName, pages: 1, grade: args.blueprintGrade },
            )
            .catch((e) => ({ ok: false, error: String(e) }))
          if (res.captcha) captchaHit = anchorName || seedId
          cands = res.ok ? res.questions || [] : []
        }
        // 本地同知识点也捞一遍（第二轮起多数命中本地）
        const localLike = anchorName
          ? lib.list({ knowledge: anchorName, limit: 60 }).filter((q) => q.stemHtml)
          : kpNames.flatMap((n) => lib.list({ knowledge: n, limit: 20 })).filter((q) => q.stemHtml)
        const poolLike = [...cands, ...localLike]

        const seedKpIds = new Set(kps.map((k) => String(k.id)))
        // 对齐判定按"考点名"来：列表卡片基本不带 zsd id，只按 id 判会一律判成未对齐（假阴性）
        const seedKpNames = new Set(
          [...kps.map((k) => String(k.name || '').trim()), ...kpNames].filter(Boolean),
        )
        const nameAligned = (q) => {
          const names = (q.knowledge || []).map((n) => String(n).trim()).filter(Boolean)
          for (const n of names) {
            if (seedKpNames.has(n)) return true
            for (const s of seedKpNames) if (s && (s.includes(n) || n.includes(s)) && Math.min(s.length, n.length) >= 4) return true
          }
          return false
        }
        const sharedCount = (q) => (q.knowledgeIds || []).filter((k) => seedKpIds.has(String(k.id))).length
        const seedDiff = Number.isFinite(seed.difficultyScore) ? seed.difficultyScore : 0.7
        const gradeWant = String(args.blueprintGrade || '').trim()
        const otherGrades = ['高一', '高二', '高三', '七年级', '八年级', '九年级'].filter((g) => g !== gradeWant)
        const gradePenalty = (q) => {
          if (!gradeWant) return 0
          const src = String(q.source || '')
          if (src.includes(gradeWant)) return 0
          return otherGrades.some((g) => src.includes(g)) ? 0.18 : 0.06
        }
        const rankOf = (q) => {
          const typeMiss = wantType && !matchType(q, wantType) ? 1 : 0
          const d = Number.isFinite(q.difficultyScore) ? q.difficultyScore : 0.7
          return typeMiss * 10 + Math.abs(d - seedDiff) + gradePenalty(q)
        }
        let pick = poolLike
          .filter((q) => !used.has(q.id) && q.id !== seedId && (!wantType || matchType(q, wantType)))
          .sort((a, b) => Number(nameAligned(b)) - Number(nameAligned(a)) || sharedCount(b) - sharedCount(a) || rankOf(a) - rankOf(b))[0]
        if (!pick && wantType) {
          // 题型是硬约束：该考点池子里没有这个题型时，宁可牺牲考点也要同题型
          // （先试"考点名当关键词 + 同题型"，再从本地全库按同题型补）
          if (siteUsed < siteBudget && anchorName) {
            siteUsed += 1
            await sleep(1200 + Math.random() * 1000)
            const res2 = await site
              .search({ subject, keyword: anchorName, type: wantType, pages: 1, grade: args.blueprintGrade })
              .catch(() => ({ ok: false }))
            if (res2.captcha) captchaHit = anchorName
            for (const q of res2.ok ? res2.questions || [] : []) if (!used.has(q.id) && q.id !== seedId) poolLike.push(q)
          }
          pick = poolLike
            .filter((q) => !used.has(q.id) && q.id !== seedId && matchType(q, wantType))
            .sort((a, b) => sharedCount(b) - sharedCount(a) || rankOf(a) - rankOf(b))[0]
          if (!pick) {
            pick = lib
              .list({ type: wantType, limit: 80 })
              .filter((q) => q.stemHtml && !used.has(q.id) && q.id !== seedId)
              .sort((a, b) => rankOf(a) - rankOf(b))[0]
          }
          if (pick) {
            positionNotes.push(`第 ${i + 1} 题：考点「${anchorName}」池里没有${wantType}，从同题型补（考点不保证对齐）`)
          }
        }
        if (!pick) {
          pick = poolLike.filter((q) => !used.has(q.id) && q.id !== seedId).sort((a, b) => rankOf(a) - rankOf(b))[0]
          if (pick) {
            positionNotes.push(`第 ${i + 1} 题：源题「${wantType || '未标注题型'}」在考点「${anchorName || '未标注'}」池里找不到同题型，题型改为 ${pick.type}`)
          }
        }
        if (!pick) {
          positionNotes.push(`第 ${i + 1} 题：源题 ${seedId}（考点「${anchor?.name || '未标注考点'}」）没有平行题`)
          continue
        }
        used.add(pick.id)
        picked.push(pick)
        positionMap.push({
          position: i + 1,
          seedId,
          targetKp: anchorName || '（源题未标注考点）',
          actualKp: primaryKpOf(pick),
          aligned: nameAligned(pick) || sharedCount(pick) > 0,
          type: pick.type || '',
          id: pick.id,
          difficultyScore: pick.difficultyScore ?? null,
        })
      }
      if (captchaHit) channelNotes.push(`⚠ 在「${captchaHit}」触发滑块验证，已中止（allowPartial 可先出未定稿卷）`)
    } else if (kpSeq.length) {
      const typeAt = []
      for (const { type, n } of mix) for (let i = 0; i < n; i++) typeAt.push(type)
      const diffSeq = String(args.blueprintDiffSequence || '')
        .split(/[,，\s]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n))

      const poolCache = new Map()
      const loadPool = async (entry, wantType = '') => {
        const cacheKey = `${entry}::${wantType}`
        if (poolCache.has(cacheKey)) return poolCache.get(cacheKey)
        const kpTag = `kp:${entry}`
        const seen = new Set()
        const local = []
        for (const q of [...lib.list({ tag: kpTag, limit: 200 }), ...lib.list({ knowledge: entry, limit: 200 })]) {
          if (seen.has(q.id) || !q.stemHtml) continue
          if (wantType && !matchType(q, wantType)) continue
          seen.add(q.id)
          local.push({ ...q, __kp: entry })
        }
        if (local.length) {
          for (const q of local) if (!pool.has(q.id)) pool.set(q.id, q)
          channelNotes.push(`考点「${entry}」${wantType || ''} 本地 ${local.length} 道`)
        }
        if (local.length >= 6) {
          poolCache.set(cacheKey, local)
          return local
        }
        if (siteUsed >= siteBudget) {
          channelNotes.push(`考点「${entry}」${wantType || ''} 站点配额已用完（${siteBudget}），只用本地 ${local.length} 道`)
          poolCache.set(cacheKey, local)
          return local
        }
        const isZsd = /^\d+$/.test(entry)
        if (!isZsd && zeroKp.has(entry)) {
          channelNotes.push(`考点「${entry}」${wantType || ''} 关键词检索已确认 0 命中，跳过（省配额）`)
          poolCache.set(cacheKey, local)
          return local
        }
        siteUsed += 1
        await sleep(1600 + Math.random() * 1400)
        const res = await site
          .search(
            isZsd
              ? { subject, knowledgeId: entry, pages: 2, grade: args.blueprintGrade, type: wantType || undefined }
              : { subject, keyword: entry, pages: 1, grade: args.blueprintGrade, type: wantType || undefined },
          )
          .catch((e) => ({ ok: false, error: String(e) }))
        if (res.captcha) captchaHit = entry
        const list = res.ok ? (res.questions || []).map((q) => ({ ...q, __kp: entry })) : []
        if (!isZsd && res.ok && !list.length) {
          zeroKp.add(entry)
          channelNotes.push(`考点「${entry}」关键词检索 0 命中 → 站点不认考点名（下次同轮直接跳过）`)
        }
        for (const q of list) {
          if (!pool.has(q.id)) pool.set(q.id, q)
          lib.upsert({ ...q, subject }, [kpTag])
        }
        if (list.length) await lib.save()
        channelNotes.push(`考点「${entry}」${wantType || ''} 站点抓 ${list.length}${res.ok ? '' : `（失败：${res.warning || res.error}）`}`)
        const merged = [...local, ...list]
        poolCache.set(cacheKey, merged)
        return merged
      }

      const total = Math.min(kpSeq.length, want)
      for (let i = 0; i < total; i++) {
        const entryList = kpCandidates[i]?.length ? kpCandidates[i] : [kpSeq[i]]
        const wantType = typeAt[i] || ''
        const target = diffSeq[i]
        const byRank = (a, b) => {
          const sa = Number(a.difficultyScore)
          const sb = Number(b.difficultyScore)
          if (Number.isFinite(target) && Number.isFinite(sa) && Number.isFinite(sb)) {
            return Math.abs(sa - target) - Math.abs(sb - target)
          }
          return diffRank(a) - diffRank(b)
        }

        // 候选链：第一个能出"该题型 + 该考点"的就用；都不行再看谁至少能出该考点
        let pick = null
        let pickedEntry = entryList[0]
        let fallbackKpOnly = null
        for (const entry of entryList) {
          const list = await loadPool(entry, wantType)
          if (captchaHit) break
          const hit = list
            .filter((q) => !used.has(q.id) && knowledgeHit(q, entry) && (!wantType || matchType(q, wantType)))
            .sort(byRank)[0]
          if (hit) {
            pick = hit
            pickedEntry = entry
            break
          }
          if (!fallbackKpOnly) {
            const kpOnly = list.filter((q) => !used.has(q.id) && knowledgeHit(q, entry)).sort(byRank)[0]
            if (kpOnly) {
              fallbackKpOnly = { q: kpOnly, entry }
            }
          }
        }
        if (captchaHit) break

        if (!pick && fallbackKpOnly) {
          pick = fallbackKpOnly.q
          pickedEntry = fallbackKpOnly.entry
          positionNotes.push(`第 ${i + 1} 题：考点「${pickedEntry}」保留，题型由${wantType}改为${pick.type}`)
        }
        if (!pick && wantType) {
          // 同题型补位：优先"考点沾边"的，其次任意同题型
          const related = [...pool.values()]
            .filter((q) => !used.has(q.id) && matchType(q, wantType) && entryList.some((e) => knowledgeHit(q, e)))
            .sort(byRank)[0]
          pick = related || [...pool.values()].filter((q) => !used.has(q.id) && matchType(q, wantType)).sort(byRank)[0]
          if (pick) {
            pickedEntry = `≈${primaryKpOf(pick)}`
            positionNotes.push(
              `第 ${i + 1} 题：考点「${entryList.join(' / ')}」都没有${wantType}，用同题型近似「${primaryKpOf(pick)}」`,
            )
          }
        }
        if (!pick) positionNotes.push(`第 ${i + 1} 题：考点「${entryList.join(' / ')}」缺口，未选到题`)
        if (pick) {
          used.add(pick.id)
          picked.push(pick)
          positionMap.push({
            position: i + 1,
            targetKp: entryList.join(' / '),
            actualKp: primaryKpOf(pick),
            aligned: entryList.some((e) => knowledgeHit(pick, e)),
            type: pick.type || '',
            id: pick.id,
            difficultyScore: pick.difficultyScore ?? null,
          })
        }
      }
      // 题数补位：考点/题型都对不上的缺口，最后按"该题型的配额"补齐，别让卷子少题
      if (!captchaHit && picked.length < want) {
        const deficit = want - picked.length
        const fill = [...pool.values()]
          .filter((q) => !used.has(q.id))
          .sort((a, b) => diffRank(a) - diffRank(b))
          .slice(0, deficit * 3)
        const added = []
        for (const q of fill) {
          if (added.length >= deficit) break
          used.add(q.id)
          picked.push(q)
          added.push(q)
          positionMap.push({
            position: picked.length,
            targetKp: '（补位）',
            actualKp: primaryKpOf(q),
            aligned: false,
            type: q.type || '',
            id: q.id,
            difficultyScore: q.difficultyScore ?? null,
          })
        }
        if (added.length) positionNotes.push(`补位：从候选池按难度补了 ${added.length} 道（考点不保证对齐，已标注）`)
      }
      if (captchaHit) channelNotes.push(`⚠ 在「${captchaHit}」触发滑块验证，已中止，避免产出考点错位的假平行卷`)
    } else if (mix.length) {
      // 没有逐题考点序列：按题型配额走知识点轮转
      for (const { type, n } of mix) {
        const byKp = new Map()
        for (const q of candidates.filter((x) => matchType(x, type) && !used.has(x.id)).sort((a, b) => diffRank(a) - diffRank(b))) {
          const k = q.__kp || '其它'
          if (!byKp.has(k)) byKp.set(k, [])
          byKp.get(k).push(q)
        }
        let guard = 0
        while (picked.filter((q) => matchType(q, type)).length < n && guard < 200) {
          guard += 1
          let progressed = false
          for (const group of byKp.values()) {
            if (picked.filter((q) => matchType(q, type)).length >= n) break
            const next = group.find((q) => !used.has(q.id))
            if (next && !used.has(next.id)) {
              used.add(next.id)
              picked.push(next)
              progressed = true
            }
          }
          if (!progressed) break
        }
      }
    } else {
      const byKp = new Map()
      for (const q of candidates) {
        const k = q.__kp || '其它'
        if (!byKp.has(k)) byKp.set(k, [])
        byKp.get(k).push(q)
      }
      for (const group of byKp.values()) group.sort((a, b) => diffRank(a) - diffRank(b))
      let guard = 0
      while (picked.length < want && guard < 400) {
        guard += 1
        let progressed = false
        for (const group of byKp.values()) {
          if (picked.length >= want) break
          const next = group.find((q) => !used.has(q.id))
          if (next && !used.has(next.id)) {
            used.add(next.id)
            picked.push(next)
            progressed = true
          }
        }
        if (!progressed) break
      }
    }

    // 7) 分值：给了总分就按题型权重分配并抹平误差
    const WEIGHT = { 单选: 4, 多选: 6, 填空: 4, 实验: 8, 综合: 14, 解答: 12, 其他: 5 }
    const weightOf = (q) => {
      const s = String(q.type || '')
      for (const k of Object.keys(WEIGHT)) if (s.includes(k)) return WEIGHT[k]
      return WEIGHT.其他
    }
    const totalWant = Number(args.blueprintTotalScore) || 0
    const scores = {}
    if (totalWant > 0 && picked.length && !String(args.blueprintScoreSequence || '').trim()) {
      const sumW = picked.reduce((s, q) => s + weightOf(q), 0)
      const unit = totalWant / sumW
      for (const q of picked) q.score = Math.max(2, Math.round(unit * weightOf(q)))
      let total = picked.reduce((s, q) => s + q.score, 0)
      let i = 0
      while (total !== totalWant && i < 400) {
        const q = picked[i % picked.length]
        if (total < totalWant) {
          q.score += 1
          total += 1
        } else if (q.score > 1) {
          q.score -= 1
          total -= 1
        }
        i += 1
      }
      for (const q of picked) {
        const key = TYPE_ORDER.find((k) => String(q.type || '').includes(k.replace('题', ''))) || '解答题'
        scores[key] = q.score
      }
    }

    // 8) 缺口校验
    const minutesOfQ = (q) => {
      const s = String(q.type || '')
      const base = /单选/.test(s)
        ? 2
        : /多选/.test(s)
          ? 3
          : /填空/.test(s)
            ? 2.5
            : /实验/.test(s)
              ? 6
              : /综合/.test(s)
                ? 10
                : /解答|计算/.test(s)
                  ? 12
                  : 3
      const d = Number(q.difficultyScore)
      const factor = Number.isFinite(d) ? (d < 0.5 ? 1.25 : d > 0.75 ? 0.85 : 1) : 1
      return base * factor
    }
    const estimatedMinutes = Math.round(picked.reduce((s, q) => s + minutesOfQ(q), 0))
    const coveredKp = new Set(picked.map((q) => q.__kp).filter(Boolean))
    const gaps = []
    if (picked.length < want) gaps.push(`题数差 ${want - picked.length} 道`)
    if (kpIds.length) {
      const missing = kpIds.filter((k) => !coveredKp.has(k))
      if (missing.length) gaps.push(`这些知识点没凑到题：${missing.join('、')}`)
    }
    if (positionNotes.length) gaps.push(...positionNotes)
    if (Number(args.blueprintMinutes)) {
      const t = Number(args.blueprintMinutes)
      if (estimatedMinutes > t) gaps.push(`预计 ${estimatedMinutes} 分钟，超过目标 ${t} 分钟（可减题或降低难度）`)
      else if (estimatedMinutes < t * 0.8) gaps.push(`预计 ${estimatedMinutes} 分钟，明显少于目标 ${t} 分钟（可加题或提高难度）`)
    }

    if (args.save !== false) {
      for (const q of picked) lib.upsert({ ...q, subject }, ['蓝图'])
      await lib.save()
    }

    return { picked, scores, gaps, channelNotes, excluded, estimatedMinutes, coveredKp: [...coveredKp], want, totalWant, captchaHit, positionMap, siteUsed, siteBudget }
  }

  // ═════════════════════════════════ 工具 ═════════════════════════════════

  // ── 状态 ──
  register({
    name: 'zujuan_status',
    description:
      '检查组卷网插件的状态：Chrome 是否已启动、是否已登录、账号权限、本地题库题量、今日额度、数据目录与浏览器模式。做任何选题前先调用一次。',
    parameters: {},
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute() {
      const stats = lib.stats()
      const usage = await readUsage()
      let login = { loggedIn: false, unknown: true }
      const alive = !!state.browser?.alive()
      const warnings = []
      if (alive) {
        try {
          login = await (await ensureSite()).loginState()
        } catch (err) {
          warnings.push(`登录态探测失败：${err.message}`)
        }
      } else {
        warnings.push('Chrome 尚未启动（首次调用任一工具时会自动拉起）')
      }
      const lines = [
        `Chrome：${alive ? '已启动' : '未启动'}`,
        `登录：${login.unknown ? '未知' : login.loggedIn ? `已登录${login.userName ? `（${login.userName}）` : ''}` : '未登录'}`,
        login.group?.name ? `账号：${login.group.name}（可看答案 ${login.group.canViewAnswer}／可看解析 ${login.group.canViewAnalysis}）` : '',
        `本地题库：${stats.total} 题（含答案 ${stats.withAnswer}）`,
        `今日：题干 ${usage.questionsFetched} 道，答案解析 ${usage.answers}/30 道`,
        `浏览器模式：${conf.headless ? '无窗口（易被拦）' : '有界面'}`,
        `滑块：${conf.autoCaptcha === false ? '自动通过已关闭' : `自动通过已开（最多 ${conf.captchaAttempts || 3} 次）`}`,
        `数据目录：${dataDir}`,
        ...warnings.map((w) => `提示：${w}`),
      ].filter(Boolean)
      return ok({ summary: lines.join('\n'), login, library: stats, usage, dataDir, headless: conf.headless })
    },
  })

  // ── 登录 ──
  register({
    name: 'zujuan_login',
    description:
      '打开学科网统一登录页（sso.zxxk.com）并等待登录完成。默认二维码模式：二维码截图存到数据目录，用微信/学科网APP扫一下即可；工具会轮询到登录成功或超时。也支持账号密码模式。',
    parameters: {
      mode: { type: 'string', enum: ['qr', 'password'], required: false, description: 'qr=扫码（推荐），password=账号密码' },
      username: { type: 'string', required: false, description: '账号密码模式的账号' },
      password: { type: 'string', required: false, description: '账号密码模式的密码' },
      waitSeconds: { type: 'integer', required: false, description: '最长等待秒数，默认 150' },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      await mkdir(loginDir, { recursive: true })
      const qrFile = path.join(loginDir, 'login-qr.png')
      const before = await site.loginState().catch(() => null)
      if (before?.loggedIn) return ok({ summary: `已经登录（${before.userName || ''}），无需重复登录。`, loggedIn: true })
      const opened = await site.openLogin({
        shotPath: qrFile,
        password: args.mode === 'password' && args.username ? { username: args.username, password: args.password || '' } : null,
      })
      const waitMs = Math.max(10, Math.min(600, Number(args.waitSeconds) || 150)) * 1000
      const done = await site.waitLogin({ timeoutMs: waitMs })
      const summary = done.loggedIn
        ? '登录成功，可以开始选题了。'
        : [
            `尚未登录成功（当前页面：${opened.title}）。`,
            args.mode === 'password'
              ? '已提交账号密码；若窗口里出现验证码请手动完成，然后再次调用本工具。'
              : '请在已打开的窗口里扫码；扫完再次调用本工具确认。',
            opened.qrImage ? `二维码截图：${opened.qrImage}` : '',
          ]
            .filter(Boolean)
            .join('\n')
      return ok({ summary, loggedIn: done.loggedIn, login: done.state, qrImage: opened.qrImage })
    },
  })

  // ── 滑块 ──
  register({
    name: 'zujuan_captcha',
    description:
      '撞到阿里云滑块验证时用。默认先自动通过（拟人轨迹 + CDP 可信鼠标事件，实测能拿到「验证通过」）；自动没过才退回人工：丢掉作废的挑战、开一个"没有调试器连接"的普通 Chrome 窗口让你拖，拖完接管。auto:false 可直接走人工。',
    parameters: {
      auto: { type: 'boolean', required: false, description: '默认 true：先自动拖一次（最多 attempts 次）' },
      attempts: { type: 'integer', required: false, description: '自动拖拽最多试几次，默认 3' },
      human: { type: 'boolean', required: false, description: '默认 true：自动失败后换成普通窗口让你手动拖' },
      waitSeconds: { type: 'integer', required: false, description: '人工模式每轮等多少秒，默认 90' },
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const waitMs = Math.max(15, Math.min(300, Number(args.waitSeconds) || 90)) * 1000
      const attempts = Math.max(1, Math.min(5, Number(args.attempts) || 3))
      let autoNote = ''

      // ① 自动：拟人拖拽（不需要人）
      if (args.auto !== false) {
        const site = await ensureSite()
        const res = await site.passCaptcha({ attempts }).catch((e) => ({ ok: false, reason: String(e) }))
        if (res.ok) {
          return ok({
            summary: `已自动通过滑块（第 ${res.attempts} 次尝试：${res.reason}）。\n可以继续选题了。`,
            passed: true,
            auto: true,
            attempts: res.attempts,
            url: await site.browser.url().catch(() => ''),
          })
        }
        autoNote = `自动拖拽未通过：${res.reason}`
        logger.info?.(`zujuan: ${autoNote}`)
      }

      // ② 人工：换一个完全不接调试器的窗口
      if (args.human !== false) {
        const existing = state.browser && !state.browser.ws ? state.browser : null
        if (!existing) {
          try {
            state.browser?.close()
          } catch {}
          state.browser = null
          state.site = null
          if (conf.chromePath) process.env.ZUJUAN_CHROME = conf.chromePath
          const fresh = new Browser({ userDataDir: profileDir, headless: false })
          await fresh.launch({ url: 'https://zujuan.xkw.com/gzwl/', attach: false })
          state.browser = fresh
        }
        const b = state.browser
        let info = await b.pageInfo()
        const deadline = Date.now() + waitMs
        while (Date.now() < deadline) {
          await sleep(2000)
          const now = await b.pageInfo()
          if (now) info = now
          if (info && !/滑动验证|访问验证/.test(info.title)) break
        }
        const passed = !!info && !/滑动验证|访问验证/.test(info.title)
        if (!passed) {
          return fail(
            [
              autoNote || '（自动模式已关闭）',
              '窗口已开在最前面，且**没有接任何调试器**（就是普通 Chrome）。请把橙色滑块按住一路拖到最右端；拖完再调用一次本工具。',
              `当前页面：${info?.title || '未知'}`,
            ].join('\n'),
            { captcha: true, human: true, url: info?.url, autoReason: autoNote || null },
          )
        }
        await b.attach()
        state.site = new ZujuanSite(b, { paceMs: conf.paceMs, cacheDir: dataDir, useFetch: conf.searchViaFetch !== false, log: (...a) => logger.info?.(...a) })
        const after = await b.pageInfo()
        return ok({ summary: `验证通过。当前页面：${after?.title || '（未知）'}\n可以继续选题了。`, passed: true, url: after?.url })
      }

      return fail(autoNote || '没有可用的通过方式（auto 与 human 都被关掉了）', { captcha: true, autoReason: autoNote || null })
    },
  })

  // ── profile 体检/净化 ──
  register({
    name: 'zujuan_profile',
    description:
      '浏览器 profile 体检与净化。实测：被滑块拦过的 profile 会积攒阿里云风控 Cookie（alicfw / acw_* / aliyungf_tc …），带着它们即便有界面也会一直被打标。clean 会在浏览器里删掉这些风控 Cookie、保留登录态，下一次请求重新走干净的 JS 挑战。',
    parameters: {
      action: { type: 'string', enum: ['status', 'clean'], required: true, description: 'status=体检；clean=删风控 Cookie（保留登录）' },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const SITE_URLS = ['https://zujuan.xkw.com/', 'https://sso.zxxk.com/', 'https://staticzujuan.xkw.com/', 'https://imzujuan.xkw.com/']
      const cookies = await site.browser.cookies(SITE_URLS).catch(() => [])
      const RISK = /^(alicfw|acw_|aliyungf|_c_WBKFRo|__jsl|Hm_|HMACCOUNT|_nb_)/i
      const KEEP = /^(user_token|xkw-device-id|xkw-fs-id|bankId|bankname|zj-device-id|ip2ProvinceId|__RequestVerificationToken)/i
      const risk = cookies.filter((c) => RISK.test(c.name))
      const keep = cookies.filter((c) => KEEP.test(c.name))
      if (args.action !== 'clean') {
        return ok({
          summary: [
            `Cookie ${cookies.length} 个；风控类 ${risk.length}，登录/身份类 ${keep.length}。`,
            risk.length ? `风控类：${risk.map((c) => c.name).join(', ')}` : '没有风控类 Cookie（profile 干净）',
            keep.length ? `保留：${keep.map((c) => c.name).join(', ')}` : '',
            risk.length ? '建议 zujuan_profile({action:"clean"}) 洗一次再检索。' : '',
          ]
            .filter(Boolean)
            .join('\n'),
          risk: risk.map((c) => c.name),
        })
      }
      let removed = 0
      for (const c of risk) {
        try {
          await site.browser.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path || '/' })
          removed += 1
        } catch {}
      }
      await site.browser.goto('https://zujuan.xkw.com/', { waitMs: 1500 }).catch(() => {})
      const state2 = await site.loginState().catch(() => null)
      return ok({
        summary: [
          `已删除 ${removed} 个风控 Cookie${removed ? `（${risk.map((c) => c.name).join(', ')}）` : ''}，登录态保留。`,
          `登录：${state2?.loggedIn ? '已登录' : '未登录（可能需要重新扫码）'}`,
          removed ? '下一步：直接跑 zujuan_search 或 zujuan_paper_outline。' : '本来就不脏。',
        ].join('\n'),
        removed,
        loggedIn: !!state2?.loggedIn,
      })
    },
  })

  // ── 教材册次 ──
  register({
    name: 'zujuan_chapters',
    description: '列出学科的教材册次（zj 编号），指定册次时再往下列出章/节。组卷时最稳的范围入口，拿到 zj 号直接喂 zujuan_search({chapterId})。',
    parameters: {
      subject: { type: 'string', required: false, description: '学科，默认高中物理' },
      book: { type: 'string', required: false, description: '册次名称或 zj 编号' },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const res = await site.chapters(args.subject || conf.subject, args.book)
      if (!res.ok) {
        const shot = await captchaHint(site)
        return fail(`教材目录抓取被拦截。${CAPTCHA_ADVICE}` + (shot ? `\n截图：${shot}` : ''), { captcha: true, screenshot: shot })
      }
      const lines = [`${res.subject} 教材册次（${res.books.length}）：`, ...res.books.map((b) => `- ${b.name} → zj${b.id}`)]
      if (res.book) lines.push('', `${res.book.name} 的章/节（${res.chapters.length}）：`, ...res.chapters.slice(0, 40).map((c) => `- ${c.name} → zj${c.id}`))
      if (res.warning) lines.push(`提示：${res.warning}`)
      return ok({ summary: lines.join('\n'), books: res.books, book: res.book, chapters: res.chapters })
    },
  })

  // ── 知识点树 ──
  register({
    name: 'zujuan_knowledge',
    description: '抓某学科的知识点树并缓存，返回 知识点名称 → zsd 编号。传 name 可模糊查。注意：站点按"当前学科"给树，跨学科时结果可能串，看到不对就用 zujuan_chapters 定位。',
    parameters: {
      subject: { type: 'string', required: false, description: '学科，默认高中物理' },
      name: { type: 'string', required: false, description: '按名称模糊查' },
      refresh: { type: 'boolean', required: false, description: '强制重新抓取' },
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const subject = args.subject || conf.subject
      const cacheDir = path.join(dataDir, 'knowledge')
      const cacheFile = path.join(cacheDir, `${toSubjectKey(subject)}.json`)
      let nodes = []
      let fromCache = false
      if (!args.refresh) {
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
          if (Array.isArray(cached.nodes) && cached.nodes.length) {
            nodes = cached.nodes
            fromCache = true
          }
        } catch {}
      }
      if (!nodes.length) {
        const site = await ensureSite()
        const tree = await site.knowledgeTree(subject)
        if (!tree.ok) {
          const shot = await captchaHint(site)
          return fail(`知识点树抓取被拦截。${CAPTCHA_ADVICE}` + (shot ? `\n截图：${shot}` : ''), { captcha: true, screenshot: shot })
        }
        nodes = tree.nodes
        await mkdir(cacheDir, { recursive: true })
        await writeFile(cacheFile, JSON.stringify({ subject, nodes, at: new Date().toISOString() }, null, 1), 'utf8')
      }
      const hit = args.name ? nodes.filter((n) => n.name.includes(args.name)) : nodes
      const list = hit.slice(0, 80)
      const summary = [
        `${subject} 知识点 ${nodes.length} 个${fromCache ? '（缓存）' : '（已抓取）'}${args.name ? `，匹配「${args.name}」${hit.length} 个` : ''}：`,
        ...list.map((n) => `- ${n.name} → zsd${n.id}`),
        hit.length > list.length ? `…… 其余 ${hit.length - list.length} 个未显示` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return ok({ summary, subject, total: nodes.length, matches: hit.length, nodes: list })
    },
  })

  // ── 检索 ──
  register({
    name: 'zujuan_search',
    description:
      '在组卷网按知识点 / 关键词 / 章节检索试题，返回题号、题型、难度、知识点与题干。关键词走站内 quessearch（按 b=题库ID 定学科），支持连续抓多页。结果自动写入本地题库。',
    parameters: {
      keyword: { type: 'string', required: false, description: '关键词' },
      knowledgeId: { type: 'string', required: false, description: '知识点 ID（zsd）' },
      chapterId: { type: 'string', required: false, description: '章节/册次 ID（zj）' },
      subject: { type: 'string', required: false, description: '学科，默认高中物理' },
      type: { type: 'string', required: false, description: '题型：单选题/多选题/填空题/解答题/实验题' },
      difficulty: { type: 'string', required: false, description: '难度：容易/适中/困难' },
      grade: { type: 'string', required: false, description: '年级：高一/高二/高三' },
      page: { type: 'integer', required: false, description: '起始页码' },
      pages: { type: 'integer', required: false, description: '连续抓几页（默认 1）' },
      limit: { type: 'integer', required: false, description: '最多返回多少题，默认 15' },
      stemChars: { type: 'integer', required: false, description: '每题回传多少字题干，默认 150；方法层面二次确认时给 400~800' },
      save: { type: 'boolean', required: false, description: '是否写入本地题库，默认 true' },
    },
    timeoutMs: 240_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    presentCall: (args) => ({ card: 'generic', title: '组卷网选题', kind: 'search', rawInput: args }),
    async execute(args) {
      const site = await ensureSite()
      const subject = args.subject || conf.subject
      const res = await site.search({
        subject,
        keyword: args.keyword,
        knowledgeId: args.knowledgeId,
        chapterId: args.chapterId,
        type: args.type,
        difficulty: args.difficulty,
        grade: args.grade,
        page: args.page,
        pages: args.pages,
      })
      if (!res.ok) {
        const shot = await captchaHint(site)
        return fail(`检索被拦截：${res.warning || '滑块验证'}。\n${CAPTCHA_ADVICE}` + (shot ? `\n截图：${shot}` : ''), {
          captcha: true,
          url: res.url,
          screenshot: shot,
        })
      }
      const limit = Math.max(1, Math.min(60, Number(args.limit) || 15))
      const picked = res.questions.slice(0, limit)
      if (args.save !== false) {
        for (const q of picked) lib.upsert({ ...q, subject }, ['搜索'])
        await lib.save()
      }
      const lines = picked.map(
        (q, i) =>
          `${i + 1}. [${q.id}] ${q.type || ''}｜${q.difficulty || ''}${q.difficultyScore ? `(${q.difficultyScore})` : ''}｜${(q.knowledge || []).slice(0, 3).join('、')}\n   ${String(q.stemText || '').replace(/\s+/g, ' ').slice(0, 150)}`,
      )
      const summary = [
        `检索到 ${res.total} 题，取前 ${picked.length} 题${args.save === false ? '' : '（已入库）'}。`,
        res.appliedFilters?.length ? `已应用筛选：${res.appliedFilters.join('、')}` : '',
        res.unappliedFilters?.length ? `⚠ 未生效筛选：${res.unappliedFilters.join('、')}` : '',
        res.pages?.length > 1 ? `抓取页：${res.pages.map((p) => `p${p.page}(${p.count})`).join(' ')}` : '',
        res.viaFetch ? '（页面内 fetch 检索，未整页导航）' : '',
        res.scoped ? '' : '⚠ 没指定知识点/章节/关键词，抓的是全科题库',
        `页面：${res.url}`,
        '',
        ...lines,
      ]
        .filter(Boolean)
        .join('\n')
      return ok({
        summary,
        total: res.total,
        url: res.url,
        questions: picked.map((q) => brief(q, Math.max(80, Math.min(800, Number(args.stemChars) || 150)))),
      })
    },
  })

  // ── 多路召回 ──
  register({
    name: 'zujuan_recall',
    description:
      '多路召回：branches 分「方法名 / 题面特征 / 目标」多组关键词，同时并上知识点池、章节池，合并去重后带"命中来源"。召回阶段刻意不加题型/难度筛选，筛选在合并后做，并报告筛掉多少——避免单路关键词漏题。',
    parameters: {
      keywords: { type: 'array', required: false, items: { type: 'string' }, description: '一组同义/异构关键词' },
      branches: {
        type: 'array',
        required: false,
        items: { type: 'string' },
        description: '检索分支，写法 "分支名:关键词1|关键词2"，每条分支独立记账',
      },
      budget: { type: 'integer', required: false, description: '本轮最多发几次检索，默认 12' },
      knowledgeId: { type: 'string', required: false, description: '知识点 ID（一路）' },
      knowledgeIds: { type: 'array', required: false, items: { type: 'string' }, description: '多个知识点：每个各占一路' },
      chapterId: { type: 'string', required: false, description: '章节 ID（一路）' },
      subject: { type: 'string', required: false, description: '学科' },
      type: { type: 'string', required: false, description: '题型过滤（合并后执行）' },
      difficulty: { type: 'string', required: false, description: '难度过滤（合并后执行）' },
      pages: { type: 'integer', required: false, description: '每路抓几页，默认 1' },
      limit: { type: 'integer', required: false, description: '返回多少条，默认 20' },
      stemChars: { type: 'integer', required: false, description: '每题回传多少字题干，默认 300' },
      save: { type: 'boolean', required: false, description: '是否入库，默认 true' },
    },
    timeoutMs: 420_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const subject = args.subject || conf.subject
      const pages = Math.max(1, Math.min(5, Number(args.pages) || 1))
      const budget = Math.max(1, Math.min(40, Number(args.budget) || 12))

      const branches = []
      for (const raw of args.branches || []) {
        const text = String(raw || '').trim()
        if (!text) continue
        const idx = text.search(/[:：]/)
        const name = idx > 0 ? text.slice(0, idx).trim() : '分支'
        const kws = (idx > 0 ? text.slice(idx + 1) : text)
          .split('|')
          .map((k) => k.trim())
          .filter(Boolean)
        if (kws.length) branches.push({ name, keywords: kws.slice(0, 4) })
      }
      const flat = (args.keywords || []).map((k) => String(k).trim()).filter(Boolean).slice(0, 6)
      if (!branches.length && flat.length) branches.push({ name: '关键词', keywords: flat })
      if (!branches.length && !args.knowledgeId && !args.knowledgeIds?.length && !args.chapterId) {
        return fail('至少要给 branches / keywords / knowledgeId / chapterId 之一')
      }

      const pool = new Map()
      const channels = []
      let used = 0
      const merge = (label, list) => {
        let added = 0
        for (const q of list) {
          const cur = pool.get(q.id)
          if (cur) {
            if (!cur.channels.includes(label)) cur.channels.push(label)
            continue
          }
          pool.set(q.id, { ...q, channels: [label] })
          added += 1
        }
        channels.push({ channel: label, fetched: list.length, added })
      }
      const runChannel = async (label, params) => {
        if (used >= budget) {
          channels.push({ channel: label, fetched: 0, added: 0, skipped: '预算用完' })
          return
        }
        used += 1
        const res = await site.search({ ...params, pages }).catch((e) => ({ ok: false, error: String(e) }))
        if (!res.ok) {
          channels.push({ channel: label, fetched: 0, added: 0, error: res.warning || res.error || '失败' })
          return
        }
        merge(label, res.questions || [])
      }

      for (const b of branches) for (const kw of b.keywords) await runChannel(`${b.name}/${kw}`, { subject, keyword: kw, pages })
      const kpIds = [...new Set([...(args.knowledgeIds || []), ...(args.knowledgeId ? [args.knowledgeId] : [])])].map(String).filter(Boolean).slice(0, 6)
      for (const kid of kpIds) await runChannel(`知识点 ${kid}`, { subject, knowledgeId: kid, pages })
      if (args.chapterId) await runChannel(`章节 ${args.chapterId}`, { subject, chapterId: args.chapterId, pages })

      const all = [...pool.values()]
      const kept = all.filter((q) => {
        if (args.type && !String(q.type || '').includes(String(args.type).replace(/题$/, ''))) return false
        if (args.difficulty) {
          const want = String(args.difficulty).replace(/题$/, '')
          if (!(String(q.difficulty || '').includes(want) || diffBucket(q.difficultyScore) === want)) return false
        }
        return true
      })
      kept.sort((a, b) => b.channels.length - a.channels.length || (b.knowledge || []).length - (a.knowledge || []).length)
      const limit = Math.max(1, Math.min(60, Number(args.limit) || 20))
      const picked = kept.slice(0, limit)
      if (args.save !== false) {
        for (const q of picked) lib.upsert({ ...q, subject }, [`召回:${q.channels.join('+')}`])
        await lib.save()
      }
      const stemChars = Math.max(80, Math.min(800, Number(args.stemChars) || 300))
      const lines = picked.map(
        (q, i) =>
          `${i + 1}. [${q.id}] ${q.channels.join(' + ')}｜${q.type || ''}｜${q.difficulty || ''}\n   ${String(q.stemText || '').replace(/\s+/g, ' ').slice(0, stemChars)}`,
      )
      const summary = [
        `多路召回（预算 ${budget}，用了 ${used}）`,
        ...channels.map((c) => {
          const note = c.skipped ? `　跳过（${c.skipped}）` : c.error ? `　失败（${c.error}）` : c.added === 0 ? '　⚠ 零新增，建议停掉这条路' : ''
          return `- ${c.channel}：抓 ${c.fetched}／新增 ${c.added}${note}`
        }),
        `并集 ${all.length} 道，筛选后 ${kept.length} 道（筛掉 ${all.length - kept.length}），返回前 ${picked.length} 道。`,
        '',
        ...lines,
      ].join('\n')
      return ok({ summary, channels, unionSize: all.length, keptSize: kept.length, questions: picked.map((q) => ({ ...brief(q, stemChars), channels: q.channels })) })
    },
  })

  // ── 同方法相似题 ──
  register({
    name: 'zujuan_similar',
    description:
      '给一道题找「同方法/同模型」的相似题：以它最具体的知识点为池子（可限同难度），按共享知识点数排序，返回候选题干供二次判定。站点自带的相似题按钮是纯 JS、抓不到，这里用可控路径。',
    parameters: {
      id: { type: 'string', required: true, description: '源题题号' },
      limit: { type: 'integer', required: false, description: '返回多少候选，默认 12' },
      sameDifficulty: { type: 'boolean', required: false, description: '只找同难度，默认 true；候选太少会自动放宽' },
      stemChars: { type: 'integer', required: false, description: '每题回传多少字题干，默认 260' },
      pages: { type: 'integer', required: false, description: '知识点池抓几页，默认 1' },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const id = String(args.id || '').trim()
      if (!id) return fail('缺少 id')
      let src = lib.get(id)
      if (!src || !src.knowledgeIds?.length) {
        const fetched = await site.question({ id, bankId: src?.bankId || '11', withAnswer: false })
        if (!fetched.ok) return fail(`源题抓取失败：${fetched.warning || '未知原因'}`)
        src = { ...(src || {}), ...fetched }
        if (args.save !== false) {
          lib.upsert({ ...fetched, detailFetchedAt: new Date().toISOString() }, ['详情'])
          await lib.save()
        }
      }
      const anchor = (src.knowledgeIds || [])[src.knowledgeIds.length - 1] || src.knowledgeIds?.[0]
      if (!anchor) return fail('这道题没有知识点标签，改用 zujuan_search({keyword}) 吧')
      const subject = src.subject || conf.subject
      const runSearch = (difficulty) => site.search({ subject, knowledgeId: anchor.id, difficulty, pages: Math.max(1, Math.min(3, Number(args.pages) || 1)) })
      let res = await runSearch(args.sameDifficulty === false ? undefined : src.difficulty)
      if (!res.ok) {
        const shot = await captchaHint(site)
        return fail(`检索被拦截。${CAPTCHA_ADVICE}` + (shot ? `\n截图：${shot}` : ''), { captcha: true, screenshot: shot })
      }
      let pool = res.questions.filter((q) => q.id !== id)
      let relaxed = false
      if (pool.length < 3 && args.sameDifficulty !== false) {
        const wider = await runSearch(undefined)
        if (wider.ok) {
          pool = [...pool, ...wider.questions.filter((q) => q.id !== id)]
          relaxed = true
        }
      }
      const srcKp = new Set(kpNamesOf(src))
      const scored = []
      const seen = new Set()
      for (const q of pool) {
        if (seen.has(q.id)) continue
        seen.add(q.id)
        const overlap = kpNamesOf(q).filter((k) => srcKp.has(k)).length
        scored.push({ q, overlap })
      }
      scored.sort((a, b) => b.overlap - a.overlap || (b.q.difficultyScore || 0) - (a.q.difficultyScore || 0))
      const picked = scored.slice(0, Math.max(1, Math.min(30, Number(args.limit) || 12)))
      if (args.save !== false) {
        for (const { q } of picked) lib.upsert({ ...q, subject }, ['相似候选'])
        await lib.save()
      }
      const stemChars = Math.max(80, Math.min(800, Number(args.stemChars) || 260))
      const lines = picked.map(
        (x, i) => `${i + 1}. [${x.q.id}] 共享知识点 ${x.overlap}｜${x.q.type || ''}｜${x.q.difficulty || ''}\n   ${String(x.q.stemText || '').replace(/\s+/g, ' ').slice(0, stemChars)}`,
      )
      return ok({
        summary: [
          `源题 ${id}：${src.type || ''}｜${src.difficulty || ''}｜${(src.knowledge || []).slice(0, 3).join('、')}`,
          `锚点知识点：${anchor.name}（zsd${anchor.id}）${relaxed ? '｜候选太少，已放宽难度' : ''}`,
          `候选 ${picked.length} 道（仍需按"同方法"人工确认）：`,
          ...lines,
        ].join('\n'),
        anchor,
        relaxed,
        candidates: picked.map((x) => ({ ...brief(x.q, stemChars), sharedKnowledge: x.overlap })),
      })
    },
  })

  // ── 单题详情 ──
  register({
    name: 'zujuan_question',
    description:
      '抓一道或多道题的完整内容：题干、选项、知识点（含 zsd 编号）、来源、答案与解析。withAnswer=true 会展开答案解析并下载答案图（需登录，普通账号每天约 30 道）。题库里已抓过详情的题默认走缓存，refresh:true 强制重取。',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'string' }, description: '题号数组' },
      withAnswer: { type: 'boolean', required: false, description: '是否抓答案与解析，默认 true' },
      bankId: { type: 'string', required: false, description: '题库 ID，默认按记录' },
      save: { type: 'boolean', required: false, description: '是否入库，默认 true' },
      refresh: { type: 'boolean', required: false, description: '强制重抓（忽略缓存）' },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const ids = (args.ids || []).map(String).filter(Boolean).slice(0, 20)
      if (!ids.length) return fail('ids 为空')
      const assetDir = path.join(dataDir, 'assets')
      const wantsAnswer = args.withAnswer !== false
      const got = []
      const failures = []
      const cached = []
      for (const id of ids) {
        try {
          const stored = lib.get(id)
          const answerKnown = Boolean(stored?.answerImage || stored?.answerText || stored?.answerAvailable === false)
          // 缓存必须"有内容"才算数：试卷页批量入库时可能只写了空壳记录（题干/知识点都空），
          // 以前会因为 detailFetchedAt 存在就命中缓存，结果拿到一串空题。
          const cacheUsable = Boolean(stored?.detailFetchedAt && String(stored?.stemHtml || '').trim())
          if (args.refresh !== true && cacheUsable && (!wantsAnswer || answerKnown)) {
            cached.push(id)
            got.push(stored)
            continue
          }
          const q = await site.question({ id, bankId: args.bankId || stored?.bankId || '13', withAnswer: wantsAnswer, assetDir })
          if (!q.ok) {
            failures.push(`${id}: ${q.warning || '抓取失败'}`)
            continue
          }
          const prev = lib.get(q.id)
          const record = {
            id: q.id,
            bankId: q.bankId,
            type: q.type,
            difficulty: q.difficulty,
            difficultyScore: q.difficultyScore,
            knowledge: q.knowledge,
            knowledgeIds: q.knowledgeIds || prev?.knowledgeIds || [],
            source: q.source,
            stemHtml: q.stemHtml,
            stemText: q.stemText,
            options: q.options,
            images: q.images,
            url: q.url,
            answerText: q.answerText || prev?.answerText || null,
            answerImage: q.answerImageFiles?.[0]?.file || prev?.answerImage || null,
            answerImages: q.answerImageFiles?.length ? q.answerImageFiles.map((f) => f.file) : prev?.answerImages || [],
            answerAvailable: q.answerAvailable ?? (q.answerImageFiles?.length ? true : prev?.answerAvailable),
            warnings: q.warnings || [],
            detailFetchedAt: new Date().toISOString(),
          }
          if (args.save !== false) lib.upsert(record, ['详情'])
          got.push(record)
        } catch (err) {
          failures.push(`${id}: ${err.message}`)
        }
      }
      if (args.save !== false) await lib.save()
      const answersGot = got.filter((q) => q.answerImage || q.answerText).length
      const usage = await bumpUsage({ answers: wantsAnswer ? answersGot : 0, questions: got.length })
      const lines = got.map(
        (q) =>
          `[${q.id}] ${q.type || ''}｜${q.difficulty || ''}｜${(q.knowledge || []).slice(0, 3).join('、')}\n` +
          `  题干：${String(q.stemText || '').replace(/\s+/g, ' ').slice(0, 220)}\n` +
          `  答案：${q.answerImage ? `图片 ${q.answerImage}` : (q.answerText || '无').slice(0, 160)}` +
          (q.warnings?.length ? `\n  提示：${q.warnings.join('；')}` : ''),
      )
      return ok({
        summary: [
          `抓取完成：成功 ${got.length} 道（其中 ${cached.length} 道命中缓存），失败 ${failures.length} 道。`,
          `今日额度：答案解析 ${usage.answers}/30。`,
          ...lines,
          ...failures.map((f) => `失败 ${f}`),
        ].join('\n'),
        questions: got.map((q) => brief(q, 240)),
        failures,
        usage,
      })
    },
  })

  // ── 试卷结构 ──
  register({
    name: 'zujuan_paper_outline',
    description:
      '读一张已有试卷的结构蓝图：试卷页把整卷信息挂在 window.paperJson 上（标题、总分、题型分区、每区题数、每题 ID 与考点）。输出可直接喂给 zujuan_paper 的 blueprintTypeMix / blueprintKpSequence。',
    parameters: {
      url: { type: 'string', required: true, description: '试卷页 URL 或站内路径，如 /13p2438857.html' },
      includeIds: { type: 'boolean', required: false, description: '是否返回题目 ID，默认 true' },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const res = await site.paperOutline(String(args.url || ''))
      if (!res.ok) {
        if (res.captcha) {
          const shot = await captchaHint(site)
          return fail(`试卷页被拦截。${CAPTCHA_ADVICE}` + (shot ? `\n截图：${shot}` : ''), { captcha: true, screenshot: shot })
        }
        return fail(res.warning || '读取失败', { url: res.url })
      }
      const typeMix = res.sections.map((s) => `${s.name}=${s.ids.length}`).join(',')
      const flatCats = res.sections.flatMap((s) => (s.categories || []).map((c) => (c || [])[0] || ''))
      const kpSequence = flatCats.filter(Boolean).join(',')
      const kpAlternatives = res.sections
        .flatMap((s) => s.categories || [])
        .map((c) => (c || []).slice(0, 3).join(' / '))
        .filter(Boolean)
        .join(' , ')
      return ok({
        summary: [
          `试卷：${res.title}`,
          `结构：${res.sections.map((s) => `${s.name} ${s.ids.length} 题`).join('｜')}　共 ${res.total} 题` + (res.paperDiff ? `｜整卷难度 ${res.paperDiff}` : ''),
          `蓝图参数：blueprintTypeMix="${typeMix}"`,
          kpSequence ? `逐题考点序列（${flatCats.filter(Boolean).length}/${res.total} 有标注）：\n${kpSequence}` : '',
          kpAlternatives ? `每题备选考点：\n${kpAlternatives}` : '',
          args.includeIds === false ? '' : `题目 ID：${res.sections.flatMap((s) => s.ids).join(',')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        title: res.title,
        total: res.total,
        typeMix,
        kpSequence,
        sections: res.sections.map((s) => ({
          name: s.name,
          count: s.ids.length,
          ids: args.includeIds === false ? undefined : s.ids,
          categories: s.categories,
        })),
        url: res.url,
      })
    },
  })

  // ── 组卷导出 ──
  register({
    name: 'zujuan_paper',
    description:
      '组卷并导出：可给 ids 直接组，也可给 blueprint* 参数自动选题（题数/题型配比/总分/时长/逐题分值/逐题考点/逐题难度/年级）。默认输出 HTML + PDF + Word + Markdown，并按题型分节；卷面只印「分值 · 难度系数 · 来源」。',
    parameters: {
      ids: { type: 'array', required: false, items: { type: 'string' }, description: '题目 ID 列表；给了就不走蓝图' },
      title: { type: 'string', required: false, description: '标题' },
      subtitle: { type: 'string', required: false, description: '副标题' },
      mode: { type: 'string', enum: ['both', 'teacher', 'student'], required: false, description: '默认 both' },
      formats: { type: 'array', required: false, items: { type: 'string', enum: ['html', 'pdf', 'doc', 'md'] }, description: '默认全部' },
      answersAtEnd: { type: 'boolean', required: false, description: '答案统一放文末' },
      groupByType: { type: 'boolean', required: false, description: '按题型分节，默认 true' },
      showKnowledge: { type: 'boolean', required: false, description: '是否打印知识点，默认 false' },
      scorePlan: { type: 'string', required: false, description: '分值方案，如 "单选题=4,解答题=14"' },
      withAnswer: { type: 'boolean', required: false, description: '是否补抓缺失答案解析（消耗站点额度），默认 false' },
      outDir: { type: 'string', required: false, description: '输出目录' },
      excludeUsedDays: { type: 'integer', required: false, description: '排除最近 N 天内标记过"已用"的原题' },
      blueprintCount: { type: 'integer', required: false, description: '蓝图模式：要多少题' },
      blueprintKnowledgeIds: { type: 'array', required: false, items: { type: 'string' }, description: '蓝图要覆盖的知识点 zsd 编号' },
      blueprintChapterId: { type: 'string', required: false, description: '蓝图的章节 zj 编号（可选一路）' },
      blueprintTypeMix: { type: 'string', required: false, description: '题型配额，如 "单选题=8,多选题=3,填空题=3,解答题=5"' },
      blueprintDifficulty: { type: 'string', required: false, description: '难度倾向：容易/适中/困难' },
      blueprintGrade: { type: 'string', required: false, description: '年级倾向：高三/高二/高一（交给站点筛）' },
      blueprintTotalScore: { type: 'integer', required: false, description: '蓝图总分（按题型权重分配每题分值）' },
      blueprintScoreSequence: { type: 'string', required: false, description: '逐题分值序列，如 "5,5,5,5,6,6,6,13,15"' },
      blueprintKpSequence: { type: 'string', required: false, description: '逐题考点序列（逗号分隔），第 i 题锁定第 i 个考点；每个题位可用 | 或 " / " 给多个候选考点，按顺序试' },
      blueprintSeedIds: { type: 'array', required: false, items: { type: 'string' }, description: '真卷题号列表：逐题按"该题最具体知识点 + 同题型 + 邻近难度"找平行题，用于仿卷（配 blueprintScoreSequence 可直接复刻分值结构）' },
      blueprintDiffSequence: { type: 'string', required: false, description: '逐题难度系数序列，第 i 题优先取最接近的' },
      blueprintMinutes: { type: 'integer', required: false, description: '计划用时，用于估时校验' },
      blueprintSiteBudget: { type: 'integer', required: false, description: '本轮最多几个考点上站点（默认 8），其余走本地' },
      allowPartial: { type: 'boolean', required: false, description: '撞滑块时是否先用已选到的题出"未定稿"部分卷，默认 false' },
    },
    timeoutMs: 900_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    presentCall: (args) => ({ card: 'generic', title: '组卷导出', kind: 'edit', rawInput: args }),
    async execute(args) {
      const formats = new Set(args.formats && args.formats.length ? args.formats : ['html', 'pdf', 'doc', 'md'])
      let blueprint = null
      let partialInfo = null
      let ids

      if (Number(args.blueprintCount) > 0) {
        blueprint = await selectByBlueprint(args)
        if (blueprint.captchaHit) {
          const site = await ensureSite()
          const shot = await captchaHint(site)
          const progressFile = path.join(dataDir, 'papers', `progress-${Date.now()}.json`)
          try {
            await mkdir(path.dirname(progressFile), { recursive: true })
            await writeFile(
              progressFile,
              JSON.stringify(
                {
                  stoppedAt: blueprint.captchaHit,
                  pickedIds: blueprint.picked.map((q) => q.id),
                  positionMap: blueprint.positionMap,
                  channels: blueprint.channelNotes,
                  at: new Date().toISOString(),
                },
                null,
                1,
              ),
              'utf8',
            )
          } catch {}
          if (args.allowPartial !== true) {
            return fail(
              `检索途中触发滑块（停在「${blueprint.captchaHit}」），已中止，避免出一份考点错位的假平行卷。\n` +
                `已抓到的题都进了题库并打了考点标签，重跑会直接命中本地。\n进度文件：${progressFile}\n${CAPTCHA_ADVICE}` +
                (shot ? `\n截图：${shot}` : ''),
              { captcha: true, screenshot: shot, progressFile, channelNotes: blueprint.channelNotes },
            )
          }
          partialInfo = { stoppedAt: blueprint.captchaHit, progressFile }
        }
        ids = blueprint.picked.map((q) => q.id)
        if (!ids.length) {
          return fail(`蓝图没凑到题。${blueprint.channelNotes.join('；')}`, { blueprint: { gaps: blueprint.gaps } })
        }
      } else {
        ids = (args.ids && args.ids.length ? args.ids.map(String) : lib.ids().slice(-20)).slice(0, 60)
      }
      if (!ids.length) return fail('没有可用题目：先 zujuan_search 或 zujuan_question 选题')

      // 排除近期用过的原题
      const excluded = []
      const days = Number(args.excludeUsedDays) || 0
      if (days > 0) {
        const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
        ids = ids.filter((id) => {
          const hit = (lib.get(id)?.usedAt || []).some((d) => d >= cutoff)
          if (hit) excluded.push(id)
          return !hit
        })
        if (!ids.length) return fail(`${excluded.length} 道题最近 ${days} 天内都用过，换一批再组（${excluded.join(',')}）`)
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const outDir = args.outDir || path.join(dataDir, 'papers', `paper-${stamp}`)
      const assetDir = path.join(outDir, 'assets')
      await mkdir(outDir, { recursive: true })
      await mkdir(assetDir, { recursive: true })

      // 补抓缺失答案（默认不做，避免烧额度）
      const refetched = []
      if (args.withAnswer === true) {
        const site = await ensureSite()
        const missing = ids.filter((id) => {
          const q = lib.get(id)
          return q && !q.answerImage && !q.answerText
        })
        for (const id of missing.slice(0, 12)) {
          try {
            const q = await site.question({ id, bankId: lib.get(id)?.bankId || '13', withAnswer: true, assetDir })
            if (q.ok) {
              lib.upsert({ id: q.id, answerText: q.answerText || null, answerImage: q.answerImageFiles?.[0]?.file || null }, ['详情'])
              refetched.push(id)
            }
          } catch {}
        }
        await lib.save()
        if (refetched.length) await bumpUsage({ answers: refetched.length })
      }

      const questions = []
      for (const id of ids) {
        const q = lib.get(id)
        if (!q) continue
        let answerHtml = null
        if (q.answerImage) {
          const abs = String(q.answerImage)
          const fileName = path.basename(abs)
          try {
            await copyFile(abs, path.join(assetDir, fileName))
            answerHtml = `<p><img src="assets/${fileName}" alt="答案与解析"></p>`
          } catch {}
        }
        questions.push({
          id: q.id,
          bankId: q.bankId,
          type: q.type,
          difficulty: q.difficulty,
          difficultyScore: q.difficultyScore,
          score: q.score,
          knowledge: q.knowledge,
          source: q.source,
          stemHtml: q.stemHtml,
          stemText: q.stemText,
          options: q.options,
          answerHtml,
          answerText: q.answerText || null,
          analysisHtml: q.analysisHtml || null,
          analysisText: q.analysisText || null,
          url: q.url ? (q.url.startsWith('http') ? q.url : 'https://zujuan.xkw.com' + q.url) : null,
        })
      }
      if (!questions.length) return fail('这些题号在本地题库里都不存在')

      questions.sort((a, b) => rankOfType(a.type) - rankOfType(b.type) || (b.difficultyScore || 0) - (a.difficultyScore || 0))

      // 逐题分值序列（按最终题序）
      const seqNums = String(args.blueprintScoreSequence || '')
        .split(/[,，\s]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
      if (seqNums.length) questions.forEach((q, i) => { if (seqNums[i]) q.score = seqNums[i] })

      const scores = { ...(blueprint?.scores || {}) }
      for (const pair of String(args.scorePlan || '').split(/[,，;]/)) {
        const m = pair.match(/^\s*([^=：:]+)[=：:]\s*(\d+(?:\.\d+)?)\s*$/)
        if (m) scores[m[1].trim()] = Number(m[2])
      }
      for (const q of questions) {
        if (q.score) continue
        const key = Object.keys(scores).find((k) => String(q.type || '').includes(k.replace(/题$/, '')))
        if (key) q.score = scores[key]
      }
      const totalScore = blueprint || seqNums.length ? questions.reduce((s, q) => s + (q.score || 0), 0) : 0

      const minutesOf = (t, ds) => {
        const s = String(t || '')
        const base = /单选/.test(s) ? 2 : /多选/.test(s) ? 3 : /填空/.test(s) ? 2.5 : /实验/.test(s) ? 6 : /综合/.test(s) ? 10 : /解答|计算/.test(s) ? 12 : 3
        const d = Number(ds)
        return base * (Number.isFinite(d) ? (d < 0.5 ? 1.25 : d > 0.75 ? 0.85 : 1) : 1)
      }
      const estimatedMinutes = Math.round(questions.reduce((s, q) => s + minutesOf(q.type, q.difficultyScore), 0))

      const kpSet = new Set()
      for (const q of questions) for (const k of kpNamesOf(q)) kpSet.add(k)
      const sig = (q) => String(q.stemText || '').replace(/\s+/g, '').slice(0, 80)
      const seenSig = new Map()
      const dupes = []
      for (const q of questions) {
        const s = sig(q)
        if (!s) continue
        if (seenSig.has(s)) dupes.push([seenSig.get(s), q.id])
        else seenSig.set(s, q.id)
      }

      const subtitleBase = args.subtitle
        ? `${args.subtitle}${totalScore && !/满分/.test(args.subtitle) ? `｜满分 ${totalScore} 分` : ''}`
        : `共 ${questions.length} 题${totalScore ? `｜满分 ${totalScore} 分` : ''}｜${conf.subject}`
      const subtitle = partialInfo ? `${subtitleBase}｜⚠ 未定稿` : subtitleBase

      const base = {
        title: args.title || '组卷网选题练习',
        subtitle,
        questions,
        showKnowledge: args.showKnowledge === true,
        showSource: true,
        showDifficulty: true,
        showType: false,
        answersAtEnd: !!args.answersAtEnd,
        groupByType: args.groupByType !== false,
        scores: blueprint ? {} : scores,
      }

      const manifest = {
        title: base.title,
        subject: args.subject || conf.subject,
        ids: questions.map((q) => q.id),
        counts: Object.fromEntries(
          [...new Set(questions.map((q) => q.type || '未知'))].map((t) => [t, questions.filter((q) => (q.type || '未知') === t).length]),
        ),
        totalScore,
        estimatedMinutes,
        knowledgeCoverage: [...kpSet],
        duplicates: dupes,
        positionMap: blueprint?.positionMap || [],
        partial: partialInfo ? { stoppedAt: partialInfo.stoppedAt, gaps: blueprint?.gaps || [] } : false,
        scorePlan: scores,
        excludedUsed: excluded,
        exportedAt: new Date().toISOString(),
      }

      const modes = args.mode === 'teacher' ? ['teacher'] : args.mode === 'student' ? ['student'] : ['teacher', 'student']
      const files = []
      for (const mode of modes) {
        const input = { ...base, mode }
        const htmlFile = path.join(outDir, `${mode}.html`)
        if (formats.has('html')) {
          await writeFile(htmlFile, buildPaperHtml(input), 'utf8')
          files.push(htmlFile)
        }
        if (formats.has('doc')) {
          const f = path.join(outDir, `${mode}.doc`)
          await writeFile(f, buildWordHtml(input), 'utf8')
          files.push(f)
        }
        if (formats.has('md')) {
          const f = path.join(outDir, `${mode}.md`)
          await writeFile(f, buildMarkdown(input), 'utf8')
          files.push(f)
        }
        if (formats.has('pdf')) {
          if (!formats.has('html')) await writeFile(htmlFile, buildPaperHtml(input), 'utf8')
          try {
            const site = await ensureSite()
            const pdf = path.join(outDir, `${mode}.pdf`)
            await site.browser.printPdf(htmlFile, pdf)
            files.push(pdf)
          } catch (err) {
            logger.warn?.(`PDF 生成失败：${err.message}`)
          }
        }
      }

      const manifestFile = path.join(outDir, 'manifest.json')
      await writeFile(manifestFile, JSON.stringify(manifest, null, 1), 'utf8')
      files.push(manifestFile)

      const stat = summarize({ ...base, mode: 'teacher' })
      const answerCount = questions.filter((q) => q.answerHtml || q.answerText).length
      return ok({
        summary: [
          `已生成 ${files.length} 个文件：${outDir}`,
          blueprint
            ? `蓝图选题：目标 ${blueprint.want} 题${blueprint.totalWant ? `／${blueprint.totalWant} 分` : ''}，实得 ${questions.length} 题` +
              `（站点 ${blueprint.siteUsed}/${blueprint.siteBudget} 次，其余命中本地）`
            : '',
          blueprint?.gaps?.length ? `⚠ 缺口：${blueprint.gaps.join('；')}` : blueprint ? '✓ 蓝图约束全部满足' : '',
          ...files.map((f) => `- ${f}`),
          `题目 ${stat.total} 道，${answerCount} 道带答案解析`,
          `体检：知识点标签 ${manifest.knowledgeCoverage.length} 个｜预计 ${estimatedMinutes} 分钟` + (totalScore ? `｜满分 ${totalScore}` : ''),
          dupes.length ? `⚠ ${dupes.length} 处疑似重复：${dupes.map((d) => d.join(' ~ ')).join('、')}` : '',
          excluded.length ? `已排除近期用过的 ${excluded.length} 道` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        outDir,
        files,
        manifest,
        questions: questions.map((q) => q.id),
      })
    },
  })

  // ── 本地题库 ──
  register({
    name: 'zujuan_library',
    description:
      '本地题库：list/search/stats/tag/remove，mark 标记"入选/淘汰"，review 记录方法核验（core/alternative/same-kp + 依据 + 用途 + 解析状态），used 记录"这个班已做过"（配合 excludeUsedDays 排重）。',
    parameters: {
      action: { type: 'string', enum: ['list', 'search', 'stats', 'tag', 'remove', 'mark', 'review', 'used'], required: true, description: '操作' },
      text: { type: 'string', required: false, description: 'search 检索词' },
      type: { type: 'string', required: false, description: '题型过滤' },
      difficulty: { type: 'string', required: false, description: '难度过滤' },
      knowledge: { type: 'string', required: false, description: '知识点过滤' },
      tag: { type: 'string', required: false, description: '标签过滤' },
      ids: { type: 'array', required: false, items: { type: 'string' }, description: '目标题号' },
      tags: { type: 'array', required: false, items: { type: 'string' }, description: '要添加的标签' },
      mark: { type: 'string', enum: ['ok', 'no'], required: false, description: 'mark：ok=入选，no=淘汰' },
      methodMatch: { type: 'string', enum: ['core', 'alternative', 'same-kp', 'unclear'], required: false, description: 'review：方法匹配度' },
      evidence: { type: 'string', required: false, description: 'review：解析里哪一步用了这个方法' },
      use: { type: 'string', required: false, description: 'review：教学用途' },
      analysisStatus: { type: 'string', enum: ['available', 'unavailable', 'partial'], required: false, description: 'review：解析是否读到' },
      limit: { type: 'integer', required: false, description: '返回条数上限，默认 30' },
    },
    isConcurrencySafe: () => true,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const action = args.action
      if (action === 'stats') {
        const s = lib.stats()
        return ok({ summary: `本地题库 共 ${s.total} 题；含答案 ${s.withAnswer}。\n题型：${JSON.stringify(s.byType)}\n难度：${JSON.stringify(s.byDifficulty)}\n更新：${s.updatedAt || '从未'}`, stats: s })
      }
      if (action === 'tag') {
        const ids = (args.ids || []).map(String)
        const tags = (args.tags || []).filter(Boolean)
        if (!ids.length || !tags.length) return fail('tag 需要 ids 和 tags')
        const n = lib.tag(ids, tags)
        await lib.save()
        return ok({ summary: `已给 ${n} 道题加上标签 ${tags.join('、')}`, tagged: n })
      }
      if (action === 'mark') {
        const ids = (args.ids || []).map(String)
        if (!ids.length) return fail('mark 需要 ids')
        const isOk = args.mark !== 'no'
        const n = lib.tag(ids, [isOk ? '入选' : '淘汰'])
        await lib.save()
        return ok({ summary: `已标记 ${n} 道为${isOk ? '入选' : '淘汰'}`, marked: n })
      }
      if (action === 'used') {
        const ids = (args.ids || []).map(String)
        if (!ids.length) return fail('used 需要 ids')
        const day = new Date().toISOString().slice(0, 10)
        const n = lib.tag(ids, [`已用@${day}`])
        for (const id of ids) {
          const q = lib.get(id)
          if (q) {
            q.usedAt = [...new Set([...(q.usedAt || []), day])]
            lib.dirty = true
          }
        }
        await lib.save()
        return ok({ summary: `已记录 ${n} 道为「${day} 已使用」`, used: n, day })
      }
      if (action === 'review') {
        const id = String(args.id || (args.ids || [])[0] || '').trim()
        if (!id) return fail('review 需要 id')
        const q = lib.get(id)
        if (!q) return fail(`题库里没有 ${id}`)
        const review = {
          methodMatch: String(args.methodMatch || 'unclear'),
          evidence: String(args.evidence || '').trim(),
          use: String(args.use || '').trim(),
          analysisStatus: String(args.analysisStatus || (q.answerImage || q.answerText ? 'available' : 'unavailable')),
          at: new Date().toISOString(),
        }
        lib.upsert({ id, review }, [review.methodMatch === 'core' ? '方法核心' : review.methodMatch === 'alternative' ? '方法可选' : '方法存疑'])
        await lib.save()
        return ok({ summary: `已记录 ${id} 的方法核验：${review.methodMatch}（解析：${review.analysisStatus}）`, review })
      }
      if (action === 'remove') {
        const n = lib.remove((args.ids || []).map(String))
        await lib.save()
        return ok({ summary: `已删除 ${n} 道题`, removed: n })
      }
      const rows = lib.list({
        text: action === 'search' ? args.text : undefined,
        type: args.type,
        difficulty: args.difficulty,
        knowledge: args.knowledge,
        tag: args.tag,
        limit: Math.max(1, Math.min(200, Number(args.limit) || 30)),
      })
      const lines = rows.map(
        (q, i) =>
          `${i + 1}. [${q.id}] ${q.type || ''}｜${q.difficulty || ''}｜${(q.tags || []).join(',')}｜${String(q.stemText || '').replace(/\s+/g, ' ').slice(0, 90)}`,
      )
      return ok({ summary: `共 ${rows.length} 条：\n${lines.join('\n')}`, questions: rows.map((q) => brief(q, 120)) })
    },
  })

  // ── AI 拟写解析 ──
  register({
    name: 'zujuan_analysis',
    description:
      '把 AI 拟写的答案/解析写回本地题库（站点 30 道/天额度用完时的兜底）。传 id + answer + analysis，导出教师版时就按【答案】【解析】排版，并标注"AI 拟写，仅供参考"。',
    parameters: {
      id: { type: 'string', required: true, description: '题号' },
      answer: { type: 'string', required: false, description: '答案' },
      analysis: { type: 'string', required: false, description: '解析正文，可多段' },
      note: { type: 'string', required: false, description: '自定义标注' },
    },
    isConcurrencySafe: () => true,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const id = String(args.id || '').trim()
      if (!id) return fail('缺少 id')
      const q = lib.get(id)
      if (!q) return fail(`题库里没有 ${id}，先抓题`)
      const note = (args.note || 'AI 拟写，仅供参考').trim()
      const analysis = String(args.analysis || '').trim()
      const answer = String(args.answer || '').trim()
      if (!analysis && !answer) return fail('answer 和 analysis 至少给一个')
      lib.upsert(
        { id, answerText: answer || q.answerText || null, analysisText: analysis ? `${note}\n${analysis}` : q.analysisText || null, analysisSource: 'ai', analysisAt: new Date().toISOString() },
        ['AI解析'],
      )
      await lib.save()
      return ok({ summary: `已写入 ${id} 的${answer ? '答案' : ''}${answer && analysis ? '与' : ''}${analysis ? '解析' : ''}（标注：${note}）`, id })
    },
  })

  // ── 豆包生图 ──
  register({
    name: 'zujuan_illustrate',
    description:
      '用火山方舟图片生成接口（豆包 Seedream）给某道题生成一张示意图，存到 assets/ 并挂到题库记录。需要 ARK API Key（config.arkApiKey 或环境变量 ARK_API_KEY）；没配就返回配置指引。生成的是示意配图，不是精确受力图。',
    parameters: {
      id: { type: 'string', required: true, description: '题号' },
      prompt: { type: 'string', required: false, description: '画面描述；省略则用题干自动拼' },
      size: { type: 'string', required: false, description: '尺寸，默认 1024x1024' },
    },
    timeoutMs: 300_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const id = String(args.id || '').trim()
      const q = lib.get(id)
      if (!q) return fail(`题库里没有 ${id}`)
      const key = conf.arkApiKey || process.env.ARK_API_KEY || ''
      if (!key) {
        return fail(
          [
            '没有 ARK API Key，生图接口调不动。二选一：',
            '1) 在 profile 的 cordis.patch.yml 里给 zujuan-tiku 加 config: { arkApiKey: "..." }',
            '2) 或设环境变量 ARK_API_KEY 后重启 dsh',
            '本机已装的 dsh-connect-doubao 走豆包客户端 skill，不需要这个 key。',
          ].join('\n'),
          { needsApiKey: true },
        )
      }
      const model = conf.arkImageModel || 'doubao-seedream-4-0-250828'
      const prompt = args.prompt || `为一道高中物理题画一张简洁的物理示意图（白底、黑色线稿、无文字说明）：${String(q.stemText || '').slice(0, 300)}`
      const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, size: args.size || '1024x1024', response_format: 'url', watermark: false }),
      })
      const text = await res.text()
      if (!res.ok) return fail(`生图接口返回 ${res.status}：${text.slice(0, 400)}`)
      let url = null
      try {
        const data = JSON.parse(text)
        url = data?.data?.[0]?.url || data?.data?.[0]?.b64_json || null
      } catch {}
      if (!url) return fail(`生图接口没有返回图片：${text.slice(0, 300)}`)
      const assetDir = path.join(dataDir, 'assets')
      await mkdir(assetDir, { recursive: true })
      const file = path.join(assetDir, `${id}-ai.png`)
      if (String(url).startsWith('http')) {
        const r = await fetch(url)
        if (!r.ok) return fail(`下载生成图失败：HTTP ${r.status}`)
        await writeFile(file, Buffer.from(await r.arrayBuffer()))
      } else {
        await writeFile(file, Buffer.from(String(url), 'base64'))
      }
      lib.upsert({ id, aiImage: file, aiImageAt: new Date().toISOString() }, ['AI配图'])
      await lib.save()
      return ok({ summary: `已生成并保存：${file}（模型 ${model}）`, file, model })
    },
  })

  // ── 调试 ──
  register({
    name: 'zujuan_dom',
    description: '调试用：打开任意组卷网页面并 dump 结构（标题、正文摘要、指定选择器的 HTML，或直接跑一段 JS 把结果打出来）。站点改版导致解析失败时用它定位新选择器。',
    parameters: {
      url: { type: 'string', required: true, description: '完整 URL 或站内路径' },
      selector: { type: 'string', required: false, description: '要 dump 的 CSS 选择器' },
      expr: { type: 'string', required: false, description: '自定义 JS 表达式（在页面里求值）' },
      max: { type: 'integer', required: false, description: '最多输出多少字符，默认 2000' },
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    output: { schema: OUT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.summary }] },
    async execute(args) {
      const site = await ensureSite()
      const url = String(args.url || '')
      const nav = await site.go(url.startsWith('http') ? url : 'https://zujuan.xkw.com' + url, { waitMs: 1500 })
      await site.waitCards({ timeout: 6000 }).catch(() => {})
      const max = Math.max(200, Math.min(20000, Number(args.max) || 2000))
      if (!nav.ok) {
        const shot = await captchaHint(site)
        const why = nav.timeout ? '页面加载超时（这类页面可能永远到不了 complete）' : `被拦截：${nav.title}`
        return fail(why + (shot ? `\n截图：${shot}` : ''), { captcha: !!nav.captcha, timeout: !!nav.timeout, screenshot: shot })
      }
      if (args.expr) {
        const value = await site.browser.evaluate(args.expr).catch((e) => ({ error: String(e.message) }))
        return ok({ summary: `URL: ${await site.browser.url()}\n\nexpr 结果:\n${JSON.stringify(value, null, 1).slice(0, max)}`, value })
      }
      const dump = await site.browser.evaluate(`(() => {
        const sel = ${JSON.stringify(args.selector || '')};
        const out = { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, ${max}) };
        if (sel) {
          const els = [...document.querySelectorAll(sel)].slice(0, 5);
          out.matched = els.length;
          out.html = els.map((e) => e.outerHTML.slice(0, ${Math.floor(max / 2)})).join('\\n\\n/* ---- */\\n\\n');
        }
        return out;
      })()`)
      return ok({
        summary: `URL: ${dump.url}\nTitle: ${dump.title}\n命中: ${dump.matched ?? 0}\n\n正文摘要:\n${dump.text}` + (dump.html ? `\n\n元素 HTML:\n${dump.html.slice(0, max)}` : ''),
        dump,
      })
    },
  })
}
