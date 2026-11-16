# zujuan · 组卷网选题插件（DSH）

把 [组卷网](https://zujuan.xkw.com/) 变成 DSH 的一个能力：**登录 → 按知识点/关键词/真卷仿卷选题 → 抓题干与答案解析 → 自动过阿里云滑块 → 一键导出教师版/学生版讲义**。

给家教备课用：一次装好，之后每次只要说"帮我找 10 道动量守恒的题，中等难度，导出讲义"，剩下全自动。
也可以直接说"仿 2025 年 1 月浙江首考物理卷出一份平行卷"——见 [示例](#示例浙江-2025-首考物理平行卷)。

## 安装（DSH 插件）

```bash
git clone https://github.com/3250mingxiang-maker/zujuan.git
```

在 DSH profile 的 `cordis.patch.yml` 里加一行（`name` 指向 clone 下来的目录）：

```yaml
- insert:
    - id: zujuan-tiku
      name: '@local/zujuan-tiku'
      config: {}          # 见文末「配置项」
```

放好后重启 DSH，`zujuan_status` 能调用就装好了。首次用 `zujuan_login` 扫码，之后长期免登录。

零运行时依赖：不需要 puppeteer/playwright，只要本机有 Chrome/Edge（Node ≥ 22，用内置 WebSocket 直连 CDP）。

### 示例：浙江 2025 首考物理·平行卷

真卷结构从组卷网试卷页读（`zujuan_paper_outline`），再用 20 道真题的题号做种出平行卷：

```js
// 1) 读真卷结构（1 次请求）
zujuan_paper_outline({ url: "/13p2438857.html" })
// → 单选 10 / 多选 3 / 实验 3 / 解答 4，共 20 题，附逐题考点

// 2) 抓 20 道真题的考点（先不入答案，不耗额度）
zujuan_question({ ids: ["25983884", /* … */ "25983903"], withAnswer: false })

// 3) 逐题找同考点平行题 + 复刻分值结构（20~24 次站点请求）
zujuan_paper({
  title: "浙江 2025 首考物理·平行卷",
  blueprintCount: 20,
  blueprintSeedIds: ["25983884", /* … */ "25983903"],
  blueprintScoreSequence: "3,3,3,3,3,3,3,3,3,3,4,4,4,4,4,6,8,10,12,14",
  blueprintGrade: "高三",
  allowPartial: true,
})
```

产出见 [`examples/浙江2025首考平行卷/`](examples/浙江2025首考平行卷)（教师版/学生版 Markdown + 学生版 HTML + manifest + 答案图）。
实测：**20 题 / 单选 10·多选 3·实验 3·解答 4 / 满分 100 / 估时 96 分钟 / 考点对齐 16·20**。单选 10 道带官方答案图；多选题/实验/解答对普通账号站点不开解析，教师版如实标注（不是额度问题）。有 3 处"该考点池里没有该题型"，按"题型是硬约束"从同题型补并在报告里标明。

---

## 它怎么工作

组卷网有三层防护：`alicfw` JS 挑战、`acw_sc__v2`、以及**阿里云滑块验证**（短时间内多次请求就会触发）。
纯 HTTP 抓取必然被拦，所以插件用的是**真实 Chrome + CDP 协议**：

- 一个**持久化的浏览器配置目录**（`~/.dsh/zujuan/chrome-profile`），登录态与挑战 Cookie 都在里面；
- 首次登录需要人扫一次码（或输一次账号密码），之后长期免登录；
- 撞到滑块时插件**先自己拖**（拟人轨迹 + CDP 可信鼠标事件，实测能拿到「验证通过」），拖完等 WAF 自己回跳，继续干活；
- 自动没过才把窗口给你（`zujuan_captcha({human:true})`），你拖一下；
- 其余（找题、翻页、读题、下载答案图、排版出 PDF/Word）全自动。

浏览器默认**有界面**（`headless: false`）：实测无窗口会被直接判成"阻断页面"，滑块也拖不动（页面没焦点时内核会丢弃 mousePressed）。窗口只是存在，不需要你操作。

---

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `zujuan_status` | 看 Chrome 是否在、是否已登录、账号权限、本地题库题量 |
| `zujuan_login` | 打开学科网统一登录页，二维码截图 + 轮询登录结果（也支持账号密码） |
| `zujuan_captcha` | 撞到阿里云滑块时用它：**默认先自动拖**（拟人轨迹，实测可通过）；自动没过才换一个完全没接调试器的窗口让你滚一下 |
| `zujuan_chapters` | 列教材册次（zj 编号）：电磁学 = 必修第三册 + 选择性必修第二册 |
| `zujuan_knowledge` | 抓「知识点树」，把"动量守恒""洛伦兹力"换成分精确的知识点 ID |
| `zujuan_search` | 按知识点 ID / 关键词 / 章节检索，可 `pages` 连续抓多页；返回题号、题型、难度、知识点、题干 |
| `zujuan_question` | 抓单题完整内容：题干 HTML、选项、来源、知识点（含 zsd 编号）、答案与解析 |
| `zujuan_similar` | 给一道题找「同方法/同模型」的相似题：以最具体知识点为池子、可限同难度，按共享知识点数排序，供人工/AI 二次判定 |
| `zujuan_recall` | 多路召回：一组同义/异构关键词 + 知识点池 + 章节池**并集去重**，先合并后筛选，报告每路贡献与筛掉多少 |
| `zujuan_library` | 本地题库：检索、统计、打标签、`mark`（入选/淘汰）、删除 |
| `zujuan_paper` | 组卷导出：自动按题型分节、可给分值算总分，教师版/学生版，HTML+PDF+Word+Markdown |
| `zujuan_analysis` | 额度用完时的兜底：把 AI 拟写的答案/解析写回题库，教师版照常出（标注"AI 拟写，仅供参考"） |
| `zujuan_illustrate` | 用豆包 Seedream（火山方舟图片 API）给题目生成示意配图，需 ARK API Key |
| `zujuan_dom` | 调试用：dump 任意页面结构（可传 `expr` 跑任意 JS），站点改版时用它换选择器 |

### 典型对话

```
你：先登录组卷网
    → zujuan_login（弹出 Chrome，扫二维码）
你：帮我把"动量守恒"这个知识点找出来
    → zujuan_knowledge({name:"动量守恒"}) → zsd41934
你：找 10 道高二中等难度的动量守恒题
    → zujuan_search({knowledgeId:"41934", grade:"高二", difficulty:"适中", limit:10})
你：都抓下来，带答案解析
    → zujuan_question({ids:[...], withAnswer:true})
你：出讲义，教师版学生版都要，答案放文末
    → zujuan_paper({title:"动量守恒·随堂练", answersAtEnd:true})
```

---

## 数据放在哪

```
~/.dsh/zujuan/
├── chrome-profile/          # 浏览器配置（登录态、反爬 Cookie）
├── library/physics-gz.json  # 本地题库（跨会话累积）
├── assets/                  # 答案与解析图片（带签名，必须落地保存）
├── knowledge/               # 知识点树缓存
├── papers/paper-<时间>/     # 导出的讲义：teacher/student × html/pdf/doc/md + assets/
└── logs/                    # 撞滑块时的现场截图
```

题库是纯 JSON，可以随便备份、迁移、手改。`zujuan_library` 的 `stats/search/tag` 都在它上面工作。

---

## 权限与额度（站点侧限制，插件如实透传）

**先看结论：本地组卷不花任何额度。** 站点的额度只跟"下载/查看答案"这类动作挂钩，而我们只取题目内容，自己排版。

| 动作 | 是否消耗站点额度 |
| --- | --- |
| `zujuan_search` 选题（题干、题型、难度、知识点、来源） | ❌ 不消耗，站点本身不限量 |
| `zujuan_question({withAnswer:false})` 取题干详情 | ❌ 不消耗 |
| `zujuan_question({withAnswer:true})` 取答案与解析 | ✅ 每天 **30 道**（普通账号） |
| `zujuan_paper` 本地组卷导出 PDF/Word | ❌ 不消耗，全在本地排版 |
| 站点自己的「导出 Word/下载试卷」 | ✅ 付费（扫码），本插件**不走这条路** |

`zujuan_paper` 的 `withAnswer` **默认 false**：只拿题干组卷，不碰额度。要答案才传 `true`，插件会同时报「今日已用 N/30」。

其他仍存在的站点限制（仅影响站方功能，不影响我们本地组卷）：单卷 35 题（`MaxQuesNumInPaper`）、每天建卷 5 份、免费下载 10 题。插件导出的文档不带站点水印，也不计入这些。

`zujuan_status` 会读出账号的权限位与今日用量：

- **答案**：普通用户可看答案；`CanViewQuesParse` 通常是 false，
- 但实测站点返回的答案图把「答案 + 详解」画在一起，所以教师版是有详解的；
- 每日查看答案解析上限 30 道（`MaxViewParse`），超了站点返回提示图，插件会在结果里告警。

---

## 滑块（阿里云「访问验证」）是怎么过的

站点这层是 aliyun Captcha 2.0 的 sliding 组件，**无缺口拼图，就是把橙色把手拖到最右边**。DOM 很固定：

| 元素 | 说明 |
| --- | --- |
| `#aliyunCaptcha-sliding-body` | 轨道（320×40） |
| `#aliyunCaptcha-sliding-slider` | 把手（40×40，初始贴左） |
| `#aliyunCaptcha-sliding-left` | 已拖动的填充条（宽度即进度） |
| `#aliyunCaptcha-sliding-text` | 轨道文案（成功变「验证通过」） |

服务端判别的是**行为**而不是答案（答案本来就是"拖到底"）。所以 `lib/slider.mjs` 做的是"把一次拖拽做得像人"，实测踩出来的三条硬约束：

1. **事件必须走 CDP `Input.dispatchMouseEvent`** —— JS 合成事件 `isTrusted=false`，直接判死；
2. **页面必须有焦点** —— 窗口被别的程序压住时，内核会**静默丢弃 `mousePressed`/`mouseReleased`**，只剩 `mousemove` 能到页面，症状就是"怎么拖都不动"。解法是 `Emulation.setFocusEmulationEnabled` + 必要时在页面空白处点一下；拖之前还会先"验证按下真的生效了"（看填充条是否 >0），没生效就松手重按；
3. **通过后不要再导航** —— WAF 会在 1~2 秒内把当前页**自己回跳**到目标页；这时候再 `goto` 一次会被当成新请求重新判风险，立刻又弹验证。所以插件通过后是"等它自己回去"，不是重新请求。

轨迹本身：起步慢 → 中段快 → 临近终点减速（easeInOutCubic），每帧 6~18ms、y 轴 ±1.6px 抖动、偶发微停顿、末段顶过右墙几像素再回正、停一拍才松手；拖之前还会在页面上随意晃 6~11 次（真实用户进验证页不会一秒内直奔把手）。

**实测**（`dev/slider-solve.mjs` / `dev/e2e-blocked.mjs`，2026-11-17 凌晨）：手势级 11 次拖拽 5 次拿到「验证通过」（约 45%，失败回包固定 `VerifyCode=F001`），所以策略是"失败就换新挑战再拖"——`captchaAttempts=3` 时 5 次调用里 4 次成功放行。全部失败才退回人工窗口。

想亲眼看过程：`node dev/slider-solve.mjs 2`（有界面，日志逐帧打印）。

---

## 额度跑满怎么办：AI 拟写解析

站点给的 30 道/天只影响「官方答案图」。用完之后正文照抓、卷子照出，只是没有官方解析图。这时有两条路：

1. **AI 拟写解析**（`zujuan_analysis`）：把题号 + 答案 + 解析正文写回题库，教师版里就按【答案】【解析】排版，并标注"AI 拟写，仅供参考"。
   ```
   zujuan_analysis({ id:"36459941", answer:"B（0.40 kg）", analysis:"动量守恒…" })
   zujuan_paper({ ids:[...], mode:"teacher" })
   ```
   写进去的是**纯文本 + 公式混排**，不用图片，也就不会再受额度限制。
2. **等第二天**：额度按自然日重置，`zujuan_status` 里能看当天用了几道。

插件还会识别站点的"占位图"（HTTP 200 但只有 414×30 的假图），命中时直接告诉你"额度大概率用完了，可以走 AI 拟写"。

## 配图：豆包有 API，两条路

- **本机已装的 `dsh-connect-doubao`**：生图走的是豆包客户端的 skill（同一个 `/chat/completion` 端点），在 DSH 里表现为模型别名「豆包 生图（Seedream 5.5）」，回复里直接返回图片 Markdown，**不需要额外 Key**。
- **火山方舟官方图片 API**（程序化、可批量）：`POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，Header `Authorization: Bearer $ARK_API_KEY`，body `{ model:"doubao-seedream-4-0-250828", prompt, size, response_format:"url", watermark:false }`。配好 key 后 `zujuan_illustrate` 就能一键给题目生成配图并落到 `assets/`。
  - key 放在 profile 的 `cordis.patch.yml`：`config: { arkApiKey: "..." }`，或设环境变量 `ARK_API_KEY`。
- 提醒：生图给的是**示意配图**，不是精确受力图/几何图。正式讲义优先用原题图（我们本来就存了）。

## 已知限制（都是站点结构决定的）
1. **滑块验证**：短时间内大量请求会触发。插件会先自动拟人拖拽（见上一节），通过后等 WAF 自己回跳；自动没过才把窗口给你。连续操作时它还会在请求之间插入 2~4 秒间隔、单轮站点请求限 8 次。
2. **答案与解析是图片**（不是文本）：插件会把图片下载到 `assets/`，讲义里以本地相对路径嵌入，离线打印不会丢图。
3. **未登录时**题目详情页只给题干，答案区显示"未登录不能查看答案" —— 插件会在结果里明确提示，不静默失败。
4. **站点改版**会让选择器失效：所有选择器集中在 `lib/site.mjs`（卡片/详情各一段页面内脚本），并用 `zujuan_dom` 先看结构再改。
5. **解析按题开放**：很多新题/一模题对普通账号 `check_ques_parse` 返回空 key，教师版里就没有官方解析 —— 这是站点侧的授权，不是额度问题（额度会返回 414×30 占位图，两者已经分开告警）。

---

## 组卷流程里做过的优化（实测踩坑后补的）

| 踩到的坑 | 现在的做法 |
| --- | --- |
| 刚启动第一次导航落在阿里云"算 Cookie 再跳转"的 JS 挑战页，等再久也不出题 | `go()` 识别挑战页（标题空 + `parm_0` 隐藏域）并自动重载一次 |
| 章节/列表页题目是前端异步注入，`readyState=complete` 时一张卡都读不到 | 每次导航后 `waitCards()` 轮询等 `.tk-quest-item`；页面显示"暂无"时立刻返回，不空等 |
| 题型/难度码每个学科不同（物理 qt2901、数学 qt2701…），硬编码必错 | 从页面筛选栏取站点自己的 href，宽松匹配"单选题-单题"→"单选题" |
| 筛选没生效但结果为空，不知道是被忽略了 | 返回 `appliedFilters`/`unappliedFilters`，摘要里 ⚠ 标出 |
| 一次只能抓一页，攒题库要反复调 | `zujuan_search({pages:5})` 连续翻页、合并去重 |
| 每道题盲点 6 个按钮等 10 秒才确认"没有解析" | 先问 `check_ques_parse` 要 key：空 key 立刻返回，不再空转 |
| 占位图 414×30 会当真答案存下来、印进讲义 | 落地后解 PNG/JPEG 头看真实像素，<700px 丢弃并告警 |
| 公式图没加载完时 `naturalWidth=0`，被误判成假图 | 不在页面里判断，改按文件尺寸验伪 |
| 工具结果里塞满 `stemHtml`（每题十几 KB），会话日志和网页渲染都被拖慢 | 回给模型的是 `brief()` 精简视图（题号/题型/难度/知识点/前 150 字），完整 HTML 只留在本地题库 |
| 重复抓同一批题要重跑一遍站点 | 详情抓过后打 `detailFetchedAt`，再次抓直接命中缓存（毫秒级），`refresh:true` 可强制重取 |
| 卷子平铺，没有分节、没有分值 | `groupByType` 自动分「一、单项选择题（共 3 小题，每小题 4 分）」；`scorePlan` 算满分 |
| 题目顺序随选题顺序，不成卷 | 自动按题型排序（单选→多选→综合→解答），同题型内由难到易 |
| 章节 id 只能手动 dump | 新增 `zujuan_chapters`，直接给册次 zj 编号 |
| **页面卡死会把整次调用拖到 180s 超时**（/gaokao/ 那种） | `goto()` 给每次 readyState 探测加 5 秒上限，超时返回 `timeout` 标记，不再挂死 |
| **每个进程都要重拉 700KB 的 /zujuan-api/base** | 学科→题库 ID 映射落盘 `bankMap.json`，只拉一次 |
| **一次连发 19 个考点 → 第 10 个就被滑块拦** | `blueprintSiteBudget`（默认 8）：本轮只用 8 次站点请求，其余走本地；撞滑块立刻中止 |
| **一次中止等于全部白干** | 每抓一个考点就把题打 `kp:<考点名>` 标签入库；下一轮直接命中本地，逐轮收敛 |
| **撞滑块只能整卷作废** | `allowPartial:true` 可先出"未定稿"部分卷，卷首与 manifest 标明缺哪几处 |
| **考点池不按题型抓 → 只能靠"近似"凑** | 每个考点的抓取带上题型（`type`），池子按 `考点+题型` 缓存 |
| **近似报告里混进"逻辑推理能力"这种能力标签** | 报告实际考点时过滤能力/素养标签；无知识点时写"站点未标注考点"而非空白 |
| **`aligned` 被自己打的标记喂成 True（自证对齐）** | 对齐判定只认知识点名；关键词命中的记为"未验证"，不再假报命中 |
| **难度全按"配合 0.7"选 → 估时 133/174 分钟** | 新增 `blueprintDiffSequence`，按真卷逐题难度曲线选题 |
| 关键词检索按"当前学科"走，切学科只等 Cookie 会搜串学科（拿数学词搜出物理题） | `/quessearch` 的学科其实是 **URL 里的 `b`＝题库 ID**（11=高中数学，13=高中物理），改用 `resolveBankId()` 动态解析，不再依赖 Cookie |
| 单关键词召回漏题（"马尔科夫链" vs "马尔可夫链" 是两批结果） | 新增 `zujuan_recall`：多关键词 + 知识点池 + 章节池并集，**召回阶段不筛**，合并后再筛并报告筛掉多少 |
| 插件重载后旧 Chrome 还占着 profile，新实例起不来 | `launch({reuse:true})` 先尝试接管在跑的实例；关闭时先发 `Browser.close` 再兜底强杀 |
| Chrome 一直挂着吃 ~650MB | 空闲 3 分钟自动关闭（`idleCloseMs` 可调），下次调用自动拉起 |
| **无窗口（headless）直接被判"阻断页面"** | 默认 `headless:false`；`zujuan_status` 里会标出当前模式 |
| **窗口没焦点时内核丢弃 mousePressed**，滑块的 press 到不了页面 → 怎么拖都不动 | `Emulation.setFocusEmulationEnabled` + 必要时点一下空白处；按下后先验"填充条是否 >0"，没生效就松手重按（最多 3 次） |
| **每次 `dispatchMouseEvent` 等回执要 ~70ms**，67 帧拖成 6.4 秒（慢到不像人） | 改"有序不限速派发"（WebSocket 保序），拖拽时长由排好的节奏决定，约 0.9~1.3 秒 |
| **自动过了却还是被拦** | 通过后误以为要重新导航 → 其实是 WAF 自己把页面回跳；改成等它自己回去，不再 `goto` |
| **拖失败后把手不复位**，第 2、3 次尝试对着空气拖 | 失败即重载验证页换新挑战，再试（`captchaAttempts`） |
| **被拦过的 profile 攒下风控 Cookie，越拖越难** | `zujuan_profile({action:"clean"})` 只删 `alicfw/acw_*/aliyungf_tc/_c_WBKFRo/HMACCOUNT` 这类 + 清 storage，保留登录态；实测删完立刻恢复（复访 `captcha=false`） |

### 实测耗时（`dev/bench.mjs`，预设情景：高三·电磁学·困难·12 题）

| 步骤 | 优化前 | 现在 |
| --- | --- | --- |
| 检索（选必二，困难+高三，2 页共 20 卡） | 22 s 且 0 题 | **8.7 s，17 KB 回传** |
| 抓 5 题题干（冷启动） | 约 30 s | **9.0 s**（1.8 s/题） |
| 同一批再抓 | 重跑 ~30 s | **3 ms**（缓存命中） |
| 出卷 html+md | 30 ms | 30 ms |
| 出卷含 PDF 打印 | 1.3 s | 2.6 s（含文件落盘） |

---

## 目录结构

```
zujuan/
├── index.js              # DSH 插件入口：16 个工具的定义与编排
├── cordis.patch.yml      # Loader 补丁（insert 一行）
├── lib/
│   ├── cdp.mjs           # 零依赖 Chrome 驱动：启动、导航、求值、可信鼠标事件、截图、下载、打印 PDF
│   ├── slider.mjs        # 阿里云滑块：DOM 探测 + 拟人轨迹 + 焦点闸门 + 失败换挑战重试
│   ├── site.mjs          # 站点层：登录、列表 URL 语法、卡片解析、详情解析、答案展开、撞验证自动恢复
│   ├── render.mjs        # 排版层：教师版/学生版 HTML、Word、Markdown
│   └── store.mjs         # 本地题库：JSON 持久化、去重、标签、检索
├── dev/                  # 开发期脚本（自测 / 滑块联调 / 现状体检），不参与运行
├── docs/                 # 阿里云滑块实测方案、真卷平行卷参数
├── examples/             # 已产出的平行卷（Markdown/HTML/manifest/答案图）
└── fixtures/             # 3 道样例题，用于离线自测
```

自测：`npm run smoke`（假 ctx 跑全部工具，含 PDF 生成，43 项断言）、`npm run selftest`（排版 41 项断言）。

滑块联调：
- `npm run slider` → `dev/slider-solve.mjs 2`：真站点拖两次，逐帧打印轨迹与判定；
- `node dev/e2e-blocked.mjs`：从"每个页面都被拦"的状态验证插件自恢复（过验证 → 自回跳 → 出题）；
- `node dev/slider-lab.mjs`：连点逼出验证页，抓 `VerifyCaptchaV2` 回包与页面事件统计；
- `node dev/slider-verify-probe.mjs`：抓服务端判定依据（`VerifyCode=F001` 之类）；
- `node dev/profile-clean.mjs`：单独洗风控 Cookie（等价 `zujuan_profile({action:"clean"})`）；
- `npm run state` → `dev/state-probe.mjs`：一行看当前 profile 是"正常/阻断/验证/未登录"。

实现细节与踩坑记录见 [`docs/阿里云滑块-实测方案.md`](docs/阿里云滑块-实测方案.md)。

---

## 许可

MIT。仅供个人备课/教学研究使用，抓取节奏请自行控制，别给站点添麻烦。


---

## 配置项

在 profile 的 `cordis.patch.yml` 里改 `zujuan-tiku` 那一行的 `config`（改完插件会自动重建）：

```yaml
- id: zujuan-tiku
  config:
    headless: false          # 必须是 false：无窗口会被判"阻断页面"，滑块也拖不动
    dataDir: ''              # 默认 ~/.dsh/zujuan
    paceMs: 2200             # 每次导航之间的间隔，防滑块
    subject: 高中物理         # 默认学科
    chromePath: ''           # 默认自动找 Chrome/Edge
    autoCaptcha: true        # 撞滑块自动拟人拖拽
    captchaAttempts: 3       # 自动拖最多几次（每次失败会换新挑战）
    searchViaFetch: true     # 关键词检索走页面内 fetch（不翻新页面指纹）
    idleCloseMs: 180000      # 空闲多久关 Chrome（省内存）
```
