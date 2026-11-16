// 本地题库：把抓到的题持久化成 JSON，支持去重、打标签、按条件检索。
// 布局：{dataDir}/library/{subject}.json
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

const EMPTY = () => ({ version: 1, updatedAt: null, questions: {} })

export class Library {
  /**
   * @param {string} dir 数据目录
   * @param {string} subject 学科键，如 physics
   */
  constructor(dir, subject = 'physics') {
    this.dir = dir
    this.subject = subject
    this.file = path.join(dir, 'library', `${subject}.json`)
    this.data = EMPTY()
    this.dirty = false
  }

  async load() {
    await mkdir(path.dirname(this.file), { recursive: true })
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.questions) this.data = parsed
    } catch (err) {
      if (err.code !== 'ENOENT') this.data = { ...EMPTY(), warning: String(err.message) }
    }
    return this
  }

  async save() {
    if (!this.dirty) return this
    this.data.updatedAt = new Date().toISOString()
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 1), 'utf8')
    await rename(tmp, this.file)
    this.dirty = false
    return this
  }

  /** 合并一条题目（同 id 覆盖，保留旧字段） */
  upsert(question, tags = []) {
    const id = String(question.id)
    const prev = this.data.questions[id]
    const merged = { ...prev, ...question, tags: [...new Set([...(prev?.tags || []), ...tags])] }
    merged.updatedAt = new Date().toISOString()
    this.data.questions[id] = merged
    this.dirty = true
    return merged
  }

  get(id) {
    return this.data.questions[String(id)] || null
  }

  ids() {
    return Object.keys(this.data.questions)
  }

  /**
   * 条件检索
   * @param {{text?: string, type?: string, difficulty?: string, knowledge?: string, tag?: string, withAnswer?: boolean, limit?: number}} query
   */
  list(query = {}) {
    const need = (query.text || '').trim()
    const out = []
    for (const q of Object.values(this.data.questions)) {
      if (query.type && !(q.type || '').includes(query.type)) continue
      if (query.difficulty && !(q.difficulty || '').includes(query.difficulty)) continue
      if (query.tag && !(q.tags || []).includes(query.tag)) continue
      if (query.knowledge && !(q.knowledge || []).some((k) => k.includes(query.knowledge))) continue
      if (query.withAnswer === true && !q.answerText && !q.answerImage) continue
      if (need) {
        const hay = [q.stemText, q.answerText, (q.knowledge || []).join(' '), q.source, q.type].join(' ')
        if (!hay.includes(need)) continue
      }
      out.push(q)
    }
    out.sort((a, b) => (a.id > b.id ? 1 : -1))
    return typeof query.limit === 'number' ? out.slice(0, query.limit) : out
  }

  tag(ids, tags) {
    let n = 0
    for (const id of ids) {
      const q = this.data.questions[String(id)]
      if (!q) continue
      q.tags = [...new Set([...(q.tags || []), ...tags])]
      n++
      this.dirty = true
    }
    return n
  }

  remove(ids) {
    let n = 0
    for (const id of ids) {
      if (this.data.questions[String(id)]) {
        delete this.data.questions[String(id)]
        n++
        this.dirty = true
      }
    }
    return n
  }

  stats() {
    const all = Object.values(this.data.questions)
    const byType = {}
    const byDifficulty = {}
    let withAnswer = 0
    let withAnalysis = 0
    for (const q of all) {
      byType[q.type || '未知'] = (byType[q.type || '未知'] || 0) + 1
      byDifficulty[q.difficulty || '未知'] = (byDifficulty[q.difficulty || '未知'] || 0) + 1
      if (q.answerImage || q.answerText) withAnswer++
      if (q.analysisHtml || q.analysisText) withAnalysis++
    }
    return { total: all.length, withAnswer, withAnalysis, byType, byDifficulty, updatedAt: this.data.updatedAt }
  }
}
