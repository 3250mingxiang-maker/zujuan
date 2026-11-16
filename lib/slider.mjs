// 阿里云「访问验证」滑块（无缺口 · 拖到最右边）自动通过。
//
// 站点这层是 aliyun Captcha 2.0 的 sliding 组件，同文档渲染，DOM 固定：
//   #aliyunCaptcha-sliding-body      轨道（宽 320）
//   #aliyunCaptcha-sliding-slider    把手（40×40，初始贴在轨道左端）
//   #aliyunCaptcha-sliding-left      已拖过的填充条（初始宽度 0）
//   #aliyunCaptcha-sliding-text      轨道文案（成功后变"验证失败，请刷新"，失败态也用它）
//   提交判定：POST https://<id>-verify.captcha-pro-open.aliyuncs.com/ Action=VerifyCaptchaV2
//            参数里带 CaptchaVerifyParam（含轨迹点序列），服务端按"行为像不像人"给结论。
//
// 两条硬约束（实测踩出来的）：
//   1) 事件必须走 CDP Input.dispatchMouseEvent —— JS 合成事件 isTrusted=false 直接判死；
//   2) 每次 dispatch 等回执要 ~70ms，67 帧就拖成 6.4 秒，慢得离谱 → 改"有序不限速派发"，
//      WebSocket 本身保序，所以拖拽时长由我们排的节奏决定，不受 RTT 拖累。
//
// 于是真正要做的就是"把一次拖拽做得像人"：
//   悬停→停顿→摁下→起步慢→中段快→临近终点减速→顶到右墙→停一拍→松手。

const SEL = {
  track: '#aliyunCaptcha-sliding-body',
  handle: '#aliyunCaptcha-sliding-slider',
  filled: '#aliyunCaptcha-sliding-left',
  text: '#aliyunCaptcha-sliding-text',
  failTip: '#aliyunCaptcha-sliding-failTip',
  errorCode: '#aliyunCaptcha-sliding-errorCode',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
const rand = (a, b) => a + Math.random() * (b - a)
const randInt = (a, b) => Math.round(rand(a, b))

/** 拖拽节奏档案：总时长(ms)、帧数密度、纵向抖动、越界量 */
export const PROFILES = {
  // 默认：人的常规速度（280px 大约 0.8~1.2 秒，50~70 帧）
  human: { totalMs: [780, 1150], pxPerFrame: [4.0, 6.0], jitterY: 1.6, overshoot: [2, 5] },
  // 手快：0.45~0.7 秒
  brisk: { totalMs: [450, 700], pxPerFrame: [6.0, 9.0], jitterY: 1.2, overshoot: [1, 3] },
  // 犹豫：1.5~2.4 秒，中间带停顿
  hesitant: { totalMs: [1500, 2400], pxPerFrame: [3.0, 4.5], jitterY: 2.0, overshoot: [3, 7] },
}

/** 拖之前在页面上"晃一晃"：真实用户进验证页不会一秒内就去按把手 */
export async function wander(browser, { log = () => {}, moves = 8 } = {}) {
  const size = await browser.evaluate('({ w: innerWidth, h: innerHeight })').catch(() => ({ w: 1200, h: 800 }))
  let x = size.w * rand(0.3, 0.7)
  let y = size.h * rand(0.3, 0.7)
  for (let i = 0; i < moves; i++) {
    x = Math.max(40, Math.min(size.w - 40, x + rand(-160, 160)))
    y = Math.max(40, Math.min(size.h - 40, y + rand(-110, 110)))
    await browser.mouse('mouseMoved', x, y, { buttons: 0, button: 'none' }).catch(() => {})
    await sleep(randInt(40, 160))
    if (Math.random() < 0.16) await sleep(randInt(120, 420))
  }
  log(`预热：在页面上移动 ${moves} 次（真实用户进验证页也有鼠标活动）`)
}

/** 页面里有没有滑块（主文档）；顺带报告 iframe 线索，便于站点改版时定位 */
export async function detectSlider(browser) {
  try {
    return await browser.evaluate(`(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      };
      const q = (s) => document.querySelector(s);
      const track = q(${JSON.stringify(SEL.track)});
      const handle = q(${JSON.stringify(SEL.handle)});
      const filled = q(${JSON.stringify(SEL.filled)});
      const tip = q(${JSON.stringify(SEL.failTip)});
      const txt = q(${JSON.stringify(SEL.text)});
      const iframes = [...document.querySelectorAll('iframe')]
        .map((f) => f.src)
        .filter((s) => /aliyunCaptcha|captcha/i.test(s));
      const bodyText = document.body ? document.body.innerText.replace(/\\s+/g, ' ').slice(0, 220) : '';
      return {
        present: Boolean(track && handle && handle.getBoundingClientRect().width > 0),
        title: document.title,
        bodyText,
        track: box(track),
        handle: box(handle),
        filledW: filled ? filled.getBoundingClientRect().width : null,
        text: txt ? (txt.innerText || '').trim() : '',
        failTip: tip ? (tip.innerText || '').trim() : '',
        iframes,
      };
    })()`)
  } catch (e) {
    return { present: false, error: String(e) }
  }
}

/** 页面整体是否还是验证页（标题/正文特征），用于"拖完到底放没放行" */
export async function isCaptchaPage(browser) {
  try {
    return await browser.evaluate(
      `(() => {
        const t = document.title || '';
        const x = document.body ? document.body.innerText.slice(0, 300) : '';
        return /滑动验证|访问验证/.test(t + x);
      })()`,
    )
  } catch {
    return false
  }
}

/**
 * 生成一条人味轨迹（只算位置与相对时间，不含绝对时刻）。
 * @returns {{x:number,y:number,t:number}[]} t 为累计毫秒
 */
export function humanTrack(from, to, profile = PROFILES.human) {
  const dist = Math.hypot(to.x - from.x, to.y - from.y)
  const px = rand(profile.pxPerFrame[0], profile.pxPerFrame[1])
  const n = Math.max(14, Math.min(120, Math.round(dist / px)))
  const total = rand(profile.totalMs[0], profile.totalMs[1])

  // 权重：起步慢、中段快、收尾减速（人手的加减速），外加偶发微停顿
  const weights = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    let w = t < 0.12 ? 2.0 : t < 0.3 ? 1.15 : t < 0.72 ? 0.72 : t < 0.9 ? 1.1 : 1.75
    if (i > 0 && i < n && Math.random() < 0.07) w += rand(1.2, 2.6) // 一次微停顿
    weights.push(w)
  }
  const wsum = weights.reduce((a, b) => a + b, 0)
  const overshoot = rand(profile.overshoot[0], profile.overshoot[1])

  const pts = []
  let acc = 0
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 // easeInOutCubic
    let x = from.x + (to.x - from.x) * e
    let y = from.y + (to.y - from.y) * e
    if (i === 0) x += -randInt(0, 2) // 摁住瞬间的轻微回撤
    if (i >= n - 1) x += overshoot // 快到位时顶过一点，被右墙拦住
    if (i > 0 && i < n) {
      x += rand(-1.2, 1.2)
      y += rand(-profile.jitterY, profile.jitterY)
    }
    acc += (weights[i] / wsum) * total
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, t: Math.round(acc) })
  }
  return pts
}

/** 等到把手重新出现（失败后组件会先隐藏再弹回左端） */
async function waitHandleBack(browser, { timeout = 4000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const s = await detectSlider(browser)
    if (s.present) return s
    await sleep(200)
  }
  return null
}

/**
 * 焦点闸门：文档没有焦点时，内核会把 mousePressed/mouseReleased 直接丢弃
 * （只剩 mousemove 能到页面），这时候怎么拖滑块都纹丝不动。
 * 除了 CDP 的 setFocusEmulationEnabled，再补一次"真点到页面上"的动作。
 * @returns {Promise<boolean>} 是否已拿到焦点
 */
export async function ensureFocus(browser, { log = () => {}, timeout = 2500 } = {}) {
  const has = () => browser.evaluate('document.hasFocus()').catch(() => false)
  if (await has()) return true

  await browser.bringToFront().catch(() => {})
  await sleep(randInt(120, 260))
  if (await has()) {
    log('焦点：bringToFront 后已获得')
    return true
  }

  // 在页面空白处点一下（避开滑块与正文链接：用视口右下角这类位置）
  const size = await browser
    .evaluate('({ w: innerWidth, h: innerHeight })')
    .catch(() => ({ w: 1200, h: 800 }))
  const pt = { x: Math.round(size.w * 0.86), y: Math.round(size.h * 0.9) }
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await browser.mouse('mouseMoved', pt.x, pt.y, { buttons: 0, button: 'none' }).catch(() => {})
    await sleep(randInt(30, 70))
    await browser.mouse('mousePressed', pt.x, pt.y, { buttons: 1, button: 'left', clickCount: 1 }).catch(() => {})
    await sleep(randInt(40, 90))
    await browser.mouse('mouseReleased', pt.x, pt.y, { buttons: 0, button: 'left', clickCount: 1 }).catch(() => {})
    await sleep(randInt(150, 300))
    if (await has()) {
      log(`焦点：空白处点击后获得（${pt.x},${pt.y}）`)
      return true
    }
  }
  log('焦点：没能拿到（窗口可能被其它程序压住）')
  return false
}

/** 读填充条宽度：>0 表示"滑块真的被拖起来了"（按下事件落地了） */
async function filledWidth(browser) {
  return browser.evaluate(`(() => { const f = document.querySelector(${JSON.stringify(SEL.filled)}); return f ? Math.round(f.getBoundingClientRect().width) : -1; })()`).catch(() => -1)
}

/** 滑块是否已经给出"通过"信号 */
export function isPassedText(text) {
  return /验证通过|已通过|通过验证|success/i.test(String(text || ''))
}

/**
 * 自动拖一次（不等回执的有序派发，节奏由轨迹决定）。
 * @param {{log?:(s:string)=>void, profile?:keyof typeof PROFILES|object}} opts
 */
export async function dragOnce(browser, { log = () => {}, profile = 'human', warm = true } = {}) {
  const prof = typeof profile === 'string' ? PROFILES[profile] || PROFILES.human : profile

  // 先确认文档有焦点，否则 press/release 会被内核静默丢弃（只剩 move 到页面）
  const focused = await ensureFocus(browser, { log })
  if (!focused) log('⚠ 焦点未拿到，仍尝试拖拽（大概率失败）')

  if (warm) await wander(browser, { log, moves: randInt(6, 11) }).catch(() => {})

  const info = await detectSlider(browser)
  if (!info.present) return { ok: false, reason: info.error || '页面上没有滑块', log: [] }

  const { track, handle } = info
  const targetX = track.x + track.w - handle.w + 1 // 把手左沿要压到轨道右端
  const from = { x: handle.cx, y: handle.cy }
  const to = { x: targetX + handle.w / 2, y: handle.cy }
  const trace = humanTrack(from, to, prof)
  log(`滑块：轨道 ${Math.round(track.w)}×${Math.round(track.h)} @${Math.round(track.x)},${Math.round(track.y)}｜把手 ${Math.round(handle.w)}｜位移 ${Math.round(to.x - from.x)}px/${trace.length} 帧/${trace[trace.length - 1].t}ms`)

  const fired = []
  const fire = (type, x, y, extra) => {
    fired.push(type)
    return browser.mouseFire(type, x, y, extra)
  }

  // 1) 鼠标晃到把手（分两段，末段轻移），然后停顿
  const approach = async () => {
    const app1 = { x: from.x - rand(45, 95), y: from.y + rand(-28, 28) }
    fire('mouseMoved', app1.x, app1.y, { buttons: 0, button: 'none' })
    await sleep(randInt(45, 95))
    fire('mouseMoved', from.x - rand(5, 15), from.y + rand(-3, 3), { buttons: 0, button: 'none' })
    await sleep(randInt(40, 80))
    fire('mouseMoved', from.x, from.y, { buttons: 0, button: 'none' })
    await sleep(randInt(90, 230))
  }

  // 2) 摁下 + 试推 8px，验证"真的拖起来了"；没起来就重按（最多 3 次）
  let engaged = false
  for (let tryPress = 1; tryPress <= 3 && !engaged; tryPress++) {
    await approach()
    fire('mousePressed', from.x, from.y, { buttons: 1, button: 'left', clickCount: 1 })
    await sleep(randInt(35, 80))
    fire('mouseMoved', from.x + 5, from.y + rand(-1, 1), { buttons: 1, button: 'left' })
    await sleep(randInt(30, 60))
    fire('mouseMoved', from.x + 9, from.y, { buttons: 1, button: 'left' })
    await sleep(randInt(60, 120))
    engaged = (await filledWidth(browser)) > 0
    if (!engaged) {
      log(`  按下没生效（第 ${tryPress} 次）：填充条仍为 0，松手重来`)
      fire('mouseReleased', from.x + 9, from.y, { buttons: 0, button: 'left', clickCount: 1 })
      await sleep(randInt(200, 420))
      await ensureFocus(browser, { log })
    }
  }
  if (!engaged) {
    return { ok: false, reason: '按下事件没能落到滑块上（页面/窗口焦点问题）', log }
  }

  const t0 = Date.now()
  // 3) 按轨迹派发（相对时刻对齐，不因 RTT 拉长）
  for (const p of trace) {
    const wait = p.t - (Date.now() - t0)
    if (wait > 0) await sleep(wait)
    fire('mouseMoved', p.x, p.y, { buttons: 1, button: 'left' })
  }

  // 4) 顶到右墙、停一拍再松手
  await sleep(randInt(70, 150))
  fire('mouseMoved', to.x + rand(2, 5), to.y + rand(-1, 1), { buttons: 1, button: 'left' })
  await sleep(randInt(45, 110))
  fire('mouseReleased', to.x + rand(2, 5), to.y, { buttons: 0, button: 'left', clickCount: 1 })
  log(`派发完成：${fired.length} 个事件，实际 ${Date.now() - t0}ms`)

  // 5) 判定：出现"验证通过" / 滑块消失 / 文案变成失败 / 页面整体放行
  const deadline = Date.now() + 9000
  let last = null
  let sawFail = false
  while (Date.now() < deadline) {
    await sleep(260)
    const now = await detectSlider(browser)
    last = now
    const txt = `${now.text || ''}${now.failTip || ''}`
    if (isPassedText(txt)) return { ok: true, reason: '站点提示「验证通过」', log, ms: Date.now() - t0 }
    if (/失败|重试|刷新|超出/.test(txt)) {
      sawFail = true
      break
    }
    if (!now.present) return { ok: true, reason: '滑块已消失（验证通过）', log, ms: Date.now() - t0 }
    const filled = Number(now.filledW)
    if (Number.isFinite(filled) && filled >= now.track.w - now.handle.w + 2 && Date.now() - t0 > 2500) {
      log(`填充条已满 ${Math.round(filled)}px，等服务端结论`)
    }
  }
  const stillCaptcha = await isCaptchaPage(browser)
  if (!stillCaptcha) return { ok: true, reason: '验证页已跳走（放行）', log, ms: Date.now() - t0 }
  if (sawFail) {
    const back = await waitHandleBack(browser)
    return {
      ok: false,
      reason: `站点判失败：${JSON.stringify((last?.text || '') + (last?.failTip || ''))}${back ? '（把手已复位，可重试）' : '（把手未复位）'}`,
      log,
      ms: Date.now() - t0,
    }
  }
  return { ok: false, reason: `9s 内无结论（text=${JSON.stringify(last?.text || '')}）`, log, ms: Date.now() - t0 }
}

/**
 * 尝试通过滑块；失败自动重试（每次都是新手速档案，避免轨迹重复）。
 * @param {{browser:any, attempts?:number, log?:(s:string)=>void, profiles?:string[], onAttempt?:(i:number,r:any)=>void}} opts
 */
export async function solveSlider({ browser, attempts = 3, log = () => {}, profiles, onAttempt, captchaUrl = '' } = {}) {
  const lines = []
  const say = (s) => {
    lines.push(s)
    log(s)
  }
  const keys = profiles && profiles.length ? profiles : ['human', 'brisk', 'human']
  for (let i = 1; i <= attempts; i++) {
    const prof = keys[(i - 1) % keys.length]

    // 上一轮失败后把手不复位（组件锁死），必须换一张新挑战：重载验证页
    if (i > 1) {
      let s = await detectSlider(browser)
      if (!s.present) {
        say('上一轮失败后把手已复位失败 → 重载验证页换新挑战')
        if (captchaUrl) await browser.goto(captchaUrl, { waitMs: 900 }).catch(() => {})
        else await browser.reload({ waitMs: 1200 }).catch(() => {})
        const deadline = Date.now() + 6000
        while (Date.now() < deadline) {
          await sleep(250)
          s = await detectSlider(browser)
          if (s.present) break
        }
      }
      if (!s.present) {
        say('  ✗ 换不到新的滑块，停止重试')
        break
      }
    }

    say(`— 第 ${i}/${attempts} 次（节奏 ${prof}）`)
    const r = await dragOnce(browser, { log: say, profile: prof })
    onAttempt?.(i, r)
    if (r.ok) return { ok: true, attempts: i, reason: r.reason, log: lines }
    say(`  ✗ ${r.reason}`)
    if (i < attempts) await sleep(randInt(700, 1500))
  }
  return { ok: false, attempts, reason: '多次尝试仍未通过', log: lines }
}
