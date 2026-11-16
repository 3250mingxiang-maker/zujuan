#!/usr/bin/env node
/**
 * zujuan-plugin / lib/render.mjs
 *
 * 组卷网（https://zujuan.xkw.com/）高中物理题目 → 家教讲义 / 试卷的排版导出模块。
 *
 * 设计约束（硬性）：
 * - 纯 ESM、单文件、零第三方依赖；
 * - 业务函数不 import 任何模块（含 node: 内置模块），仅在 `--selftest` 分支内动态 import
 *   `node:fs/promises` / `node:path` / `node:url` 做文件读写；
 * - 所有来自网页的文本一律经 `escapeHtml` / `sanitizeQuestionHtml` 处理；
 * - 学生版永不出现答案、解析及 `【答案】`/`【解析】` 标记。
 *
 * 自测： `node lib/render.mjs --selftest`
 *
 * @module render
 */

/* ============================================================================
 * 1. 类型定义（JSDoc）
 * ==========================================================================*/

/**
 * @typedef {Object} QuestionOption
 * @property {string} label 选项字母，如 "A"
 * @property {string} html  选项内容（可含图片）
 */

/**
 * @typedef {Object} Question
 * @property {string} id                    题号，如 "36527119"
 * @property {string} [bankId]              题库 id，如 "11"
 * @property {string} [type]                "单选题" | "多选题" | "填空题" | "解答题-问答题" | ...
 * @property {string} [difficulty]          "容易" | "适中" | "困难"
 * @property {number} [difficultyScore]     0~1
 * @property {string[]} [knowledge]         知识点
 * @property {string} [source]              来源，如 "26-27高二上·宁夏石嘴山·期中"
 * @property {string} [stemHtml]            题干 HTML（可能含 img / table / sup）
 * @property {string} [stemText]            题干纯文本（stemHtml 缺失时回退）
 * @property {QuestionOption[]} [options]   选项
 * @property {string|null} [answerHtml]     答案 HTML
 * @property {string|null} [answerText]     答案纯文本
 * @property {string|null} [analysisHtml]   解析 HTML
 * @property {string|null} [analysisText]   解析纯文本
 * @property {string} [url]                 原题链接
 * @property {string[]} [images]            题内图片 URL
 */

/**
 * @typedef {Object} PaperInput
 * @property {string} title
 * @property {string} [subtitle]
 * @property {'teacher'|'student'} mode
 * @property {Question[]} questions
 * @property {boolean} [showKnowledge]  默认 true
 * @property {boolean} [showSource]     默认 true
 * @property {boolean} [showDifficulty] 默认 true
 * @property {boolean} [answersAtEnd]   true = 答案统一放文末（教师版）
 * @property {string} [headerNote]
 * @property {string} [footerNote]
 * @property {number} [numberFrom]      起始题号，默认 1
 */

/**
 * @typedef {Required<Pick<PaperInput,'title'|'subtitle'|'mode'|'questions'|'showKnowledge'|'showSource'|'showDifficulty'|'answersAtEnd'|'headerNote'|'footerNote'|'numberFrom'>>} ResolvedPaperInput
 */

/**
 * @typedef {Object} PaperSummary
 * @property {number} total
 * @property {number} withAnswer
 * @property {number} withAnalysis
 * @property {Record<string, number>} types
 * @property {number} totalChars
 */

/* ============================================================================
 * 2. HTML 转义与实体处理
 * ==========================================================================*/

/** 用于反转义的命名实体表（排版文档里实际会出现的子集）。
 * @type {Record<string, string>} */
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  minus: '−',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
  laquo: '«',
  raquo: '»',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  permil: '‰',
  rarr: '→',
  larr: '←',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  rArr: '⇒',
  there4: '∴',
  because: '∵',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  Delta: 'Δ',
  theta: 'θ',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  omega: 'ω',
  Omega: 'Ω',
  phi: 'φ',
  varphi: 'φ',
  epsilon: 'ε',
  eta: 'η',
};

/**
 * 把任意值强制转成字符串；null / undefined / 非字符串安全降级为空串。
 *
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * HTML 转义：`& < > " '`。所有来自网页的文本都必须先过这里。
 *
 * @param {string} s 原始文本
 * @returns {string} 可安全嵌入 HTML 的文本
 */
export function escapeHtml(s) {
  return str(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 解码常见 HTML 实体（用于纯文本输出 / Markdown）。
 *
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return str(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, name) => {
      const hit = NAMED_ENTITIES[name];
      return typeof hit === 'string' ? hit : m;
    });
}

/* ============================================================================
 * 3. 白名单式 HTML 清洗
 * ==========================================================================*/

/** 允许保留的标签（题干、选项、答案里真实会出现的排版标签）。
 * @type {ReadonlySet<string>} */
const ALLOWED_TAGS = new Set([
  'img', 'br', 'sup', 'sub', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'strong', 'b', 'em', 'i', 'u', 'span', 'p', 'div',
]);

/** 危险标签：连内容一起删除。
 * @type {RegExp} */
const DROP_WITH_CONTENT =
  /<(script|style|noscript|template|iframe|frame|frameset|object|embed|applet|svg|math|form|input|button|textarea|select|option|link|meta|base|video|audio|source|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

/** 残留的危险自闭合 / 无闭合标签。
 * @type {RegExp} */
const DROP_SELF =
  /<\/?(script|style|noscript|template|iframe|frame|frameset|object|embed|applet|svg|math|form|input|button|textarea|select|option|link|meta|base|video|audio|source|canvas)\b[^>]*>/gi;

/** style 中允许保留的声明白名单；颜色类（color / background）一律剔除。
 * @type {ReadonlySet<string>} */
const ALLOWED_STYLE_PROPS = new Set([
  'text-align', 'vertical-align', 'width', 'height', 'max-width', 'max-height',
  'font-weight', 'font-style', 'text-decoration', 'font-size', 'line-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'white-space', 'border-collapse', 'border-spacing',
]);

/** 各标签允许的普通属性。
 * @type {Record<string, ReadonlySet<string>>} */
const ALLOWED_ATTRS = {
  '*': new Set(['style']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'width', 'height', 'align', 'valign']),
  th: new Set(['colspan', 'rowspan', 'width', 'height', 'align', 'valign']),
  table: new Set(['width', 'align', 'cellspacing', 'cellpadding', 'border']),
  tr: new Set(['align', 'valign']),
  span: new Set(['align']),
  div: new Set(['align']),
  p: new Set(['align']),
};

/**
 * 判断 URL 是否可安全用于 `img/@src`：只允许 http(s)、协议相对、相对路径、
 * 以及位图 data URI（拒绝 data:text/html 与 data:image/svg+xml，后者可携带脚本）。
 *
 * @param {string} raw
 * @returns {boolean}
 */
function isSafeImageUrl(raw) {
  const url = str(raw).trim();
  if (!url) return false;
  if (/^(javascript|vbscript|file|blob):/i.test(url)) return false;
  if (/^data:/i.test(url)) return /^data:image\/(png|jpe?g|gif|webp|bmp|x-icon);base64,[a-z0-9+/=\s]+$/i.test(url);
  if (/^https?:\/\//i.test(url)) return true;
  if (/^\/\//.test(url)) return true;
  // 相对路径 / 锚点 / 查询串
  return /^[./#?]/.test(url) || /^[\w\-.~%\u4e00-\u9fa5]+([/?#][^\s"'<>]*)?$/.test(url);
}

/**
 * 过滤内联 style：只保留白名单属性，剔除所有 `color` / `background*` 与
 * `url(...)` / `expression(...)` 之类可执行或会破坏版面的声明。
 *
 * @param {string} raw
 * @returns {string} 过滤后的 `prop:value; ...` 串（可能为空串）
 */
function filterStyle(raw) {
  const out = [];
  const parts = str(raw).split(';');
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!prop || !value) continue;
    if (!ALLOWED_STYLE_PROPS.has(prop)) continue;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:/i.test(value)) continue;
    if (/[<>"]/.test(value)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

/**
 * 解析一个开始标签的属性串，按标签白名单 + 值安全检查重建属性列表。
 *
 * @param {string} tag 小写标签名
 * @param {string} attrSource 原始属性串（不含标签名）
 * @returns {string} 形如 ` src="a.png" alt="b"` 的安全属性串（前导空格）
 */
function sanitizeAttributes(tag, attrSource) {
  const common = ALLOWED_ATTRS['*'] || new Set();
  const spec = ALLOWED_ATTRS[tag] || new Set();
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const pieces = [];
  const seen = new Set();
  let m;
  while ((m = attrRe.exec(str(attrSource))) !== null) {
    const name = m[1].toLowerCase();
    const rawValue = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    if (seen.has(name)) continue;
    // on* 事件属性、data-*、以及所有未在白名单的属性直接丢弃
    if (name.startsWith('on')) continue;
    const allowed = common.has(name) || spec.has(name);
    if (!allowed) continue;
    const value = rawValue === undefined ? '' : rawValue;

    if (name === 'style') {
      const filtered = filterStyle(value);
      if (!filtered) continue;
      seen.add(name);
      pieces.push(` style="${escapeHtml(filtered)}"`);
      continue;
    }
    if (name === 'src') {
      if (!isSafeImageUrl(value)) return '\u0000DROP_TAG\u0000';
      seen.add(name);
      pieces.push(` src="${escapeHtml(value.trim())}"`);
      continue;
    }
    if (name === 'width' || name === 'height') {
      const v = value.trim();
      if (!/^\d{1,4}(\.\d+)?%?$/.test(v)) continue;
      seen.add(name);
      pieces.push(` ${name}="${escapeHtml(v)}"`);
      continue;
    }
    if (name === 'colspan' || name === 'rowspan' || name === 'cellspacing' || name === 'cellpadding' || name === 'border') {
      const v = value.trim();
      if (!/^\d{1,2}$/.test(v)) continue;
      seen.add(name);
      pieces.push(` ${name}="${escapeHtml(v)}"`);
      continue;
    }
    if (name === 'align' || name === 'valign') {
      const v = value.trim().toLowerCase();
      if (!/^(left|right|center|justify|top|middle|bottom|baseline)$/.test(v)) continue;
      seen.add(name);
      pieces.push(` ${name}="${escapeHtml(v)}"`);
      continue;
    }
    seen.add(name);
    pieces.push(` ${name}="${escapeHtml(value.trim())}"`);
  }
  return pieces.join('');
}

/**
 * 清洗题目富文本：去掉 `script`/`style`/`iframe` 等危险标签与其内容，剥离 `on*`
 * 事件属性、`javascript:` 协议、内联 `color`/`background`，只保留允许的排版标签。
 * `img` 缺少有效 `src` 时整枚丢弃。
 *
 * @param {string} html 原始 HTML
 * @returns {string} 可安全插入文档的 HTML
 */
export function sanitizeQuestionHtml(html) {
  let s = str(html).replace(/\u0000/g, '');
  if (!s) return '';
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(DROP_WITH_CONTENT, '');
  s = s.replace(DROP_SELF, '');
  // 预先把裸的 `<` 保护起来，避免残缺标签吞掉后续内容
  s = s.replace(/<(?![a-zA-Z/!])/g, '&lt;');

  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  /** @type {string[]} */
  const out = [];
  let last = 0;
  let match;
  while ((match = tagRe.exec(s)) !== null) {
    const text = s.slice(last, match.index);
    out.push(text.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    last = tagRe.lastIndex;
    const raw = match[0];
    const tag = match[1].toLowerCase();
    const isClose = raw.startsWith('</');
    if (!ALLOWED_TAGS.has(tag)) continue; // 丢标签、留内容
    if (isClose) {
      out.push(`</${tag}>`);
      continue;
    }
    if (tag === 'br') {
      out.push('<br>');
      continue;
    }
    if (tag === 'img') {
      const attrs = sanitizeAttributes('img', match[2] || '');
      // 无有效 src（缺失 / javascript: / data:text/html）→ 整枚丢弃
      if (attrs === '\u0000DROP_TAG\u0000' || !/\ssrc="/.test(attrs)) continue;
      out.push(`<img${attrs}>`);
      continue;
    }
    const attrs = sanitizeAttributes(tag, match[2] || '');
    if (attrs === '\u0000DROP_TAG\u0000') continue;
    out.push(`<${tag}${attrs}>`);
  }
  out.push(s.slice(last).replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  // 注意：不做空白折叠——中文试卷里的全角空格（如"（　　）"的答题括号）必须原样保留
  return out.join('').trim();
}

/* ============================================================================
 * 4. 富文本 → 纯文本 / Markdown 片段
 * ==========================================================================*/

/**
 * 把富文本压成纯文本：`<br>`/`</p>` 变换行，`<img>` 变成 `![](url)`，其余去标签并解码实体。
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  let s = str(html).replace(/\u0000/g, '');
  if (!s) return '';
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(DROP_WITH_CONTENT, '');
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const url = m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
    return isSafeImageUrl(url) ? ` ![](${url.trim()}) ` : ' ';
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, '\n');
  s = s.replace(/<\/t[dh]\s*>/gi, ' ');
  s = s.replace(/<[^>]*>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 题干正文：优先使用清洗后的 `stemHtml`，缺失时回退到转义过的 `stemText`。
 *
 * @param {Question} q
 * @returns {string} 可直接插入文档的 HTML
 */
function stemHtmlOf(q) {
  const clean = sanitizeQuestionHtml(str(q.stemHtml));
  if (clean) return clean;
  const text = str(q.stemText).trim();
  if (!text) return '';
  return escapeHtml(text).replace(/\n/g, '<br>');
}

/**
 * 题干纯文本：优先 `stemText`，缺失时从 `stemHtml`/`stemText` 粗暴去标签。
 *
 * @param {Question} q
 * @returns {string}
 */
function stemTextOf(q) {
  const text = str(q.stemText).trim();
  if (text) return text;
  return htmlToText(str(q.stemHtml));
}

/**
 * 答案 / 解析的纯文本。
 *
 * @param {Question} q
 * @returns {{ answerText: string, analysisText: string }}
 */
function answerTextsOf(q) {
  const answerHtml = str(q.answerHtml);
  const analysisHtml = str(q.analysisHtml);
  return {
    answerText: str(q.answerText).trim() || htmlToText(answerHtml),
    analysisText: str(q.analysisText).trim() || htmlToText(analysisHtml),
  };
}

/**
 * 该题是否有答案 / 解析内容。
 *
 * @param {Question} q
 * @returns {{ hasAnswer: boolean, hasAnalysis: boolean }}
 */
function hasAnswerOf(q) {
  const { answerText, analysisText } = answerTextsOf(q);
  const answerHtml = sanitizeQuestionHtml(str(q.answerHtml));
  const analysisHtml = sanitizeQuestionHtml(str(q.analysisHtml));
  return {
    hasAnswer: Boolean(answerHtml || answerText),
    hasAnalysis: Boolean(analysisHtml || analysisText),
  };
}

/**
 * 题号格式化：`1` → `1．`（全角句点，符合中文试卷习惯）。
 *
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  return `${n}．`;
}

/**
 * 估算一道题的"体量"，用于决定是否允许跨页断裂。
 *
 * @param {Question} q
 * @returns {number} 近似字符数
 */
function questionWeight(q) {
  const { answerText, analysisText } = answerTextsOf(q);
  let weight = stemTextOf(q).length + answerText.length + Math.min(analysisText.length, 800);
  const options = Array.isArray(q.options) ? q.options : [];
  for (const opt of options) weight += htmlToText(str(opt && opt.html)).length;
  const images = (stemHtmlOf(q).match(/<img\b/gi) || []).length;
  return weight + images * 120;
}

/* ============================================================================
 * 5. 输入归一化 / 元信息行
 * ==========================================================================*/

/**
 * 归一化 input：补默认值、过滤非法题目、规范 mode / numberFrom。
 *
 * @param {PaperInput} input
 * @returns {ResolvedPaperInput}
 */
function normalizeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('buildPaperHtml/buildWordHtml/buildMarkdown: input 必须是对象');
  }
  const src = /** @type {PaperInput} */ (input);
  const questions = (Array.isArray(src.questions) ? src.questions : []).filter(
    (q) => q && typeof q === 'object',
  );
  const numberFromNum = Number(src.numberFrom);
  const numberFrom = Number.isFinite(numberFromNum) ? Math.trunc(numberFromNum) : 1;
  return {
    title: str(src.title).trim() || '高中物理试题',
    subtitle: str(src.subtitle).trim(),
    mode: src.mode === 'teacher' ? 'teacher' : 'student',
    questions: /** @type {Question[]} */ (questions),
    showKnowledge: src.showKnowledge !== false,
    showSource: src.showSource !== false,
    showDifficulty: src.showDifficulty !== false,
    answersAtEnd: src.answersAtEnd === true,
    headerNote: str(src.headerNote).trim(),
    footerNote: str(src.footerNote).trim(),
    numberFrom,
    groupByType: src.groupByType === true,
    showType: src.showType === true,
    scoreOf: src.scores && typeof src.scores === 'object' ? src.scores : null,
  };
}

/** 题型归类：把"单选题-单题"这类长名字归到六大类，用于分节 */
const TYPE_GROUPS = [
  { key: '单选题', title: '单项选择题', match: /单选|单项选择/ },
  { key: '多选题', title: '多项选择题', match: /多选|多项选择/ },
  { key: '填空题', title: '填空题', match: /填空/ },
  { key: '实验题', title: '实验题', match: /实验/ },
  { key: '作图题', title: '作图题', match: /作图/ },
  { key: '判断题', title: '判断题', match: /判断/ },
  { key: '综合题', title: '综合题', match: /综合/ },
  { key: '解答题', title: '解答题', match: /解答|计算/ },
]

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十']

/**
 * 判断一道题属于哪个题型分组。
 * @param {Question} q
 * @returns {{ key: string, title: string }}
 */
function groupOf(q) {
  const t = str(q.type)
  for (const g of TYPE_GROUPS) if (g.match.test(t)) return { key: g.key, title: g.title }
  return { key: '其他', title: '其他题' }
}

/**
 * 分节标题：「一、单项选择题（共 3 小题，每小题 4 分，共 12 分）」
 * @param {string} title
 * @param {number} index 从 0 开始
 * @param {number} count
 * @param {number|null} score 每小题分值
 * @returns {string}
 */
function sectionTitle(title, index, count, score) {
  const meta = [`共 ${count} 小题`]
  if (score) meta.push(`每小题 ${score} 分，共 ${count * score} 分`)
  return `${CN_NUM[index] ?? index + 1}、${title}（${meta.join('，')}）`
}

/**
 * 副标题：调用方没给时自动拼一个，并追加版本标识。
 *
 * @param {ResolvedPaperInput} paper
 * @returns {string}
 */
function subtitleOf(paper) {
  const parts = [];
  if (paper.subtitle) parts.push(paper.subtitle);
  else parts.push(`共 ${paper.questions.length} 题`);
  parts.push(paper.mode === 'teacher' ? '教师版 · 含答案与解析' : '学生版 · 仅试题');
  return parts.join(' · ');
}

/**
 * 元信息行 HTML：题型 / 难度 / 来源 / 知识点，按 show* 开关拼装。
 *
 * @param {Question} q
 * @param {ResolvedPaperInput} paper
 * @returns {string} `<span class="q-meta">…</span>` 或空串
 */
function renderMetaLineHtml(q, paper) {
  const bits = [];
  // 卷面只要「分值 · 难度系数 · 来源」：题型/知识点默认不进正文（showType/showKnowledge 可开）
  if (paper.showType) {
    const type = str(q.type).trim();
    if (type) bits.push(`<span class="m-type">${escapeHtml(type)}</span>`);
  }
  const score = Number(q.score);
  if (Number.isFinite(score) && score > 0) {
    bits.push(`<span class="m-score">${score} 分</span>`);
  }
  if (paper.showDifficulty) {
    const diffScore = Number(q.difficultyScore);
    if (Number.isFinite(diffScore)) {
      bits.push(`<span class="m-diff">难度系数 ${diffScore.toFixed(2)}</span>`);
    } else {
      const difficulty = str(q.difficulty).trim();
      if (difficulty) bits.push(`<span class="m-diff">难度：${escapeHtml(difficulty)}</span>`);
    }
  }
  if (paper.showSource) {
    const source = str(q.source).trim();
    if (source) bits.push(`<span class="m-src">来源：${escapeHtml(source)}</span>`);
  }
  if (paper.showKnowledge) {
    const knowledge = (Array.isArray(q.knowledge) ? q.knowledge : [])
      .map((k) => str(k).trim())
      .filter(Boolean);
    if (knowledge.length) {
      bits.push(`<span class="m-kp">知识点：${escapeHtml(knowledge.join('、'))}</span>`);
    }
  }
  if (!bits.length) return '';
  return `<div class="q-meta">${bits.join('<span class="m-sep">｜</span>')}</div>`;
}

/* ============================================================================
 * 6. 题目 / 答案块渲染（HTML 与 Word 共用）
 * ==========================================================================*/

/**
 * 选项列表 HTML：A．B．C．D．逐行，选项内图片照常显示。
 *
 * @param {Question} q
 * @returns {string}
 */
function renderOptionsHtml(q) {
  const options = Array.isArray(q.options) ? q.options : [];
  if (!options.length) return '';
  const items = [];
  for (const opt of options) {
    if (!opt || typeof opt !== 'object') continue;
    const label = str(opt.label).trim();
    const body = sanitizeQuestionHtml(str(opt.html)) || escapeHtml(str(opt.html).trim());
    if (!label && !body) continue;
    items.push(
      `<div class="opt"><span class="opt-label">${escapeHtml(label)}．</span><span class="opt-body">${body}</span></div>`,
    );
  }
  if (!items.length) return '';
  return `<div class="opts">\n${items.join('\n')}\n</div>`;
}

/**
 * 教师版答案块：浅灰底 + 左侧竖线 + `【答案】`/`【解析】` 标记。
 *
 * 答案内容是块级富文本（`<p>` / `<table>`）时用 `<div>` 承载，短答案用 `<span>`，
 * 避免 span 里嵌块级元素造成浏览器 / Word 的断行错乱。
 *
 * @param {Question} q
 * @returns {string}
 */
function renderAnswerBlockHtml(q) {
  const { hasAnswer, hasAnalysis } = hasAnswerOf(q);
  const answerHtml = sanitizeQuestionHtml(str(q.answerHtml)) || escapeHtml(str(q.answerText).trim());
  const analysisHtml =
    sanitizeQuestionHtml(str(q.analysisHtml)) || escapeHtml(str(q.analysisText).trim());
  /**
   * @param {string} key
   * @param {string} content
   * @returns {string}
   */
  const row = (key, content) => {
    const wrapper = /<(p|div|table|ul|ol)\b/i.test(content) ? 'div' : 'span';
    return `<div class="answer-row"><span class="answer-key">${key}</span><${wrapper} class="answer-value">${content}</${wrapper}></div>`;
  };
  /** @type {string[]} */
  const rows = [];
  if (hasAnswer) rows.push(row('【答案】', answerHtml));
  if (hasAnalysis) rows.push(row('【解析】', analysisHtml));
  if (!rows.length) rows.push(row('【答案】', '（原题未提供答案与解析）'));
  return `<div class="answer-block">\n${rows.join('\n')}\n</div>`;
}

/**
 * 单题结构：题号（与题干首行同行）+ 题干 + 元信息行 + 选项 +（教师版内联）答案/解析块。
 *
 * 题号特意注入题干第一段内部，避免"1．"独占一行造成大片空白——中文试卷里
 * 题号与题干同起一行才是正常观感。
 *
 * @param {Question} q
 * @param {number} number 显示用题号
 * @param {ResolvedPaperInput} paper
 * @returns {string}
 */
function renderQuestionHtml(q, number, paper) {
  const weight = questionWeight(q);
  const longClass = weight > 620 ? ' q-long' : '';
  const stemInner = stemHtmlOf(q);
  const noHtml = `<span class="q-no">${escapeHtml(formatNumber(number))}</span>`;
  let stem;
  if (!stemInner) {
    stem = `<p>${noHtml}</p>`;
  } else if (/^<p\b[^>]*>/i.test(stemInner)) {
    // 题干以 <p> 开头：把题号塞进该段
    stem = stemInner.replace(/^<p\b[^>]*>/i, (open) => `${open}${noHtml}`);
  } else {
    stem = `${noHtml}${stemInner}`;
  }

  /** @type {string[]} */
  const parts = [];
  parts.push(`<article class="q${longClass}" data-qid="${escapeHtml(str(q.id))}">`);
  parts.push(`<div class="q-stem">${stem}</div>`);
  const meta = renderMetaLineHtml(q, paper);
  if (meta) parts.push(meta);
  const options = renderOptionsHtml(q);
  if (options) parts.push(options);
  if (paper.mode === 'teacher' && !paper.answersAtEnd) parts.push(renderAnswerBlockHtml(q));
  parts.push('</article>');
  return parts.join('\n');
}

/**
 * 教师版文末「参考答案与解析」章节：编号与题号一致。
 *
 * @param {ResolvedPaperInput} paper
 * @returns {string}
 */
function renderAnswerSectionHtml(paper) {
  if (paper.mode !== 'teacher' || !paper.answersAtEnd) return '';
  if (!paper.questions.length) return '';
  /** @type {string[]} */
  const cards = [];
  paper.questions.forEach((q, index) => {
    const number = paper.numberFrom + index;
    const type = str(q.type).trim();
    cards.push(
      [
        '<div class="answer-card">',
        `<div class="answer-card-head"><span class="q-no">${escapeHtml(formatNumber(number))}</span>${
          type ? `<span class="answer-card-type">${escapeHtml(type)}</span>` : ''
        }</div>`,
        renderAnswerBlockHtml(q),
        '</div>',
      ].join('\n'),
    );
  });
  return [
    '<section class="answers-section" id="answers">',
    '<h2 class="section-title">参考答案与解析</h2>',
    cards.join('\n'),
    '</section>',
  ].join('\n');
}

/* ============================================================================
 * 7. 样式表
 * ==========================================================================*/

/**
 * 打印优先的屏幕 + 打印样式表。
 *
 * 页码说明：浏览器的 `@page { @bottom-center { … } }` 属于 CSS Paged Media 的
 * 页边界框，Chrome / Firefox / Safari 目前不实现（Prince、WeasyPrint、Paged.js 实现）。
 * 因此这里两层方案：
 *   1. 保留 `@page` 的 `@bottom-center` 写法 —— 支持它的引擎直接拿到"第 x 页 / 共 y 页"；
 *   2. 同时输出 `position: fixed` 的 `.print-footer` 作为兜底，Chrome 打印时会在每页
 *      底部重复渲染（固定元素逐页重绘），footer 里放 `footerNote` 与页码占位提示。
 *
 * @returns {string}
 */
function paperStyles() {
  return `
:root {
  --ink: #1a1a1a;
  --muted: #6b6b6b;
  --line: #d9d9d6;
  --soft: #f5f5f2;
  --accent: #8a8a86;
}

* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: #ececea;
  color: var(--ink);
  font-family: "Times New Roman", "SimSun", "宋体", serif;
  font-size: 10.5pt;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}

.page {
  width: 178mm;
  margin: 14mm auto 20mm;
  padding: 18mm 16mm 22mm;
  background: #fff;
  box-shadow: 0 3px 22px rgba(0, 0, 0, 0.13);
}

/* ---------- 文档头 ---------- */
.doc-head { text-align: center; margin: 0 0 14mm; }

.doc-title {
  margin: 0 0 4pt;
  font-size: 18pt;
  font-weight: 700;
  letter-spacing: 3px;
  line-height: 1.4;
}

.doc-subtitle {
  margin: 0 0 8pt;
  font-size: 11pt;
  color: var(--muted);
  letter-spacing: 0.5px;
}

.doc-note {
  margin: 10pt auto 0;
  max-width: 150mm;
  padding: 6pt 12pt;
  border-top: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
  font-size: 9.5pt;
  color: var(--muted);
  text-align: left;
  line-height: 1.6;
}

/* ---------- 题目 ---------- */
.q-section {
  margin: 16pt 0 10pt;
  font-size: 11.5pt;
  font-weight: 700;
  letter-spacing: 0.5px;
  break-after: avoid;
  page-break-after: avoid;
}

.q-section:first-child { margin-top: 4pt; }

.q {
  margin: 0 0 13pt;
  padding: 0 0 13pt;
  border-bottom: 1px dashed var(--line);
  break-inside: avoid;
  page-break-inside: avoid;
}

.q:last-of-type { border-bottom: none; }

/* 长题（含大图 / 大段解析）允许跨页，避免出现半页空白 */
.q.q-long { break-inside: auto; page-break-inside: auto; }

.q-no {
  margin-right: 2pt;
  font-weight: 700;
  font-size: 11pt;
  letter-spacing: 0.5px;
}

.q-meta {
  margin: 2pt 0 3pt;
  font-size: 9pt;
  color: var(--muted);
  line-height: 1.5;
}

.q-meta .m-sep { padding: 0 4pt; color: #c4c4c0; }

.q-stem {
  margin: 2pt 0 0;
  text-align: justify;
  text-justify: inter-ideograph;
  word-break: break-word;
}

.opts { margin: 3pt 0 0; padding: 0 0 0 1.4em; }

.opt {
  margin: 0;
  padding: 1pt 0;
  text-align: justify;
  text-justify: inter-ideograph;
  word-break: break-word;
}

.opt-label { margin-right: 2pt; font-weight: 400; }

/* ---------- 图片 / 表格 / 上下标 ---------- */
/* 组卷网的题图是原始大图（站点靠 ?resizew= 缩略参数控制显示尺寸），
   这里统一压到版面内：最宽 62% 正文宽、最高 240px，避免一张图吃掉整页。 */
.q img,
.opts img,
.answer-block img {
  max-width: 100%;
  height: auto;
  vertical-align: middle;
}

.q img {
  max-width: 62%;
  max-height: 240px;
  width: auto;
  margin: 3pt 6pt 3pt 0;
}

/* 公式是静态 SVG，本来该跟正文一个字号；若套上 62% 宽度会被拉成一条横线 */
.q img[src*="/formula/"],
.q img[src*="quesimg"] {
  max-width: none;
  max-height: 1.55em;
  margin: 0 1pt;
}

.opts img { max-width: 55%; max-height: 160px; width: auto; }

.answer-block img { max-width: 100%; max-height: none; }

sup, sub { font-size: 72%; line-height: 0; }

/* 选项表在站点上就是无边框的，导出也保持无边框 */
table {
  border-collapse: collapse;
  margin: 4pt 0;
  max-width: 100%;
  width: auto;
  font-size: 10pt;
}

td, th {
  border: none;
  padding: 1.5pt 8pt 1.5pt 0;
  vertical-align: middle;
  text-align: left;
}

/* ---------- 答案 / 解析 ---------- */
.answer-block {
  margin: 7pt 0 0;
  padding: 6pt 10pt 6pt 10pt;
  background: var(--soft);
  border-left: 3px solid var(--accent);
  font-size: 10pt;
  line-height: 1.65;
  break-inside: avoid;
  page-break-inside: avoid;
}

.answer-row { margin: 1pt 0; text-align: justify; }

.answer-key {
  font-weight: 700;
  letter-spacing: 1px;
}

.answer-value { word-break: break-word; }

/* 解析首段紧跟【解析】标记同一行起排，节省竖直空间 */
.answer-value > p:first-child { display: inline; }

.answer-block p { margin: 2pt 0; }

.answer-block p:first-child { margin-top: 0; }

/* ---------- 文末答案章节 ---------- */
.section-title {
  margin: 16pt 0 10pt;
  padding-top: 10pt;
  border-top: 2px solid var(--ink);
  font-size: 13pt;
  font-weight: 700;
  text-align: center;
  letter-spacing: 2px;
  break-after: avoid;
  page-break-after: avoid;
}

.answers-section { margin: 0; }

.answer-card {
  margin: 0 0 10pt;
  break-inside: avoid;
  page-break-inside: avoid;
}

.answer-card-head { margin: 0 0 2pt; }

.answer-card-type {
  margin-left: 6pt;
  font-size: 9pt;
  color: var(--muted);
}

/* ---------- 页脚（屏幕隐藏） ---------- */
.print-footer { display: none; }

/* ---------- A4 / 打印 ---------- */
@page {
  size: A4;
  margin: 18mm 16mm;
  /* 支持 CSS Paged Media 页边界框的引擎（Prince / WeasyPrint / Paged.js）会渲染页码 */
  @bottom-center {
    content: "第 " counter(page) " 页 / 共 " counter(pages) " 页";
    font-family: "Times New Roman", "SimSun", "宋体", serif;
    font-size: 9pt;
    color: #777;
    vertical-align: top;
    padding-top: 4mm;
  }
}

@media print {
  body { background: #fff; }

  .page {
    width: auto;
    margin: 0;
    padding: 0;
    box-shadow: none;
  }

  .no-print { display: none !important; }

  a { color: inherit; text-decoration: none; }

  .q, .answer-block, .answer-card {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  .q.q-long {
    break-inside: auto;
    page-break-inside: auto;
  }

  h1, h2, .section-title {
    break-after: avoid;
    page-break-after: avoid;
  }

  .answer-block { background: #f2f2f0 !important; }

  /* 兜底页码：Chrome 打印时固定元素逐页重复 */
  .print-footer {
    display: block;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0 0 1mm;
    font-family: "Times New Roman", "SimSun", "宋体", serif;
    font-size: 8.5pt;
    color: #777;
    text-align: center;
  }

  .print-footer .pf-note { display: block; }
}
`.trim();
}

/**
 * Word 兼容样式（`mso-` 前缀 + WordSection1 页面设置）。
 *
 * @returns {string}
 */
function wordStyles() {
  return `
@page WordSection1 {
  size: 210.0mm 297.0mm;
  margin: 18.0mm 16.0mm 20.0mm 16.0mm;
  mso-page-orientation: portrait;
  mso-header-margin: 12.0mm;
  mso-footer-margin: 12.0mm;
  mso-footer: wf1;
  mso-paper-source: 0;
}

div.WordSection1 { page: WordSection1; }

body {
  margin: 0;
  font-family: "Times New Roman", "SimSun", "宋体", serif;
  font-size: 10.5pt;
  line-height: 1.7;
  color: #1a1a1a;
  mso-fareast-font-family: "宋体";
}

p, div, span, td, th, li {
  font-family: "Times New Roman", "SimSun", "宋体", serif;
  mso-fareast-font-family: "宋体";
  font-size: 10.5pt;
  line-height: 1.7;
}

.doc-head { text-align: center; margin: 0 0 14pt; }

.doc-title {
  margin: 0 0 4pt;
  font-size: 18pt;
  font-weight: bold;
  text-align: center;
  letter-spacing: 3pt;
  mso-line-height-rule: exactly;
}

.doc-subtitle {
  margin: 0 0 8pt;
  font-size: 11pt;
  color: #6b6b6b;
  text-align: center;
}

.doc-note {
  margin: 10pt 0 0;
  padding: 6pt 10pt;
  border-top: 1pt solid #d9d9d6;
  border-bottom: 1pt solid #d9d9d6;
  font-size: 9.5pt;
  color: #6b6b6b;
  text-align: left;
}

.q {
  margin: 0 0 12pt;
  page-break-inside: avoid;
  mso-pagination: none;
}

.q-section {
  margin: 14pt 0 8pt;
  font-size: 11.5pt;
  font-weight: bold;
  mso-pagination: keep-with-next;
}

.q.q-long { page-break-inside: auto; }

.q-no { font-weight: bold; font-size: 11pt; margin-right: 2pt; }

.q-meta {
  margin: 2pt 0 3pt;
  font-size: 9pt;
  color: #6b6b6b;
}

.q-meta .m-sep { padding: 0 4pt; color: #c4c4c0; }

.q-stem { margin: 2pt 0 0; text-align: justify; }

.opts { margin: 3pt 0 0 0; }

.opt { margin: 0; padding: 1pt 0; text-align: justify; }

.opt-label { margin-right: 2pt; }

img {
  max-width: 78%;
  width: auto;
  height: auto;
  vertical-align: middle;
}

.q-stem img, .q img { max-width: 55%; max-height: 200px; }

sup, sub { font-size: 72%; }

table {
  border-collapse: collapse;
  width: auto;
  mso-table-lspace: 0pt;
  mso-table-rspace: 0pt;
}

td, th {
  border: none;
  padding: 1.5pt 8pt 1.5pt 0;
  mso-border-alt: none;
}

.answer-block {
  margin: 7pt 0 0 0;
  padding: 6pt 10pt;
  background: #f5f5f2;
  border-left: 3pt solid #8a8a86;
  font-size: 10pt;
  page-break-inside: avoid;
}

.answer-row { margin: 1pt 0; text-align: justify; }

.answer-key { font-weight: bold; }

.section-title {
  margin: 16pt 0 10pt;
  padding-top: 8pt;
  border-top: 1.5pt solid #1a1a1a;
  font-size: 13pt;
  font-weight: bold;
  text-align: center;
  letter-spacing: 2pt;
  page-break-after: avoid;
}

.answer-card { margin: 0 0 10pt; page-break-inside: avoid; }

.answer-card-type { margin-left: 6pt; font-size: 9pt; color: #6b6b6b; }

p.MsoFooter {
  margin: 0;
  font-size: 9pt;
  color: #777;
  text-align: center;
  mso-fareast-font-family: "宋体";
}
`.trim();
}

/* ============================================================================
 * 8. HTML / Word 文档拼装
 * ==========================================================================*/

/**
 * 文档头（标题 / 副标题 / 说明）。
 *
 * @param {ResolvedPaperInput} paper
 * @returns {string}
 */
function renderHeadHtml(paper) {
  /** @type {string[]} */
  const parts = ['<header class="doc-head">'];
  parts.push(`<h1 class="doc-title">${escapeHtml(paper.title)}</h1>`);
  parts.push(`<p class="doc-subtitle">${escapeHtml(subtitleOf(paper))}</p>`);
  if (paper.headerNote) {
    parts.push(`<div class="doc-note">${escapeHtml(paper.headerNote).replace(/\n/g, '<br>')}</div>`);
  }
  parts.push('</header>');
  return parts.join('\n');
}

/**
 * 渲染整份试卷的正文（题目列表 + 文末答案章节）。
 *
 * @param {ResolvedPaperInput} paper
 * @returns {string}
 */
function renderBodyHtml(paper) {
  /** @type {string[]} */
  const parts = ['<main class="paper-body">'];
  if (!paper.questions.length) {
    parts.push('<p class="q-empty">（本卷暂无题目）</p>');
  }
  const counts = new Map();
  for (const q of paper.questions) {
    const g = groupOf(q);
    counts.set(g.key, (counts.get(g.key) || 0) + 1);
  }
  let number = paper.numberFrom;
  let prevGroup = null;
  let groupIndex = -1;
  paper.questions.forEach((q) => {
    if (paper.groupByType) {
      const g = groupOf(q);
      if (g.key !== prevGroup) {
        groupIndex += 1;
        prevGroup = g.key;
        const score = paper.scoreOf ? Number(paper.scoreOf[g.key]) || 0 : 0;
        parts.push(`<h2 class="q-section">${escapeHtml(sectionTitle(g.title, groupIndex, counts.get(g.key) || 0, score))}</h2>`);
      }
    }
    parts.push(renderQuestionHtml(q, number, paper));
    number += 1;
  });
  parts.push(renderAnswerSectionHtml(paper));
  parts.push('</main>');
  return parts.filter(Boolean).join('\n');
}

/**
 * 生成可打印 / 可另存 PDF 的完整 HTML 文档（教师版或学生版）。
 *
 * @param {PaperInput} input 输入（mode 决定是否输出答案与解析）
 * @returns {string} 完整 HTML 字符串
 */
export function buildPaperHtml(input) {
  const paper = normalizeInput(input);
  const title = paper.mode === 'teacher' ? `${paper.title}（教师版）` : `${paper.title}（学生版）`;
  const footer = paper.footerNote || `${paper.title} · ${subtitleOf(paper)}`;
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="zujuan-plugin/lib/render.mjs">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    paperStyles(),
    '</style>',
    '</head>',
    `<body class="mode-${paper.mode}">`,
    '<div class="page">',
    renderHeadHtml(paper),
    renderBodyHtml(paper),
    '</div>',
    '<footer class="print-footer">',
    `<span class="pf-note">${escapeHtml(footer)}</span>`,
    '</footer>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * 生成 Word 兼容 HTML（保存为 `.doc` 直接用 Word 打开）：A4 页面、宋体正文、
 * `mso-` 页面设置、页脚域代码页码。
 *
 * @param {PaperInput} input
 * @returns {string} 完整 Word-HTML 字符串
 */
export function buildWordHtml(input) {
  const paper = normalizeInput(input);
  const title = paper.mode === 'teacher' ? `${paper.title}（教师版）` : `${paper.title}（学生版）`;
  const footerNote = paper.footerNote || `${paper.title} · ${subtitleOf(paper)}`;
  return [
    '<html xmlns:o="urn:schemas-microsoft-com:office:office"',
    '      xmlns:w="urn:schemas-microsoft-com:office:word"',
    '      xmlns="http://www.w3.org/TR/REC-html40" lang="zh-CN">',
    '<head>',
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">',
    '<meta name="ProgId" content="Word.Document">',
    '<meta name="Generator" content="Microsoft Word 15">',
    '<meta name="Originator" content="Microsoft Word 15">',
    `<title>${escapeHtml(title)}</title>`,
    '<!--[if gte mso 9]><xml>',
    ' <o:DocumentProperties>',
    `  <o:Title>${escapeHtml(title)}</o:Title>`,
    ' </o:DocumentProperties>',
    '</xml><![endif]-->',
    '<style>',
    '<!--',
    wordStyles(),
    '-->',
    '</style>',
    '</head>',
    `<body lang="ZH-CN" class="mode-${paper.mode}">`,
    '<div class="WordSection1">',
    renderHeadHtml(paper),
    renderBodyHtml(paper),
    '</div>',
    // Word 页脚：域名 wf1，由 @page WordSection1 { mso-footer: wf1 } 挂载
    '<div style="mso-element:footer" id="wf1">',
    `<p class="MsoFooter"><span class="pf-note">${escapeHtml(footerNote)}</span>　第 <span style="mso-field-code:PAGE">1</span> 页 / 共 <span style="mso-field-code:NUMPAGES">1</span> 页</p>`,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/* ============================================================================
 * 9. Markdown
 * ==========================================================================*/

/**
 * 把多行文本整理成 Markdown 段落（保留换行，行尾去空格）。
 *
 * @param {string} text
 * @returns {string}
 */
function mdParagraph(text) {
  return str(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

/**
 * 生成 Markdown 讲义/试卷：`## 1. [题型]` 结构，题干纯文本，教师版追加答案与解析。
 *
 * @param {PaperInput} input
 * @returns {string} Markdown 文本
 */
export function buildMarkdown(input) {
  const paper = normalizeInput(input);
  /** @type {string[]} */
  const lines = [];
  lines.push(`# ${paper.title}`);
  lines.push('');
  lines.push(`> ${subtitleOf(paper)}`);
  if (paper.headerNote) {
    lines.push('>');
    for (const line of mdParagraph(paper.headerNote).split('\n')) lines.push(`> ${line}`);
  }
  lines.push('');

  const mdCounts = new Map();
  for (const q of paper.questions) {
    const g = groupOf(q);
    mdCounts.set(g.key, (mdCounts.get(g.key) || 0) + 1);
  }
  let mdPrevGroup = null;
  let mdGroupIndex = -1;

  paper.questions.forEach((q, index) => {
    const number = paper.numberFrom + index;
    const type = str(q.type).trim() || '试题';
    if (paper.groupByType) {
      const g = groupOf(q);
      if (g.key !== mdPrevGroup) {
        mdGroupIndex += 1;
        mdPrevGroup = g.key;
        const score = paper.scoreOf ? Number(paper.scoreOf[g.key]) || 0 : 0;
        lines.push(`## ${sectionTitle(g.title, mdGroupIndex, mdCounts.get(g.key) || 0, score)}`);
        lines.push('');
      }
    }
    lines.push(`### ${number}.${paper.showType ? ` [${type}]` : ''}`);
    lines.push('');

    /** @type {string[]} */
    const quotes = [];
    const qScore = Number(q.score);
    if (Number.isFinite(qScore) && qScore > 0) quotes.push(`${qScore} 分`);
    if (paper.showDifficulty) {
      const diffScore = Number(q.difficultyScore);
      if (Number.isFinite(diffScore)) quotes.push(`难度系数 ${diffScore.toFixed(2)}`);
      else if (str(q.difficulty).trim()) quotes.push(`难度：${str(q.difficulty).trim()}`);
    }
    if (paper.showSource && str(q.source).trim()) quotes.push(`来源：${str(q.source).trim()}`);
    if (paper.showKnowledge) {
      const knowledge = (Array.isArray(q.knowledge) ? q.knowledge : [])
        .map((k) => str(k).trim())
        .filter(Boolean);
      if (knowledge.length) quotes.push(`知识点：${knowledge.join('、')}`);
    }
    if (quotes.length) {
      lines.push(`> ${quotes.join(' · ')}`);
      lines.push('');
    }

    const stem = mdParagraph(stemTextOf(q));
    if (stem) lines.push(stem);
    lines.push('');

    // 图片：题干里已经内联的跳过，未出现的（stemText 分支）单独补成 ![](url)
    const imageUrls = (Array.isArray(q.images) ? q.images : [])
      .map((url) => str(url).trim())
      .filter((url) => url && isSafeImageUrl(url));
    for (const url of imageUrls) {
      if (stem.includes(url)) continue;
      lines.push(`![](${url})`);
    }
    if (imageUrls.length) lines.push('');

    const options = Array.isArray(q.options) ? q.options : [];
    for (const opt of options) {
      if (!opt || typeof opt !== 'object') continue;
      const label = str(opt.label).trim();
      const body = mdParagraph(htmlToText(str(opt.html)) || str(opt.html));
      if (!label && !body) continue;
      // 行尾两个空格 = Markdown 硬换行，保证 A/B/C/D 各自成行
      lines.push(`${label}．${body}`.trimEnd() + '  ');
    }
    if (options.length) lines.push('');

    if (paper.mode === 'teacher' && !paper.answersAtEnd) {
      const { answerText, analysisText } = answerTextsOf(q);
      lines.push(`**答案：** ${answerText || '（原题未提供答案）'}`);
      lines.push('');
      if (analysisText) {
        lines.push(`**解析：** ${analysisText}`);
        lines.push('');
      }
    }
  });

  if (paper.mode === 'teacher' && paper.answersAtEnd) {
    lines.push('---');
    lines.push('');
    lines.push('## 参考答案与解析');
    lines.push('');
    paper.questions.forEach((q, index) => {
      const number = paper.numberFrom + index;
      const type = str(q.type).trim();
      lines.push(`### ${number}.${type ? ` [${type}]` : ''}`);
      lines.push('');
      const { answerText, analysisText } = answerTextsOf(q);
      lines.push(`**答案：** ${answerText || '（原题未提供答案）'}`);
      lines.push('');
      if (analysisText) {
        lines.push(`**解析：** ${analysisText}`);
        lines.push('');
      }
    });
  }

  if (paper.footerNote) {
    lines.push('---');
    lines.push('');
    lines.push(`> ${paper.footerNote}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ============================================================================
 * 10. summarize
 * ==========================================================================*/

/**
 * 统计试卷概况：题目数、含答案数、含解析数、题型分布、总字符数。
 *
 * `totalChars` = 每题的（题干 + 选项 + 答案 + 解析）纯文本字符数之和，
 * 不含题号、元信息与排版空白，可用于估算打印页数。
 *
 * @param {PaperInput} input
 * @returns {PaperSummary}
 */
export function summarize(input) {
  const paper = normalizeInput(input);
  /** @type {Record<string, number>} */
  const types = {};
  let withAnswer = 0;
  let withAnalysis = 0;
  let totalChars = 0;

  for (const q of paper.questions) {
    const { hasAnswer, hasAnalysis } = hasAnswerOf(q);
    if (hasAnswer) withAnswer += 1;
    if (hasAnalysis) withAnalysis += 1;
    const type = str(q.type).trim() || '未标注';
    types[type] = (types[type] || 0) + 1;

    const { answerText, analysisText } = answerTextsOf(q);
    totalChars += stemTextOf(q).length;
    const options = Array.isArray(q.options) ? q.options : [];
    for (const opt of options) totalChars += htmlToText(str(opt && opt.html)).length;
    totalChars += answerText.length + analysisText.length;
  }

  return { total: paper.questions.length, withAnswer, withAnalysis, types, totalChars };
}

/* ============================================================================
 * 11. 内部工具导出（测试用）
 * ==========================================================================*/

/** 内部小工具，仅供自测 / 调试，不承诺向后兼容。 */
export const __testing = {
  ALLOWED_TAGS,
  ALLOWED_STYLE_PROPS,
  NAMED_ENTITIES,
  decodeEntities,
  filterStyle,
  sanitizeAttributes,
  isSafeImageUrl,
  htmlToText,
  stemHtmlOf,
  stemTextOf,
  answerTextsOf,
  hasAnswerOf,
  formatNumber,
  questionWeight,
  normalizeInput,
  subtitleOf,
  renderMetaLineHtml,
  renderOptionsHtml,
  renderAnswerBlockHtml,
  renderQuestionHtml,
  renderAnswerSectionHtml,
  renderHeadHtml,
  renderBodyHtml,
  paperStyles,
  wordStyles,
  normalizeInputSafe(input) {
    try {
      return normalizeInput(input);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
};

/* ============================================================================
 * 12. 自测 CLI： node lib/render.mjs --selftest
 * ==========================================================================*/

/**
 * 运行自测：读取 fixtures/sample-questions.json，导出 out/ 下 6 个文件，逐项断言。
 *
 * @returns {Promise<number>} 失败项数量（0 表示全部通过）
 */
async function runSelfTest() {
  const { mkdir, readFile, writeFile, stat } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = join(here, '..', 'fixtures', 'sample-questions.json');
  const outDir = join(here, '..', 'out');
  await mkdir(outDir, { recursive: true });

  const raw = await readFile(fixturePath, 'utf8');
  /** @type {Question[]} */
  const questions = JSON.parse(raw);

  /** @type {{ name: string, ok: boolean, detail: string }[]} */
  const results = [];
  /**
   * @param {string} name
   * @param {boolean} ok
   * @param {string} [detail]
   */
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail });
  };

  const base = {
    title: '高中物理·动量与电磁感应专题训练',
    subtitle: '共 3 题 / 满分 100 分 / 高中物理·动量守恒与电磁感应',
    questions,
    showKnowledge: true,
    showSource: true,
    showDifficulty: true,
    headerNote: '作答要求：选择题将答案填在括号内，解答题写出必要的文字说明、方程式和重要的演算步骤。',
    footerNote: '组卷网讲义 · 仅供家教课堂使用',
    numberFrom: 1,
  };

  const teacherHtml = buildPaperHtml({ ...base, mode: 'teacher', answersAtEnd: false });
  const studentHtml = buildPaperHtml({ ...base, mode: 'student', answersAtEnd: false });
  const teacherHtmlAtEnd = buildPaperHtml({ ...base, mode: 'teacher', answersAtEnd: true });
  const teacherWord = buildWordHtml({ ...base, mode: 'teacher', answersAtEnd: false });
  const studentWord = buildWordHtml({ ...base, mode: 'student', answersAtEnd: false });
  const teacherMd = buildMarkdown({ ...base, mode: 'teacher', answersAtEnd: false });
  const studentMd = buildMarkdown({ ...base, mode: 'student', answersAtEnd: false });

  const files = [
    ['teacher.html', teacherHtml],
    ['student.html', studentHtml],
    ['teacher.doc', teacherWord],
    ['student.doc', studentWord],
    ['teacher.md', teacherMd],
    ['student.md', studentMd],
    ['teacher-answers-at-end.html', teacherHtmlAtEnd],
  ];
  /** @type {{ file: string, bytes: number }[]} */
  const sizes = [];
  for (const [name, content] of files) {
    const target = join(outDir, String(name));
    await writeFile(target, String(content), 'utf8');
    const info = await stat(target);
    sizes.push({ file: String(name), bytes: info.size });
  }

  /* ---------------- 断言 1：学生版绝不泄露答案 ---------------- */
  /**
   * 取文档正文（去掉 `<style>` 块），避免把 CSS 类名当成内容误判。
   *
   * @param {string} html
   * @returns {string}
   */
  const bodyOnly = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, '');
  const studentBody = bodyOnly(studentHtml);
  const studentWordBody = bodyOnly(studentWord);
  const teacherBody = bodyOnly(teacherHtml);
  /** @param {string} s */
  const compact = (s) => String(s).replace(/\s+/g, '');
  const teacherPlain = compact(__testing.htmlToText(teacherBody));

  const leakMarkers = ['【答案】', '【解析】', 'answer-block', '参考答案与解析'];
  for (const marker of leakMarkers) {
    check(
      `student.html 不含标记 ${marker}`,
      !studentBody.includes(marker),
      `student.html ${studentBody.includes(marker) ? '出现' : '未出现'} ${marker}`,
    );
  }
  check(
    'student.doc 不含答案块',
    !studentWordBody.includes('answer-block') && !studentWordBody.includes('【答案】'),
    `student.doc ${studentWordBody.includes('【答案】') ? '出现' : '未出现'} 答案标记`,
  );
  for (const marker of ['【答案】', '【解析】']) {
    check(
      `student.md 不含标记 ${marker}`,
      !studentMd.includes(marker),
      `student.md ${studentMd.includes(marker) ? '出现' : '未出现'} ${marker}`,
    );
  }

  let answerLeakPlain = '';
  let answerLeakOk = true;
  for (const q of questions) {
    const { answerText, analysisText } = __testing.answerTextsOf(q);
    for (const snippet of [answerText, analysisText]) {
      if (compact(snippet).length < 12) continue;
      if (studentBody.includes(snippet)) {
        answerLeakOk = false;
        answerLeakPlain = `题 ${q.id} 的答案/解析文本出现在 student.html：${snippet.slice(0, 24)}…`;
      }
    }
  }
  check('student.html 不含答案/解析正文', answerLeakOk, answerLeakPlain || '未检出答案或解析正文');

  /* ---------------- 断言 2：教师版必须有答案与解析 ---------------- */
  check('teacher.html 含 【答案】', teacherBody.includes('【答案】'));
  check('teacher.html 含 【解析】', teacherBody.includes('【解析】'));
  check(
    'teacher.html 含文末答案章节（answersAtEnd=true）',
    teacherHtmlAtEnd.includes('参考答案与解析') && teacherHtmlAtEnd.includes('【答案】'),
  );
  check(
    'teacher-answers-at-end 的题号与正文一致（1．2．3．）',
    ['1．', '2．', '3．'].every((n) => teacherHtmlAtEnd.includes(n)),
  );
  let teacherHasAll = true;
  /** @type {string[]} */
  const missing = [];
  for (const q of questions) {
    const answerSource = String(q.answerHtml || q.answerText || '');
    const snippet = compact(__testing.htmlToText(answerSource)).slice(0, 12);
    if (snippet && !teacherPlain.includes(snippet)) {
      teacherHasAll = false;
      missing.push(q.id);
    }
  }
  check('teacher.html 逐题含答案文本', teacherHasAll, missing.length ? `缺失：${missing.join(',')}` : '');

  /* ---------------- 断言 3：summarize ---------------- */
  const summary = summarize({ ...base, mode: 'teacher' });
  check('summarize.total === 3', summary.total === 3, `total=${summary.total}`);
  check('summarize.withAnswer === 3', summary.withAnswer === 3, `withAnswer=${summary.withAnswer}`);
  check(
    'summarize.withAnalysis === 3',
    summary.withAnalysis === 3,
    `withAnalysis=${summary.withAnalysis}`,
  );
  check(
    'summarize.types 分布正确',
    summary.types['单选题'] === 1 &&
      summary.types['多选题'] === 1 &&
      summary.types['解答题-问答题'] === 1 &&
      Object.keys(summary.types).length === 3,
    JSON.stringify(summary.types),
  );
  check('summarize.totalChars > 800', summary.totalChars > 800, `totalChars=${summary.totalChars}`);

  /* ---------------- 断言 4：清洗与转义 ---------------- */
  const dirty = sanitizeQuestionHtml('<img src=x onerror=alert(1)>');
  check('sanitize 去掉 onerror', !/onerror/i.test(dirty), dirty);
  check('sanitize 去掉 <script>', !/script/i.test(sanitizeQuestionHtml('<p>安全</p><script>alert(1)</script>')));
  check(
    'sanitize 去掉 javascript: 协议',
    !/javascript:/i.test(sanitizeQuestionHtml('<img src="javascript:alert(1)"><a href="javascript:void(0)">x</a>')),
  );
  check(
    'sanitize 去掉内联 color',
    !/color\s*:/i.test(sanitizeQuestionHtml('<span style="color:red;text-align:center">红</span>')),
  );
  check('sanitize 丢弃无 src 的 img', !/<img/i.test(sanitizeQuestionHtml('<p>图：<img alt="缺图"></p>')));
  check(
    'sanitize 保留 img/br/sup/sub/table/strong',
    ['<img src="https://a/b.png">', '<br>', '<sup>2</sup>', '<sub>1</sub>', '<table>', '<strong>b</strong>'].every(
      (frag) => sanitizeQuestionHtml(frag).includes(frag),
    ),
    sanitizeQuestionHtml('<table><tr><td><img src="https://a/b.png"><br><sup>2</sup><sub>1</sub><strong>b</strong></td></tr></table>'),
  );
  check(
    'sanitize 保留全角答题括号空白',
    sanitizeQuestionHtml('答案（　　）').includes('（　　）'),
    sanitizeQuestionHtml('答案（　　）'),
  );
  check('escapeHtml("<b>&") 正确转义', escapeHtml('<b>&') === '&lt;b&gt;&amp;', escapeHtml('<b>&'));  check(
    'escapeHtml 转义引号',
    escapeHtml(`"'`) === '&quot;&#39;',
    escapeHtml(`"'`),
  );

  /* ---------------- 断言 5：Word 文档结构 ---------------- */
  check('teacher.doc 含 mso 页面设置', teacherWord.includes('mso-page-orientation'));
  check('teacher.doc 含 charset meta', /charset=utf-8/i.test(teacherWord));
  check('teacher.doc 含 A4 尺寸', /210\.0mm\s+297\.0mm/.test(teacherWord));
  check('teacher.doc 含页脚域代码', teacherWord.includes('mso-field-code:PAGE'));

  /* ---------------- 断言 6：Markdown 结构 ---------------- */
  check('teacher.md 含 **答案：**', teacherMd.includes('**答案：**'));
  check('student.md 不含 **答案：**', !studentMd.includes('**答案：**'));
  // 题号用三级标题（### 1.）；题型在分节标题里（groupByType/scorePlan 时）
  check('teacher.md 题号用三级标题 ### 1.', /^### 1\./m.test(teacherMd));
  check('teacher.md 图片写成 ![](url)', /\!\[\]\(https?:\/\//.test(teacherMd));
  check(
    'teacher.md 选项使用硬换行（行尾两空格）',
    teacherMd.split('\n').filter((line) => /^[A-D]．/.test(line) && line.endsWith('  ')).length >= 4,
  );
  check('student.md 保留来源引用行', studentMd.includes('来源：'));

  /* ---------------- 断言 7：中文排版参数 ---------------- */
  check(
    'teacher.html 含中文字体栈',
    teacherHtml.includes('"Times New Roman", "SimSun", "宋体", serif'),
  );
  check('teacher.html 含 @page A4 18mm/16mm', /@page\s*{[^}]*size:\s*A4/.test(teacherHtml) && teacherHtml.includes('margin: 18mm 16mm'));
  check('teacher.html 含 break-inside: avoid', teacherHtml.includes('break-inside: avoid'));
  check('teacher.html 含 img max-width: 100%', /img\s*{[^}]*max-width:\s*100%/s.test(teacherHtml.replace(/\n/g, ' ')) || teacherHtml.includes('max-width: 100%'));

  /* ---------------- 输出 ---------------- */
  console.log('组卷网讲义渲染 自测报告');
  console.log('='.repeat(72));
  console.log(`题库样例：${fixturePath}`);
  console.log(`输出目录：${outDir}`);
  console.log('');
  console.log('生成文件：');
  for (const item of sizes) {
    console.log(`  ${item.file.padEnd(30)} ${String(item.bytes).padStart(8)} 字节`);
  }
  console.log('');
  console.log('断言：');
  let failed = 0;
  for (const item of results) {
    if (!item.ok) failed += 1;
    const tail = item.detail ? `  — ${item.detail}` : '';
    console.log(`  [${item.ok ? 'PASS' : 'FAIL'}] ${item.name}${tail}`);
  }
  console.log('');
  console.log('='.repeat(72));
  console.log(`汇总：${results.length - failed} PASS / ${failed} FAIL（共 ${results.length} 项）`);
  console.log(`summarize：${JSON.stringify(summary)}`);
  return failed;
}

if (process.argv.includes('--selftest')) {
  runSelfTest()
    .then((failed) => {
      if (failed > 0) process.exitCode = 1;
    })
    .catch((error) => {
      console.error('[selftest] 运行失败：', error);
      process.exitCode = 1;
    });
}
