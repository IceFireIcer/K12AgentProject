# 优化工程基线（WP-00）

> **用途**：`docs/optimise-plan.md` 的 WP-00 产物。所有子代理开工前先读本文件，完工后按同一口径复跑并 diff。
> **纪律**：本文件只记**本仓库实测值**；`docs/optimise-report.md` 中的"现状"数字仅作对照，冲突时**以本文件为准**（见 §7）。
> **复跑命令**（全部在 `desktop/` 下）：`npm run typecheck` · `npm test` · `node scripts/design/check-contrast.mjs` · `node scripts/doc-facts.mjs` · `npm run guards:mutation` · `ux:pages` / `ux:layout` / `ux:student`（需真机 + 调试端口）。

---

## 1. 门禁基线（2026-09-27 实测）

| 门禁 | 实测值 |
| --- | --- |
| 渲染进程行数 | **41,329** |
| 主进程行数 | 24,774 |
| Python app 行数 | 22,065 |
| preload 方法数 / IPC 通道数 / 契约模型数 | **64 / 64 / 64** |
| 单测条数 | **957 全绿** |
| 对比度检查 | **234 项：达标 234，不达标 0** |
| 变异验证 | **68 条全部被守卫抓到**（逐条恢复） |
| 冻结事件词表 | 6 个（delta / citation / payload / blocked / done / error） |
| 页面 | 9 个（chat / animation / coding / quiz / study / settings / dependency / knowledge / demo） |
| Vue 文件 / TS 文件（渲染进程） | 52 / 60 |

> ⚠️ 本表是 **WP-00 的起点**（施工与验收的锚点）；**收尾后的实测数字见 §9**（只增不改，便于 diff）。

---

## 2. 字号相关迁移清单（WP-01 / WP-05）

**现状档位**：`2xl 32 · xl 24 · lg 18 · title 17 · md 16 · sm 14 · xs 13 · micro 12`
**报告目标档位**：`hero 40 · h1 32 · h2 24 · h3 20 · body-lg 18 · body 16 · body-sm 14 · caption 13 · label 12`（删 `title 17`、删重复的 `xl`）

| 旧 token | 出现位置（文件 × 次数） | 改法 |
| --- | --- | --- |
| `--k12-fs-title`（17px） | `assets/base.css`×1 · `components/AppTopbar.vue`×1 · `components/MarkdownProse.vue`×1 · `views/Dependency.vue`×1（共 4 处 / 4 文件） | → `body-lg`（18px） |
| `--k12-fs-2xl`（32px） | `assets/base.css`×1 · `views/Chat.vue`×1（共 2 处） | → `hero`（40px，仅空态问候） |
| `--k12-fs-xl`（24px） | `assets/base.css`×2 · `study/ReportTab.vue`×3 · `views/Knowledge.vue`×1（共 6 处） | → `h2`（24px，语义重命名）；若该处是页面身份行则 → `h1`（32px） |
| `--k12-fs-lg`（18px） | 23 文件 / 31 处（卡片与区块标题为主） | → `body-lg`（18px）保留；**卡片内小标题**改 `h3`（20px）需逐处判定 |
| `--k12-fs-micro`（12px） | 21 文件 / 38 处 | → `label`（12px，仅 ≤4 字角标），语义不变 |
| 页面硬编码 px 字号 | **0 处** | 必须保持 0（守卫） |

**层次关系守卫需要同步的三条**（现值为 17 < 24、16 > 13/12、12 仅角标）：改为 `body-lg 18 < h1 32`、`body 16 > caption/label`、`label` 仅 ≤4 字角标。

---

## 3. 间距相关迁移清单（WP-02）

| token | 现值 | 报告目标 | 出现位置 |
| --- | --- | --- | --- |
| `--k12-gap-block` | 20px | **24px** | `assets/base.css`×1 · `components/ChatMessage.vue`×2 · `views/Settings.vue`×1（共 4 处 / 3 文件） |
| `--k12-gap-msg` | 36px | **32px** | `assets/base.css`×1 · `components/ChatMessage.vue`×1 · `views/Chat.vue`×1（共 3 处 / 3 文件） |
| `--k12-sp-7` | 32px | **40px**（报告：sp-7 改 40 + 新增 sp-8 48） | `assets/base.css`×1 · `views/Dependency.vue`×1（共 2 处） |

**裸值清单（不走 token 的间距，需逐处判定语义）**

| 值 | 处数 | 位置 |
| --- | --- | --- |
| `20px`（padding/margin/gap） | 9 行（含 token 定义 2 行） | `components/ConfirmDialog.vue`（`padding: 20px`）· `views/Animation.vue`（`padding: 20px 22px`）· `views/Chat.vue`（`padding: 20px 24px 8px`）· `study/ReportTab.vue`（`margin: 20px 0 8px`）· `components/PageActions.vue` 注释里的覆盖示例 |
| `36px` | 3 行（含 token 定义 1 行） | `components/AppSidebar.vue`（图标块 `36×36`，属尺寸不是间距）· `--k12-gap-msg` 定义 |

> ⚠️ `--k12-sp-5 = 20px` 同时也是"标准间距档"：报告要求网格为 `4/8/12/16/24/32/40/48`，因此 `sp-5` 的 20 需要并入 **24**；迁移时必须区分"真的是间距"与"尺寸/图标块"（如 AppSidebar 的 36×36）。

---

## 4. 圆角相关迁移清单（WP-03）

| token | 现值 | 报告目标 | 出现位置 |
| --- | --- | --- | --- |
| `--k12-r-card` | 14px | **12px** | 27 文件 / **48 处** |
| `--k12-r-control` | 14px | **8px** | 19 文件 / **42 处**（按钮/输入/分段控件） |
| `--k12-r-inset` | 8px | 8px（不变，语义明确） | 27 文件 / 77 处 |
| `--k12-r-flat` | 4px | 4px（对应报告 `r-xs`） | 19 文件 / 50 处 |
| `--k12-r-pill` | 999px | 999px（保留） | — |
| **裸 `border-radius: Npx`** | **1 处** | 改 token | `components/MarkdownProse.vue` |

新增档位：`r-sm 6`（chip/tag）、`r-xl 16`（大卡片/模态/浮层）；嵌套圆角公式 `内 = max(0, 外 − padding)` 需在 inset 块上验证（inset 77 处是主要战场）。

---

## 5. 断点与响应式现状（WP-06）

**现有 media query 全量分布**：

| 查询 | 处数 | 说明 |
| --- | --- | --- |
| `(hover: hover) and (pointer: fine)` | **68** | 所有 hover 效果都包在这里（触屏不出现悬停残留） |
| `(prefers-reduced-motion: reduce)` | 8（另加 JS composable 1 处） | 减动效 |
| `(max-width: 1279px)` | 6 | 侧栏图标条、右栏转浮层等 |
| `(max-width: 1439px)` | 1 | 对话页卡片网格 4 → 2 列 |
| `(max-height: 640px)` | 1 | 对话页紧凑态 |
| 1024 / 1920 断点 | **0** | 报告要新增 `bp-md 1024` / `bp-2xl 1920` 与高度断点 768/900 |

最小宽度：`#app { min-width: 1120px }`（`assets/base.css` 第 186 行）——报告要求降到 1024。

---

## 6. 组件、状态与资产现状

| 项 | 实测 |
| --- | --- |
| 共享组件（`components/`） | 24 个；`cards/` 4 张卡 + 1 分派器；`study/` 5 页签 + `study/map/` 2 个；`layouts/` 1 |
| Element Plus 用量 | `el-button 65` · `el-descriptions(-item) 50` · `el-form(-item) 27` · `el-tag 21` · `el-table(-column) 21` · `el-input 11` · `el-collapse(-item) 18` · `el-segmented 5` · `el-radio-group/button 8` · `el-progress 4` · `el-timeline(-item) 8` |
| EP CSS 变量覆盖 | `--el-*` 出现 **71 处**（全部在 `assets/base.css`，未使用 SCSS 管线） |
| EmptyState 四态用量 | `tone="empty"` 7 · `loading` 6 · `error` 6 · `success` 2（另有 `tone="float"` 2 处属 SurfacePanel） |
| 无障碍 | `aria-*` 113 · `role=` 33 · `focus-visible` 样式仅 5 个文件（`base.css` / `Quiz.vue` / `GraphMap.vue` / `Settings.vue` / `SessionList.vue`） · `sr-only` 4 |
| 探针锚点 | `data-testid` 共 **532 处** |
| 状态层 | Pinia store 21 个；composable 6 个 |
| 骨架屏 / 虚拟滚动 / 五态 token | **均不存在**（报告要新增） |

---

## 7. 性能与技术债务基线

**打包产物（`desktop/out/renderer/assets`，最近一次构建）**

| 产物 | 体积 |
| --- | --- |
| `editor.api-*.js`（Monaco 编辑器） | 5,103,772 B ≈ **4.87 MB** |
| `index-*.js`（应用主包） | 1,779,810 B ≈ 1.70 MB |
| `index-*.css` | 597,958 B ≈ 0.57 MB |
| `editor.worker-*.js` | 584,829 B ≈ 0.56 MB |
| `editor-*.css` | 115,950 B ≈ 0.11 MB |

> ★ **2026-09-27 收尾实测（WP-13 之后）**：上面那张是 **WP-00 的基线**（未压缩构建）。
> 收尾时发现 electron-vite 的渲染进程默认 `minify: false`，打开 `minify: 'esbuild'` 后：
>
> | 产物 | WP-00 基线 | 收尾实测 |
> | --- | --- | --- |
> | `editor.api-*.js` | 4.87 MB | **2.52 MB**（2,646.80 kB） |
> | `index-*.js` | 1.70 MB | **0.77 MB**（784.18 kB） |
> | `editor.worker-*.js` | 0.56 MB | **0.26 MB**（266.2 kB + 0.13 kB 入口壳） |
> | 语言 chunk | ~90 个（abap / sql / php …） | **1 个**（`python-*.js`，3.76 kB） |
>
> 报告 §5.1 的 `<3MB` 验收线在「压缩 + 只注册 Python」之后成立；判据进
> `tests/monaco-bundle.test.ts`（有产物时量 <3MB，没有产物则跳过）。

**数据规模（当前随包资产 / 本机学生）**

- 知识图谱：**57 节点 / 78 条边**（初中档，学生视角审计实测；报告设想的"几百节点"场景当前不存在，Canvas 触发条件按报告写 >100 节点，实测未触发）。
- 历史会话：本机被测学生十余条；`studies` 分页列表规模在两位数。
- 题库：8 章分片，共 684 题（choice 569 / blank 115；**没有 code_blank 题型**）。
- 动画模板：215 份 JSON + `_shared/`（anime.min.js 17KB + runtime.js 103KB + base.css 12KB + skins.css 15KB）。

**本仓实测值 vs 报告引用的"现状"数字（需求以报告为准，数字以实测为准）**

> 口径：**做什么以 `docs/optimise-report.md` 为准**（本文件不改需求）；**起点数字与验收阈值以本表实测为准**
> （本文件是施工与验收的锚点）。两者并列，不互相改写；差异只在批次验收单里说明。

| 报告引用的现状 | 本仓实测（2026-09-27） | 施工口径 |
| --- | --- | --- |
| 对比度"98.7%（231/234）" | 234 项检查、**达标 234、不达标 0** | WP-04 的验收仍按报告要求"扩展到交互态后 100%" |
| Monaco chunk "≈5.1MB" | `editor.api` **4.87MB**（5,103,772 B） | WP-13 目标 <3MB 不变，起点按 4.87MB 记 |
| "知识图谱可能有几百个节点"（报告用于论证 Canvas 必要性） | 当前初中档 **57 节点 / 78 边** | WP-14 按报告实现视口裁剪 + LOD + **>100 节点切 Canvas**；当前数据量下 Canvas 分支已实现但不激活，用 500 节点合成场景验收 |
| "键盘可达覆盖约 60%" | 未系统测量 | WP-08 完成后以"纯键盘走通全流程 + 新增守卫"作为新基线 |

---

## 8. 每个工作包的"开工必读"索引

| WP | 必读小节 |
| --- | --- |
| WP-01 字体 | §2（含三处层次守卫需要同步的关系） |
| WP-02 间距 | §3（含 `sp-5=20px` 与"尺寸≠间距"的区分提醒） |
| WP-03 圆角 | §4 |
| WP-04 颜色 | §1（234 项基线）+ §6（`--el-*` 71 处） |
| WP-05 层次 | §2 + §6（EP 用量，顶栏 chip 受影响） |
| WP-06 断点 | §5 |
| WP-07 卡片统一 | §6（四态用量）+ §7（题库题型） |
| WP-08 键盘 | §6（focus-visible 只 5 文件、aria/role 现状、532 个 testid） |
| WP-09 交互态/骨架屏 | §6（骨架屏与五态 token 均不存在）+ §1 |
| WP-10 减动效 | §5（8 处 CSS + 1 处 JS） |
| WP-11 EP 对齐 | §6（EP 用量 + 71 处 `--el-*`，无 SCSS 管线） |
| WP-12 组件 API | §6（24 共享组件） |
| WP-13 Monaco | §7（4.87MB 起点 + worker chunk） |
| WP-14 图谱/列表 | §7（57/78 节点、列表规模） |
| WP-15 探针 | §6（532 个 testid）+ §1（68 条变异） |

---

## 9. 收尾实测（2026-09-27 晚，WP-07 / 10 / 12 / 13 / 14 / 15 之后）

**门禁**：

| 门禁 | WP-00 基线 | 收尾实测 |
| --- | --- | --- |
| 单测条数 | 957 | **1034 全绿**（含 check:api / check:tool-schema / check:docs） |
| 变异条目 | 68 | **103**（本轮新增 84–103 共 20 条，逐条变红） |
| 守卫测试文件 | — | 新增 16 个（`card-single-question` / `monaco-bundle` / `reduced-motion-mode` / `component-api` / `map-performance` / `probe-structure` …） |

**真机性能基准线（`npm run ux:perf`，K12_DEBUG_PORT=9224，重载后 3.2s 内采样）**：

| 指标 | 实测 | 门槛 |
| --- | --- | --- |
| FCP 首次内容绘制 | **240 ms** | < 2500 ms |
| LCP 最大内容绘制 | **300 ms** | < 4000 ms |
| FID 首次输入延迟 | 本轮无真实输入 → SKIP | < 100 ms |
| DCL (DOMContentLoaded) | **177 ms** | — |
| load 载入完成 | **279 ms** | — |

**真机探针**：`ux:motion` 9/9 · `ux:pages` 27/27 · `ux:layout` 28/28（4 视口 × 7 页）·
`ux:student` 24/24；`ux:layout` 首跑抓到 1024 下「语音输入」按钮被 flex 压成 15×28 的真缺陷（已修）。

**图谱 / 列表规模口径**：当前初中档仍是 **57 节点 / 78 边** → Canvas 分支（>100 节点）不激活；
验收用 `tests/map-performance.test.ts` 的 **500 节点合成布局**（裁剪后可见数 < 总数一半、裁剪耗时 <100ms）。

---

## 10. 视觉边界改造（2026-09-27 深夜，D-105）

> **起因**：用户走查报告——"侧栏像飘在空中、顶栏边界不明显、右栏内部没有层次、
> 四张能力卡片与页面底色都是白色"。报告给的诊断是"缺少背景色层次"，
> 实测后确认它是**对的但不完整**（见 D-105 的"被否决的方案"一节）。

**门禁**：

| 门禁 | §9 收尾 | 本次（D-105） |
| --- | --- | --- |
| 单测条数 | 1034 | **1042 全绿** |
| 对比度检查 | 234 项 | **342 项**（新增边框可见性 4 条 × 18 组、`muted`/`fg-2` on page 2 条 × 18 组） |
| 变异条目 | 103 | **112**（新增 107–112 共 6 条，逐条变红） |
| 守卫测试文件 | 17 个 | **18 个**（新增 `visual-edges.test.ts`，6 条断言） |
| 后端动画皮肤 | — | `server/resources/templates/_shared/skins.css` **同步重建**（同一份 `tokens.source.json` 的第二消费方；漏了会红 `tests.test_sandbox_palette`） |

**关键取值（18 组配色，逐组验过）**：

| token | 旧 | 新 | 说明 |
| --- | --- | --- | --- |
| `border` | `#E6EAF2`（1.21:1） | **`#D1D5DB`（1.47:1）** | 卡片发丝线 |
| `border-strong` | `#D9DFEC`（1.34:1） | **`#9CA3AF`（2.54:1）** | 结构分面线（侧栏 / 顶栏 / 右栏 / 浮层） |
| `default` 档 page | `#FFFFFF` | **`#EEF2FC`** | **开机默认档**，原是纯白 |
| mono 档 page（6 个） | `#FAFAFB` | **`#F1F2F6`** | 原比嵌入块还亮（顺序倒挂） |
| soft 档 page / s2 | 1.025–1.045 | **≥1.045 / ≥1.06** | 由 `author-tokens.mjs` 的不塌陷下限派生 |

**结论**：18 组配色里"桌面 vs 纸面"的色差全部 ≥1.045:1，两支边框全部达标，
`default`（开机默认）与 5 个学段的 `mono` 档不再出现"白底白线"。
