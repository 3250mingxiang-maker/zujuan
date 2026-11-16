// 极简 CDP 浏览器驱动（零依赖，使用 Node 24 内置 WebSocket）
// 用于：打开真实 Chrome、过 JS 反爬挑战、维持登录 Cookie、执行页面内提取脚本。
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

const CANDIDATES = [
  process.env.ZUJUAN_CHROME,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export function findChrome() {
  for (const p of CANDIDATES) if (p && existsSync(p)) return p
  throw new Error('未找到 Chrome/Edge 可执行文件，请设置环境变量 ZUJUAN_CHROME')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

class Ws {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.listeners = new Set()
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ' :: ' + msg.error.data : ''}`))
        else resolve(msg.result)
        return
      }
      if (msg.method) for (const fn of this.listeners) fn(msg)
    })
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 60_000)
    })
  }
  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  close() {
    try {
      this.ws.close()
    } catch {}
  }
}

async function connect(url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败: ' + (e?.message || 'error'))), {
      once: true,
    })
  })
  return new Ws(ws)
}

const STEALTH = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {}, app: { isInstalled: false } };
const _query = navigator.permissions && navigator.permissions.query;
if (_query) navigator.permissions.query = (p) => p.name === 'notifications'
  ? Promise.resolve({ state: Notification.permission }) : _query.call(navigator.permissions, p);
`

export class Browser {
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir
    this.headless = opts.headless !== false
    this.offscreen = opts.offscreen !== false // 有界面时默认把窗口放到屏幕外，不打扰用户
    this.diag = Boolean(opts.diag)
    this.ua = opts.userAgent || DEFAULT_UA
    this.overrideUserAgent = Boolean(opts.userAgent)
    this.proc = null
    this.ws = null
    this.sessionId = null
    this.targetId = null
    this.requests = []
    this.responses = []
    this.console = []
    this.port = null
  }

  /**
   * 启动 Chrome。
   * @param {{url?: string, attach?: boolean}} options
   *   url：起始页；attach=false 时**完全不接 CDP**（窗口就是一个普通浏览器，反爬指纹最干净），
   *   之后需要操作时再调用 attach()。
   */
  async launch({ url = 'about:blank', attach = true, reuse = true } = {}) {
    if (this.ws) return this
    await mkdir(this.userDataDir, { recursive: true })
    const portFile = path.join(this.userDataDir, 'DevToolsActivePort')

    // 复用：如果这个 profile 已经有 Chrome 在跑（插件重载过、或上次没关干净），直接接上去，
    // 否则两个实例抢同一个 user-data-dir 会双双起不来。
    if (reuse) {
      try {
        const raw = await readFile(portFile, 'utf8')
        const port = Number(String(raw).split('\n')[0].trim())
        if (port > 0) {
          const v = await httpJson(`http://127.0.0.1:${port}/json/version`)
          if (v.webSocketDebuggerUrl) {
            this.port = port
            this.versionUrl = v.webSocketDebuggerUrl
            this.reused = true
            if (attach) await this.attach()
            return this
          }
        }
      } catch {}
    }

    const exe = findChrome()
    // 先删掉上次遗留的端口文件，再启动；顺序反了会把新写出来的端口文件删掉
    try {
      await rm(portFile, { force: true })
    } catch {}
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--exclude-switches=enable-automation',
      '--disable-features=TranslateUI,OptimizationHints,CalculateNativeWinOcclusion',
      '--no-proxy-server',
      '--disable-popup-blocking',
      '--lang=zh-CN',
      '--window-size=1440,900',
      // 各种"首次启动/上次没关干净"的弹窗全部压掉（我们要的是别在用户桌上弹东西）
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      '--disable-search-engine-choice-screen',
      '--no-service-autorun',
      '--password-store=basic',
      '--disable-component-update',
    ]
    // 「有界面但别在人眼前」：连上 CDP 后由 hideWindow() 把窗口挪到屏幕边缘（留一条窄边，
    // 避免被 Windows 判成遮挡而冻结渲染）。启动参数只负责关掉后台节流。
    if (!this.headless && this.offscreen) {
      args.push('--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling')
    }
    // 默认不覆盖 UA：真实 UA 与 Client Hints 一致，反爬指纹更自然
    if (this.overrideUserAgent) args.push(`--user-agent=${this.ua}`)
    if (this.headless) args.push('--headless=new', '--hide-scrollbars', '--mute-audio')
    args.push(url)
    this.proc = spawn(exe, args, { stdio: 'ignore', detached: false, windowsHide: this.headless })
    this.proc.on('error', () => {})

    let version
    const deadline = Date.now() + 40_000
    while (Date.now() < deadline) {
      try {
        if (existsSync(portFile)) {
          const raw = (await readFile(portFile, 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean)
          const port = Number(raw[0])
          if (port > 0) {
            const v = await httpJson(`http://127.0.0.1:${port}/json/version`)
            if (v.webSocketDebuggerUrl) {
              this.port = port
              version = v
              break
            }
          }
        }
      } catch {}
      await sleep(250)
    }
    if (!version?.webSocketDebuggerUrl) throw new Error('无法连接 Chrome DevTools 端点（请检查 Chrome 是否被安全软件拦截）')

    this.versionUrl = version.webSocketDebuggerUrl
    if (!attach) return this
    await this.attach()
    // --window-position 常被 profile 记住的窗口位置覆盖（实测又回到 0,0），
    // 所以连上之后显式再挪一次，确保真的在人看不见的地方
    if (!this.headless && this.offscreen) await this.hideWindow().catch(() => {})
    return this
  }

  /** 连接已经在跑的 Chrome（可复用它在人类操作后留下的登录态/挑战 Cookie） */
  async attach({ reusePage = true } = {}) {
    if (this.ws) return this
    this.ws = await connect(this.versionUrl)
    let targetId
    if (reusePage) {
      try {
        const list = await httpJson(`http://127.0.0.1:${this.port}/json/list`)
        const page = (list || []).find((t) => t.type === 'page')
        targetId = page?.id
      } catch {}
    }
    if (!targetId) ({ targetId } = await this.ws.send('Target.createTarget', { url: 'about:blank' }))
    this.targetId = targetId
    const { sessionId } = await this.ws.send('Target.attachToTarget', { targetId, flatten: true })
    this.sessionId = sessionId

    this.ws.on((msg) => {
      if (msg.sessionId !== this.sessionId) return
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request
        this.requests.push({
          url: r.url,
          method: r.method,
          type: msg.params.type,
          postData: r.postData,
        })
        if (this.requests.length > 4000) this.requests.splice(0, 1000)
      }
      if (this.diag) {
        if (msg.method === 'Network.responseReceived') {
          this.responses.push({
            url: msg.params.response.url,
            status: msg.params.response.status,
            requestId: msg.params.requestId,
            type: msg.params.type,
          })
          if (this.responses.length > 2000) this.responses.splice(0, 500)
        }
        if (msg.method === 'Runtime.consoleAPICalled') {
          const args = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
          this.console.push({ level: msg.params.type, args: String(args).slice(0, 400) })
          if (this.console.length > 500) this.console.splice(0, 200)
        }
        if (msg.method === 'Log.entryAdded') {
          this.console.push({ level: msg.params.entry.level, args: String(msg.params.entry.text).slice(0, 400) })
        }
      }
    })

    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH }).catch(() => {})
    await this.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' }).catch(() => {})
    // 强制"页面获得焦点"：窗口被别的程序压住时，内核会丢弃 mousePressed/mouseReleased，
    // 只剩 mousemove 能到页面（拖滑块就是这个症状：怎么拖都不动）。
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    // 复用已开的 Chrome 时也要确保它在屏幕外（这条路径不走 launch 末尾的挪窗）
    if (!this.headless && this.offscreen) await this.hideWindow().catch(() => {})
    // 仅在诊断模式下开这些域：Network/Runtime/Log 会被反爬指纹探测，正常跑不开
    if (this.diag) {
      await this.send('Network.enable', { maxPostDataSize: 65536 }).catch(() => {})
      await this.send('Runtime.enable').catch(() => {})
      await this.send('Log.enable').catch(() => {})
    }
    return this
  }

  send(method, params) {
    return this.ws.send(method, params, this.sessionId)
  }

  /** 不接 CDP 也能读到当前页标题/地址（走 HTTP /json/list，不产生任何 CDP 会话） */
  async pageInfo() {
    try {
      const list = await httpJson(`http://127.0.0.1:${this.port}/json/list`)
      const page = (list || []).find((t) => t.type === 'page')
      return page ? { title: page.title || '', url: page.url || '' } : null
    } catch {
      return null
    }
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      const d = res.exceptionDetails
      throw new Error(d.exception?.description || d.text || '页面脚本异常')
    }
    return res.result?.value
  }

  async goto(url, { waitMs = 1200, timeout = 45_000 } = {}) {
    this.lastGotoTimedOut = false
    await this.send('Page.navigate', { url }).catch(() => {})
    // 不依赖 Page.enable/loadEventFired（少开一个 CDP 域，指纹更干净），改为轮询 readyState。
    // 单个 evaluate 也可能挂（有的页面脚本卡死会把 CDP 求值拖住），这里给每次探测加 5 秒上限，
    // 否则整次工具调用会一直挂到 180s 超时（/gaokao/ 那类页面就是这么挂死的）。
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      let state = null
      try {
        state = await Promise.race([
          this.evaluate('document.readyState', { awaitPromise: false }),
          sleep(5000).then(() => null),
        ])
      } catch {
        state = null
      }
      if (state === 'complete' || state === 'interactive') break
      await sleep(200)
    }
    if (Date.now() >= deadline) this.lastGotoTimedOut = true
    await sleep(waitMs)
    return this
  }

  /** 重新加载当前页（拿一次全新的验证挑战） */
  async reload({ waitMs = 1500, timeout = 30_000 } = {}) {
    await this.send('Page.reload', { ignoreCache: false }).catch(() => {})
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState', { awaitPromise: false })
        if (state === 'complete') break
      } catch {}
      await sleep(200)
    }
    await sleep(waitMs)
    return this
  }

  async url() {
    return this.evaluate('location.href')
  }

  async title() {
    return this.evaluate('document.title')
  }

  async waitFor(expression, { timeout = 30_000, interval = 300 } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        const v = await this.evaluate(`(() => { try { return ${expression} } catch (e) { return false } })()`, {
          awaitPromise: false,
        })
        if (v) return v
      } catch {}
      await sleep(interval)
    }
    return false
  }

  async cookies(urls) {
    const res = await this.send('Network.getCookies', urls ? { urls } : {})
    return res.cookies || []
  }

  async setCookies(cookies) {
    for (const c of cookies) {
      await this.send('Network.setCookie', {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite,
      }).catch(() => {})
    }
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Buffer.from(data, 'base64'))
    return file
  }

  /** 按可见文字点一个元素（找最短匹配，避免点到容器） */
  async clickText(text, { exact = true, tag = 'a,button,span,div' } = {}) {
    return this.evaluate(`(() => {
      const want = ${JSON.stringify(text)};
      const cands = [...document.querySelectorAll(${JSON.stringify(tag)})]
        .filter((el) => {
          const t = (el.innerText || '').trim().replace(/\\s+/g, '');
          return ${exact ? 't === want.replace(/\\s+/g, "")' : 't.includes(want.replace(/\\s+/g, ""))'};
        })
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const el = cands[0];
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`)
  }

  /** 在页面上下文里发请求（自动带 cookie），返回文本 */
  async fetchText(url, init = {}) {
    return this.evaluate(
      `fetch(${JSON.stringify(url)}, ${JSON.stringify({ credentials: 'include', ...init })})
        .then(async (r) => ({ status: r.status, text: await r.text() }))`,
    )
  }

  /** 用浏览器的 cookie 在 Host 侧下载二进制（绕过 CORS），返回字节数 */
  async download(url, file, { referer } = {}) {
    const origin = new URL(url).origin + '/'
    const jar = await this.cookies([origin])
    const cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ')
    const res = await fetch(url, {
      headers: {
        'user-agent': this.ua,
        cookie,
        ...(referer ? { referer } : {}),
      },
    })
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url.slice(0, 120)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, buf)
    return { bytes: buf.length, status: res.status, type: res.headers.get('content-type') || '' }
  }

  /** 把本地 HTML 打印成 A4 PDF */
  async printPdf(htmlFile, pdfFile, { landscape = false, marginMm = 16 } = {}) {
    const url = 'file:///' + path.resolve(htmlFile).replace(/\\/g, '/').replace(/^\//, '')
    await this.goto(url, { waitMs: 900 })
    const inch = Number((marginMm / 25.4).toFixed(3))
    const { data } = await this.send('Page.printToPDF', {
      printBackground: true,
      paperWidth: 8.27,
      paperHeight: 11.69,
      landscape,
      marginTop: inch,
      marginBottom: inch,
      marginLeft: inch,
      marginRight: inch,
      preferCSSPageSize: true,
    })
    await mkdir(path.dirname(pdfFile), { recursive: true })
    await writeFile(pdfFile, Buffer.from(data, 'base64'))
    return pdfFile
  }

  async bringToFront() {
    try {
      await this.ws.send('Target.activateTarget', { targetId: this.targetId })
    } catch {}
  }

  /** 当前标签页所在窗口的 windowId（移到屏/移出屏都要用它） */
  async windowId() {
    if (this._windowId) return this._windowId
    try {
      const r = await this.ws.send('Browser.getWindowForTarget', { targetId: this.targetId })
      this._windowId = r.windowId
      return this._windowId
    } catch {
      return null
    }
  }

  /** 把窗口挪回屏幕内并置前（扫码登录、人工拖滑块时才需要） */
  async showWindow({ left = 120, top = 80, width = 1360, height = 900 } = {}) {
    const id = await this.windowId()
    if (!id) return false
    try {
      // 先恢复 normal，否则最大化/最小化的窗口不接受 left/top
      await this.ws.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState: 'normal' } })
      await this.ws.send('Browser.setWindowBounds', { windowId: id, bounds: { left, top, width, height } })
      await this.bringToFront()
      return true
    } catch {
      return false
    }
  }

  /** 把窗口挪出屏幕（默认状态：有界面但不打扰）
   *  注意：完全移出屏幕会被 Windows 判成"被遮挡"，Chrome 会冻结渲染进程（evaluate 不返回）。
   *  所以默认只留一条 12px 的边在屏幕边缘——人眼看不到，但渲染保持活跃。
   */
  async hideWindow({ sliver = 12 } = {}) {
    const id = await this.windowId()
    if (!id) return false
    try {
      const cur = await this.ws.send('Browser.getWindowBounds', { windowId: id }).catch(() => null)
      const w = cur?.bounds?.width || 1360
      await this.ws.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState: 'normal' } })
      await this.ws.send('Browser.setWindowBounds', { windowId: id, bounds: { left: -(w - sliver), top: 80 } })
      return true
    } catch {
      return false
    }
  }

  /** 连通性体检：CDP 卡死（渲染进程被冻结/页面假死）时能快速发现 */
  async ping({ timeoutMs = 4000 } = {}) {
    try {
      const r = await Promise.race([
        this.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }),
        sleep(timeoutMs).then(() => null),
      ])
      return r?.result?.value === 2
    } catch {
      return false
    }
  }

  /**
   * 发一次"可信"鼠标事件（走浏览器输入管线，isTrusted=true，站点 JS 无法伪造）。
   * @param {'mouseMoved'|'mousePressed'|'mouseReleased'|'mouseWheel'} type
   */
  async mouse(type, x, y, { button = 'left', buttons, clickCount = 1, modifiers = 0 } = {}) {
    const btn = buttons ?? (type === 'mousePressed' || type === 'mouseMoved' ? 1 : 0)
    return this.send('Input.dispatchMouseEvent', {
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: type === 'mouseMoved' && btn === 0 ? 'none' : button,
      buttons: btn,
      clickCount: type === 'mouseMoved' ? 0 : clickCount,
      modifiers,
      pointerType: 'mouse',
    })
  }

  /**
   * 派发鼠标事件但**不等回执**：WebSocket 本身保序，所以事件顺序不变，
   * 而节奏不再被每次 ~70ms 的 CDP 往返拖长（拖拽要像人，不能6秒钟蹭280px）。
   * @returns {Promise<void>} 只保证已写进 socket
   */
  mouseFire(type, x, y, { button = 'left', buttons, clickCount = 1, modifiers = 0 } = {}) {
    const btn = buttons ?? (type === 'mousePressed' || type === 'mouseMoved' ? 1 : 0)
    const payload = {
      id: ++this.ws.seq,
      method: 'Input.dispatchMouseEvent',
      sessionId: this.sessionId,
      params: {
        type,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        button: type === 'mouseMoved' && btn === 0 ? 'none' : button,
        buttons: btn,
        clickCount: type === 'mouseMoved' ? 0 : clickCount,
        modifiers,
        pointerType: 'mouse',
      },
    }
    try {
      this.ws.ws.send(JSON.stringify(payload))
    } catch {}
    return Promise.resolve()
  }

  async click(selectorOrExpr) {
    return this.evaluate(`(() => {
      const el = ${JSON.stringify(selectorOrExpr)}.startsWith('/') || ${JSON.stringify(selectorOrExpr)}.startsWith('(')
        ? null : document.querySelector(${JSON.stringify(selectorOrExpr)});
      if (!el) return false;
      el.click();
      return true;
    })()`)
  }

  close() {
    // 先礼貌地让 Chrome 自己退出（能正常释放 user-data-dir 的锁、把 Cookie 落盘），
    // 等它真的退出；3 秒还不退再强杀。
    // 之前 400ms 就强杀，会导致刚从滑块验证拿到的 Cookie 还没写进 Cookies 文件就丢了，
    // 下次启动又立刻被拦——这正是"拖完还是被拦"的一个原因。
    try {
      this.ws?.send('Browser.close', {}).catch(() => {})
    } catch {}
    try {
      this.ws?.close()
    } catch {}
    const proc = this.proc
    const pid = proc?.pid
    const exited = () =>
      new Promise((resolve) => {
        if (!proc) return resolve(true)
        let done = false
        const finish = () => {
          if (!done) {
            done = true
            resolve(true)
          }
        }
        proc.once?.('exit', finish)
        setTimeout(finish, 3000)
      })
    exited().then(() => {
      try {
        if (proc && proc.exitCode === null) proc.kill('SIGKILL')
      } catch {}
      try {
        if (process.platform === 'win32' && pid && proc && proc.exitCode === null) {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        }
      } catch {}
    })
    this.ws = null
    this.proc = null
  }

  alive() {
    return !!this.ws
  }
}

export async function tempProfile(name = 'default') {
  const dir = path.join(os.tmpdir(), 'zujuan-chrome', name)
  await mkdir(dir, { recursive: true })
  return dir
}
