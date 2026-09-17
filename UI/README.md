# K12Agent 界面原型（UI/）

> 由 Pencil 画布 `pencil-new.pen` 的选中帧生成，用于**界面布置准备**。
> **暂不接线**：本目录不依赖 `desktop/` 的 IPC、preload 与冻结契约运行时，也不依赖 `server/`。

## 怎么跑

```bash
cd UI
npm install
npm run dev        # http://localhost:5273
npm run typecheck  # vue-tsc --noEmit
npm run build      # 生产构建（同时跑 typecheck）
npm run gen:tokens # 由 tokens.source.json 重新生成两轴 CSS 变量
```

## 技术栈

| 项 | 选择 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5 + TypeScript 5.9（strict） | 与 `desktop/` 保持一致，便于后续整体迁入渲染进程 |
| 构建 | Vite 7 | 与 `electron-vite@5` 的 peer 一致 |
| 组件库 | **Element Plus 2.14.5** | **按需引入**（unplugin 自动导入），承担骨架与交互（表单/按钮/单选框/输入框） |
| 图标 | **lucide-vue-next**（主）+ EP 图标 | 画布中所有图标都是 lucide；EP 图标只用于 EP 组件内部 |
| 路由 | vue-router 5（hash 模式） | hash 模式提前对齐 Electron 的 `file://` 加载 |
| 状态 | Pinia 4 | 只有主题一个 store |
| 字体 | **本地自托管 woff2**（可变字重） | Inter / Noto Sans SC / JetBrains Mono，**零 CDN**（断网演示硬约束） |

**为什么用可变字体**：画布大量使用 550 / 620 / 650 这类中间字重，静态字重包没有这些档位。

## 设计 token：两轴主题

画布的文档变量本身就是 **`grade` 轴（6 档）× `sat` 轴（3 档）= 18 组**，
因此代码里也用两轴属性选择器：

```css
:root[data-grade="junior"][data-sat="vivid"] { --k12-accent: #4F46E5; ... }
```

- 全部色值来自 `scripts/tokens.source.json`（由画布 `GetVariables()` 导出），
  经 `scripts/gen-tokens.mjs` 生成 `src/styles/tokens.generated.css`。
- **组件里不硬编码任何色值**，一律引用 `--k12-*`。改色 → 改画布 → 重新导出。
- 变量统一加 `k12-` 前缀，避免与 Element Plus 的 `--el-*` 冲突。
- 另有 `.k12-swatch[data-grade][data-sat]` 一类，让**单个元素自带某组主题**
  —— 配色总览页需要在同一屏同时展示 18 组配色。

生成物包含 18 组完整规则 + 单轴回退（只设 `data-grade` 或只设 `data-sat` 时用默认值补齐）。

## 路由结构（三区）

| 区 | 路径 | 内容 |
| --- | --- | --- |
| 产品主线 | `/app/*` | 侧栏 7 项（学习台 / 对话课堂 / 动画讲解 / 编程环境 / 闯关练习 / 学习档案 / 设置） |
| 产品主线（不占导航） | `/app/workbench`、`/app/knowledge`、`/app/dependency` | 多模态工作台、教材知识库、依赖图谱 |
| 设计系统 | `/system/*` | 配色总览、四学段对照 |
| 开发页 | `/dev/theme` | 主题切换台 |

侧栏导航**由路由表 `meta` 推导**（`nav` / `section` / `icon` / `badge`），不在组件里另写一份清单，
避免「加了页面忘了加导航」。

## ★ 学段：无人工入口（按架构修正）

`AGENTS.md §5.1` 明令：**学段没有人工选择入口、没有确认、没有纠偏**，唯一写路径是服务端推断。
画布上有两处与之冲突，本原型**按架构修正**（不是遗漏）：

| 画布位置 | 画布上的样子 | 本原型的处理 |
| --- | --- | --- |
| 「1. 对话课堂」顶栏 | `Segmented`（初中 / 高中 / 小学高）选择器 | 换成 `GradeIndicator` 只读指示器 |
| 「2. 学段自适应」提示条 | 「确认调整」/「保持初中」两个按钮 | 改为**只读说明条**，两个按钮删除 |

`stores/theme.ts` 用两个概念把它们分开，避免把「配色轴」误当成「学生学段」：

- `inferredGrade` —— 学生的真实学段（领域事实，来自服务端推断；原型为 mock）；
- `grade` —— 配色轴（跟随 `inferredGrade`，开发期可在开发页临时改）；
- `displayGrade` —— 指示器实际显示的学段。

**开发模式门禁是两层的**：
1. 页面本身在 `/dev/theme`，不在学生端导航；侧栏底部有「开发工具」入口；
2. 必须先点「开启开发模式」，否则 `setGrade()` 直接拒绝并警告；
   关闭开发模式时配色轴**复位到学生真实学段**，避免开发态残留影响验收。

## 哪些页面没有生成

画布上有 33 个顶层帧，**大量是探索产物，不应变成代码**。以下**有意不生成**：

| 画布帧 | 数量 | 为什么不生成 |
| --- | --- | --- |
| 焕新方向 A–F | 6 | 配色方向探索稿。资产是 token，已全部落进 `tokens.generated.css` |
| 蓝橙微调 A–F | 6 | 同上 |
| 蓝粉方案 A–F | 6 | 同上 |
| 主题接口规范 | 1 | 设计系统内部规格说明，不是学生界面 |
| 学习档案与设置（合帧） | 1 | 只是把 5/6 两屏竖排，内容与 `/app/profile`、`/app/settings` 完全重复 |
| 学段自适应（整屏） | 1 | 含已作废的确认/纠偏交互；**其内部三张卡已拆出**并入学习档案页 |

**从「2. 学段自适应」拆出并复用的三张卡**（现在在 `/app/profile`）：
学段变化轨迹 · 判定信号 · 学段隔离检索。

## 与冻结契约的关系

`src/types/contract.ts` 是**手写的对照镜像**，字段名逐字对齐 `server/app/contracts.py`
（camelCase 出参）。`src/mocks/index.ts` 的形状也对齐契约，内容尽量取自仓库真实资产：

- 知识点 / 章节 / 小节名 ← `server/_data/shared/kb.sqlite` 的 `chunk` 表
- 依赖边 ← `server/knowledge/manifest.json` 的 `dependencies`（47 条，`from` 是前置）
- 题目 ← `server/resources/quizbank/junior.json`

> **接线时**：`openapi-typescript` 生成的类型应**取代** `contract.ts`（票 04 的防漂移链），
> `mocks/` 目录整体删除，改为 IPC 事件流 + sidecar HTTP 响应。

**已发现的一处契约内部不一致**（记此备查，未擅自改动后端）：
`contracts.py` 的 `ChatRequest` 仍带 `grade_level: GradeLevel` 字段，
但其 docstring 与 `AGENTS.md §5.1` 都声明「请求不带学段」。本原型按「**请求不带学段**」执行。

## 内联卡做到什么程度

按决定「视觉完整、引擎不接」：

| 卡片 | 已做 | 未接（接线时补） |
| --- | --- | --- |
| 动画 | 卡头 / 四层舞台 / 播放条 / 全屏按钮 | Anime.js、sandboxed iframe（**禁 `allow-same-origin`**）、nonce 资源路由 |
| 编程 | 任务面板 / 高亮代码区 / 运行结果 / 三级求助 | Monaco、Pyodide Worker、超时中断 |
| 闯关 | 选项交互 / 题号推进 / 提交态 | 真实判分（**答案不下发前端**，只走 `/api/quiz/grade`） |

## 已知取舍

- **尺寸**：**弹性 + 整体等比缩放**，两者各管一段：
  - 宽 ≥1440：`scale` 恒为 1、外壳宽度 `100%`，内容铺满宽屏；
    对话阅读栏设上限（`--chat-reading-width: 860px`）并居中，避免宽屏下正文行长无限拉长。
  - 宽 <1440：外壳固定 1440px 并 `transform: scale(w/1440)` 整体等比缩小，
    高度按比例反算，设计比例在窄窗口下不被压扁。
  - 实测：1100px 窗口 → scale 0.764、横向溢出 0；1920px 窗口 → scale 1、右侧无空白。
- **favicon 缺失**：`vite preview` 会报一条 404，无影响。
- **EP 按需引入是硬要求**：若在 `main.ts` 里写 `app.use(ElementPlus)` +
  引入 `element-plus/dist/index.css`，主 chunk 会从 **149 kB 涨到 1035 kB**（gzip 59 → 342 kB）。
  中文语言包改用 `App.vue` 的 `<el-config-provider :locale="zhCn">`。

## 目录

```
UI/
├─ scripts/
│  ├─ tokens.source.json     # 画布变量导出（改色改这里，或改画布后重导）
│  └─ gen-tokens.mjs         # 生成两轴 CSS 变量
├─ src/
│  ├─ cards/                 # 动画 / 编程 / 闯关 内联卡
│  ├─ components/            # 侧栏、顶栏、玻璃卡、极光背景、只读学段指示器、右栏、输入条
│  ├─ layouts/AppShell.vue   # 外壳：极光背景 + 侧栏 + 顶栏 + 内容区 + 等比缩放
│  ├─ mocks/                 # mock 数据（接线时整体删除）
│  ├─ router/                # 三区路由
│  ├─ stores/theme.ts        # 学段 × 饱和度，含开发模式门禁
│  ├─ styles/
│  │  ├─ base.css            # 字体、排版尺度、玻璃拟态、EP 主题覆盖
│  │  └─ tokens.generated.css # ★ 自动生成，勿手工编辑
│  ├─ types/contract.ts      # 与 contracts.py 对齐的类型镜像
│  └─ views/                 # app/ system/ dev/
```
