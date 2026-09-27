# 优化工程验收单（批次 A / B / C，全量，2026-09-27）

> 依据：`docs/optimise-report.md`（需求权威）· 施工基线：`docs/optimise-baseline.md`（数字权威）· 排期与工作包：`docs/optimise-plan.md`。
> 复核命令（全部在 `desktop/` 下）：`npm run typecheck` · `npm test` · `node scripts/design/check-contrast.mjs` · `npm run guards:mutation` · `node --test tests/<file>.test.ts`。

## 一、批次 A（P0：字体 / 间距 / 层次 / 键盘）

| 报告条目 | 落地 | 守卫 | 变异 |
| --- | --- | --- | --- |
| §1.1 字体系统重构（9 档、删 17px） | `hero40 / h1 32 / h2 24 / h3 20 / body-lg 18 / body 16 / body-sm 14 / caption 13 / label 12`；旧名保留别名；`var(--k12-fs-旧名)` 全量迁移 529 处 / 47 文件 | `tests/design-tokens.test.ts`（5 条） | 70–74 |
| §2.1 视觉层次（顶栏 18 / 身份行 32 / 卡头 20 / 空态 40） | 顶栏 `body-lg + fg-2 + border-strong`；`.k12-identity__main → h1`；`.k12-card-head → h3`；`Chat.vue` 空态 → hero；标题档逐处落位 | 同上（第 5 条） | 70–73 |
| §1.2 间距 8 点网格 | `sp-1..8 = 4/8/12/16/24/32/40/48`；语义间距 `gap16 / block24 / section40 / msg32`；9 处裸 20px 迁走 | `tests/spacing-grid.test.ts`（3 条） | 75–76 |
| §3.1 键盘可达性 | 「跳到主内容」+ `#k12-content[tabindex=-1]`；全站 `*:focus-visible` 基线；**修掉真缺口**：两个非模态浮窗补焦点契约（`useFocusReturn(..., { trap: false })`）；Tab 顺序写入版式契约 §8.1 | `tests/keyboard-a11y.test.ts`（6 条，第 6 条钉 `scripts/ux-keyboard.mjs` 存在与三条判据齐全） | （无独立变异；真机入口 `node scripts/ux-keyboard.mjs`，注意先跑 `ux:layout` 会哑掉 CDP 键盘输入，见 P-149） |

## 二、批次 B（P1：形状 / 颜色 / 断点 / 卡片 / 状态 / EP / Monaco）

| 报告条目 | 状态 | 证据 |
| --- | --- | --- |
| §1.3 圆角 4/6/8/12/16 + 控件 14→8 | ✅ | `tests/radius-tokens.test.ts`；变异 77 |
| §1.4 + §3.2 + §4.3 交互态与对比度 | ✅ | `tests/interaction-states.test.ts`（5 条，18 套配色 hover/active ≥4.5:1、disabled ≥3:1、相邻态色差 ≥10%）；变异 81 |
| §2.2 响应式断点（1024/1920 + 高度） | ✅ | 断点 token 6+3；最小宽 1024；窄屏档 <1024；气泡网格 4/3/2；`ux-layout-audit` 四视口；`tests/breakpoints.test.ts`；变异 79–80 |
| §3.2 交互状态与 Loading 四形态 | ✅（骨架屏 + 状态） | `components/Skeleton.vue` + 会话列表接入；按钮 loading / 输入框 filled+error / 卡片 hover 抬升（减动效退化）；`tests/skeleton.test.ts`；变异 82 |
| §3.3 减动效（CSS 半边） | ✅（CSS） | 全站兜底压时长 + `scroll-behavior:auto`；JS 半边由 `useReducedMotion()`（滚动/定时器） |
| §4.1 Element Plus 全量对齐 | ✅ | EP 圆角 8/6/12、字号 16/14/18/20、语义色（**补上此前缺失的 info/danger 全套派生**）、表格/表单/描述列表间距；`tests/ep-theme.test.ts`；变异 78 |
| §2.3 卡片系统统一 | ✅ | 四张卡迁三段结构；对话内练习卡**单题**（步骤条 + 上一题/提交/下一题）；进度卡由 `ChatMessage` 独立渲染；`card-single-question` + `card-structure` 迁移断言；探针 `verify-ui` / `ux:pages` 已加「渲染题数 = 1」；变异 84–87 |
| §5.1 Monaco 精简（<3MB） | ✅ | 只注册 Python；固定 `vs-dark`；minimap/多光标关；重试 ≤3；`CodeEditor.vue` 异步组件 + `CodeEditorSkeleton`；**打开渲染进程压缩**（根因：electron-vite 默认 `minify:false`）→ `editor.api` **5,103.77 → 2,646.80 kB（2.52 MB）**；守卫 `monaco-bundle`；变异 88–90 |

## 三、门禁现状（2026-09-27 实测）

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npm test` | ✅ **1042 条全绿**（含 check:api / check:tool-schema / check:docs） |
| 对比度（静态） | ✅ **342 项全过**（含边框可见性下限 4 条与"落在桌面上的 meta" 2 条） |
| 对比度（交互态） | ✅ 18 套配色 × hover/active/disabled 全达标（新增守卫） |
| 视觉边界（2026-09-27 深夜，D-105） | ✅ `tests/visual-edges.test.ts` **6/6**：18 组配色的"桌面 vs 纸面"色差 ≥1.045、两支边框达标、侧栏/顶栏/右栏的线+单侧投影在位、`.k12-inset` 有真实消费者 |
| 变异验证 | ✅ 新增 **70–103 共 34 条**逐条变红；仓库总条目 68 → **103** →（D-105）**112** |
| 门禁覆盖面（2026-09-27 补记） | `npm test` 现在同时是**探针锚点自检**的执行入口（`tests/probe-anchors.test.ts`）—— 报告 §5.3 要求的"CI 添加探针验证步骤"因此由 CI 既有的 `npm test` 步骤满足，无需改 `ci.yml` |
| 新增守卫测试文件（16 个） | 批次 A/B 的 10 个 + 本轮 6 个：`card-single-question` · `monaco-bundle` · `reduced-motion-mode` · `component-api` · `map-performance` · `probe-structure` |
| 新增探针脚本 | `scripts/ux-keyboard.mjs`（真机键盘：不掉焦点 / 第一站跳转链接 / Esc 后焦点仍在文档内）· `scripts/ux-probe-reduced-motion.mjs`（`ux:motion`）· `scripts/ux-probe-perf.mjs`（`ux:perf`）· `scripts/probe-lib.mjs`（结构化锚点 / 隔离 / 截图 / axe 类规则） |
| 真机探针（2026-09-27，端口 9224） | `ux:motion` **9/9** · `ux:perf` FCP 240/LCP 300/DCL 177/load 279 ms · `ux:pages` **27/27** · `ux:layout` **28/28**（并修掉 1024 下 15×28 的语音输入按钮）· `ux:student` **24/24** |

## 四、剩余工作（诚实清单，2026-09-27 收工）

> **15 个工作包全部落地**（WP-00…WP-15）；批次 A/B/C 的功能面没有未做的项。
> 剩下的是**验证与出包**，以及本轮新增的两条环境型探针问题：

1. **全量变异复跑**：本轮新增 84–103 共 20 条已**逐条**验证变红（分 6 批跑），
   但仓库总条目 **103 条**没有一次跑完（历史上整跑在 Windows 上偶发中途崩，见 P-146）——下次发版前建议整跑一次。
2. **`verify-ui.mjs` 真机执行**：脚本已按「单题 + 翻题 + 卡脚提交」改造（含题卡渲染题数 = 1 的断言），
   但本轮没有真跑（它要注入 payload 并驱动真实对话）。
3. **便携版出包抽查**：`npm run build:portable` + `check:bundle`（后者需先 `build:unpack`）本轮未跑。
4. **`ux:pages` 的「对话页 · 练习卡」两格**当次 SKIP（那轮对话里没有练习卡）——用 `verify-ui` 或先做一道题可覆盖。
5. **探针环境两坑（不是产品缺陷）**：① CDP `Input.dispatchKeyEvent` 在
   `Emulation.setDeviceMetricsOverride` 之后不再送达渲染进程 → 键盘类审计要在视口仿真之前跑或重启应用（P-149）；
   ② 僵尸监听会让 `K12_DEBUG_PORT` 静默绑不上（P-152）。
6. **报告未做的一项**（诚实标注，不是遗漏）：§4.2 提到的「自研 Button 组件」在本仓不存在
   （按钮是 `.k12-cta` / `.btn` 类）——没有为了迁移清单新建组件；`ControlVariant` / `ControlSize` 已作为类型就位。
