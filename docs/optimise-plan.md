# 前端设计优化执行计划（依据 `docs/optimise-report.md`）

> **唯一依据**：`docs/optimise-report.md`（7 大领域 / 32 项问题 / 15 段执行计划 / 180 个 checkbox）。
> **本计划的纪律**：**严格照报告的建议出计划**，不另行论证建议本身的对错；只做两件事——
> ① 把报告的建议翻译成**本仓库可执行的工作包**（含验收证据与并行编排）；
> ② 报告与仓库既有约定**直接冲突**的地方，作为**待裁决决策点**列出（附我的推荐），由用户点头或否决。
> **改动性质**：纯渲染层（token / 组件 / 样式 / 探针 / 守卫 / 文档）。**不动契约、不动 IPC 通道、不动后端**，因此不需要 `export_openapi` / `gen:api`。
> **完成判据（每一批都适用）**：`npm run typecheck` + `npm test` + `npm run check:contrast -- --strict` + 真机探针（`ux` / `ux:pages` / `ux:layout` / `ux:student`）+ `npm run guards:mutation`（受影响的条目逐条变红）+ 文档同步（版式契约 / AGENTS / decisions / pitfalls）。

---

## 0. 工作包总览（15 个，与报告 15 段执行计划一一对应）

| 包 | 来源 | 标题 | 报告优先级 | 批次 | 建议执行者 |
| --- | --- | --- | --- | --- | --- |
| WP-00 | 本计划新增 | 基线冻结（把"现状"变成本仓库的实测数字） | — | A 前置 | 主代理 |
| WP-01 | §1.1 | 字体系统重构（9 档 + 语义命名 + 删 17px） | P0 | A | 子代理 1 |
| WP-02 | §1.2 | 间距系统标准化（8 点网格 + 语义间距重构） | P0 | A | 子代理 2 |
| WP-03 | §1.3 | 圆角系统优化（4/6/8/12/16 + 嵌套公式） | P1 | B | 子代理 1 |
| WP-04 | §1.4 | 颜色系统增强（交互态 + 对比度守卫扩展） | P1 | B | 子代理 2 |
| WP-05 | §2.1 | 视觉层次重构（顶栏 18 / 身份行 32 / 权重梯度） | P0 | A | 子代理 1 |
| WP-06 | §2.2 | 响应式断点优化（1024 / 2xl / 高度断点） | P1 | B | 子代理 3 |
| WP-07 | §2.3 | 卡片系统统一（标准头身尾 + 练习卡单题 + 进度卡外置） | P1 | B | 子代理 3 |
| WP-08 | §3.1 | 键盘可达性系统审计（列表/SVG/卡片/跳转链接/focus 统一） | P0 | A | 子代理 3 |
| WP-09 | §3.2 | 交互状态完善（五态/六态 + 骨架屏 + 进度条） | P1 | B | 子代理 2 |
| WP-10 | §3.3 | 减动效增强（CSS+JS 双通道 + 设置页三档开关） | P2 | C | 子代理 1 |
| WP-11 | §4.1 | Element Plus 集成优化（主题变量 + 特殊组件适配） | P1 | B | 子代理 1 |
| WP-12 | §4.2 | 组件 API 标准化（严格类型 + 命名统一） | P2 | C | 子代理 2 |
| WP-13 | §5.1 | Monaco 编辑器优化（chunk 5.1MB→<3MB + 异步骨架） | P1（路线图列在阶段三） | C | 子代理 3 |
| WP-14 | §5.2 | 依赖图与长列表性能（视口裁剪 + LOD + 虚拟化） | P2 | C | 子代理 3 |
| WP-15 | §5.3 | 探针维护性改进（结构化锚点 + 自检 + 隔离 + CI） | P2 | C | 子代理 1 |

### 0.1 批次 A 进度（2026-09-27，主代理单线程执行）

| WP | 状态 | 证据 |
| --- | --- | --- |
| WP-00 基线冻结 | ✅ 完成 | `docs/optimise-baseline.md`（957 单测 / 234 对比度 / 68 变异 / Monaco 4.87MB / 图谱 57 节点 / 532 个 data-testid） |
| WP-01 字体系统 | ✅ 完成 | `base.css` 九档 + 旧名别名；`var(--k12-fs-旧名)` 全量迁移 **529 处 / 47 文件**；`tests/design-tokens.test.ts` 5 条断言；变异 **70–74** |
| WP-02 间距网格 | ✅ 完成 | `sp-1..8 = 4/8/12/16/24/32/40/48` + 四档语义间距（gap 16 / block 24 / section 40 / msg 32）；9 处裸 20px 间距迁移；`tests/spacing-grid.test.ts` 3 条；变异 **75–76** |
| WP-05 视觉层次 | ✅ 完成 | 顶栏 `body-lg 18 + fg-2 + border-strong`；身份行 `h1 32`；卡头 `h3 20`；空态 `hero 40`；标题档逐处落位（Quiz / Demo / ContextRail / MarkdownProse / EmptyState / system×2 / MapTab / ModelPicker / cards×4） |
| WP-08 键盘可达性 | ✅ 完成（除真机脚本） | 新增「跳到主内容」+ `#k12-content[tabindex="-1"]`；全站 `*:focus-visible` 基线；**抓到并修掉一个真缺口**：追问浮窗 / 机制浮窗原先只有 Esc、没有焦点契约 → `useFocusReturn` 新增 `trap:false`（非模态不锁 Tab）并给两个浮窗接上；`tests/keyboard-a11y.test.ts` 5 条 |
| 批次 A 门禁 | ✅ 全绿 | `npm run typecheck`；`npm test` **970 条全绿**；`node scripts/verify-guard-mutations.mjs 70 71 72 73 74 75 76` 七条逐条变红 |
| 批次 A 剩余 | ⬜ 1 项 | `scripts/ux-keyboard.mjs`（真机键盘走通脚本）；`ux:*` 真机探针需应用带调试端口启动后再跑 |
| 批次 A 收尾（2026-09-27） | ✅ 完成 | 补 `scripts/ux-keyboard.mjs`：CDP 真机探针，判据三条 —— Tab 24 次焦点**不掉回 body** · 第一站必须是「跳到主内容」 · 按 Esc 后焦点仍在文档内；退出码 0/1/2。守卫 `tests/keyboard-a11y.test.ts` 增第 6 条（探针存在且三条判据齐全）。真机执行需 `K12_DEBUG_PORT` 启动应用 |

### 0.2 批次 B 进度（2026-09-27，P1）

| WP | 状态 | 证据 |
| --- | --- | --- |
| WP-03 圆角系统 | ✅ 完成 | 五档 `r-xs 4 / r-sm 6 / r-md 8 / r-lg 12 / r-xl 16` + 语义映射（inset=md、card=lg、control=**md 8**、float=**xl 16**、flat=xs 别名）；`.k12-float` 走 r-float；全仓最后 1 处裸 `border-radius: 5px` 迁到 r-sm；`tests/radius-tokens.test.ts` 3 条；变异 **77** |
| WP-11 EP 对齐 | ✅ 完成 | EP 圆角 base 8 / small 6 / large 12；字号 base 16 / small 14 / large 18 / extra-large 20；**抓到真缺口**：`--el-color-info` 从未映射（EP 默认灰 `#909399` 会漏到 tag/alert）→ 补齐 info + danger 的 light-3/5/7/8/9 与 dark-2；表格单元格内边距 / 表单字段间距 / 描述列表行高对齐 k12 间距与行高；`tests/ep-theme.test.ts` 4 条；变异 **78** |
| WP-06 响应式断点 | ✅ 完成 | 断点 token 6 档（0/640/1024/1280/1440/1920）+ 高度 3 档（640/768/900）；`#app` 最小宽 1120→**1024**；窄屏收拢档从 <1280 改为 **<1024**（7 个文件统一迁移，1024–1279 保留完整侧栏）；聊天气泡网格 **4 / 3 / 2** 三档；`ux-layout-audit` 视口表 1120→**1024 并新增 1920**（四视口）；`tests/breakpoints.test.ts` 4 条；变异 **79/80**；同步修掉 `session-tree.test.ts` 里写死 1279 的旧断言 |
| 批次 B 门禁 | ✅ 全绿 | `npm run typecheck`；`npm test` **981 条全绿**；`node scripts/verify-guard-mutations.mjs 77 78 79 80` 四条逐条变红 |
| 批次 B 剩余 | ⬜ 4 项 | **WP-04** 颜色交互态 + 对比度守卫扩展 · **WP-07** 卡片系统统一（含对话内练习卡单题化 + 进度卡外置）· **WP-09** 交互五态 + 骨架屏 · **WP-13** Monaco 精简（<3MB） |

### 0.3 批次 B 续（WP-04 交互态，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 交互态 token（报告 §1.4） | ✅ 完成 | `base.css` 新增 `--k12-accent-hover/active/disabled`、`--k12-good-hover/soft-hover/border-hover`、`--k12-warn-hover`、`--k12-bad-hover`，全部由 `color-mix` 从两支强调色派生（学段一换自动跟随，不手写 18 套色值） |
| CTA 五态（报告 §3.2） | ✅ 完成 | `.k12-cta` 补齐 hover（走 `--k12-accent-hover`）· **active（新增，压深 24% + 收阴影）** · focus-visible（原有）· disabled（按报告配方：`--k12-accent-disabled` 底 + `muted` 文字 + `opacity: .6`） |
| 守卫口径改写（计划 §3 D5） | ✅ 完成 | `student-view-discipline.test.ts` 里"禁用态不许用 opacity"的旧断言改为「底色必须是 `--k12-accent-disabled` 且文字必须是 `--k12-muted`」；窗口 1400→2400（新增注释后原窗口切不到 `:disabled`） |
| 门禁 | ✅ 全绿 | `npm test` **981 条全绿** |
| WP-04 收尾（报告 §4.3） | ✅ 完成 | 新增 `tests/interaction-states.test.ts` 3 条：在 sRGB 里把 `color-mix` 算出来再算对比度 → **18 套学段配色**的 hover/active 文字仍 ≥4.5:1、禁用态 muted 文字 ≥3.0:1；并把派生比例**从 CSS 解析**（不写死在测试里）后断言 default→hover、hover→active 色差 ≥10%；变异 **81**（hover 改成 100% 同色 → 守卫变红） |
| 门禁 | ✅ 全绿 | `npm test` **984 条全绿** |
| 批次 B 剩余 | ⬜ 3 项 | **WP-09** 交互五态落地（输入框六态/卡片 hover 抬升/骨架屏/进度条）· **WP-07** 卡片系统统一（对话内练习卡单题化 + 进度卡外置）· **WP-13** Monaco 精简（<3MB） |

### 0.4 批次 B 续（WP-09 第一批，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 骨架屏组件（报告 §3.2 的 Loading 四形态） | ✅ 完成 | 新增 `components/Skeleton.vue`：`rows` / `variant(text|row|card)` 两个 prop；只用 k12 token；`aria-hidden`（读屏由外层状态文案负责）；闪烁包在 `prefers-reduced-motion: no-preference` 里；接进**会话列表**加载分支（保留 `data-testid="session-loading"`，探针判据不变） |
| 守卫 | ✅ 完成 | `tests/skeleton.test.ts` 2 条（组件规范 + 「至少一处列表真的用它」防死代码） |
| 门禁 | ✅ 全绿 | `npm run typecheck`；`npm test` **986 条全绿** |
| WP-09 第二批（报告 §3.2 的状态与动效） | ✅ 完成 | 按钮 **loading 态**（`[data-loading]`：文字转透明 + 14px 转圈 + `pointer-events:none` + 独立 `k12-spin`；减动效下停转改静态）· 输入框补 **filled（`:has(input:not(:placeholder-shown))`）** 与 **error（`aria-invalid` / `.el-form-item.is-error`）** 两态 · **卡片 hover 抬升**（`shadow-float` + `translateY(-1px)`，减动效下只换阴影不位移）· 守卫扩到 4 条 |
| 门禁 | ✅ 全绿 | `npm test` **987 条全绿** |
| WP-09 剩余 | ⬜ | 重建索引 / 导入改用**进度条**（报告 §3.2 第三种 Loading 形态）· 学习记录「活动明细」列表接入骨架屏 |

### 0.5 批次 C 起步（WP-10 减动效 CSS 半边，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 全站减动效兜底（报告 §3.3 第一条） | ✅ 完成 | `base.css` 新增 `@media (prefers-reduced-motion: reduce)` 全局兜底：`animation-duration/iteration-count/transition-duration` 全压到 0.01ms、`scroll-behavior: auto !important`；与既有的组件级"替换表达"规则（loading 静态亮点、卡片只换阴影）并存；JS 半边由 `useReducedMotion()` 负责（滚动与定时器） |
| 守卫 | ✅ 完成 | `tests/interaction-states.test.ts` 扩到 5 条（新增减动效兜底 + composable 读同一媒体查询） |
| 门禁 | ✅ 全绿 | `npm test` **988 条全绿** |
| WP-10 剩余 | ⬜ | **设置页三档开关**（自动 / 开启 / 关闭 + localStorage 持久化 + 实时生效，报告 §3.3 第二条）· 真机探针加减动效模式检查（§3.3 第三条） |

### 0.6 文档半边（报告 §3.1 的「Tab 顺序未文档化」，2026-09-27）

`docs/ui/版式契约.md` 新增三节：**8.1 页面级 Tab 顺序**（跳转链接 → 侧栏 → 顶栏 → PageActions → 内容 → 浮层，
含"为什么第一站是跳转链接"与 `#k12-content[tabindex=-1]` 的理由）、**8.2 非模态浮层的焦点契约**
（模态锁 Tab / 非模态 `{ trap: false }` 的判据表）、**8.3 focus-visible 基线**（低特异度基线 + 组件覆盖）。
至此报告 §3.1 的三条（补可达、统一焦点环、自动化）与"Tab 顺序规范"四格都有落点。

### 0.7 变异补齐（2026-09-27）

新增 **82**（骨架屏：把会话列表的加载分支退回一句纯文字 → `tests/skeleton.test.ts` 变红 ✅）。
**至此 70–82 共 13 条新变异全部"改回坏写法即变红"**，对应本轮新增的 9 个守卫测试文件；
仓库变异条目总数 68 → **82**，全量跑法：`npm run guards:mutation`。

### 0.8 WP-15 第一件实事：探针锚点自检（报告 §5.3「自动锚点验证」，2026-09-27）

新增 `tests/probe-anchors.test.ts`：扫描 7 个探针脚本里的**静态 `data-testid`**，要求它们
必须真的存在于渲染层源码；同时维护一张**否定锚点表**（探针故意找"不该存在"的东西）。
一上线就抓到 4 处真问题：

| 发现 | 处置 |
| --- | --- |
| `ux-audit.mjs` 找 `degraded-notice`，组件真实锚点是 `error-notice` | 探针改用真实锚点（并把旧名从代码里清掉） |
| `ConfirmDialog` 的确认/取消按钮**没有任何锚点** | 补 `confirm-yes` / `confirm-no` |
| `AppTopbar` 的模型 chip 只有类名、无锚点（探针只能靠 `composer-model` 兜底） | 补 `topbar-model` |
| `grade-notice` / `grade-notice-detail` / `grade-selector` / `grade-option` | 确认为**否定锚点**（D-083 之后本就该消失），写进表里并断言"它必须不存在" |

门禁：`npm test` **989 条全绿**。

### 0.9 WP-07 第一步：标准卡片三段结构（报告 §2.3 执行计划 7.1，2026-09-27）

> **下一步交接备忘（按顺序做，每步都要配守卫/变异）**
> 1. **四张卡迁移三段结构**：`cards/QuizCard.vue` / `AnimationCard.vue` / `CodingCard.vue` / `ProgressCard.vue` 的卡头改用 `components/card/CardHeader.vue`（`title` / `meta` / `actions` 三槽），卡身与卡脚按需改用 `CardBody` / `CardFoot`；迁移时**保留既有 `data-testid`**（`quiz-card` / `quiz-count` / `quiz-submit` / `animation-card` 等），否则 `verify-ui` 与 `ux:*` 探针会连带失效。
> 2. **对话内练习卡改单题**：`QuizCard.vue` 加 `cursorQid` + `finished`（与 `views/Quiz.vue` 同构），题体复用现有 `items` 渲染但只渲一行；卡头「第 N / M 题」+ 步骤条；卡脚「上一题 / 下一题 / 提交」；`下一题` 判据仍是**后端 `correct === true`**。
> 3. **进度卡外置**：`ProgressCard` 从 `QuizCard` 的模板里移出，改由 `ChatMessage.vue` 的卡片组按 `kind === 'progress'`（或载荷里的 `levels`）独立渲染，紧跟题卡之后。
> 4. **守卫与探针**：新增 `tests/card-single-question.test.ts`（练习卡默认只渲一行 + 进度卡不嵌题卡）与 `tests/card-structure.test.ts` 的迁移断言；`ux-pages-audit` / `verify-ui` 加「题卡渲染题数 = 1」断言；变异条目从 **84** 起追加。

| 项 | 状态 | 证据 |
| --- | --- | --- |
| `CardHeader` / `CardBody` / `CardFoot` 三个子组件 | ✅ 完成 | 新目录 `components/card/`：卡头三槽（`title` / `meta` / `actions`，对象级操作进卡头）、卡身与卡脚各一个默认槽；**类名直通 `base.css` 的 `.k12-card-head/-body/-foot`**，子组件不重写背景与边框（皮肤唯一来源） |
| 守卫 | ✅ 完成 | `tests/card-structure.test.ts` 2 条：① 三段类名在 base.css 确有定义 + 子组件不许自写背景/边框；② 槽位分工（卡头三具名槽 + actions 靠右、卡身/卡脚各一个默认槽、卡脚用途写进文件） |
| 门禁 | ✅ 全绿 | `npm test` **992 条全绿**；变异 **83**（卡头改用自造类名 `my-card-head` → 卡片结构守卫变红 ✅） |
| WP-07 剩余 | ✅ 完成（见 §0.10） | ① 四张卡迁移到三段结构；② 对话内练习卡改单题；③ 进度卡移出题卡、消息层独立渲染；④ 守卫 + 探针 + 变异 84–87 |

---

### 0.10 WP-07 收尾：三段结构 + 对话内单题 + 进度卡外置（报告 §2.3 执行计划 7.1–7.3，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 四张卡迁移三段结构 | ✅ | `QuizCard` / `AnimationCard` / `CodingCard` / `ProgressCard` 全部改走 `components/card/CardHeader|CardBody|CardFoot`，根元素给 `k12-card`（皮肤唯一来源 = base.css）；既有 `data-testid` 一个没丢（`quiz-card` / `animation-card` / `coding-card` / `progress-card` …） |
| 对话内练习卡改**单题** | ✅ | 卡头 = 「第 N / M 题」+ 可点题号步骤条；卡身 = 当前这一题（`visibleRows`，与 `views/Quiz.vue` 同构）；卡脚 = 上一题 / 提交 / 下一题；`下一题` 判据仍是**后端 `correct === true`**；最后一题答对 → 收尾说明（答对 N/M + 回去接着做） |
| 进度卡外置 | ✅ | `QuizCard` 不再 import `ProgressCard`；改由 `ChatMessage.vue` 按载荷 `levels` 在卡片组内独立渲染（紧跟题卡） |
| 守卫 | ✅ | 新增 `tests/card-single-question.test.ts`（5 条）；`tests/card-structure.test.ts` 加第 3 条迁移断言（逐卡钉死根类名 + 锚点不丢 —— 宽泛正则会被同文件其它分支喂饱，变异 87 实测过） |
| 探针 | ✅ | `verify-ui.mjs` F 节改为：题卡渲染题数 = 1、点第 2 颗步骤翻到填空题仍只渲 1 道、卡脚提交键只有 1 个；`ux-pages-audit.mjs` 新增「对话页 · 练习卡」两格（单题渲染 / 进度卡不嵌题卡，没有练习卡时如实 SKIP） |
| 门禁 | ✅ | `npm test` 998 条全绿；变异 **84–87** 逐条变红 |

### 0.11 WP-13 Monaco 精简（报告 §5.1，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 只加载 Python 语言 | ✅ | `loadMonaco()` 只 import `monaco-editor/languages/definitions/python/register`；不再拉 `basic-languages/monaco.contribution`（那一个文件会注册 ~90 种语言）。产物里的语言 chunk 从 90 个降到只剩 `python` |
| 主题精简 | ✅ | 按计划 §3 D9 的收口口径：固定 `vs-dark`（`DEFAULT_EDITOR_THEME`），`vs` 只留注释里的未来路径；新增 `--k12-editor-bg`（与 Monaco vs-dark 背景同值），卡片与编程页的编辑器外框同底 |
| minimap / 多光标 | ✅（等价落地） | minimap 关；monaco 0.56 的 standalone 入口没有编译期移除开关 → 用 `multiCursorLimit: 1` + `columnSelection: false` 等价关掉（代码里写明理由） |
| 失败重试 ≤3 | ✅ | `loadMonaco()` 内部循环重试（`MONACO_MAX_LOAD_ATTEMPTS = 3` + 退避），三次都失败会**清掉缓存的 Promise**（学生再点一次能重试） |
| 异步组件 + 骨架 | ✅ | 新增 `components/CodeEditor.vue`（异步组件本体，`defineExpose` 给最小句柄）+ `components/CodeEditorSkeleton.vue`；卡片与编程页都走 `defineAsyncComponent({ loader, loadingComponent, delay, timeout, onError 重试 })` |
| chunk < 3MB | ✅ | **根因**：electron-vite 渲染进程默认 `minify: false` → 打开 `minify: 'esbuild'`。实测 `editor.api` **5,103.77 kB → 2,646.80 kB（2.52 MB）**；顺带主包 1,806.60 → 784.18 kB、workers 266 kB |
| 守卫 / 变异 | ✅ | `tests/monaco-bundle.test.ts`（6 条，含产物层 <3MB 的实测断言）；变异 **88–90** |

### 0.12 WP-10 减动效收尾（报告 §3.3 的第二、三件，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 设置页三档开关 | ✅ | `stores/reducedMotion.ts`（自动 / 开启 / 关闭，`localStorage` 键 `k12.reducedMotion`，写模式 = 写 `<html>` 属性 + 落盘）；设置页「外观主题 → 减少动效」三档（报告原文案），点一下立刻生效 |
| CSS 双向钩子 | ✅ | 媒体块加 `:root:not([data-k12-reduced-motion='off'])`（**「关闭」能覆盖系统偏好**，否则第三档是假选项）+ `[data-k12-reduced-motion='on']` 属性块（系统没开也能强制减）；8 个组件级替代表达同步 |
| JS 半边 | ✅ | `useReducedMotion()` 改为返回**有效值**（模式 × 系统）；新增统一滚动 helper `scrollIntoViewRespectingMotion()`（全站唯一 `scrollIntoView` 实现，Quiz 两处已迁） |
| 动画沙箱 | ✅ | `server/resources/templates/_shared/runtime.js` 读**自己的** `prefers-reduced-motion`：时长 / 停顿 / stagger 全零 + `anime.defaults.duration = 0`（瞬间到终态）；`InlineCard` 的 key 带减动效状态 → 切档立刻重建 iframe |
| 真机探针 | ✅ | 新增 `scripts/ux-probe-reduced-motion.mjs`（`npm run ux:motion`，用 CDP 模拟系统偏好 + 2s 探针动画量时长）：**真机 9/9 全过**（含「关闭覆盖系统偏好」「点一下当场生效」） |
| 守卫 / 变异 / 文档 | ✅ | `tests/reduced-motion-mode.test.ts`（8 条）；变异 **91–93**；`docs/ui/减动效指南.md` + `docs/ui/版式契约.md` §6.1 |

### 0.13 WP-12 组件 API 标准化（报告 §4.2，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 词表单一出处 | ✅ | 新增 `types/component-props.ts`：`ComponentProps` + `ControlVariant/ControlSize/SurfaceTone/EmptyStateTone/SkeletonVariant/SurfacePadding/SurfaceRadius` + `BadgeLevel`（再导出） |
| `SurfacePanel` | ✅ | `padding` 从任意字符串收成 `'none' \| 'sm' \| 'md' \| 'lg'`（映射表在组件内，3 处调用点迁移）；`radius` 已是严格枚举，保留**语义名**（inset / card / control）并在验收单里说明与报告字面枚举的差异理由 |
| `Badge.level` | ✅ | 严格枚举 + `components/badge-level.ts` 纯函数解析（中文档位 → 英文枚举；认不出回第一档）。⚠️ 纯逻辑单独成文件是因为 `<script setup>` 不允许 ES 模块导出，且 node 直跑 `.ts` 要求显式扩展名（零 import 模块最省事） |
| `EmptyState` | ✅ | `EMPTY_STATE_TITLE_MAX / DESC_MAX` + 开发期 `console.warn`（**只警告不截断**，文案比排版重要） |
| 守卫 / 变异 | ✅ | `tests/component-api.test.ts`（8 条：类型化 / 无 any / 布尔正向命名 / 轴命名 / 三处收口 / 纯函数）；变异 **94–96** |
| 未做（诚实） | ⬜ | 报告提到的「自研 Button 组件」在本仓不存在（按钮是 `.k12-cta` / `.btn` 类，全站 200+ 处）——没有为了一个迁移清单新建组件；`ControlVariant/ControlSize` 以类型形式就位，供将来真做组件时用 |

### 0.14 WP-14 图谱与长列表性能（报告 §5.2，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 视口裁剪（±100px） | ✅ | `study/map/culling.ts`（零 import 纯函数）；`GraphMap.vue` 按视口只渲染可见节点 / 边（顺序不变，坐标不改） |
| LOD | ✅ | `study/map/lod.ts`：`zoom < 0.5` 点 / `< 1.0` 图标 / 其余完整（报告阈值照抄）；只在 Canvas 模式生效（SVG 是 1:1，13px 标签不许被密度掉档吞掉） |
| >100 节点切 Canvas | ✅ | 新增 `study/map/GraphCanvas.vue`：canvas 只画（aria-hidden），**透明真按钮命中层**承担点击 / Tab / 读屏（只给视口内的节点）；`MapTab.vue` 按节点数切渲染器 + 「适应宽度 / 1:1」 |
| 长列表虚拟化 | ✅ | 新增依赖 `vue-virtual-scroller@3.0.5`（**devDependencies**）；新增 `components/VirtualList.vue`（`DynamicScroller`，>60 条才启用，两条路径共用同一 slot）；接入学习记录会话列表 + 对话页侧栏会话树 |
| 性能埋点 / 探针 / 基线 | ✅ | `perf.ts`（FCP/LCP/FID → `window.__k12Perf`）+ `scripts/ux-probe-perf.mjs`（`npm run ux:perf`）。**真机实测**：FCP 240ms / LCP 300ms / DCL 177ms / load 279ms（门槛 2500 / 4000ms），FID 本轮无真实输入 → 如实 SKIP |
| 守卫 / 变异 | ✅ | `tests/map-performance.test.ts`（7 条，含 **500 节点合成场景**：走 Canvas + 裁剪后可见数 << 总数 + 裁剪耗时 <100ms）；变异 **97–100** |

### 0.15 WP-15 探针维护性（报告 §5.3 + §6.4 的 axe 类规则，2026-09-27）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 结构化锚点接口 | ✅ | `scripts/probe-lib.mjs` 的 `ANCHORS`（id / selector / attribute / expected / description）+ 页面侧自检脚本：**缺锚点 = 「部分失败」提示，行为不符 = 判红** |
| 组件 `data-probe-*` | ✅ | 按 D12 范围只给「量行为」的：练习卡题数（`data-probe-count`）、进度卡、引用开合（`data-probe-expanded`）、会话折叠 |
| 探针隔离 | ✅ | `CLEANUP_SCRIPT(keys)` 按 key 删（**不 `clear()`**）+ 移除注入元素；`ux-probe-reduced-motion.mjs` 先记旧值、收尾写回 |
| 失败截图 | ✅ | `captureFailureScreenshot()` → `desktop/.probe-artifacts/`（已 gitignore）；`ux-pages-audit` / `ux:motion` 已接 |
| axe 类规则 | ✅ | `A11Y_SCRIPT` 三条：`no-focusable-hidden` / `interactive-name` / `text-contrast`（≥4.5:1）；`ux-pages-audit` 收尾跑一遍并判红 —— **真机实测零违规** |
| CI | ✅（等价） | `probe-anchors` + `probe-structure` 两条守卫在 `npm test` 里，而 `npm test` 是 `ci.yml` 的门禁步骤 —— 不需要改 `ci.yml` |
| 维护指南 | ✅ | `docs/agents/probe-guide.md`（两类锚点分工 + 改组件 checklist + 隔离 / 截图 / axe / CI 口径） |
| 守卫 / 变异 | ✅ | `tests/probe-structure.test.ts`（7 条）；变异 **101–103** |

### 0.16 收尾真机验证（2026-09-27，K12_DEBUG_PORT=9224）

| 探针 | 结果 |
| --- | --- |
| `ux:reload` | ✅ |
| `ux:motion` | ✅ **9/9**（三档语义 + 实时生效） |
| `ux:perf` | ✅ FCP 240 / LCP 300 / DCL 177 / load 279 ms |
| `ux:pages` | ✅ **27/27**（六页走查 + 锚点自检 + axe 类规则零违规；对话页练习卡两格因当时无练习卡 SKIP） |
| `ux:layout` | ✅ **28/28**（4 视口 × 7 页）—— 首跑抓到并修掉一个真缺陷：1024 下输入条「语音输入」按钮被 flex 压成 **15×28**（`.cp__att` 补 `flex: none`） |
| `ux:student` | ✅ **24/24**（学生视角技术词 + 教师视角反向对照） |
| `npm test` | ✅ **1034/1034**（含 check:api / check:tool-schema / check:docs） |
| 变异 | 本轮新增 **84–103 共 20 条**逐条变红（分 6 批跑） |

> ⚠️ 两个**探针环境**问题（不是产品缺陷，已记 P-149）：① `ux:layout` 用过
> `Emulation.setDeviceMetricsOverride` 之后，CDP 的 `Input.dispatchKeyEvent` 不再送达渲染进程
> （页面内 `dispatchEvent` 与发送按钮都正常）—— 键盘类审计要放在视口仿真之前，或重启应用再跑；
> ② `K12_DEBUG_PORT` 绑不上时先查僵尸监听（见 P-152）。

---

## 1. 批次与并行编排（并发上限 = 4：主代理 + 3 子代理）

### 1.0 角色分配（对应优化报告 §6.2 的人力资源表）

> **2026-09-27 执行方式变更（用户裁决）**：子代理的任务载荷在本环境**投递不通**（spawn 与 followup 三次实测，
> 子代理均回报"没有 NEW_TASK 载荷"），因此**改为主代理一人分饰全部五个角色**、按批次顺序推进；
> 下面这张表仍按报告 §6.2 保留角色分工，只是承担者都是主代理（逐 WP 换帽子）。

| 角色（报告 §6.2） | 承担者 | 职责范围 | 对应 WP |
| --- | --- | --- | --- |
| **项目经理** | 主代理 | 排期与批次验收单、决策点收口、守卫/探针/文档总集成、真机验收 | 全批次 |
| **UI 设计师** | 主代理 | 设计 token（字号/间距/圆角/颜色/断点）与层次决策、`docs/ui/版式契约.md` 维护 | WP-01/02/03/04/06/09 |
| **前端开发 A** | 主代理 | 排版与网格、响应式断点、卡片系统统一 | WP-01/02/05/06/07 |
| **前端开发 B** | 主代理 | 交互状态、键盘可达性、Element Plus 集成、Monaco、图谱性能 | WP-08/09/11/13/14 |
| **QA 工程师** | 主代理 | 守卫与变异验证、真机探针、基线数字维护、探针维护性 | WP-00/12/15 |

> 规则：每个 WP 开工前先声明"这一轮戴哪顶帽子"，完工的批次验收单里写清"角色 + WP 编号 + 证据"。
> 若后续子代理通道恢复，可把 WP 按上表拆回并行；拆分的文件所有权约定见 §1 各波的括号说明。

### 批次 A —— P0 + 快速收益（报告"里程碑 1"）

| 波次 | 子代理 1 | 子代理 2 | 子代理 3 | 主代理 |
| --- | --- | --- | --- | --- |
| A-1 | WP-01 字体系统（token 层） | WP-02 间距系统（token 层） | WP-08 键盘可达性（组件层） | WP-00 基线冻结 + 守卫/探针骨架 |
| A-2 | WP-05 视觉层次（顶栏/身份行/空态） | WP-02 迁移点清理 + 守卫 | WP-08 续（探针 + 守卫） | 集成、版本对齐、变异验证、文档 |

**为什么 A-1 的 WP-01 与 A-2 的 WP-05 合成一个代理**：两者都在动字号阶梯与顶栏/身份行，拆成两个人必然互相覆盖（同一批 CSS 变量 + 同一批组件）。

### 批次 B —— P1 体验提升（报告"里程碑 2"）

| 波次 | 子代理 1 | 子代理 2 | 子代理 3 | 主代理 |
| --- | --- | --- | --- | --- |
| B-1 | WP-03 圆角 + WP-11 EP 对齐（同属"形状与组件皮肤"） | WP-04 颜色态 + WP-09 交互态（同属"状态系统"） | WP-06 响应式断点 | 集成 + 三视口探针回归 |
| B-2 | WP-13 Monaco 优化 | WP-07 卡片统一（含对话内练习卡单题化） | WP-07 的探针/守卫侧（渲染题数、进度卡外置） | 集成 + 判分链路回归（不改后端，只验交互） |

### 批次 C —— P2 长期改进（报告"里程碑 3"）

| 波次 | 子代理 1 | 子代理 2 | 子代理 3 | 主代理 |
| --- | --- | --- | --- | --- |
| C-1 | WP-10 减动效 | WP-12 组件 API | WP-14 图谱与列表性能 | 集成 + 性能基线 |
| C-2 | WP-15 探针维护性 | WP-15 续（CI 步骤） | WP-14 续（实测触发项） | 全量回归 + 便携版出包抽查 |

**跨波次的硬依赖（不可并行）**：
- WP-01（字号）必须先于 WP-05（层次）完成 token 改名，否则两批替换会互相打架。
- WP-03（圆角）与 WP-11（EP 对齐）必须同一个代理串行完成（同一批 `--el-*` 变量）。
- WP-04（颜色态）必须先于 WP-09（交互态落地）。
- WP-07（练习卡单题化）必须等 WP-09 的按钮状态与 WP-12 的类型约束就位后再冻结 API。

---

## 2. 各工作包：改动面 + 验收证据

> 记法：**改动面**列出要碰的层（token / 组件 / 守卫 / 探针 / 文档）；**验收**列出必须给出的证据。

### WP-00 基线冻结（先做，产出给所有子代理共用）
- **改动面**：不改代码。跑一遍并记录：`doc-facts`（行数/通道/方法/契约数）、`check-contrast`（当前 234 项）、`npm test`（当前 957 条）、`ux:pages` / `ux:layout` / `ux:student`（七页现状）、受影响文件的 token 引用清单（`fs-title` / `fs-xl` / `fs-micro` / `sp-7` / `20px` / `36px` / `14px` 圆角的出现位置与计数）。
- **验收**：一份基线清单（落 `docs/optimise-baseline.md`），供每个 WP 在开工前对照、完工后 diff。

### WP-01 字体系统重构（§1.1 + §2.1 的字号部分）
- **改动面**：token 层（新增 `hero 40 / h1 32 / h2 24 / h3 20 / body-lg 18 / body 16 / body-sm 14 / caption 13 / label 12`，删除 `fs-title(17)` 与重复的 `fs-xl(24)`）；`AppTopbar`（17→18）；`PageIdentity`（24→32）；卡片/区块标题（→20/24）；对话空态问候（32→40）；全局替换 `fs-title→body-lg`、`fs-micro→label`；字号关系守卫（顶栏 < 身份行、正文 > meta、label 仅 ≤4 字角标）改为新档位；真机探针基准（正文 ≥16、层次关系）同步。
- **验收**：页面硬编码字号仍为 0；三条字号关系守卫绿；`ux:layout` 三视口无裁切/错位；变异验证新锚点（把身份行改回 24 → 守卫变红）。

### WP-02 间距系统标准化（§1.2）
- **改动面**：`sp-7: 40px`（原 32）、新增 `sp-8: 48px`；`gap-block 20→24`、`gap-msg 36→32`；新增 `gap-section 40`；所有 20px / 36px / 32px(sp-7) 用法的迁移清单（逐处确认语义后再替换）；新增两条守卫（间距必须是 4 的倍数；语义间距只能用 token）。
- **验收**：全仓无裸 `20px` / `36px` 间距（守卫）；`ux:pages` 无横向滚动、无布局错位；对话轮间距实测 32px、块间距 24px（探针采样）。

### WP-03 圆角系统优化（§1.3）
- **改动面**：新增 `r-xs 4 / r-sm 6 / r-md 8 / r-lg 12 / r-xl 16`；语义映射 `r-card=12 / r-inset=8 / r-control=8 / r-float=16`；嵌套圆角公式 `内 = max(0, 外 − padding)` 落到卡片内嵌块；chip/tag 从 pill 改 6px（若为矩形 chip）；新增守卫（圆角只能用 token；嵌套必须计算）。
- **验收**：全仓无裸 `border-radius: Npx`（豁免 pill 与 `50%`）；视觉回归截图（卡片/按钮/输入/chip/浮层五类）；对比度不受影响（234 项仍全过）。

### WP-04 颜色系统增强（§1.4）
- **改动面**：为 6 学段 × 3 饱和度生成 hover/active/disabled 三态派生色（`accent-*` / `accent-ink-*`）；功能色补 `hover`（good/warn/bad + soft/border）；`check-contrast` 扩展到"所有交互态"并新增"交互态色差 ≥10%"守卫；把对比度检查纳入 `npm test`。
- **验收**：对比度项数从 234 增到覆盖交互态后的新总数且全过；色差守卫绿；三态在真机上逐档抽查（6 学段 × 3 饱和度各抽 1 页）。

### WP-05 视觉层次重构（§2.1）
- **改动面**：顶栏（18px + `fg-2` + 底边 1px `border-strong` + chip 尺寸适配）；身份行 32px；区块标题 24px（上 40 / 下 24 间距）；卡片标题 20px；空态 hero 40px 与垂直间距；把"权重梯度 32→24→20→16→14→13"写进 `docs/ui/版式契约.md` 与页面注释。
- **验收**：`ux:layout` 三视口（WP-06 后是四视口）层次关系正确；`PageIdentity` 仍是全页唯一最大字号；对话页仍无身份行且空态为 hero。

### WP-06 响应式断点优化（§2.2）
- **改动面**：新增 `bp-md 1024 / bp-2xl 1920` 与高度断点 `h-md 768 / h-lg 900`；`#app min-width` 1120→1024；1024–1119 紧凑布局（不横向滚动）；聊天卡片网格 4→3 列（1024–1279）；设置页/动画/编程页在 1024 的布局细化；真机探针新增 1024 视口（三→四视口）。
- **验收**：`ux:layout` 在 1024/1280/1440/1920 四档全绿；Electron 窗口最小宽度配置同步（若报告要求）；1024 下无横向滚动。

### WP-07 卡片系统统一（§2.3）
- **改动面**：定义标准卡片结构 header/body/footer，`SurfacePanel` 支持三个具名槽位（并新增 `CardHeader/CardBody/CardFooter` 子组件）；**对话内练习卡改为单题渲染**（卡头"第 N/M 题" + 步骤条、卡脚上一题/下一题/提交，全铺开不在对话内提供）；**进度卡从练习卡内移出**，改到消息层独立渲染；新增两条守卫（练习卡默认单题；进度卡不嵌题卡）；探针加"渲染题数"断言。
- **验收**：对话内练习卡单题 + 可翻题 + 判分结果按 qid 落回对应题；进度卡独立成卡且不再把卡片拉长；守卫 + 探针绿；闯关页单卡行为不受影响。

### WP-08 键盘可达性系统审计（§3.1）
- **改动面**：会话列表项（`tabindex` + 方向键导航 + `role`）；知识图谱 SVG 节点（`tabindex` + `aria-label` + 键盘选中）；可展开卡片（Space/Enter）；新增"跳到主内容"sr-only 链接（Tab 第一个）；模态补 Shift+Tab 反向循环；统一 `focus-visible`（全局 token + 覆盖所有交互元素 + 移除浏览器默认 outline）；新增守卫（所有可点元素必须键盘可达）+ 键盘端到端脚本。
- **验收**：纯键盘完成一次"进页 → 选会话 → 打开 → 关闭 → 提交"全流程；键盘可达性守卫绿；`ux:student` 无新增技术词。

### WP-09 交互状态完善（§3.2）
- **改动面**：按钮五态（default/hover/active/focus/disabled/loading）；输入框六态（default/hover/focus/filled/error/disabled）；卡片 hover 态；列表项 selected/hover；Loading 四种形态分工（转圈 / 骨架屏 / 进度条 / 流式）并新增 `Skeleton` 组件，应用到学习记录与会话列表；重建索引/导入改用进度条。
- **验收**：五态/六态在真机逐类截图核对；骨架屏替换的三处加载态无布局跳动；对比度守卫覆盖新状态色。

### WP-10 减动效增强（§3.3）
- **改动面**：CSS 全局兜底（`animation/transition-duration: 0.01ms` + `scroll-behavior: auto`，保留加载指示的静态替代）；JS 层收尾（所有 `scrollIntoView` 走统一 helper；沙箱 anime.js 在减动效下 `duration=0`；倒计时直接显示结果）；设置页"外观主题"节新增"减少动效：自动 / 开启 / 关闭"（localStorage 持久化、实时生效）；探针新增减动效模式检查。
- **验收**：开启后全站无移动/循环动画（探针实测），信息不丢；偏好重启保留；守卫覆盖"减动效下滚动必须 auto"。

### WP-11 Element Plus 集成优化（§4.1）
- **改动面**：按报告对齐 EP 的圆角（base 8 / small 6 / large 12）、字号（16/14/18）、间距（16/8/24）、颜色（primary→accent、success→good、warning→warn、danger→bad、info→cyan）、边框与文字色映射、全局 28px 触控下限；特殊组件适配（`el-segmented` 独立圆角、`el-table` 边框与间距、`el-form` 标签间距、`el-descriptions` 行高）；新增守卫（EP 圆角/颜色必须来自 k12 token）。
- **验收**：EP 组件抽查（button/input/table/form/descriptions/segmented/collapse/tag/progress/timeline）视觉与 k12 系统一致；守卫绿；`ux:pages` 七页全过。

### WP-12 组件 API 标准化（§4.2）
- **改动面**：统一 `variant / tone / size` 命名；布尔属性正向命名（`flush` / `disabled` / `loading`）；为 24 个共享组件加严格类型（`SurfacePanel.radius`、`padding` 改枚举；`Badge.level` 改枚举；EmptyState 文案长度校验）；移除宽松 `string`/`any`；新增守卫（props 必须有 TS 约束；布尔不得 `is-`/`no-` 前缀）。
- **验收**：`typecheck` 零错误；调用点全部迁移（无兼容分支残留）；守卫绿。

### WP-13 Monaco 编辑器优化（§5.1）
- **改动面**：只加载 Python 语言与必要 feature（移除 diff / multi-cursor / minimap）；主题精简（按决策点）；`defineAsyncComponent` + `CodeEditorSkeleton` + 失败重试（≤3 次）；Web Worker 单独 chunk；记录 chunk 体积与首开耗时。
- **验收**：chunk < 3MB（或给出实测下限与解释）；首次打开编程环境 <2s、二次 <500ms；`check:bundle` 通过；编辑/运行/提示链路回归。

### WP-14 依赖图与长列表性能（§5.2）
- **改动面**：知识图谱视口裁剪（只渲染可见节点 ±100px）、LOD（zoom<0.5 点 / <1.0 图标 / 其余完整）、按节点数切换 Canvas 渲染（>100）；长列表虚拟化（历史会话 / 学习记录活动）；性能埋点（FCP/LCP/FID）与基准线；探针加性能指标。
- **验收**：500 节点场景 FPS>30；1000 条列表滚动流畅；基准线入库（`docs/optimise-baseline.md` 追加）。

### WP-15 探针维护性改进（§5.3）
- **改动面**：结构化锚点接口（id/selector/attribute/expected/description）；组件加 `data-probe-*`（按决策点的范围）；探针运行前自动锚点自检（失配显式报"部分失败"）；探针隔离（清理 DOM / 重置 store / 清 localStorage）；失败自动截图；CI 增加探针验证步骤；《探针维护指南》+ 改组件 checklist。
- **验收**：锚点自检能抓出人为去掉一个 `data-probe-id` 的变异；探针连续两次运行结果一致（无状态残留）；CI 步骤可跑通。

---

## 3. 决策点（⚠️ 2026-09-27 用户裁决：**报告是需求权威，全量实现；唯一例外 = 深色模式**）

> **用户原话**：「全部按照你推荐的决策来 **但是我给你的优化报告里面的要全量实现** 除了那个深色模式」，
> 以及后续复核口径：「确定 plan / baseline 是**严格按照 optimise-report.md** 生成的吧」。
>
> **口径澄清（本节以此为准，覆盖下表右列）**：
> 1. **需求层（做什么）**：一律以 `docs/optimise-report.md` 的 15 段执行计划 + §6 里程碑验收标准为准，**一项不减**。
> 2. **落地层（怎么做）**：我的"推荐"只允许是**等价实现路径**（例如 D7 用 CSS 变量表达报告要求的全部 EP 变量），
>    **不允许**变成"少做一项"。凡我的推荐在字面上收窄了报告项的，一律回到报告口径，逐条如下：
>    - **D5 禁用态**：报告要求 `background: var(--accent-disabled)` + `color: var(--muted)` + `opacity: 0.6` ⇒ 全量照做；
>      仓库里"禁用态不许用 opacity"的旧守卫需要按新口径改写（改成"禁用态文字色必须是 muted 且对比度达标"），并在验收单里记录这次不变量变更。
>    - **D6 卡片 hover**：报告要求 hover 抬升（`box-shadow` + `translateY(-1px)`）⇒ 全量照做；用 `--k12-dur-state` 统一时长，
>      并在 `prefers-reduced-motion` 下退化为"只变色不位移"。
>    - **D9 Monaco 主题**：报告要求主题精简（只保留 `vs-dark`）⇒ 照做（编辑器固定深色皮肤），
>      同时保留 `vs` 的选择只作为"未来如需浅色皮肤"的代码路径注释，不暴露入口。
>    - **D10 长列表虚拟化**：报告要求引入 `vue-virtual-scroller` ⇒ 照做（新增依赖 + 历史会话/学习记录活动列表接入）。
>    - **D13 组件 API 枚举化**：报告要求 `radius/padding` 改枚举、`Badge.level` 改枚举 ⇒ 一次性切换 + 全量调用点迁移，不做兼容分支。
> 3. **数字层（基线/验收阈值）**：以 `docs/optimise-baseline.md` 的**实测值**为准（那是我方施工与验收的锚点），
>    报告里引用的"现状"数字保留为对照口径；两者不一致时**不改报告**，只在验收单里并列说明。

| # | 决策点 | 选项 | 我的推荐 |
| --- | --- | --- | --- |
| D1 | 范围与节奏 | ① 全量三批连续执行 ② 先只做批次 A，验收后再定 ③ 只做 P0+P1 | **①**：报告本身按三阶段设计，批次间有硬依赖（见 §1） |
| D2 | 身份行字号 | ① 24→32（报告 §1.1/§2.1）② 保留 24，只改顶栏 | **①**：报告明确要求，且"顶栏 18 < 身份行 32"关系成立 |
| D3 | 旧 token 名 | ① 保留别名一版（deprecated）② 直接删除 | **①**：替换面大（450+ 处），别名让每批可独立验收 |
| D4 | `sp-7` 语义 | ① 照报告（sp-7 从 32→40，新增 sp-8=48）② 保持 32，新增 sp-8=40 / sp-9=48 | **①**：严格照报告；迁移点会逐处列出 |
| D5 | 禁用态实现 | ① 报告写法（opacity .6）② 仓库既有写法（实心灰底，新增 accent-disabled token） | **②**：仓库既有守卫明确禁止用透明度表达禁用；换 token 同样满足"五态齐全" |
| D6 | 卡片 hover 位移 | ① 报告写法（translateY(-1px) + 阴影）② 只做阴影/边框/底色变化 | **②**：与"零装饰动效/唯一状态过渡 token"一致；hover 位移会被减动效偏好收掉反而更不一致 |
| D7 | EP 主题落地路径 | ① 报告写法（SCSS 变量 + 新增 sass 依赖 + 构建改造）② 继续 CSS 变量覆盖，把报告要求的全部值落成 `--el-*` | **②**：同样实现"EP 与 k12 对齐"，不引入新构建依赖（EP 2.x 的 CSS 变量已覆盖报告列的全部项） |
| D8 | `focus-visible` 范围 | ① 全局 `*` 通配 ② 手写元素统一 + 全量补缺失处 | **②**：全局通配会覆盖 EP 自带状态，出品不一致 |
| D9 | Monaco 主题 | ① 只保留 vs-dark（报告）② 保留 vs / vs-dark 两档 | **②**：学生当前看到浅色编辑器，单方面改深色是一次未经验证的观感变更；报告的性能目标靠"语言/feature 精简"达成 |
| D10 | 长列表虚拟化 | ① 引入 `vue-virtual-scroller` ② 自研轻量窗口化 / 实测后再引入 | **②**：报告触发条件是"1000+ 条"；先按报告做图谱侧优化，列表虚拟化在实测触发后引入 |
| D11 | 知识图谱 Canvas 模式 | ① 做（>100 节点切换）② 只做视口裁剪 + LOD | **①**：报告明确要求，且以实测节点数触发，条件未到时不生效 |
| D12 | `data-probe-*` 铺开范围 | ① 全量组件 ② 只给"量行为"的锚点（卡片数、题数、开合态、折叠态） | **②**：全量铺开会让 52 个组件都背一层探针属性 |
| D13 | 组件 API 枚举化 | ① 一次性切换（含全部调用点迁移）② 只对新组件生效 | **①**：报告明确要求；作为批次 C 的独立 WP，一次性切完并跑全量回归 |

---

## 4. 与仓库既有纪律的接口（执行时必须同时遵守，不需要用户裁决）

1. **不动契约**：本计划所有改动都在渲染层；`contracts.py` / `openapi.json` / IPC 通道 / 6 事件词表一个字不改。
2. **守卫同步**：凡报告要求改变既有不变量的，**改守卫 + 加变异条目**（例如身份行 24→32、圆角 14→8、间距 20→24）。守卫变红不是"阻塞"，是"清单"。
3. **探针真机**：所有视觉/交互结论以真机探针与截图为准（窗口须前台可见），不靠推理。
4. **出包口径**：需要产物验证时只跑 `npm run build:portable`（本地唯一出包命令）。
5. **文档同步**：`docs/ui/版式契约.md`（层次/字号/间距/圆角/断点）、`AGENTS.md`（若涉及命令或硬约束）、`docs/report-material/decisions.md`（每个 WP 一条 D 记录）、`docs/report-material/pitfalls.md`（踩坑）、`docs/optimise-baseline.md`（基线与性能数字）。
6. **分批验收**：每批结束时给用户一份"批次验收单"（守卫 / 探针 / 变异 / 截图 / 剩余风险），用户点头后才进下一批。

---

## 5. 报告里"条件项 / 未来方向"的处理（**除深色模式外，其余按报告口径落地或保留触发条件**）

| 报告位置 | 报告原文口径 | 本计划处理 |
| --- | --- | --- |
| §8.2 深色模式（中优先级 4–6 周） | 建议第二阶段完成后启动 | **用户明确排除**：本期不做，只在 `docs/optimise-plan.md` 留档 |
| §8.2 移动端适配（低优先级 8–12 周） | **「如果未来需要移动端」**——条件句 | 按报告条件处理：本期只落**token 预留**（`--k12-bp-xs/sm` 两档 + 移动端触控 44px 的注释口径），布局改造等到"未来需要"再立项 |
| §8.2 AI 辅助设计系统 | 报告自标"**研究性项目**，2–3 个月" | 按研究报告项处理：本期不落代码，只在验收单的"后续改进"里留一行 |
| §6.2 Figma 库 / Storybook | 报告的人力与文档流程建议 | 用本仓等价物落地（**可执行替代**，不是砍项）：设计 token 源 = Figma 库的单一真相；真机探针 + 截图 = 视觉回归；`ux:student` 扫描 = 无障碍抽查 |
| §6.4 风险应对里的 **axe-core 自动化** | "CI 集成 axe-core 自动化测试" | **纳入 WP-15**：把可访问性规则检查接进真机脚本（不引 axe-core 依赖时，用自研规则集覆盖报告点名的键盘/语义/对比度三类）——**这一条按报告落地**，不等未来 |
| §6.2 / §6.4 的"灰度发布、内部教师试用 2 周" | 流程建议 | 本仓等价物：**演示档/教师档先验收**（`ux:demo` + 教师视角截图），再切学生默认视角 |
