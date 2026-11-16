// 组卷网站点流程层：登录、选题列表、题目详情、答案图片。
// 只依赖 Browser（CDP）与站点公开 DOM / 公开接口，不引入第三方库。
import path from 'node:path'
import { mkdir, unlink, readFile, writeFile } from 'node:fs/promises'
import { detectSlider, solveSlider } from './slider.mjs'

export const BASE = 'https://zujuan.xkw.com'
export const SSO = 'https://sso.zxxk.com'

/** 学科 → URL 前缀。前缀来自站点频道页，可直接拼在域名后。 */
export const SUBJECTS = {
  高中物理: { slug: 'gzwl', level: '高中', name: '物理' },
  初中物理: { slug: 'czwl', level: '初中', name: '物理' },
  高中数学: { slug: 'gzsx', level: '高中', name: '数学' },
  初中数学: { slug: 'czsx', level: '初中', name: '数学' },
  高中化学: { slug: 'gzhx', level: '高中', name: '化学' },
  初中化学: { slug: 'czhx', level: '初中', name: '化学' },
  高中生物: { slug: 'gzsw', level: '高中', name: '生物' },
  高中语文: { slug: 'gzyw', level: '高中', name: '语文' },
  高中英语: { slug: 'gzyy', level: '高中', name: '英语' },
  初中语文: { slug: 'czyw', level: '初中', name: '语文' },
  初中英语: { slug: 'czyy', level: '初中', name: '英语' },
  高中地理: { slug: 'gzdl', level: '高中', name: '地理' },
  高中历史: { slug: 'gzls', level: '高中', name: '历史' },
  高中政治: { slug: 'gzzz', level: '高中', name: '政治' },
}

/** 题型 → 列表页参数（qt 前缀） */
const TYPE_PARAM = {
  单选题: 'qt2701',
  多选题: 'qt2704',
  填空题: 'qt2702',
  解答题: 'qt2703',
  判断题: 'qt2705',
}

/** 难度 → 列表页参数（d 前缀） */
const DIFF_PARAM = { 容易: 'd1', 适中: 'd2', 困难: 'd3' }

/** 年级 → 列表页参数（g 前缀） */
const GRADE_PARAM = {
  七年级: 'g7',
  八年级: 'g8',
  九年级: 'g9',
  高一: 'g10',
  高二: 'g11',
  高三: 'g12',
}

/** 兜底的学科 → 题库 ID 映射（实测：11=高中数学，13=高中物理） */
const BANK_FALLBACK = { 高中数学: '11', 高中物理: '13' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 读 PNG/JPEG 头拿真实像素尺寸（用来识别站点返回的 414×30 占位图） */
export async function imageSize(file) {
  let buf
  try {
    buf = await readFile(file)
  } catch {
    return null
  }
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), type: 'png' }
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++
        continue
      }
      const marker = buf[i + 1]
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), type: 'jpeg' }
      }
      const len = buf.readUInt16BE(i + 2)
      if (!len) break
      i += 2 + len
    }
  }
  return null
}

/** 站点会在题干正文里带一层自己的题号（"1 . …"），导出时我们自己编号，先剥掉 */
export function stripLeadingNumber(html = '', text = '') {
  const m = String(text).match(/^\s*(\d{1,3})\s*[.．、]\s*/)
  if (!m) return { html, text }
  const trimmedText = String(text).slice(m[0].length)
  const trimmedHtml = String(html).replace(
    /^((?:\s|<[^>]*>)*)\d{1,3}\s*[.．、]/,
    (_all, lead) => lead,
  )
  return { html: trimmedHtml, text: trimmedText }
}

/** 站点在风险判定后会插入阿里云滑块验证页 */
export function isCaptchaPage(title, text = '') {
  return /滑动验证|访问验证/.test(title) || /按住滑块|拖动到最右边|访问验证/.test(text)
}

export class ZujuanSite {
  /**
   * @param {import('./cdp.mjs').Browser} browser
   * @param {{paceMs?: number, log?: (msg: string) => void, autoCaptcha?: boolean}} options
   */
  constructor(browser, options = {}) {
    this.browser = browser
    this.paceMs = options.paceMs ?? 2200
    this.log = options.log ?? (() => {})
    this.cacheDir = options.cacheDir || ''
    this.useFetch = options.useFetch !== false
    this.autoCaptcha = options.autoCaptcha !== false
    this.captchaStats = { tried: 0, passed: 0, failed: 0, last: null }
    this.lastUrls = []
  }

  /**
   * 自动过滑块：把验证页拉出来 → 等组件渲染 → 拟人拖拽 → 确认放行。
   * 这是"撞滑块"之后的兜底，而不是靠它去硬撞。
   * @param {{attempts?:number, navTo?:string}} opts
   */
  async passCaptcha({ attempts = 3, navTo = null } = {}) {
    if (!this.autoCaptcha) return { ok: false, reason: 'autoCaptcha 已关闭' }
    this.captchaStats.tried += 1
    const log = (s) => this.log(`[captcha] ${s}`)

    // 触发时页面内是 fetch 拿到的验证 HTML，DOM 上并没有验证页 → 导航一次把组件渲染出来
    let info = await detectSlider(this.browser).catch(() => null)
    if (!info?.present) {
      const target = navTo || (await this.browser.url().catch(() => '')) || BASE + '/gzwl/'
      await this.go(target, { waitMs: 900, recover: false }).catch(() => {})
      // 组件是前端注入的，给它一点时间
      const deadline = Date.now() + 6000
      while (Date.now() < deadline && !info?.present) {
        await sleep(250)
        info = await detectSlider(this.browser).catch(() => null)
      }
    }
    if (!info?.present) {
      this.captchaStats.failed += 1
      this.captchaStats.last = { ok: false, reason: '验证页上没有渲染出滑块组件' }
      log('验证页上没有滑块组件，交给人工')
      return { ok: false, reason: '验证页上没有渲染出滑块组件' }
    }

    const solved = await solveSlider({ browser: this.browser, attempts, log: (s) => log(s), captchaUrl: navTo || '' })
    if (solved.ok) {
      // 通过后站点会把页面跳回原地址；等它自己走完
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        await sleep(300)
        const title = await this.browser.title().catch(() => '')
        const text = await this.browser.evaluate('document.body ? document.body.innerText.slice(0,200) : ""').catch(() => '')
        if (!isCaptchaPage(String(title), String(text))) break
      }
      this.captchaStats.passed += 1
      this.captchaStats.last = { ok: true, attempts: solved.attempts, reason: solved.reason }
      log(`已通过（第 ${solved.attempts} 次：${solved.reason}）`)
      return { ok: true, attempts: solved.attempts, reason: solved.reason, log: solved.log }
    }
    this.captchaStats.failed += 1
    this.captchaStats.last = { ok: false, reason: solved.reason }
    log(`未通过：${solved.reason}`)
    return { ok: false, reason: solved.reason, log: solved.log }
  }

  /** 等验证页自己回跳到正常页（最多 12 秒），返回落地信息 */
  async waitCaptchaCleared({ timeout = 12_000 } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      await sleep(400)
      const title = String(await this.browser.title().catch(() => ''))
      const text = String(
        await this.browser.evaluate('document.body ? document.body.innerText.slice(0,200) : ""').catch(() => ''),
      )
      if (!isCaptchaPage(title, text)) {
        return { title, url: await this.browser.url().catch(() => '') }
      }
    }
    return null
  }

  /** 带节奏的导航；遇到滑块会先尝试自动通过一次，通过后等它自己回跳 */
  async go(pathname, { waitMs = 1200, tries = 1, recover = true } = {}) {
    const url = pathname.startsWith('http') ? pathname : BASE + pathname
    for (let i = 0; i < tries; i++) {
      await this.browser.goto(url, { waitMs })
      if (this.browser.lastGotoTimedOut) {
        return { ok: false, timeout: true, url: await this.browser.url().catch(() => url), title: '' }
      }
      // 阿里云/加速乐的第一层是"算 Cookie 再跳转"的 JS 挑战页：标题为空 + parm_0 隐藏域，
      // 这种页面等再久也不会出现题目卡片，必须重载一次让 Cookie 生效。
      const challenge = await this.browser
        .evaluate(
          `(() => {
            const t = document.title || '';
            const hasParm = !!document.querySelector('input[name="parm_0"]');
            const body = document.body ? document.body.innerText.slice(0, 80) : '';
            return (!t && hasParm) || /check\\(\\)/.test(body);
          })()`,
        )
        .catch(() => false)
      if (challenge) {
        await sleep(1200)
        await this.browser.reload({ waitMs: 1200 })
      }
      const title = await this.browser.title()
      const text = await this.browser.evaluate('document.body ? document.body.innerText.slice(0,200) : ""')
      this.lastUrls.push({ url: await this.browser.url(), title })
      if (isCaptchaPage(title, text)) {
        if (recover && this.autoCaptcha) {
          const passed = await this.passCaptcha({ navTo: url })
          if (passed.ok) {
            // 关键：验证页通过后 WAF 会**自己把当前页回跳**到目标页（约 1~2 秒）。
            // 这时绝不能再导航一次——新导航会被当成新请求重新判风险，立刻又弹验证。
            const landed = await this.waitCaptchaCleared()
            return {
              ok: true,
              url: landed?.url || (await this.browser.url().catch(() => url)),
              title: landed?.title || '',
              viaCaptcha: true,
            }
          }
          return { ok: false, captcha: true, url: await this.browser.url(), title, captchaAttempt: passed.reason }
        }
        return { ok: false, captcha: true, url: await this.browser.url(), title }
      }
      if (i < tries - 1) await sleep(this.paceMs)
    }
    return { ok: true, url: await this.browser.url(), title: await this.browser.title() }
  }

  /** 读取登录状态与账号权限（/zujuan-api/user 返回的是 JS 变量串） */
  async loginState() {
    const res = await this.browser.fetchText(`${BASE}/zujuan-api/user?t=${Date.now()}`)
    const text = typeof res === 'string' ? res : res?.text || ''
    const visitor = /isvisitor\s*=\s*true/.test(text)
    const group = {}
    const g = text.match(/usergroup\s*=\s*(\{[\s\S]*?\})\s*,\s*usermoney/)
    if (g) {
      try {
        const parsed = JSON.parse(g[1])
        for (const [k, v] of Object.entries(parsed)) group[k] = v
      } catch {}
    }
    const userName = (text.match(/UserName["']?\s*[:=]\s*["']([^"']+)["']/) || [])[1] || null
    return {
      loggedIn: !visitor,
      visitor,
      userName,
      group: {
        name: group.GroupName || null,
        canViewAnswer: group.CanViewQuesAnswer ?? null,
        canViewAnalysis: group.CanViewQuesParse ?? null,
        maxQuestionsPerPaper: group.MaxQuesNumInPaper ?? null,
        maxPapersPerDay: group.MaxCreatePaperOneDay ?? null,
        maxViewParse: group.MaxViewParse ?? null,
      },
      raw: text.slice(0, 400),
    }
  }

  /** 打开登录页；QR 模式会把二维码截图存盘并返回路径 */
  async openLogin({ shotPath, password } = {}) {
    const service = encodeURIComponent(`${BASE}/`)
    const url = `${SSO}/login?service=${service}`
    await this.browser.goto(url, { waitMs: 2500 })
    await this.browser.bringToFront()
    let shot = null
    if (shotPath) {
      const box = await this.browser.evaluate(`(() => {
        const el = document.querySelector('.wrp_code, [class*=qrcode], [class*=qr-code], #qrcode');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`)
      await mkdir(path.dirname(shotPath), { recursive: true })
      if (box && box.width > 40) {
        const { data } = await this.browser.send('Page.captureScreenshot', {
          format: 'png',
          clip: { ...box, scale: 2 },
        })
        const { writeFile } = await import('node:fs/promises')
        await writeFile(shotPath, Buffer.from(data, 'base64'))
        shot = shotPath
      } else {
        shot = await this.browser.screenshot(shotPath)
      }
    }
    if (password && password.username) {
      await this.browser.evaluate(`(() => {
        const u = document.querySelector('#username, input[name=username]');
        const p = document.querySelector('#password, input[name=password], input[type=password]');
        if (!u || !p) return false;
        const set = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        set(u, ${JSON.stringify(password.username)});
        set(p, ${JSON.stringify(password.password)});
        return true;
      })()`)
      await sleep(300)
      await this.browser.clickText('登录', { exact: false, tag: 'button,a,span' })
    }
    return {
      url: await this.browser.url(),
      title: await this.browser.title(),
      qrImage: shot,
      needsGeetest: await this.browser.evaluate(
        `!!document.querySelector('.geetest_panel, .geetest_holder, [class*=geetest]')`,
      ),
    }
  }

  /** 轮询直到登录成功或超时（滑块/验证码留给人在可见窗口里完成） */
  async waitLogin({ timeoutMs = 120_000, intervalMs = 2500 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const url = await this.browser.url()
      const onSso = /sso\.zxxk\.com/.test(url)
      if (!onSso) {
        const state = await this.loginState().catch(() => null)
        if (state?.loggedIn) return { loggedIn: true, state, url }
      }
      await sleep(intervalMs)
    }
    const state = await this.loginState().catch(() => null)
    return { loggedIn: !!state?.loggedIn, state, url: await this.browser.url() }
  }

  /**
   * 列表页 URL 组装。
   * 关键词检索走站点的 /quessearch（实测 `?word=` 在频道页是死路，返回 0 张卡）；
   * 它的筛选栏是 /quessearch/d3/?keyword=xxx 这种形式，交给 filterHref 点选即可。
   */
  buildListUrl({ subject, knowledgeId, chapterId, keyword, type, difficulty, grade, year, page, sort, bankId }) {
    const conf =
      SUBJECTS[subject] ||
      SUBJECTS[Object.keys(SUBJECTS).find((k) => k.includes(subject || '')) || '高中物理']
    const slug = conf.slug
    if (keyword) {
      // b = 题库 ID，决定检索范围（高中物理 13 / 高中数学 11）；不传 b 会按站点默认学科搜，容易搜串学科
      const q = new URLSearchParams({
        keyword,
        intent: 'question',
        b: String(bankId || BANK_FALLBACK[subject] || '0'),
        urlSource: '0',
        sourceType: '0',
      })
      return { url: `${BASE}/quessearch?${q.toString()}`, subjectKey: subject, slug, keyword: true }
    }
    const params = [
      type ? TYPE_PARAM[type] || '' : '',
      difficulty ? DIFF_PARAM[difficulty] || '' : '',
      grade ? GRADE_PARAM[grade] || '' : '',
      year ? `y${year}` : '',
      sort === 'latest' ? 'o1' : sort === 'hot' ? 'o2' : '',
      page && page > 1 ? `p${page}` : '',
    ].join('')
    let base = `${BASE}/${slug}/`
    if (knowledgeId) base += `zsd${knowledgeId}/`
    else if (chapterId) base += `zj${chapterId}/`
    const query = keyword ? `?word=${encodeURIComponent(keyword)}` : ''
    return { url: `${base}${params}${query}`, subjectKey: subject, slug }
  }

  /** 页面内提取题目卡片（列表页/试卷页通用，选择器按从宽到窄排列） */
  static cardScript() {
    return `(() => {
      const roots = [...document.querySelectorAll('.tk-quest-item, .ques-item, .sec-list > li')];
      const out = [];
      for (const el of roots) {
        const addBtn = el.querySelector('a.addques, [class*=addques]');
        const id = el.getAttribute('questionid') || (addBtn && addBtn.getAttribute('quesid')) || null;
        if (!id) continue;
        const infos = [...el.querySelectorAll('.addi-info .info-cnt, .addi-info')].map((x) => (x.innerText || '').trim()).filter(Boolean);
        const diffText = (infos.find((t) => /容易|适中|困难|\\d\\.\\d+/.test(t)) || '');
        const diffMatch = diffText.match(/(容易|适中|困难)\\s*\\(?([\\d.]+)?\\)?/);
        const stem = el.querySelector('.wrapper.quesdiv .quesdiv, .quesdiv, .ques-stem, [class*=stem]');
        const knowledge = [...el.querySelectorAll('a.knowledge-item, .knowledge-list a')].map((a) => (a.innerText || '').trim()).filter(Boolean);
        const rawStem = stem ? (stem.innerText || '').trim() : '';
        const numMatch = rawStem.match(/^\\d{1,3}\\s*[.．、]\\s*/);
        const stemText = numMatch ? rawStem.slice(numMatch[0].length) : rawStem;
        const stemHtml = stem
          ? (numMatch
              ? stem.innerHTML.replace(/^((?:\\s|<[^>]*>)*)\\d{1,3}\\s*[.．、]/, (_all, lead) => lead)
              : stem.innerHTML.slice(0, 20000))
          : '';
        out.push({
          id: String(id),
          bankId: el.getAttribute('bankid') || (addBtn && addBtn.getAttribute('bankid')) || null,
          type: (infos.find((t) => /题|选择|填空|判断|解答|实验|计算|问答题/.test(t)) || (addBtn && addBtn.getAttribute('qyname')) || '').replace(/\\s+/g, ' ').slice(0, 24),
          difficulty: diffMatch ? diffMatch[1] : (addBtn && addBtn.getAttribute('qdname')) || '',
          difficultyScore: diffMatch && diffMatch[2] ? Number(diffMatch[2]) : (addBtn && Number(addBtn.getAttribute('qdvalue'))) || null,
          knowledge,
          source: (addBtn && addBtn.getAttribute('questitle')) || '',
          stemHtml: stemHtml.slice(0, 20000),
          stemText: stemText.slice(0, 4000),
          images: stem ? [...stem.querySelectorAll('img')].map((i) => i.src).slice(0, 20) : [],
          url: '/' + (el.getAttribute('bankid') || (addBtn && addBtn.getAttribute('bankid')) || '11') + 'q' + id + '.html',
        });
      }
      const seen = new Set();
      const uniq = out.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)));
      const totalText = (document.body.innerText.match(/(?:共计|共)\\s*([\\d,]+)\\s*道/) || [])[1] || null;
      return { total: totalText ? Number(totalText.replace(/,/g, '')) : uniq.length, questions: uniq, pageTitle: document.title };
    })()`
  }

  /** 等列表卡片真的渲染出来（章节页/列表页是前端异步注入的，只看 readyState 会读空） */
  async waitCards({ timeout = 9_000 } = {}) {
    const found = await this.browser
      .waitFor(
        `(() => {
          if (document.querySelectorAll('.tk-quest-item, .ques-item').length > 0) return true;
          // 该筛选组合本身就没有题：页面会直接说"暂无"，不要白等到超时
          const t = document.body ? document.body.innerText : '';
          return /暂无试题|没有找到|未找到相关|共计\\s*0\\s*道/.test(t);
        })()`,
        { timeout, interval: 250 },
      )
      .catch(() => false)
    return !!found
  }

  /**
   * 在当前列表页上，按文字找到站点自己给出的筛选链接。
   * 站点把题型写成 qt2901/qt2908…、难度 d1/d2/d3、年级 g10…，而且**每个学科的题型码不同**，
   * 硬编码迟早会错，所以统一从页面上的筛选栏里取 href。
   * 匹配用宽松策略：题干里的"单选题-单题"也要能对上筛选栏的"单选题"。
   */
  async filterHref(label) {
    const want = String(label).trim()
    return this.browser.evaluate(`(() => {
      const raw = ${JSON.stringify(want)};
      const norm = (s) => String(s || '').replace(/\\s+/g, '').split('-')[0].split('（')[0];
      const target = norm(raw);
      const variants = new Set([target, target.replace(/题$/, ''), target + '题']);
      let fuzzy = null;
      for (const a of document.querySelectorAll('a')) {
        const t = norm((a.innerText || '').trim());
        if (!t || t.length > 12) continue;
        const href = a.getAttribute('href') || '';
        if (!/zsd|zj|^\\//.test(href)) continue;
        if (variants.has(t)) return href;
        if (!fuzzy && (t.startsWith(target) || target.startsWith(t))) fuzzy = href;
      }
      return fuzzy;
    })()`)
  }

  /**
   * 学科 → 题库 ID（/quessearch 的 b 参数）。站点用 b 决定检索范围，跟 Cookie 无关：
   * 实测 b=11 → 高中数学，b=13 → 高中物理。优先从 /zujuan-api/base 动态解析，失败用兜底表。
   */
  async resolveBankId(subject) {
    const key = SUBJECTS[subject]
      ? subject
      : Object.keys(SUBJECTS).find((k) => k.includes(subject || '')) || '高中物理'
    if (!this._bankMap) {
      this._bankMap = { ...BANK_FALLBACK }
      // 先读本地缓存的学科映射：/zujuan-api/base 有 700KB，每个进程只该拉一次
      const cacheFile = this.cacheDir ? path.join(this.cacheDir, 'bankMap.json') : ''
      if (cacheFile) {
        try {
          const cached = JSON.parse(await readFile(cacheFile, 'utf8'))
          if (cached && typeof cached === 'object') Object.assign(this._bankMap, cached)
        } catch {}
      }
      if (!cacheFile || Object.keys(this._bankMap).length <= 2) {
        try {
          const res = await this.browser.fetchText(`${BASE}/zujuan-api/base`)
          const text = typeof res === 'string' ? res : res?.text || ''
          const re = /\{"ID":(\d+),"Name":"([^"]+)","Subject":\d+,"subjectName":"[^"]*"/g
          let m
          while ((m = re.exec(text))) this._bankMap[m[2]] = m[1]
          if (cacheFile) await writeFile(cacheFile, JSON.stringify(this._bankMap, null, 1), 'utf8').catch(() => {})
        } catch {}
      }
    }
    return this._bankMap[key] || null
  }

  /**
   * 把"当前学科"切到目标学科。
   * 站点用 bankId Cookie 记住学科，跳转太快 Cookie 还没落地，后面的检索就还按旧学科走。
   * 所以这里要等标题真的变成该学科再返回。
   */
  async ensureSubject(subject) {
    const conf = SUBJECTS[subject] || SUBJECTS[Object.keys(SUBJECTS).find((k) => k.includes(subject || '')) || '高中物理']
    await this.go(`/${conf.slug}/`, { waitMs: 600 })
    // 真正的信号是 bankname Cookie 变成目标学科：标题会先好，Cookie 后写，只看标题会切不干净
    const ok = await this.browser
      .waitFor(`(document.cookie.match(/bankname=([^;]+)/) || [])[1] === ${JSON.stringify(conf.slug)}`, {
        timeout: 9000,
        interval: 200,
      })
      .catch(() => false)
    return { ok: !!ok, slug: conf.slug, name: conf.name }
  }

  /**
   * 页面内 fetch 检索：不导航、只发同源 XHR。
   * 导航会整页重载（最容易触发风控、也最慢），而站内检索本身就是个 GET，
   * 用 fetch + DOMParser 在同一标签页里解析，请求量不变但"页面级指纹"不再翻新。
   * 返回结构对齐 search()，命中验证页时返回 { captcha: true }。
   */
  async searchViaFetch(params = {}) {
    const bankId = await this.resolveBankId(params.subject || '高中物理').catch(() => null)
    const urls = []
    const pages = Math.max(1, Math.min(3, Number(params.pages) || 1))
    for (let p = 1; p <= pages; p++) {
      const q = new URLSearchParams({
        keyword: String(params.keyword || ''),
        intent: 'question',
        b: String(bankId || 0),
        urlSource: '0',
        sourceType: '0',
      })
      urls.push(`${BASE}/quessearch?${q.toString()}`)
    }
    const out = await this.browser.evaluate(`(async () => {
      const res = { captcha: false, questions: [], total: 0, statuses: [], htmlHead: '' }
      const seen = new Set()
      let first = true
      for (const u of ${JSON.stringify(urls)}) {
        let html = ''
        try {
          const r = await fetch(u, { credentials: 'include' })
          res.statuses.push(r.status)
          html = await r.text()
        } catch (e) { res.statuses.push('ERR'); continue }
        if (first) { res.htmlHead = html.slice(0, 3000); first = false }
        if (/滑动验证|访问验证/.test(html.slice(0, 4000))) { res.captcha = true; return res }
        const D = new DOMParser().parseFromString(html, 'text/html')
        const totalText = (D.body ? D.body.innerText.match(/(?:共计|共)\\s*([\\d,]+)\\s*道/) : null)
        if (totalText) res.total = Number(totalText[1].replace(/,/g, ''))
        for (const el of D.querySelectorAll('.tk-quest-item, .ques-item')) {
          const addBtn = el.querySelector('a.addques, [class*=addques]')
          const id = el.getAttribute('questionid') || (addBtn && addBtn.getAttribute('quesid')) || null
          if (!id || seen.has(id)) continue
          seen.add(id)
          const infos = [...el.querySelectorAll('.addi-info .info-cnt, .addi-info')].map((x) => (x.innerText || '').trim()).filter(Boolean)
          const diffText = infos.find((t) => /容易|适中|困难|\\d\\.\\d+/.test(t)) || ''
          const dm = diffText.match(/(容易|适中|困难)\\s*\\(?([\\d.]+)?\\)?/)
          const stem = el.querySelector('.wrapper.quesdiv .quesdiv, .quesdiv, .ques-stem, [class*=stem]')
          const raw = stem ? (stem.innerText || '').trim() : ''
          const nm = raw.match(/^\\d{1,3}\\s*[.．、]\\s*/)
          res.questions.push({
            id: String(id),
            bankId: el.getAttribute('bankid') || (addBtn && addBtn.getAttribute('bankid')) || null,
            type: (infos.find((t) => /题|选择|填空|判断|解答|实验|计算|问答题/.test(t)) || '').replace(/\\s+/g, ' ').slice(0, 24),
            difficulty: dm ? dm[1] : '',
            difficultyScore: dm && dm[2] ? Number(dm[2]) : null,
            knowledge: [...el.querySelectorAll('a.knowledge-item, .knowledge-list a')].map((a) => (a.innerText || '').trim()).filter(Boolean),
            source: (addBtn && addBtn.getAttribute('questitle')) || '',
            stemText: (nm ? raw.slice(nm[0].length) : raw).slice(0, 4000),
            stemHtml: (stem ? (nm ? stem.innerHTML.replace(/^((?:\\s|<[^>]*>)*)\\d{1,3}\\s*[.．、]/, (_a, lead) => lead) : stem.innerHTML) : '').slice(0, 20000),
            images: [],
            url: '/' + (el.getAttribute('bankid') || '11') + 'q' + id + '.html',
          })
        }
      }
      return res
    })()`)
    if (!out) return { ok: false, warning: '页面内检索没有返回数据' }
    if (out.captcha) {
      // 页面内 fetch 拿到的是验证页 HTML（DOM 上没有组件）：导航出来 → 自动过 → 重试一次
      if (this.autoCaptcha && params.useFetch !== false) {
        const passed = await this.passCaptcha({ navTo: urls[0] }).catch((e) => ({ ok: false, reason: String(e) }))
        if (passed.ok) return this.searchViaFetch({ ...params, useFetch: true })
        return { ok: false, captcha: true, url: BASE + '/quessearch', questions: [], warning: '触发滑块验证', captchaAttempt: passed.reason }
      }
      return { ok: false, captcha: true, url: BASE + '/quessearch', questions: [], warning: '触发滑块验证' }
    }
    // 站点把题目卡片改成前端注入了：fetch 到的 HTML 里一张卡都没有。
    // 这种情况**不能**当"检索到 0 题"返回（上层会以为真没题，白丢结果），
    // 要显式标记，让 search() 退回导航路径（导航后等前端渲染）。
    if (!out.questions.length) {
      const looksEmptyPage = !/tk-quest-item|ques-item/.test(String(out.htmlHead || ''))
      if (looksEmptyPage) return { ok: false, emptyFetch: true, warning: '页面内 fetch 拿不到卡片（前端注入），改走导航' }
    }
    return {
      ok: true,
      url: `${BASE}/quessearch?keyword=${encodeURIComponent(String(params.keyword || ''))}`,
      total: out.total || out.questions.length,
      questions: out.questions,
      viaFetch: true,
    }
  }

  /** 搜索/浏览题目列表：先到基础列表页，再逐个人肉点筛选（用站点自己的链接） */
  async search(params = {}) {
    // 关键词检索优先走"页面内 fetch"：不导航、不发新页面请求，触发风控的概率低得多。
    // fetch 撞到验证页再退回原来的导航路径（导航能处理 JS 挑战页）。
    if (params.keyword && this.useFetch && params.useFetch !== false) {
      const viaFetch = await this.searchViaFetch(params).catch(() => null)
      if (viaFetch?.ok) return viaFetch
      if (viaFetch?.captcha) return viaFetch // 交给上层报"撞滑块"，不再导航一次去撞第二遍
      // emptyFetch：站点卡片是前端注入的，fetch 到 0 张就退回导航路径（下面继续走）
    }
    const bankId = params.keyword ? await this.resolveBankId(params.subject || '高中物理').catch(() => null) : null
    const { url } = this.buildListUrl({ ...params, bankId, type: undefined, difficulty: undefined, grade: undefined })

    let nav = await this.go(url, { waitMs: 800 })
    if (!nav.ok) return { ok: false, captcha: true, url: nav.url, questions: [], warning: '触发阿里云滑块验证' }
    await this.waitCards()

    const filters = [params.type, params.difficulty, params.grade].filter(Boolean)
    const appliedFilters = []
    for (const label of filters) {
      const href = await this.filterHref(label).catch(() => null)
      if (!href) continue
      nav = await this.go(href.startsWith('http') ? href : BASE + href, { waitMs: 600 })
      if (!nav.ok) return { ok: false, captcha: true, url: nav.url, questions: [], warning: '触发阿里云滑块验证' }
      await this.waitCards()
      appliedFilters.push(label)
    }

    let data = await this.browser.evaluate(ZujuanSite.cardScript())

    // 翻页：params.page 指定起始页，params.pages 指定连续抓几页（攒题库时一次抓够）
    const startPage = Math.max(1, Number(params.page) || 1)
    const pageCount = Math.max(1, Math.min(20, Number(params.pages) || 1))
    const collected = [...data.questions]
    const pages = [{ page: 1, count: data.questions.length }]

    const gotoPage = async (n) => {
      const href = await this.browser
        .evaluate(`(() => {
          const want = ${JSON.stringify(String(n))};
          for (const a of document.querySelectorAll('a')) {
            if ((a.innerText || '').trim() === want) return a.getAttribute('href');
          }
          return null;
        })()`)
        .catch(() => null)
      const target = href
        ? href.startsWith('http')
          ? href
          : BASE + href
        : (await this.browser.url()).replace(/\/$/, '').replace(/p\d+$/, '') + `p${n}/`
      const r = await this.go(target, { waitMs: 600 })
      if (!r.ok) return false
      await this.waitCards()
      return true
    }

    for (let n = startPage; n < startPage + pageCount; n++) {
      if (n === 1) continue
      const ok = await gotoPage(n)
      if (!ok) break
      const d = await this.browser.evaluate(ZujuanSite.cardScript())
      collected.push(...d.questions)
      pages.push({ page: n, count: d.questions.length })
      if (!d.questions.length) break
    }

    const seen = new Set()
    const questions = collected.filter((q) => (seen.has(q.id) ? false : (seen.add(q.id), true)))

    return {
      ok: true,
      url: await this.browser.url(),
      total: data.total,
      pageTitle: data.pageTitle,
      appliedFilters,
      unappliedFilters: filters.filter((f) => !appliedFilters.includes(f)),
      scoped: Boolean(params.knowledgeId || params.chapterId || params.keyword),
      pages,
      questions,
      warning:
        questions.length === 0
          ? '页面已打开但没有解析到题目卡片，可用 zujuan_dom 查看页面结构'
          : filters.length && appliedFilters.length < filters.length
            ? `有筛选没生效：${filters.filter((f) => !appliedFilters.includes(f)).join('、')}（页面筛选栏里没找到对应项）`
            : undefined,
    }
  }

  /**
   * 教材目录：学科 → 册（zj 编号），指定册时再往下取章/节。
   * 电磁学的常用入口就是「选择性必修 第二册」+「必修 第三册」，有了这个就不用猜知识点 id。
   */
  async chapters(subject = '高中物理', book) {
    const conf = SUBJECTS[subject] || SUBJECTS['高中物理']
    await this.go(`/${conf.slug}/`, { waitMs: 1000 })
    const nav = await this.go('/zhangjie/', { waitMs: 1500 })
    if (!nav.ok) return { ok: false, captcha: true, books: [], chapters: [] }
    await this.waitCards({ timeout: 8000 })

    const books = await this.browser.evaluate(`(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\\/(\\w+)\\/zj(\\d+)\\/$/);
        if (!m) continue;
        const name = (a.innerText || '').trim();
        if (!name || name.length > 24) continue;
        out.push({ name, id: m[2], url: href });
      }
      const seen = new Set();
      return out.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
    })()`)

    if (!book) return { ok: true, subject, books, chapters: [] }

    const target = books.find((b) => b.id === String(book) || b.name.replace(/\s/g, '').includes(String(book).replace(/\s/g, '')))
    if (!target) return { ok: true, subject, books, chapters: [], warning: `没找到教材「${book}」` }
    const r = await this.go(target.url, { waitMs: 1500 })
    if (!r.ok) return { ok: false, captcha: true, books, chapters: [] }
    await this.waitCards({ timeout: 8000 })
    const chapters = await this.browser.evaluate(`(() => {
      const bookId = ${JSON.stringify(String(target.id))};
      const out = [];
      const seen = new Set();
      const push = (name, id, trusted) => {
        const n = String(name || '').trim().replace(/\s+/g, ' ');
        if (!n || n.length > 40 || !id || String(id) === bookId) return;
        // 只收"像章节"的名字：第 X 章 / 第 X 节 / 章节标题，或带 data-chapterid 的节点
        if (!trusted && !/^第[一二三四五六七八九十百\\d]+[章节]/.test(n) && !/[章节]$/.test(n)) return;
        if (seen.has(n)) return;
        seen.add(n);
        out.push({ name: n, id: String(id) });
      };
      for (const el of document.querySelectorAll('[data-chapterid], [class*=chapter]')) {
        const raw = el.getAttribute('data-chapterid') || el.getAttribute('data-id') || ''
        const m = raw.match(/\\d{4,}/)
        if (m) push(el.innerText, m[0], true)
      }
      for (const a of document.querySelectorAll('a[href*="/zj"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/zj(\\d+)/);
        if (!m || m[1] === bookId) continue;
        push(a.innerText, m[1], false);
      }
      return out.slice(0, 60);
    })()`)
    return {
      ok: true,
      subject,
      book: target,
      books,
      chapters,
      ...(chapters.length ? {} : { warning: '页面上没识别出册内章节，可直接用这本书的 zj 编号当 chapterId 检索' }),
    }
  }

  /**
   * 读取"试卷页"的结构蓝图：组卷网把整卷信息挂在 window.paperJson 上，
   * {paperTitle, totalScore, paperDiff, quesTypes:[{id,name,quesList:[{id}]}], categories}。
   * 有了它就能"参照这张卷换一套题"，而不是靠肉眼数题型。
   */
  async paperOutline(pathOrUrl) {
    const nav = await this.go(pathOrUrl.startsWith('http') ? pathOrUrl : BASE + pathOrUrl, { waitMs: 900 })
    if (!nav.ok) return { ok: false, captcha: true, warning: '触发滑块验证' }
    await this.browser.waitFor(`typeof window.paperJson !== 'undefined'`, { timeout: 9000, interval: 250 }).catch(() => false)
    const data = await this.browser.evaluate(`(() => {
      const pj = window.paperJson
      if (!pj) return null
      const sections = (pj.quesTypes || []).map((t) => ({
        id: t.id,
        name: t.name || '',
        ids: (t.quesList || []).map((q) => String(q.id || q.ID || q.quesCode || '')).filter(Boolean),
        categories: (t.quesList || []).map((q) => (Array.isArray(q.category) ? q.category : []).filter(Boolean)),
      }))
      return {
        title: pj.paperTitle || document.title,
        totalScore: pj.totalScore ?? null,
        paperDiff: pj.paperDiff ?? null,
        paperDiffList: pj.paperDiffList ?? null,
        sections,
        total: sections.reduce((s, x) => s + x.ids.length, 0),
      }
    })()`)
    if (!data) return { ok: false, warning: '这个页面没有 paperJson（可能不是试卷页）', url: await this.browser.url() }
    return { ok: true, ...data, url: await this.browser.url() }
  }

  /**
   * 单题详情。实测结构（2026-11）：
   *   section.quest-content > div.quesroot[questionid][bankid]
   *     ├ div.info-list > span.info-item      题型/难度/引用次数/题号
   *     ├ div.cnt-box > div.quest-cnt         题干 + 选项（含公式 svg、题图）
   *     ├ div.cnt-box > div.quest-exam        来源卷
   *     └ div.exam-item__info                 更新时间 / 纠错 / 收藏 / 加入试题篮
   *   section.answer-box > div.knowledges     【知识点】…
   *   section.answer-box > img[src*=getAnswerAndParse]   答案与解析（图片，带短时签名）
   *   section.rec-tests                       相似题推荐（不要采）
   */
  async question({ id, bankId = '11', withAnswer = false, assetDir }) {
    const qid = String(id)
    const url = `${BASE}/${bankId}q${qid}.html`
    const nav = await this.go(url, { waitMs: 700 })
    if (!nav.ok) return { ok: false, captcha: true, url, warning: '触发滑块验证' }
    // 详情页也是异步渲染：等题干容器出现再解析，比死等固定毫秒更稳也更快
    await this.browser.waitFor(`!!document.querySelector('.quesroot[questionid]')`, { timeout: 10_000, interval: 200 })

    const detail = await this.browser.evaluate(`(() => {
      const qid = ${JSON.stringify(qid)};
      const txt = (el) => (el && el.innerText ? el.innerText.trim() : '');
      const pick = (sels, root = document) => { for (const s of sels) { const el = root.querySelector(s); if (el) return el } return null };
      const root =
        document.querySelector('section.quest-content .quesroot[questionid="' + qid + '"]') ||
        document.querySelector('.quesroot[questionid="' + qid + '"]') ||
        document.querySelector('section.quest-content .quesroot') ||
        document.querySelector('.quesroot[questionid]');
      const box = pick(['section.answer-box', '.answer-box']);
      const info = {};
      if (root) for (const s of root.querySelectorAll('.info-list .info-item')) {
        const m = txt(s).match(/^(题型|难度|引用次数|题号)：(.+)$/);
        if (m) info[m[1]] = m[2].trim();
      }
      const cnt = root ? pick(['.quest-cnt', '.cnt-box .quest-cnt', '.cnt-box'], root) : null;
      // 部分题型（填空/判断）会把【知识点】块渲染在题干容器里，导出时会混进卷面，这里先剔掉
      let stemNode = cnt
      if (cnt) {
        stemNode = cnt.cloneNode(true)
        for (const node of stemNode.querySelectorAll(
          '.knowledges, .knowledge-title, .knowledge-item, a.knowledge-name, .knowledge-list',
        )) {
          node.remove()
        }
      }
      const rawStemHtml = stemNode ? stemNode.innerHTML : '';
      const rawStemText = stemNode ? (stemNode.innerText || '').trim() : '';
      const optionLines = rawStemText.split('\\n').map((s) => s.trim()).filter((s) => /^[A-H][．.、]/.test(s));
      // 组卷网把选项直接写进题干正文里，再单独渲染一遍会重复，所以只有在正文没有选项时才单独给
      const stemHasOptions = /(^|\\n)\\s*A[．.、]/.test(rawStemText)
      const options = stemHasOptions ? [] : optionLines.slice(0, 8).map((line) => ({ label: line[0], text: line, html: null }));
      const knowledge = box
        ? [
            ...new Set(
              [...box.querySelectorAll('a.knowledge-name, .knowledges .knowledge-item')]
                // 「解读」是个 javascript: 按钮，不是知识点；顺带把名字尾巴上的"解读"去掉
                .filter((a) => !/KnowledgeUnscramble|knowledge-explain/i.test(String(a.className || '')))
                .map((a) => txt(a).replace(/解读$/, '').trim())
                .filter(Boolean),
            ),
          ]
        : [];
      // 知识点 ID：找"同方法相似题"要用它当池子
      const knowledgeIds = box
        ? (() => {
            const seen = new Set();
            const out = [];
            for (const a of box.querySelectorAll('a.knowledge-name')) {
              if (/KnowledgeUnscramble|knowledge-explain/i.test(String(a.className || ''))) continue;
              const id =
                a.getAttribute('cid') ||
                ((a.getAttribute('href') || '').match(/zsd(\\d+)/) || [])[1] ||
                null
              const name = (a.innerText || '').trim().replace(/解读$/, '')
              if (!id || !name || seen.has(id)) continue
              seen.add(id)
              out.push({ id: String(id), name })
            }
            return out
          })()
        : [];
      const answerImgEls = box
        ? [...box.querySelectorAll('img[src*="getAnswerAndParse"], img[src*="AnswerAndParse"]')]
        : [];
      const answerImgMeta = answerImgEls.map((i) => ({ src: i.src, w: i.naturalWidth || 0, h: i.naturalHeight || 0 }));
      // 注意：图片没加载完时 naturalWidth 是 0，不能凭它在页面里判断真假图，
      // 这里全部收下来，下载后再按真实像素尺寸验伪（站点无权限时给的是 414×30 占位图）。
      const answerImgsAll = [...new Set(answerImgMeta.map((m) => m.src))];
      const rawAnswerText = txt(box)
        .split('\\n')
        .filter((line) => !/声明|著作权|【知识点】/.test(line))
        .join('\\n')
        .trim();
      const exam = root ? txt(pick(['.quest-exam', '.cnt-box .quest-exam'], root)) : '';
      const score = info['难度'] ? Number(info['难度']) : null;
      return {
        url: location.href,
        title: document.title,
        info,
        quoteCount: info['引用次数'] ? Number(info['引用次数']) : null,
        difficultyScore: Number.isFinite(score) ? score : null,
        source: exam ? exam.replace(/\\s*查看更多.*$/, '').trim() : null,
        knowledge,
        knowledgeIds,
        stemHtml: rawStemHtml,
        stemText: rawStemText,
        options,
        answerImgs: answerImgsAll,
        answerPlaceholder: false,
        answerText: rawAnswerText && rawAnswerText.length > 4 ? rawAnswerText.slice(0, 4000) : null,
        images: cnt ? [...cnt.querySelectorAll('img')].map((i) => i.src) : [],
        loggedOut: /未登录|不能查看答案/.test(document.body ? document.body.innerText : ''),
      };
    })()`)

    const scoreToName = (s) => (s == null ? null : s >= 0.75 ? '容易' : s >= 0.49 ? '适中' : '困难')
    const clean = stripLeadingNumber(detail.stemHtml, detail.stemText)
    const result = {
      ok: true,
      id: qid,
      bankId: String(bankId),
      type: detail.info?.['题型'] || null,
      difficulty: scoreToName(detail.difficultyScore),
      difficultyScore: detail.difficultyScore,
      quoteCount: detail.quoteCount,
      source: detail.source,
      knowledge: detail.knowledge,
      knowledgeIds: detail.knowledgeIds,
      stemHtml: clean.html,
      stemText: clean.text,
      options: detail.options,
      images: detail.images,
      url: detail.url,
      title: detail.title,
      answerText: detail.answerText,
      answerImageFiles: [],
      answerImgs: detail.answerImgs,
      warnings: [],
    }
    if (detail.loggedOut) result.warnings.push('未登录：答案与解析不可见，请先 zujuan_login')

    if (withAnswer && !detail.loggedOut) {
      // 实测：登录后答案图在页面加载时就已经在 DOM 里，不需要点"查看答案"
      let imgs = detail.answerImgs
      if (!imgs.length) {
        // 先问站内接口要一个 key：key 为空说明这道题对当前账号不开解析，
        // 这时不要再盲目点 6 个按钮等 10 秒（每次点击还都要 1.6s）
        const probe = await this.browser
          .evaluate(`(async () => {
            const tok = document.querySelector('input[name="__RequestVerificationToken"]');
            if (!tok) return { ok: false, reason: 'no-token' };
            try {
              const r = await fetch('/zujuan-api/check_ques_parse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', RequestVerification: tok.value },
                body: JSON.stringify({ quesId: ${Number(qid)}, bankId: ${Number(bankId)} }),
              });
              const text = await r.text();
              let key = null;
              try { key = JSON.parse(text).key || null } catch {}
              return { ok: r.ok, status: r.status, key, raw: text.slice(0, 120) };
            } catch (e) { return { ok: false, reason: String(e) } }
          })()`)
          .catch(() => null)
        result.answerProbe = probe
        if (probe && !probe.key) {
          result.answerAvailable = false
          // 页面上的"很抱歉，您每日最多可查看30道…"是站点的通用话术，实际原因是这道题没对普通账号开解析
          //（额度会返回 414×30 占位图，两者要分开）。别把限额话术印进讲义。
          result.answerText = '（站点未对本题开放解析：普通账号只开放部分题目，不是额度问题）'
          result.answerNote = 'parse-not-open'
          result.warnings.push(
            `站点没有对这道题开放解析（check_ques_parse 返回空 key${probe.raw ? `，${probe.raw}` : ''}）：换题或让 AI 拟写（zujuan_analysis）兜底。`,
          )
          return result
        }
        result.answerExpanded = await this.expandAnswer()
        imgs = await this.browser.evaluate(
          `[...new Set([...document.querySelectorAll('img[src*="getAnswerAndParse"], img[src*="AnswerAndParse"]')].map((i) => i.src))]`,
        )
      }
      if (imgs.length && assetDir) {
        await mkdir(assetDir, { recursive: true })
        for (const [i, src] of imgs.entries()) {
          const ext = /\\.png/i.test(src) ? 'png' : 'jpg'
          const file = path.join(assetDir, `${qid}-${i + 1}.${ext}`)
          try {
            const meta = await this.browser.download(src, file, { referer: url })
            const size = await imageSize(file)
            if (!size || size.width < 700) {
              // 站点无权限/额度用尽时给的是 414×30 占位图，HTTP 也是 200，只能看像素尺寸
              await unlink(file).catch(() => {})
              result.answerPlaceholder = true
              result.warnings.push(
                `站点返回"无权限/额度用尽"占位图（${size ? size.width + '×' + size.height : '无法解码'}），可用 zujuan_analysis 让 AI 拟写解析。`,
              )
              continue
            }
            result.answerImageFiles.push({ file, bytes: meta.bytes, width: size.width, height: size.height, src })
          } catch (err) {
            result.warnings.push(`答案图下载失败：${err.message}`)
          }
        }
      } else if (!imgs.length) {
        result.warnings.push('页面上没有答案解析区块，可用 zujuan_dom 复查站点结构')
      }
    }
    return result
  }

  /** 点开"查看答案/展开解析"，兼容按钮文字差异 */
  async expandAnswer() {
    const tried = []
    for (const label of ['查看答案', '答案与解析', '展开解析', '查看解析', '解析', '答案']) {
      const ok = await this.browser.clickText(label, { exact: false, tag: 'a,button,span,div' }).catch(() => false)
      tried.push({ label, ok })
      if (ok) {
        await sleep(1600)
        const has = await this.browser.evaluate(`!!document.querySelector('img[src*="getAnswerAndParse"]')`)
        if (has) return { clicked: label, tried }
      }
    }
    // 兜底：直接调站内接口（需要 __RequestVerificationToken 头）
    const api = await this.browser.evaluate(`(async () => {
      const tok = document.querySelector('input[name="__RequestVerificationToken"]');
      if (!tok) return { ok: false, reason: 'no-token' };
      const qid = (location.pathname.match(/q(\\d+)\\.html/) || [])[1];
      const bankId = (location.pathname.match(/^\\/(\\d+)q/) || [])[1] || '11';
      try {
        const r = await fetch('/zujuan-api/check_ques_parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', RequestVerification: tok.value },
          body: JSON.stringify({ quesId: Number(qid), bankId: Number(bankId) }),
        });
        const t = await r.text();
        return { ok: r.ok, status: r.status, body: t.slice(0, 400) };
      } catch (e) { return { ok: false, reason: String(e) } }
    })()`)
    return { clicked: null, tried, api }
  }

  /** 知识点树（用于把"动量守恒"映射到 zsd id） */
  async knowledgeTree(subject = '高中物理') {
    const conf = SUBJECTS[subject] || SUBJECTS['高中物理']
    await this.go(`/${conf.slug}/`, { waitMs: 1800 })
    const nav = await this.go('/zhishidian/', { waitMs: 2600 })
    if (!nav.ok) return { ok: false, captcha: true, nodes: [] }
    const nodes = await this.browser.evaluate(`(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/zsd"]')) {
        const t = (a.innerText || '').trim();
        const id = (a.getAttribute('href').match(/zsd(\\d+)/) || [])[1];
        if (t && id) out.push({ id, name: t });
      }
      const seen = new Set();
      return out.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
    })()`)
    return { ok: true, subject, nodes }
  }
}
