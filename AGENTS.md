# AGENTS.md

面向后续 ZCode / 编码代理的工作区说明。只记录本仓库特有、从代码本身看不出来的信息。

> **本文件依据 `项目执行文档.md`（唯一权威）+ `docs/` 现存的 5 份文档 +「代码从零重建」决议重写。**
> 若本文件与执行文档冲突，**以执行文档为准**，并顺手修正本文件。
> ⚠️ 历史文档（含执行文档的 v1→v2 修订说明）里残留的 `S00–S02`、`D-00x`、`P-00x`、旧文件名、
> 「SSE → IPC 返工」等说法**均已作废**：文件名映射见第 4 节命名表，决策/踩坑编号在第 10 节重新起算。

## 0. ⚠️ 先读这一条：代码从零重建

**当前仓库已有完整可运行代码**（不再是「只有文档」）：

```
K12Agent/
├─ AGENTS.md              # 本文件
├─ 项目执行文档.md         # 唯一权威执行文档 v3.0（从零重建版：混合后端 + IPC-only）
├─ docs/                  # 设计文档 + ui/（原型说明与版式契约）+ tickets/ + agents/ + report-material/
└─ .gitignore  .gitattributes
```

`desktop/` 与 `server/` **均已落地**（后端 900+ / 桌面 600+ 项测试全绿；安装包与绿色版可出）。
界面已按 **D-039** 换成原型的设计（原来的 `UI/` 目录**已删除**，产物在 `desktop/src/renderer`）。
另有两条**只覆盖跨层**的验证：`npm run smoke:wire`（主进程真连 Python sidecar，需先起 sidecar）
与 `node scripts/verify-ui.mjs`（CDP 看真实 DOM，需 `K12_DEBUG_PORT` 且**本机允许绑定调试端口**）。

> **测试数字不要写死**（它会随每一票增长）：以后端 `uv run python -m unittest discover -s tests`
> 与桌面 `npm test`（= `node --test` + `check:api` + `check:tool-schema`）的**实际输出**为准。
> 本文件里的量级只表示「已有成规模回归」，不是某个精确基线。

因此：

- **不恢复、不参考任何历史实现**。删码前的代码产物（Electron 壳、sidecar 握手、pydantic 契约层、事件通道、单测与守卫）
  **已移出工作区**；`archive/s02-full-code` 标签**仅作历史留档**——
  **禁止 `git checkout` 恢复、禁止阅读其实现、禁止照它重写**。「从零重建」是有意决策，不是事故。
  旧代码踩过的坑已沉淀为第 8 节的设计约束，**不需要（也不允许）回头翻代码**。
- **后端是刻意的混合架构**（一句话）：**Python 管数据 / RAG / 嵌入 / 判分 / 学习记录，
  TypeScript（Electron 主进程）管编排 / LLM / Prompt / Tool 注册 / 6 事件映射**，两端只经冻结契约通信。
  **这不是过渡态**，四条硬边界见第 5 节。
- **开工前先看两处**：`docs/tickets/`（票与各票 `Blocked by` →「今天做什么」）与 `项目执行文档.md`（规格 →「做成什么样」）。

> **嵌入模型（约 90MB，从未入 git）**：由**自写脚本** `server/scripts/fetch_embedding_model.py` **联网获取**，
> 落到 `server/resources/models/fastembed/`。仓库外的本地备份
> （`E:\FolderForVibeCoding\Zcode\K12Agent_backup_resources\resources`）**仅作断网兜底**，不是主路径。
> 拿到模型后立刻验证检索链路（票 10 / 票 11），不要攒到收口。

## 1. 项目是什么

面向 K12 的 AI 学习对话智能体，充当「7×24 小时在线 AI 教师」，
覆盖小学低/高年级、初中、高中四个学段，具备学段自适应、多模态交互、个性化学习路径。

> **产品名：智团团**（吉祥物是一只抱着蜂窝的小熊）。
> ★ 2026-09-21（D-064）：**自称统一为「智团团」**（提示词四份模板 / `rules.ts` 挡话 / 开场白 / 渲染层 / `BRAND_TAGLINE`），
> 并把「通识课」全部去掉 —— **本项目没有「课程」**：教材与知识点只是模型回答时的**参考**，
> 学生问什么就聊什么。详见 `docs/report-material/decisions.md` 的 D-064。
> - 品牌名的**唯一来源**是 `desktop/src/shared/brand.ts`（主进程与渲染进程共用）；
>   `desktop/src/renderer/index.html` 的 `<title>` 与 `desktop/electron-builder.yml` 的
>   `productName` 是纯静态配置、无法 import，**改品牌名时必须手工同步这三处**。
> - ★ **存储目录名刻意与品牌名解耦**：`userData` 钉在固定 slug
>   （`src/main/index.ts` 的 `applyStableUserDataSlug`）。否则改一次品牌名，
>   学生的 `config.json` / `learning.db` / Pi 会话就整体留在旧目录里「凭空消失」。
>   这个 slug **不要再改**；确需变更必须写迁移逻辑。守卫：`desktop/tests/brand.test.ts`。
> - **吉祥物素材**：仓库根 `logos/` 是原始图（2048²、约 12MB，**不入包**）；
>   经 `server/scripts/make_brand_icons.py` 生成 `desktop/build/icon.ico`（打包图标，
>   多尺寸）与 `desktop/resources/brand/*.png`（运行时 256px，按学段切换）。
>   改了 logo 就重跑那个脚本，不要手工导出。

- **交付物**：可运行的 Electron 桌面应用原型（**本期只做 Windows .exe**）、完整源码 + 本地运行说明、项目报告与汇报 PPT、演示视频。
- **约束前提**：**单人开发 · 15 天极限冲刺**。所有排期与范围决策都服从这一前提。
- **评分权重**：设计合理性 25% / 多模态交互质量 25% / 教育适配性 20% / 用户体验 15% / 创新性 15%。

## 2. 当前进度与下一步

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| S00–S02（历史） | 环境基线 / 双端脚手架 / 契约与事件通道（删码前的旧实现） | ❌ **代码已删除，不再恢复**（经验已沉淀进第 8 节） |
| **票 01** | **双端脚手架与依赖基线** | ⬜ **当前起点**，15 天排期从这里重新起算 |
| 票 02–24 | 见下方清单 | ⬜ 按各票 `Blocked by` 顺序推进 |

**关卡（硬性验收线，不过不进下一阶段）**：A = 票 02（sidecar 握手 + 打包不炸）；
**B₁ = 票 03（Pi 可加载 + esbuild 打包冒烟）**；B = 票 06（流式对话贯通 + 学段 Prompt）；
C = 票 11（RAG 学段隔离）；D = 票 15（闯关闭环）；E = 票 23（完整应用可交付）。

> **★ 票 03 是全程风险最高的一票**：Pi 包根导入会拖入 `esbuild` 原生依赖（Pi issue #9286），
> 必须**在最早的提交里就在打包产物上冒烟**，不要等收口。失败则启用 Plan B = Pi RPC 模式。

### 23 票清单（一票一文件：`docs/tickets/issues/`；索引：`docs/tickets/README.md`）

> ⚠️ 票 24（交付物：报告 / PPT / 演示视频）已由用户裁决**移除**，不纳入交付范围；
> `docs/tickets/issues/24-交付物报告与PPT与演示视频.md` **只作裁决留档**。
> 原来这里是「24 票」、README 是「23 票」、而磁盘上两个文件都在 —— 三处口径打架过，现统一以 README 为准。

- **关卡 B₁ / B（票 01–06）**：01 双端脚手架与依赖基线 · 02 Sidecar 生命周期与端口握手（**关卡 A**） ·
  03 Pi 可加载性 + esbuild 打包冒烟（**关卡 B₁**） · 04 契约冻结 + OpenAPI→TS 防漂移链 ·
  05 IPC 事件通道 + preload 白名单 · 06 对话贯通 + 学段 Prompt 注入（**关卡 B**）
- **配置与 Agent 骨架（票 07–09）**：07 设置页 + 连通性探测 · 08 主 Agent + 6 Extension 骨架 + 轨迹导出 ·
  09 Pi 会话改道 + 跨学生隔离断言 + 学习记录回流
- **数据与检索（票 10–13）**：10 教材骨架四学段 + 分块入库 · 11 RAG 四级降级链 + 学段隔离（**关卡 C**） ·
  12 知识点依赖图双用途 · 13 `rag_search` Tool + `citation` 事件
- **练习与闯关（票 14–15）**：14 练习 Extension + 客观题批改 · 15 主观题批改 + 闯关闭环（**关卡 D**）
- **多模态与编程（票 16–19）**：16 动画沙箱 + RPC + nonce 资源托管 · 17 动画模板优先 + 容错降级 ·
  18 Monaco + Pyodide Worker 隔离 · 19 编程模板 + 报错感知 + 分级求助
- **闭环、安全与收口（票 20–23）**：20 个性化闭环 · 21 学段自适应（**默认自动生效 + 学生可手动指定**；
  2026-09-17 由 D-037 定案，取代 D-020 的「无人工入口」） ·
  22 内容安全终审 + provider 边界脱敏 · 23 集成回归 + 四学段补齐 + 最终打包（**关卡 E**）
  （票 24「交付物：报告 / PPT / 演示视频」已由用户裁决移除 —— 交付物本身仍要做，只是不再作为一张票跟踪）

> **「今天做什么」看 `docs/tickets/` + 各票 `Blocked by`；「规格是什么」看执行文档；「做完没有」看执行文档第 14 节验收。**
> 切片只是执行文档的任务视图，**冲突时以执行文档为准**。
> ⚠️ 若目录里仍是删码前的旧票（如「01-恢复代码与数据基线」「02-Pi 可加载性…」），**以本清单为准**：
> 按新清单改写票文件与 `docs/tickets/README.md`，**绝不要执行旧票里的「恢复代码」步骤**。

## 3. 文档权威顺序（冲突时以此为准）

| 文件 | 角色 |
| --- | --- |
| `项目执行文档.md` | **唯一权威执行文档 v3.0（从零重建版：混合后端 + IPC-only）**（范围、契约、DDL、15 天排期、执行纪律、验收、演示脚本、风险表）。开发时**先查这一份**。Pi 迁移与混合后端四条边界已在本文件裁决完毕（§0.2 / §13.3）。 |
| `docs/业务陷阱清单.md` | 各模块**领域陷阱与业务验收口径**（与编排框架无关）。写代码时**最容易漏掉**，动手前扫一眼。 |
| `docs/tickets/` | 任务切片（一票一文件 + 索引 README），**只是执行文档的任务视图**，冲突以执行文档为准。 |
| `docs/agents/` | 工程技能约定：tracker 路径、triage 标签、领域文档消费方式。 |
| `docs/研判文档PiAgent.md` | Pi 迁移提案（含核实批注）。已归档，**含 6 项未决分叉的原始陈述**；执行文档第 13.3 节已裁决。**不要再照它实现。** |
| `docs/研判文档Deepseek.md` | 数据层、RAG、教育适配的设计依据。编排部分已被执行文档取代。 |
| `docs/项目简介.md` | 需求原文与评分标准，需求边界以此为准。 |
| `docs/研判文档Qwen3.7.md` | 早期研判，**部分结论已被取代**。仅背景参考，不要照它实现。 |

**执行文档相对研判文档的关键裁剪**（**不要「恢复」这些，是有意为之**）：
编排改用 **Pi Agent SDK（TypeScript，嵌入 Electron 主进程）**，但 **Python sidecar 保留**为数据 / RAG / 嵌入 / 判分 / 学习记录服务；
嵌入维持 **fastembed bge-small-zh-v1.5（移除 Ollama/torch）**；契约维持 **pydantic 唯一来源**；
动画维持「模板优先 + 生成补充」；检索加 FTS5 + numpy 兜底；语音降为 P2；
学段改为 **默认完全自动推断、自动生效；学生可手动指定（手动后冷却 10 轮回归自动）** ——
2026-09-17 由 **D-037** 定案（它取代了 2026-09-16 的 D-020「界面无选择入口」那一半：
D-020 曾让需求「学生可选择学段」的字面要求被主动放弃，D-037 把它收回来了）。
详见执行文档第 0 节、第 10 节与第 13 节。
**混合后端（Python + TS）是刻意取舍，不是半成品**——不要为「统一语言」把编排挪回 Python 或把数据挪进 TS。

> **决策与踩坑记录在 `docs/report-material/`（README.md / decisions.md / pitfalls.md，已建立）**，编号从 D-001 / P-001 起。
> 执行文档第 0.4 节引用的 **D-001 / D-002 / D-003 / D-009 / D-010 均已在 `decisions.md` 对号入座**：
> 需要依据时查该文件，**不要从 git 取旧素材**。

## 4. 已锁定的技术选型与硬约束

不要擅自替换以下选型，除非用户明确要求：

- 部署形态：**Electron 桌面壳 + Python 后端 sidecar**，全本地化，不做服务器部署。
- **后端混合架构（刻意的）**：**Python 做数据 / 检索 / 嵌入 / 判分 / 学习记录，TypeScript 做编排 / LLM / Prompt / Tool / 事件映射**，
  两端只经**冻结契约**通信。四条硬边界见第 5 节开头，**违反任一条即为架构事故**。
- 进程模型：**双进程 + 主进程内嵌 Agent 运行时**。
  - **Electron 主进程**：UI 壳 + sidecar 生命周期 + **Pi Agent 编排**（`@earendil-works/pi-coding-agent`）+ sidecar 的唯一 HTTP 客户端。
  - **Python sidecar**：数据 / RAG / 嵌入 / 判分 / 学习记录（**无编排、无 LLM 调用**）。
  - 二者经 `127.0.0.1` HTTP 通信（随机 token 鉴权）。
  - **渲染进程 ↔ 主进程**：**IPC 事件流**（`ipcMain` / `webContents.send` ↔ `ipcRenderer.on`），6 事件词表冻结。
  - **渲染进程不直连 sidecar**：渲染进程只走 IPC 白名单，**token 永不进入渲染进程**。
- 编排：**Pi Agent SDK**（**锁 `^0.85.1`**，0.85.0 在 Electron 里会崩）。主 Agent 由 LLM **自主选 Tool** 路由
  （**不设 `intent` 字段**），能力经 `pi.registerTool()` 暴露，共 6 个 Extension（动画/编程/练习/画像/学段/学习记录）、
  **10 个 Tool**（`AGENT_TOOL_NAMES`）。**不用 LangGraph，不用 `langgraph-checkpoint-sqlite`，不用 `SqliteSaver`。**
  **传输层是 IPC：本项目从零实现，永不写 SSE / `EventSource`。**
- **个性化记忆（D-031，两条接线，别理解成两个新机制）**：
  - **画像每轮进 Prompt**：`runtime.ts` 的 `buildSystemPrompt()` 是**唯一拼装出口**（6 个 prompt 落点共用），
    内容 = 学段（`gradeExtension.systemPromptFor`）+ **学生情况块**（`prompts/student-context.ts`）。
    块插在**学段权威段之前**（学段必须是最后一句权威指令）；两块**各自按自己的标题 strip** → 天然幂等。
    ⚠️ 块是**预取**的（`fetchStudentContext`，在 `runTurn` 里 `reviewInput` **之前**），因为拼装点有 6 个、
    且三条早退路径（输入拦截 / 无 Key / 鉴权未过）落盘的 prompt 必须与真发出去的那份**同一份文本**。
    ⚠️ 抓不到画像 → 块为**空串**，对话照常（画像只是增强，绝不阻断）。
  - **偏好写入口**：`remember_preference` Tool → `PUT /api/profile/{id}/preferences` → `profile_pref` 表。
    ★ **key 是固定词表 4 个**（`interest` / `explain_style` / `pace` / `note`，契约 `PreferenceKey`）：
    因为 key 是主键，**总条数天然 ≤ 4**、不需要清理逻辑；且「模型写掌握度」在**类型层面不可能**
    （掌握度是判分规则算出的客观量 —— 一旦模型能写，就会出现「模型觉得懂了就改分」的漏洞）。
    值限 1–40 字、**拒换行**（防长文塞进每轮 prompt）。
    守卫：`desktop/tests/student-context.test.ts`（含「6 个拼装点不许各写一份」的源码级断言）。
  - ★★ **注入块必须逐字节稳定（D-032，改这块前必读）**：块在 system prompt **之内**（system prompt 是整条请求的最前面一段，
    按「最长相同前缀」命中）—— 块里**任何每轮都变的字节**都会让它之前的内容一起前功尽弃、
    并**连同其后全部对话历史**掉出缓存（学生感觉到的是响应变慢，账单上是成本）。
    所以三条硬规则：**① 块里不放时间**（「最近活跃」已移除；`lastActiveAt` 仍在契约里给界面用，
    但**不得进给模型的那一段**）；**② 偏好按 `PREFERENCE_ORDER` 固定顺序渲染**，不用 `Object.entries`
    的原始顺序（那取决于 SQLite 行序 —— 重写同一个键就可能让整块变样）；**③ 掌握度平局按 `kpId` 兜底排序**，
    不依赖服务端返回的数组顺序。
    守卫：`student-context.test.ts` 的 **G21 组 6 条**（含**反向对照**：画像真变了块**必须**变 ——
    防「为省缓存把块冻成常量」这种假优化）。
    ⚠️ 学段模板整份替换（约 1.8k token）**是应该付的代价**，不要为缓存把它拆成「公共基座 + 风格段」
    ——「四学段语气可明显区分」是评分表上的明文验收项。
    ⚠️ 也**不要**把画像改成「每轮追加进对话历史」：内容会永久驻留并逐轮叠加（长期反而更贵），
    还会把内部画像写进学生的 Pi 会话 JSONL（破坏「画像只在数据层」的边界）。
  - **错题摘要也进这个块**（与「学习档案 → 错题本」**同一个端点** `/api/quiz/mistakes/{id}`）：
    只注入 `{知识点名, 错次}` **最多 3 条** —— 它让 `senior.ts` 那条「错题要给变式题巩固」
    从**悬空要求**变成有数据支撑的行为（此前模型手里没有任何错题数据）。
    ⚠️ **绝不注入题干（`stem`）与时间（`lastWrongAt`）**：前者稳定挤掉教材上下文，
    后者每天都在变（违反上面那条 D-032 硬规则）。守卫：`student-context.test.ts` 的 **G22 组 8 条**。
  - **教材章节 = 软偏好（D-038）**：学生可显式选定「当前在学哪一章教材」，
    它作为**软偏好**渲染进上面那个块的**固定位置**（紧跟首行标题、在掌握度之前；无章节时**整行不出现**）——
    **不做 SQL 硬过滤、不改 `RagSearchRequest`**（学生问「前面学的那个…」时硬过滤会检索不到）。
    ★ **学生的显式选择，模型不可写**：不新增 Tool、不扩 `PreferenceKey`（仍 4 个）、也不写进 `profile_pref`。
    ★ **章节清单只读 `kb.sqlite`（`kb_repo.chapters_by_grade`），「当前章节」只写 `learning.db` 的
    `student.current_chapter` 列** —— 两处不许混。
    ⚠️ **学段变更即清空当前章节**（见第 5 节第 1 条）：章节属于某一本教材，学段换了那本书就不存在了。
    章节行只在**学生改动时**变 → 不违反 D-032；守卫：`server/tests/test_chapter_selection.py`、
    `desktop/tests/student-context.test.ts` 的 **G23 组**。
- 前端（`desktop/`）：**Electron 44 + electron-vite 5 + vite 7 + Vue 3 + Pinia 4 + TypeScript 5.9（strict）
  + Element Plus 2（按需）+ lucide-vue-next**，对话优先布局，内联卡片 + 展开/全屏。
  **Electron 侧不得引入任何原生数据库模块**（刻意的风险隔离）——**Pi 迁移不影响此约束**。
  ⚠️ **不要升 vite 8**（`electron-vite@5` 的 peer 不收）、**不要升 TS 7**（`openapi-typescript` peer 为 `^5.x`）。
  ★ **界面本体由 `UI/` 原型移植而来（该目录已删除）**，三条随之而来的约定：
  - 别名 **`@/*` → `src/renderer/src/*`**（与 `@shared/*`、`@renderer/*` 并列），
    所以源码里的 `@/stores/xxx` 是合法的；引用现成文件时优先跟随**该文件已有的**相对写法。
  - **Element Plus 组件与 Vue/Pinia API 由 `unplugin-*` 自动导入**（`electron.vite.config.ts` 的 renderer 段）——
    用 `<el-button>` 不必 import、写 `ref()` 不必 import。生成的两个 `.d.ts` 落在
    `src/renderer/src/types/`（守卫会扫它们，实测干净；若哪天脏了，改 dts 输出路径到 `desktop/src/types/`）。
  - **仍然没有 vue-router，且不引入**：导航的唯一真相是 `stores/ui.ts` 的 `PAGES` + `go(page)`。
    Electron 单窗口没有 URL / 后退 / 深链需求；引进来会造成「router 与 store 双真相」，
    并让 `ui-shell.test.ts` 与 `verify-ui.mjs` 的 `view-entry` 循环同时失效。
  - 设计令牌是 **`--k12-*`**（`assets/tokens.generated.css` 由 `scripts/design/gen-tokens.mjs` 生成，
    **不要手改**；改色改 `scripts/design/tokens.source.json` 再跑 `npm run gen:tokens`）。
    版式契约见 `docs/ui/版式契约.md`。
    ★★ **字号阶梯（D-043，改前必读）**：正文 **16px**，全 8 档写在 `assets/base.css` 的 `:root`，
    **不要在页面里写 `font-size: <数字>px`**（写死的值在抬字号时会裁字 / 错位，见 P-071）。
    三条关系必须成立：**顶栏页面名 17px < 内容区身份行 24px**；**正文 16px > 任何 meta 13px**；
    **`--k12-fs-micro` 12px 只给 ≤4 字角标**（id / 说明 / 关系名一律 `--k12-fs-xs`）。
    ★ 抬字号的连锁代价：**容器尺寸要跟着长**（侧栏 264 / 顶栏 72 / 阅读栏 880 都是这么来的），
    并且要逐页真的看一遍 —— 固定高度会裁字、窄栏里的 `align-items: center` 单行会在折行后错位，
    这两类问题 typecheck 与单测**都覆盖不到**。
- 后端（`server/`）：**Python 3.12（uv 锁定）+ FastAPI + uvicorn + pydantic v2**。
  契约文件是 **`server/app/contracts.py`**；UTF-8 stdio 强制在 **`server/app/console.py`**。
- 契约：**pydantic 模型是唯一契约来源**（`server/app/contracts.py`）→ FastAPI 自动产出 OpenAPI →
  `openapi-typescript` 生成前端 TS 类型。
  **Pi Tool 参数用 TypeBox `TSchema` 声明，必须与 pydantic 模型做一致性断言**（防静默漂移）。
- 数据（**三处分离**）：
  - `kb.sqlite`（全局只读）：教材 chunk、embedding、依赖图、题库。
  - `learning.db`（每人一份）：画像、掌握度、学习历史、进度、学段信号与轨迹。
  - **Pi JSONL 会话树**（每人一份）：对话历史、工具调用记录、分支。
  - **必须显式配置 Pi 的 `agentDir` / `sessionDir` 落到 `students/<id>/pi-agent/`**，
    否则会写进用户全局 `~/.pi/agent/`，造成跨学生数据混放（合规硬伤）。**SQLite 不存对话正文。**
- 主模型：**DeepSeek 云端 API**（OpenAI 兼容），必须支持下改**供应商 / BaseURL / APIKey / Model ID**。
  ★ **配置的权威源是设置页**（`userData/config.json`），Pi 的 `models.json` 只是**由它派生的产物**
  （每次建会话 / 保存设置都重写）—— 不要再去手改 `models.json`，也不要让它变回「存在就不动」。
  ★★ **默认值必须与 Pi 内置目录一字不差**：`provider_id="deepseek"` /
  `base_url="https://api.deepseek.com"`（**无 `/v1`**）/ `model_id="deepseek-v4-flash"`。
  ⚠️ 历史默认 `deepseek-chat` **不在 Pi 的模型目录里**（那里的 deepseek 只有
  `deepseek-v4-flash` / `-vision-exp` / `-pro`），会让首轮对话直接抛「Pi 里找不到模型」（P-048）。
  两种 `/v1` 写法都可能连通，**保存时必须做真实连通性探测**，不要静默改写用户填的地址。
- **供应商预设与拉取模型**：Pi 自带 40 个 provider 的目录（端点 + 模型清单），
  用 `ModelRuntime.create({ modelsPath: null })` **离线**读出来（不碰 `~/.pi`），
  设置页的预设下拉与「拉取模型」都基于它。自定义/校内网关（`providerId` 自取，如 `custom`）
  **必须写 `models[]`**，否则该 provider 一个模型都没有 → 建会话失败。
- 嵌入：**fastembed `BAAI/bge-small-zh-v1.5`（512 维，ONNX，约 90MB）**。**不引入 torch，不依赖 Ollama**。
  维度写在配置常量里，勿散落硬编码；升级 `bge-base-zh-v1.5`（768 维）须同步改 `vec0` 维度并重建索引。
- 动画：**Anime.js v3**（**锁 v3，v4 API 不兼容**），运行在 sandboxed iframe。
- 编程：**Monaco Editor** + **Pyodide**（独立 Web Worker，资源本地自托管，不依赖 CDN）。
- 语音：**P2 后置**（Python 下可用 `sherpa-onnx` pip 包低成本回捡）。
- 硬件：**纯 CPU，无 GPU**。所有本地模型/推理必须 CPU 可跑。
- 教材来源：**根目录 `K12KnowledgeBase/`（用户提供的成品库）经 `server/scripts/import_knowledge.py` 导入**，
  加一章本项目自写的补充章（第 8 章「编程实践」，源在 `server/knowledge-supplement/`）。
  **形态是人工编写的 Markdown + 元数据文件，不做 PDF 解析。**
  ★ **当前规模（2026-09-19 整体替换后的唯一口径）**：**57 个概念 × 四学段 = 228 个知识点 / 8 章 / 483 条依赖边**；
  每个学段各 57 个知识点（同一批概念、深浅不同），不再是「按学段分配不同知识点」的旧结构。
  kp_id 形如 `<slug>-<pl|ph|jr|sr>`（`ai-definition-pl` / `prog-loop-jr` / `transformer-sr`）。
  导入脚本把「1 概念 1 文件（内含四学段小节）」拆成「1 概念 1 学段 1 文件」写进
  `server/knowledge/{primary-low,primary-high,junior,senior}/`，文件名 = kp_id，**幂等可重跑**。
  依赖图由该脚本生成（概念内 `X-pl→X-ph→X-jr→X-sr` 成链 + 概念间按源库 related 连同学段，
  每条边严格增大「概念序号, 学段序号」→ **结构上无环**，实测 `find_cycles()` 返回空）。
  ⚠️ **不是「唯一根」**：实测有 **6 个入度为 0 的起点**（`ai-definition-pl` / `narrow-ai-pl` / `data-pl` /
  `computing-power-pl` / `speech-recognition-pl` / `short-term-memory-pl`）——
  「推荐路径」要按学生已掌握的前缀分别取后继，不要假设「一切都从 `ai-definition-pl` 展开」。
  术语表 `server/knowledge/terminology.json` 的 `min_grade` 也由它**从正文实际位置推导**（当前 43 条）。
  ⚠️ 由此有三条不可违背的推论：① **改教材 = 重跑 `import_knowledge.py --write` 再 `build_kb`**，
  不要手改 `server/knowledge/` 下的文件（会被下次导入覆盖）；② 新增/改名概念必须同时更新
  `import_knowledge.py` 的 `SLUGS`（全库 id 的唯一映射表）与依赖清单，否则题库 / 模板的 `kp_id` 对不上；
  ③ 章节排序只认阿拉伯数字 `第N章`（`kb.py` 的 `_CHAPTER_NUMBER_RE`），
  **源库的中文序号（`第一章.…`）由导入脚本 `normalize_chapter()` 转换** —— 中文序号会让章节排到列表末尾。
  ⚠️ `server/knowledge/README.md` 正由另一处在改，**当前规模口径以本节为准**（它是导入前的旧版描述）。
- 题库：`server/resources/quizbank/` 为**一章节一文件** `ch01.json`…`ch08.json`（共 684 题，每个 kp 恰好 3 题）。
  `app/routes/quiz.py` 的 `load_bank()` 支持两种形态 —— 有文件级 `grade_level` 的旧形态，
  与有 `chapter` 的章分片（逐题按 kp_id 后缀 `grade_from_kp_id()` 推学段）。**新库只有后者。**
- 代码模板：`server/resources/code-templates/` 只有 **3 份、都是初中**（`prog-variable-jr` / `prog-loop-jr` / `prog-list-jr`）——
  只有第 8 章「编程实践」配有模板（源库是通识概念课，没有编程内容）。
- 动画模板 **8 份**（`server/resources/templates/`），`kp_ids` 已重挂到新知识点。
- 范围裁剪：核心只做 4 种交互（对话问答、动画讲解、编程环境、游戏化练习）；**绘本生成、多模态教学资源推荐明确砍掉**。
  **不引入 `pi-subagents`**（非官方第三方包；Pi 官方哲学即「No sub-agents」），SubAgent 用自有 Extension 实现。

### ★ 关键重命名表（旧文档 / 旧票里的名字一律以下列新名为准）

| 旧名（历史文档中出现） | 新名（以新名为准） |
| --- | --- |
| `server/app/models.py` | **`server/app/contracts.py`**（pydantic 唯一契约来源） |
| `server/app/encoding.py` | **`server/app/console.py`**（UTF-8 stdio 强制） |
| `server/app/sse.py` | **删除**（本项目不存在 SSE，不要重建） |
| `desktop/src/main/sidecar-logic.ts` | **`desktop/src/main/sidecar/protocol.ts`**（纯逻辑，可单测） |
| `desktop/src/main/sidecar.ts` | **`desktop/src/main/sidecar/manager.ts`**（进程生命周期） |
| `desktop/src/main/agent/stream.ts` | **`desktop/src/main/agent/events.ts`**（事件映射） |
| `desktop/src/renderer/src/api/sse-parser.ts` | **`desktop/src/renderer/src/api/events.ts`**（IPC 事件解帧） |

**新增（无旧名）**：`desktop/src/main/bridge/client.ts`（唯一的 sidecar HTTP 客户端）、
`desktop/src/main/ipc/channels.ts`（IPC 通道名单一来源）、`desktop/src/shared/ipc-events.ts`（6 事件 TS 类型）、
`desktop/src/main/settings/runtime-config.ts`（**设置 → Pi 的唯一桥梁**：取「生效中的 LLM 配置」，含明文 Key）、
`desktop/src/shared/provider-catalog.ts`（供应商预设 / 拉取模型的跨进程类型；**非 pydantic 契约**，
因为那份数据只存在于 Pi 的 TS 目录里 —— 理由见文件头）。

> **Tool 名与 6 事件名不变**——它们是**契约**而非命名，改名会同时打断 Python、Pi 与前端三方。若文档里出现旧文件名，按上表直呼新名。

## 5. 架构边界与层规则（改动时必须遵守）

**★ 混合后端四条硬边界（动手前先看，违反任一条即为架构事故）**

- **数据域 → 只在 Python**：`kb.sqlite` / `learning.db` 的读写、检索与四级降级链、嵌入与向量索引、判分规则、
  学习记录落库，全部在 `server/`。**TS 侧不得读写 SQLite、不得自己拼 SQL、不得自己算向量**。
  降级链必须在 Python **一次调用内**走完，TS 只读结果里的 `degraded: "vector"|"cloud"|"fts"|"outline"` 并原样展示。
- **编排域 → 只在 TypeScript**：主 Agent 编排、路由、System Prompt、Tool 定义与注册、6 事件映射、Pi 会话管理，
  全部在 `desktop/src/main/`。**Python 侧不得调用任何 LLM**，**不得安装 langgraph / langchain**（编排类库一概不装）。
- **契约面 → 只走冻结契约**：跨语言交换一律 pydantic（`server/app/contracts.py`）→ OpenAPI → 生成 TS；
  **禁止手写 TS 接口兜底、禁止临时加松散字段**。
  ⚠️ **唯一例外（有意为之，且只此一处）**：`desktop/src/shared/provider-catalog.ts` 手写两个 TS 类型。
  理由是那份数据**在 Python 侧根本不存在** —— 它是 Pi（TS 包）自带的 provider 目录，
  只有主进程能读到。把一份 TS 独有的形状塞进 pydantic 契约，等于给「pydantic 是唯一来源」
  这条规则开一个更坏的口子（TS 从此也能「凭需要造契约」）。
  该例外有两条硬约束：① 只承载**界面展示用的候选清单**，不参与持久化与任何业务判定；
  ② 里面**不允许**出现任何凭证字段（Key / token），G13 守卫盯着。
- **执行面 → 只在渲染进程**：学生代码只在渲染进程的 **Pyodide Worker** 执行，**绝不在主进程**（也不能落到 Python 进程）。

以下为原有层规则：

1. **学段：默认自动推断 + 学生可手动指定（D-037，2026-09-17 定案；它取代了 D-020 的「无人工入口」那一半）**：
   两条写路径，**同一个决策者与同一列**（`student.grade_level` + `grade_history`）：

   | 路径 | 谁触发 | `source` | 生效时机 | 冷却窗口 |
   | --- | --- | --- | --- | --- |
   | **自动**（默认） | 四类规则信号每轮写入 `grade_signals`，第 3 轮（不足则第 5 轮）跑一次轻量 LLM 判定 | `inferred` | 下一轮（`before_agent_start`） | `COOLDOWN_TURNS` = 5 |
   | **手动** | 学生点指示器或设置页 → `grade:set` → `POST /api/grade/override` | `explicit` | **立即** | `MANUAL_COOLDOWN_TURNS` = 10 |

   **规则引擎一个字没变**（`server/app/grade/rules.py`：置信度 < 0.6 不改 / 连续 3 轮同向 / 单次最多动一级 /
   LLM 与规则反向即否决）—— 手动路径**不经过** `decide()`，它写库、报冷却，由现有的冷却机制接管。
   **冷却窗口按来源推导**（锚点 = 最近一条 `from_level` 非空的 `grade_history` 行），**刻意不加列**。
   SubAgent 不得自行推断或改写学段。

   ★★ **三条硬约束（违反即架构事故）**：
   - **不把 `gradeLevel` 加回 `ChatSendRequest`**（G6c 钉死字段集合恰好是 `['text']`）。手动走**独立通道** ——
     加回请求里会让「发一条消息」变成「顺带改一次学段」的副作用。
   - **不新增表或列**（冷却长度可从来源推导；加列会引入第二处真相）。
   - **手动选择不写 `grade_signals`**（信号是「观察到的证据」，手动是「学生的意图」；混进去会污染连续同向计数）。
   - ⚠️ **在途的自动判定不得覆盖手动选择**：`grade.ts` 的 `epoch` 在 `adoptOverride` 时 +1，
     上交任务 `await` 前后比对，不一致就丢弃结论（与「跨学生丢弃在途证据」同一手法）。

   **已知代价（不要粉饰）**：学生可能把自己锁在错档位最多 10 轮。兜底：冷却期**不是**关闭自动（期满立刻按
   积累的证据判定，期间信号照常收集）；学生**随时可以再改**（重复选择写新锚点、冷却重新计时）。
   ★ 与 D-020 相比的**收益**：需求原文「学生可选择所在学段」**重新被字面满足**，四学段对比演示重新有 UI 入口。
   ★ **教材章节与学段相互独立（D-038）**：选章节**不改学段**；反过来，**学段一变就清空当前章节** ——
   章节属于某一本教材，学段换了那本书就不存在了，留着就是第二处真相。
   写学段的地方只有**两处**（`server/app/grade/rules.py` 的 `_apply()` 与 `override_level()`），
   **都要清 `current_chapter`**：自动路径只在 `decision.changed` 为真时被调用（直接改语句）；
   手动路径按 `changed` 分成**两条 SQL**（改学段的那条才带 `current_chapter = NULL`）——
   重复确认同一学段 = 学生确认现状，**不得**顺手清掉他已选的章节。
   ⚠️ 因此按字面 grep `UPDATE student SET grade_level` 会数到 **3 行**（`override_level()` 占两条），
   这不是「多了一处落点」。
2. **主 Agent 负责路由与对话答疑**：路由交给 LLM 自主选 Tool；
   **但关键约束必须在代码层强制**——学段隔离在 `rag_search` Tool 内由 Python 强制（模型改不了 WHERE），
   安全终审是独立步骤，沙箱是运行时属性，Tool 参数由 TypeBox 校验。**不要把这四条也交给模型。**
3. 所有跨语言/跨模块调用走**冻结的接口契约**（pydantic 唯一来源，前端用生成 TS 类型）；禁止临时加松散字段。
   **Pi Tool 的 TypeBox 参数也必须纳入契约一致性断言。**
4. **RAG 检索严格按学段隔离**，允许向上兼容但必须显式标注 `compat`。
   学段过滤**必须写在 SQL 层**（不能只在应用层筛，否则早被 KNN top-k 截断）。
   **四级降级链（vector → cloud → FTS5 → 依赖图/大纲）必须在 Python 侧一次调用内完成**，
   不要让编排层感知降级；结果带 `degraded` 字段供轨迹图展示。
5. **内容安全只做后端审核**，采用「流式输出 + 生成结束后整段终审」，违规则撤回并替换为安全提示（`blocked.safeText`）。
6. 知识点依赖图**同时**服务于推荐路径规划与检索上下文扩展，两个用途都要保留；导入阶段用 DFS 检测环。
7. 沙箱隔离是硬要求：动画在 sandboxed iframe（**禁止加 `allow-same-origin`**），Pyodide 在独立 Worker，
   **不得与侧车进程或主线程共享执行环境**。
   ⚠️ **Pi 的 Extension 与 Agent 同进程且拥有完整系统权限**，因此
   **「学生代码绝不在主进程执行」上升为硬约束**——`evaluate_code` 必须把代码经 IPC 交给渲染进程的
   Pyodide Worker 执行，结果回传。**这条要有架构守卫测试。**
8. **每个学生独立存储，不得跨学生共享或复用连接/数据**（一人一库；Pi 会话一人一目录，**必须显式改道**）。
9. **LLM 与嵌入模型不得明文写入日志**；API Key 仅本地存储。
   除既有日志过滤器外，**Pi 侧用 `before_provider_request` / `before_provider_headers` 在 provider 边界做第二道脱敏**。
10. **Python 代码不得裸 `python` 执行**——本机 `python`/`py` 指向损坏路径，一律用 `uv run`。
11. **必须设 `systemPromptOverride`**：Pi 官方 issue #6308 —— SDK 嵌入时默认 system prompt 会
    **泄漏宿主应用的安装路径**给模型。
12. **Pi 配置必须隔离**：`ModelRuntime.create({ authPath, modelsPath })` 与 `DefaultResourceLoader({ agentDir })`
    指向本应用自己的目录，**不得读写用户的 `~/.pi/agent`**。
13. **`session.dispose()` 必须在 `before-quit` 调用**，否则 JSONL 可能半写。
14. **Pi Tool 的 `execute()` 必须自己兜异常**（返回可读错误而非抛出）——Pi 与 UI 同在主进程，抛异常会同时带走两者。

## 6. 编码约定

- **接口先行**：先冻结 pydantic 契约（`server/app/contracts.py`，含 6 个事件枚举），各模块再并行实现；
  改了模型必须重跑 OpenAPI → TS 生成（`--check` 做字节比对），并跑 Tool TypeBox 一致性断言。
- **事件词表固定 6 个**：`delta | citation | payload | blocked | done | error`，**冻结**。
  传输层是 **IPC 事件流**（主进程 `webContents.send` → preload 白名单 → 渲染进程 `ipcRenderer.on`）；
  **本项目从零实现，永不写 SSE / `EventSource`**。
  **守卫测试写成正向断言**：「聊天事件流必须经 preload 白名单 IPC 通道送达」（通道名取自
  `desktop/src/main/ipc/channels.ts`，事件名必须是 6 词表之一，payload 结构走生成类型）。
- **架构守卫（一律正向断言，见票 04 / 09 / 18）**：
  ① 聊天事件流必须走 preload 白名单 IPC 通道；② 学生代码执行必须经 IPC 落到渲染进程 Pyodide Worker；
  ③ Pi 会话文件必须落在 `students/<id>/` 内。**不要写成「禁止某历史实现」式断言**。
- **事件来源映射（票 08 依据）**：`delta`←`message_update`；`citation`←`rag_search` 结果；
  `payload`←`tool_execution_end`（按 Tool 名映射 `kind`）；`blocked`←安全终审；
  `done`←`agent_end`；`error`←provider/Tool 异常或降级。映射实现在 `desktop/src/main/agent/events.ts`。
- **Tool 名 → 事件 `kind` 映射冻结**（新增 Tool 必须同步登记）：
  `generate_animation→animation`；`get_code_template`/`get_coding_hint`/`evaluate_code→coding`；
  `generate_quiz`/`submit_quiz`/`generate_variants→quiz`。
  ⚠️ **不发 `payload` 的 Tool 明确不在表内**：`rag_search`（走 `citation`）、`get_student_profile` 与
  `remember_preference`（只影响 Prompt / 只写库）。**不要**为了「整齐」把它们塞进 `TOOL_TO_KIND`。
- SubAgent 输出用统一 pydantic Payload（`AnimationPayload` / `CodeTemplate` / `CodingHint` / `CodeEvaluation` / `QuizPayload` / `QuizResult`），不要用松散 dict。
  **不要引入 `ModuleResult<T>` / `ModuleError` 那套 `{success, error}` 包装**——失败统一走 `error` 事件（带 `degraded`），否则前端要处理两套失败形态。
- **答案泄漏防护**：`QuizQuestion`（含 `answer`）**只留 Python 侧**，发给前端/TS 的一律是 **`QuizQuestionOut`（无 `answer`）**——
  **两个模型都要在 `contracts.py` 显式声明**，不要靠 `exclude=True` 临时裁剪（执行文档 §6.3）；判分只走后端 `/api/quiz/grade`。
- 字段命名：Python `snake_case`，出参统一转 `camelCase`（pydantic alias），前端统一 camelCase。**只做一次约定，不要两边混用。**
- 检索 chunk 元数据 schema 固定：`chunk_id, text, embedding, grade_level, chapter_title, section_title, knowledge_point, content_type, parent_chunk_id, token_count`；
  节级 chunk 控制 300–600 token，父子 chunk（小子块检索、命中回父块作上下文）。
- 数据合规：K12 涉未成年人数据，**最小化采集，不采集生物特征**。
- **中文输出**：仓库文档、面向学生与家长的文案、System Prompt 均为中文；代码标识符与提交信息可用英文。
- ★★ **双视角纪律（D-063，加任何「给评委看」的内容前必读）**：
  界面上有两类读者 —— **学生**（日常使用）与**老师 / 评委**（看设计证据）。
  **证据不是删掉，是默认不给学生看**：
  - 技术 / 运维 / 实现细节一律包进 `<TeacherGate>`（`components/TeacherGate.vue`），
    它是渲染侧**唯一**的开关（自带 `data-teacher` 标记，验收脚本按它量）；
  - 学生那一半必须给**人话替代**（「隔离在 SQL 层强制，模型改不了 WHERE」→
    「团团这次只用了初中和更低学段的教材，不会超纲」），**不能只是隐藏**；
  - 开关入口**只在设置页的「高级设置（教师 / 答辩）」**，顶栏与侧栏不放；
  - ⚠️ **这是「防误入」，不是权限系统**：本应用没有账号体系，渲染进程里的开关
    都是可绕过的。文档与答辩口径都不许说成「权限隔离」——真正被强制的边界仍然
    只有三条（学段隔离在 SQL / 判分只在 Python / 代码只在渲染 Worker）。
  - 守卫：`tests/student-view-discipline.test.ts`（21 条）+ `npm run ux:student`
    （真机扫描，**含教师视角反向对照**：证据必须还在）。改文案后跑 `npm run guards:mutation`。
- ★★ **学生界面不得出现技术词 / 内部 id（同一条纪律的落点）**：
  `SQL` / `FTS5` / `WHERE` / `regex` / `kp_id` / `kb.sqlite` / `Pyodide` / `nonce` /
  `sandboxed` / `POST /api` / `HTTP 200` / `端点` / `契约` / `兜底` / `降级链` /
  `向量维度` / `分块` / `端口号` / `进程号` —— 以及**知识点 slug**
  （`ai-definition-jr` 这种）与 **qid**（`gen-ai-definition-jr-…`，它里面就嵌着 slug）。
  ★ **取名字的唯一口径是 `study/kp-label.ts` 的 `kpLabel()`**：
  有中文名用中文名，**取不到就给中性标签或整格不渲染，绝不回落成 id**
  （回落是这类泄漏最常见的成因：平时看不出来，教材换代后才露出来）。
  ★ **插值也算**：`{{ row.kpId }}` 在源码里是表达式，扫描器看不见它 ——
  所以另有一条守卫专门盯「把 id 直接插值出来」（`student-view-discipline.test.ts` 的卡片那条）。
  ★ **历史回看的每一条路都要过译文**（`stores/chat.ts` 的 `studentFacingUserText`）：
  JSONL 里存的是发给模型的 wire 原文，只挡实时路径等于从后门漏
  （对话页两处恢复 + 档案页「历史会话」共三条，见 P-110）。
- ★★ **去告诉学生的话不许超出代码的承诺**：写「不会上传」「只在本机」这类句子时，
  必须核**同一屏上的每个按钮**。实例：编程卡片写过「代码…不会上传。卡住就点『求助』」，
  而那个「求助」会把代码前 400 字发给模型（P-110）。
  判据：这句话在**这条路径**上成立吗？换个入口还成立吗？不成立就别印在面板上。
- **学段语气**：System Prompt 按学段差异化（童话拟人 / 严谨逻辑推导），不要只改难度数字而忽略语气。
  四学段各一份模板放 `desktop/src/main/agent/prompts/`。
- **学段的手动写入只走 `grade:set` 独立通道（D-037）**：**绝不能把 `gradeLevel` 加回对话请求** ——
  `ChatSendRequest` 的字段集合被守卫 **G6c** 钉死为 `['text']`，加回去会让「每轮对话」变成「每轮改学段」的副作用。
  前端既**不推断**学段（那不是它的事），也**不自己改本地状态** —— 它只把「学生选了什么」递给主进程，
  生效逻辑全在服务端（`rules.override_level`）。阈值（`CONFIDENCE_THRESHOLD` / `COOLDOWN_TURNS` /
  `MANUAL_COOLDOWN_TURNS` / `MAX_STEP_LEVELS`）只写在 `server/app/grade/rules.py` 里，**别处不得再写字面量**。
- **学习档案（D-033）**：四个只读聚合端点的**聚合与判定全在 Python**（连续天数、正确率、章节排序、
  错题归并、依赖图分层），渲染进程只显示；**导出成 Markdown 的拼装放在渲染进程**
  （`study/report-markdown.ts`，纯函数）—— 它是展示文本，不参与持久化/推荐/Prompt。
  ⚠️ 章节清单来自 `kb.sqlite`、学生进度来自 `learning.db`，**不要把教材清单存进学生库**。
  ⚠️ 章节顺序**只能按章号解析**（`第N章`）：既不能按标题字典序，**也不能按 rowid**
  （rowid 是文件名字典序，实测会排成 `1,6,1,3,5,2` —— 见 P-057）。
- **历史会话：回看 + 切换续聊 + 启动恢复（D-034，2026-09-19 补齐）**：
  `session:transcript` 与 `session:open` 都**只接受会话 id，绝不接受路径** ——
  主进程先用 `SessionManager.list()` 的结果做白名单对齐，再用 **Pi 给的 `path`** 打开。
  ★★ 四条新通道：`session:open` / `session:new` / `session:state`（三条 invoke）+
  `session:changed`（**推送**，唯一的 session 推送通道 —— 五条 invoke 不许进 `PUSH_CHANNELS`）。
  ★★ **切换 = dispose 旧的 + 装配新的**，顺序不能反（`swapToSession()`）：
    不 dispose 会让旧 JSONL 半写；先装配后 dispose 会让并发取数拿到旧实例
    （表现是「会话切了一半，有的调用用新会话、有的用旧的」）。
  ★ **冷启动来源是 `'recent'`**（`sessionSourceForBoot()`，`K12_NEW_SESSION_ON_BOOT=1` 可改回
    `'new'`）—— 这一条就是「重启后数据延续演练」达标的落点（已实测：重开应用恢复出
    66 轮的历史会话）。
  ★★ **`cwd` 必须由 `piSessionCwd(paths)` 统一给出**（建会话与**列**会话共用）：
    Pi 的 `list(cwd, sessionDir)` 在传了自定义 `sessionDir` 时**会额外按 cwd 过滤**
    （且不报错）—— 两处写不同的值 = **列表恒为空**（实测踩到：改前列表永远是 0 条，
    而磁盘上有 19 个会话文件。见 P-102）。
  ★★ **三种会话来源（`create` / `continueRecent` / `open`）都必须传 `paths.sessionDir`**
    并过 `assertSessionManagerIsolated`，三者收敛在**同一个** `openSessionManager()` 里。
    漏传 `open` 那份最严重：新建只是写错地方，**恢复是读到别人的会话**（G9-3b 有断言）。
  ★ `session:state`（挂载时读）**会装配** —— 恢复出来的正文只有主进程手里有；
    不装配就回空，学生看到的是「关掉应用再打开，上一段对话消失了」（数据其实还在盘上）。
- ★★ **会话分叉（「从这里重新问」，D-059）**：`session:branch` 一条新增通道
  （**invoke**）。底层是 Pi 的 `createBranchedSession(entryId)` —— 它是**复制**
  （写一个新 JSONL，头里记 `parentSession` 指回原文件），**原会话一个字节不动**。
  ★ **分叉点用「条目 id」而不是「第几条消息」**：编号会漂（开场引导是一条 assistant
    消息但不算一轮；失败/被拦下的轮次不留条目）—— `TranscriptMessage.entryId` 才是稳定标识。
  ★★ **两道校验缺一不可**（`handlers.ts` 的 `branchFromMessage`）：
    `sessionId` 走会话白名单；**`entryId` 必须属于那条会话**（先按 id 读回条目再对齐）——
    少了后者就能「拿 B 会话的 id 去分叉 A」（`createBranchedSession` 只认 id、不认归属）。
  ★★ **先分叉、后 dispose**（顺序有断言）：分叉只是写文件，失败时当前会话毫发无损；
    反过来的话一次失败会让学生连当前对话都没了。
  ★★ **会话树（`projectSessionTree`）**：Pi 的分叉产生的是**新文件**，
    所以「树」在存储层就是「一串带 `parentSession` 指向的会话」；投影把它摊成
    **深度优先的扁平数组 + `depth`**，界面按 `depth` 缩进、按 `guides` 画连接线。
    - `depth` 缩进 / `guides[]` 每层竖线 / `childCount` **只数直接子**（0 就不给箭头）
      / `parentTitle` **父不在列表里时不填**（否则是个点不开的入口，那是谎话）；
    - ★★ **排序用「子树里最新的 mtime」而不是各自的 `modifiedAt`**：
      从旧会话分叉出的新会话不会因为**父文件 mtime 不变**而沉在列表底部；
      **没有分支时它退化成「按 mtime 倒序」**，所以老学生看到的顺序不变（不是洗牌）；
    - ★ **必须断环**（A→B→A）：`parentSession` 是读来的字段，手改过的文件可能造出环，
      不断就是**栈溢出**（实测 `RangeError`）—— 一个坏文件不该让整个列表打不开；
    - 界面：**折叠箭头与条目是两个按钮**（合成一个 → 「想展开却切了会话」），
      收起一个节点藏的是**整枝**（判据是「任一祖先被收起」）。
  ★★ **实时轮次也必须能分叉**（`turn:entries` 推送，P-105）：`entryId` 原先只由
    「恢复历史」那条路填，于是按钮**只对历史消息出现**、对刚聊出来的回答不出现。
    主进程在每轮结束后推该轮的 `{userEntryId, entryId}`（按 `requestId` 配对）；
    渲染进程要**缓冲超前到达**的那条（推送可能早于 `sendChat` 的回执）。
  ★★ **恢复历史要配成轮次**（P-106）：`restoreConversation` 里一问一答是**一轮**，
    不是两条各占一轮 —— 初版那样写，界面长成「一半一半」（一轮只有学生气泡、
    下一轮只有回答）。配对时别把学生那半丢掉。
  ★★ **分叉后侧栏要刷新**：判据是 `currentSessionId` **变了**（不是 `messageCount`
    边沿）—— 分叉出来的会话**天生带着历史**，条数一开始就 > 0，
    所以「0→N」那个边沿**不发生**（实测：分叉后列表里找不到刚分叉出来的那条）。
    同时要把它祖先链**从 `collapsed` 里移除**，否则被折叠的父会把它挡住
    （表现与「没刷新」一模一样）。
  守卫：`desktop/tests/session-branch.test.ts`（23）+ `session-tree.test.ts`（14，
  含 4 组变异验证：家族排序 / 断环 / 折叠只看直接父 / 忘加 `.stop`）+
  `npm run ux` 的 D7–D12 六项（真跑界面数按钮、量缩进与连接线宽度、验折叠真的藏整枝）。
- ★★ **主动发起对话（D-055，需求原文「智能体也能主动发起对话引导学习章节内容」）**：
  全项目**唯一一处「AI 先开口」**。服务端 `GET /api/profile/{id}/opening` 用**模板拼接**
  （`routes/profile.py` 的 `_opening_text`，复用 `_recommendation_summary` 的措辞）——
  **不调 LLM**：它在「新建会话」这条路上，零延迟 / 断网可用 / 无成本三条都重要。
  ★ 主进程**只在 `messageCount === 0` 时发**（`swapToSession()` 里那一行）：
  不是「刚刚新建」（切到一条空的历史会话同样该开场），不是 `getEntries().length`
  （那里面还有 `model_change`，开场**永远发不出来**）。
  ★★ **冷启动不发**（`session:state` 回空串）：那份恢复出来的历史里本来就有当时发过的那条，
    再发一次就是「每次开应用都看到同一句招呼」。
  ★★ 写进 Pi 会话用 **`appendMessage` + `role: 'assistant'`**，
  **不许**用 `custom_message`（Pi 的 `convertToLlm` 会把它变成 **user** 消息 ——
  模型以为「从X开始吧」是学生说的，属伪造对话记录）。
  ★ 三种来源三种说法、`source == 'empty'` 时 `text` 为空串 → 前端**不发**（不硬凑寒暄）；
  无 `kpId` 时不渲染动作按钮（点了什么都不发生）。
  ★ `fetchOpening` 全仓**只有一个调用点**（切换/新建那条路）：每轮对话都不许碰它。
  `usage` 全 0 **是事实**（模板拼出，没花 token）。
  守卫：`server/tests/test_opening_guidance.py`（13）+ `desktop/tests/opening-guidance.test.ts`（12）+
  `desktop/tests/session-switch.test.ts`（16）+ `desktop/tests/session-boot.test.ts`（7）。
- **导出文件名用白名单重建（D-035）**：`sanitizeFileName()` 只保留
  「汉字/字母/数字/空格/`-`/`_`/`.`」并可强制 `.md`；回执**只回文件名**（完整路径不进渲染进程）。
- **学习地图自绘内联 SVG（D-036）**：**不引入任何图表库**（零新增依赖 + 断网可用）；
  布局是纯函数（`study/map/layout.ts`），箭头永远向下、同层按 kpId 排、直角折线。
- **学段手动入口（D-037）**：两处入口（`GradeIndicator.vue` 点开 + `Settings.vue` 的「学段」区块）
  **必须共享同一个 store action `chat.setGrade`** —— 各写一份就会出现「一处改了另一处没同步」。
  指示器上要有**来源标签**（`gradeOriginLabel()`，唯一实现在 `labels.ts`）：
  「手动选中」/「AI 引擎推算」，否则学生点完看不出到底生效没有。
  ★ **选项默认收起**（点触发器才展开）：展开是**学生主动动作**的结果，
  而不是顶栏上一直摊着一个选择控件。
  ★ **`gradeHistory` 的 `source` 有两种取值**，报告叙事要分清
  「第 3 轮系统判定为初中（inferred, 0.81）」与「第 8 轮学生手动选为小学低年级（explicit）」。
- **教材章节（D-038）**：章节是**软偏好**，不改检索契约、不做 SQL 硬过滤（见第 4 节）。
  ★ **手动写入只走 `chapter:set` 独立通道**，**绝不混进 `ChatSendRequest`** ——
  G6c 仍钉死那个请求的字段集合为 `['text']`，混进去会让「发一条消息」变成「顺带改一次章节」的副作用。
  ★ **两处入口（对话页 `ChapterIndicator.vue` + 设置页的「章节」区块）必须共用同一个
  store action `chat.setChapter`** —— 与 `chat.setGrade` 同一条纪律，各写一份会出现「一处改了另一处没同步」。
  学生身份由主进程决定（`chapter:get` / `chapter:set` 都不接受渲染进程递来的 `studentId`）。

## 7. 开发与打包命令

双端骨架建成后（票 01 起）逐步可用；**脚本统一放 `server/scripts/`，不要手敲 pyinstaller、不要在仓库根建脚本**：

```bash
# ── 后端（数据/RAG/嵌入/判分/学习记录）──
cd server
uv sync
uv run uvicorn app.main:app --reload --port 8756     # 开发用固定端口
uv run python scripts/fetch_embedding_model.py       # 联网获取 bge-small-zh-v1.5（约 90MB）
uv run python scripts/export_openapi.py              # 导出 OpenAPI → 生成前端 TS 类型
uv run python scripts/make_brand_icons.py            # 从 logos/ 生成打包图标 + 学段 logo（改了 logo 就跑）

# 后端打包（--onedir，不用 onefile）——统一走脚本，不要手敲 pyinstaller
uv run python scripts/build_server.py                # 建库 + 打包 + 26 项产物自检（含指纹新鲜度）
uv run python scripts/build_server.py --verify       # 只自检已有产物（产物过期会**响亮失败**）
uv run python scripts/build_server.py --if-stale     # 产物已是当前源码打的就秒退（前端构建链用它）
uv run python scripts/build_info.py --json           # 看源码指纹 / commit / 构建时间

# ── 前端（含 Pi Agent 运行时）──
cd desktop
npm run dev            # electron-vite dev（会自动拉起 uv run 的 server）
npm run typecheck      # vue-tsc --noEmit
npm run build          # ★ 先确保 sidecar 最新（过期内自动重打），再编主/渲染进程
npm run build:win      # 出 .exe：构建 → 装包 → **校验包里那份后端是最新的**
npm run build:unpack   # ★ 票 03 必做：打包后实测 esbuild 是否解包、Pi 能否加载

# 只想单独查后端产物新旧（不构建）：
npm run check:server              # 查 server/dist 里的那一份
npm run check:server:packaged     # 查**已装进安装包**的那一份
```

> ★★ **两条构建链现在由代码联动，不再靠「记得先跑」（P-072 / D-045）**：
> `desktop/package.json` 的 `build` **先**跑 `build:server`
> （= `build_server.py --if-stale`：产物新鲜就秒退，过期才重打），
> `build:win` / `build:unpack` 在 electron-builder **之后**再跑 `check:server:packaged`
> 校验**装进包里的那一份**的源码指纹 —— 不对就**非零退出**，不会打出一个「跑的是旧后端」的包。
>
> 机制的三块拼图（改任何一块前先读它们顶部的注释）：
> | 文件 | 职责 |
> | --- | --- |
> | `server/scripts/build_info.py` | **指纹的唯一实现**：对会进包的文件按路径排序做 sha256（`resources/models/` 只记大小；`tests/`、`dist/`、`resources/kb/` 不参与）|
> | `server/scripts/build_server.py` | 打包**前**算指纹 → 打包 → 写 `<dist>/build-info.json`；`--verify` 断言「产物指纹 == 当前源码指纹」|
> | `desktop/scripts/build-server.mjs` | JS 只**调用**上面的 Python，不自己算哈希（两套算法必然漂移）；`--check dist\|packaged` 做比对 |
>
> ⚠️ 逃生舱 `K12_SKIP_SERVER_BUILD=1` 会**打印警告**后跳过 —— 只在「刚单独打过、确实知道自己在干什么」时用。
> ⚠️ 重打前先关掉正在运行的打包版，否则 `dist/win-unpacked` 的文件被占用删不掉
> （报 `Device or resource busy`）。
>
> 守卫：`desktop/tests/build-pipeline.test.ts`（G20-1…G20-8）+ `server/tests/test_build_info.py`（25 条）。

### ★ CI / CD（`.github/workflows/`，2026-09-19 起）

| 文件 | 触发 | 干什么 | 多久 |
| --- | --- | --- | --- |
| `ci.yml` | push master / PR / 手动 | 后端测试 + 桌面 typecheck/测试/三项自检 + 令牌漂移 | ~3 min |
| `nightly.yml` | 每天 UTC 18:00 / 手动 | **真打包**：取模型 → 建带向量 kb → 双端全量测试 → PyInstaller → electron-builder（nsis/zip/portable）→ 校验包内后端新鲜度 → **发 GitHub Release** + 传 artifact（保留 14 天） | ~19 min |

**四条纪律（都是云端首跑踩出来的，见 P-107）**：
1. **中文输出必须自己保证 stdio 是 UTF-8**：任何会打印中文的入口（含被 PyInstaller
   `exec` 的 spec）都要先 `install_utf8_stdio()`。**本地是中文 Windows，永远不会暴露**。
2. **跑自家脚本的 subprocess 要显式 `encoding="utf-8"`**：子进程输出 UTF-8 是刻意的，
   父进程按 locale 猜的话在西文环境会静默拿到 `stderr=None`（报错还完全不相干）。
3. **`resources/models/` 里不许留符号链接**：HF 缓存默认建链接，
   而**能不能建取决于权限**（本机不能 → 实体；runner 能 → 链接 → 7-Zip 中止打包）。
   `spec` 与 `fetch_embedding_model.py` 都会 `materialize_symlinks()` 并断言残留为 0。
4. **不要在 artifact 里列不会产出的文件**：`latest.yml` 只在开了 publish provider 时才有，
   列了它会让 `upload-artifact` 整步失败。

### ★ 怎么读 CI 的日志（两条「看着吓人其实没事」，别白查）

1. **`Traceback` ≠ 失败。** 后端测试里有若干**故意制造错误**的用例
   （`test_broken_database_is_503_not_500` 真的 `DROP TABLE student`、
   动画模板故意插一行 `throw new Error`、`test_broken_template_is_skipped_not_fatal` …），
   而 `logger.exception` 把堆栈打到 stderr **正是要验的行为**（生产里也要留档）。
   实测：一次全量跑会在日志里留下 **3 条 Traceback**，而结论是 `OK`。
   ★ **唯一的判据是最后两行**：`Ran N tests in Xs` + `OK` / `FAILED (...)`。
   退出码由 `unittest` 决定（`uv run` 原样透传），真实失败一定非零。
2. **被取消的 run 显示 `X`，那不是失败。** `ci.yml` 的
   `concurrency: {group: ci-<ref>, cancel-in-progress: true}` 会在**同一分支
   又来一次 push** 时取消上一轮 —— 于是你看到「X + 日志里一堆报错 + 结尾
   `KeyboardInterrupt` / `The operation was canceled`」。
   那种日志里**没有** `Ran N tests` 那一行（它根本没跑完）。
   想避免的话：一次把改动推完，或在 Actions 页只认最新的那条 run。

**发 Release 的三条（nightly 独有）**：
5. **`permissions` 要 `contents: write`**（CI 是 `read`）。不写的话 `gh release create`
   被 403 挡下，而报错在**最后一步**才出现 —— 前面十几分钟构建全白跑。
6. ★★ **`checkout` 要 `fetch-depth: 30`**：默认只取 **1 条**提交，而发布说明要读
   最近 20 条标题 —— 默认值下 `git log -20` 只输出一条**且不报错**（静默降级）。
   发布说明那一步另有**条数自检**（不足 2 条就 `::warning::` 点名 fetch-depth）。
7. **`shell: bash`**（Windows runner 默认 pwsh）：`git log --pretty=format:`、
   `shopt`、数组这些在 pwsh 里语法不同。★ 脚本里的 `shopt -s nullglob` 是**必须**的
   （实测：不开的话没匹配到的通配符会变成一个原样的文件名，最后报「文件找不到」
   而不是「没构建出产物」）。

**纪律**：关卡不过不进下一阶段；每天结束做一次 git 提交（写清「票号 + 产出」）；
每完成一步跑一次 `npm run typecheck`（契约漂移的第一道防线，不要攒到最后修）；
**每加一个原生/数据依赖就重打一次包验证**（票 03 就是这个纪律的第一道关口）。

### ★ UX 体检（真机交互测试，与单测是**两件事**）

单测测「逻辑对不对」，`verify-ui.mjs` 测「元素在不在」，**都不测「人用起来顺不顺」**。
后者要真跑界面、真发消息、真滚动、真按键盘，再看结果 —— 就是 `desktop/scripts/ux-*.mjs`：

```bash
cd desktop
npm run dev                     # 另一个终端里带调试端口起：K12_DEBUG_PORT=9222 npm run dev
npm run ux                      # ★ 对话页体检 34 项：键盘/滚动/触控目标/浮层几何/破坏性操作/运行期健康
npm run ux:scroll               # 滚动行为 7 项（跟随 / 停住 / 回到最新 / 发消息必跟随）
npm run ux:busy                 # 忙时发送（排队是否可见、是否自动发出）
npm run ux:attribute            # 滚动掉队归因（B1 红了先跑它，看是哪类内容掉队）
npm run ux:pages                # ★ 逐页体检 24 项（学生视角六页；知识库是教师专属页，不在清单里）
npm run ux:layout               # ★ 版式体检：三视口（1120/1280/1440）× 七页 = 21 格，查错位/裁切/表格错位
npm run ux:student              # ★★ 学生视角技术词扫描 17 项：右栏三页签 + 三个浮层 + 正文，**含教师视角反向对照**
npm run ux:reload               # ★ 跑探针前先重载：改过 onMounted 后 HMR 不会重跑它
npm run guards:mutation         # ★★ 守卫的守卫：把每处修复改回坏写法，确认对应断言真的会红（19 条）
```

⚠️ **`ux:*` 探针默认假定应用停在对话页**（它们不发导航）。跑完 `ux:layout` 这类
会逐页切页的脚本之后，应用会停在**最后一页**，直接跑 `ux` / `ux:scroll` / `ux:busy`
会看到一堆假失败（找不到输入框 / 轮次不变）。**先 `npm run ux:reload` 或手动切回对话页。**
另：`npm run ux` 的 A3/A5/B1/G* 依赖真实模型往返，会话很长（40+ 轮）时容易超时 ——
那几条红了先看是不是环境问题，别急着改代码（本轮实测过一次 8 条假红）。

★★ **`guards:mutation` 不属于 `npm test`**（它会临时改文件），但**改守卫时一定要跑**：
本轮新写的 19 条守卫里，**有 5 条**在第一次变异验证时被证明「看着在守、其实守不住」
（判据锚在定义 / 子串 / 注释上，见 P-111）。

**这套东西的定位（别把它当单测的重复）**：`npm test` 705 项**全部通过**时，
它照样抓出过 **8 个缺陷**（P-076~P-083）。下面这张表是本轮最有价值的产出 ——
它说明「什么样的缺陷是单测结构上测不到的」，照这个清单去写检查，比泛泛地说「多测点」有用：

| 缺陷 | 为什么单测测不到 | 检查该怎么写 |
| --- | --- | --- |
| P-076 模型输出里的 `**` 直接露给学生 | 单测样本是**我们自己造的**；模型的输出习惯不是我们定的 | 用**真实模型输出**做样本 |
| P-077 动画不肯用它手里的内联 HTML | 只在「资源过期后重新加载」这条**时序**上发生 | 造出那条时序（资源过期 → 重载） |
| P-078 引用块出现时视图掉队 759px | 只在**过程中**发生，终态是好的 | 持续采样，判「任一次超标」而不是「最终态」 |
| P-079 忙时按 Enter 零反馈 | 只在「上一轮还没结束」这个**状态**下发 | 先进入那个状态，再操作 |
| P-080 输入框无自动聚焦 / chip 只有 24px | **纯交互属性**，没有逻辑可断言 | 量 DOM 属性（`activeElement` / `getBoundingClientRect`） |
| P-081 排障文案直出给学生 | 断言问的是「有没有报错」，**没问「这句话给谁看」** | 扫界面文本里有没有技术词 |
| P-082 浮标压住输入框 17px | 重叠是**关系**，不在任何单个元素的属性里 | 取多个元素的矩形**互相比较** |
| P-083 多处可点元素低于 28px | 尺寸是**渲染结果**，源码里看不出来 | 逐个量 `getBoundingClientRect()` |

**一句话总结这张表**：单测覆盖的是「我们写下的逻辑」，而上面每一条都发生在
**逻辑之外** —— 真实模型的输出、真实时序、真实状态、渲染后的几何关系。
所以 UX 体检不是「多测点」，是**换一个被测对象**。

★ 另外两个**同样只在这种走查里才会出现**的维度（各有专门脚本）：

| 维度 | 怎么查 | 抓到过什么 |
| --- | --- | --- |
| **交互态**（浮层打开/下拉展开/模态） | 逐个打开再量（`ux-audit` 的 G 组等） | 两个下拉 **Esc 与点外部都关不掉**（P-090） |
| **窗口宽度**（响应式） | `npm run ux:layout` 三视口 × 八页 | 表格列宽总和超预算 → **表头被切一半**（P-088）；「刚好放不下」的标签被**从中间切断**（P-089） |

⚠️ **量法本身也会错，四条实测**（都写进了脚本注释）：
`overflow: auto/scroll` 是刻意的滚动条（不算问题）、Monaco 的 `16777215/16777216`
是内部哨兵值、模态本来就该盖住后面的一切（且「盒」是模态根节点的**子元素**）、
下拉盖住按钮是正常的（只有盖住**输入框**才算缺陷）。

⚠️ **两条踩过的坑，用之前先读**：
1. **跑探针前必须 `npm run ux:reload`**：HMR 改过 `onMounted` 一类生命周期代码后，
   旧组件实例不会重新执行它，量出来的现象是「改动完全没生效」，会把人带错方向。
2. **断言要给足粒度**：初版 B1 只查「回答结束时离底部 ≤8px」—— 而引用块在正文之后到达、
   之后再无内容时，最后那次滚动会把一切抹平，**过程中掉队几百毫秒完全测不到**。
   现在改成「流式期间持续采样，任一次 >24px 即失败」。

⚠️ **量法本身也会有 bug，先怀疑量法**（两条实测）：
- **假阳性**：直接量 `<input type="radio">` 得到 13×13，那是它画的小圆点，
  学生实际点的是 `<label>`（46×22）→ 据此误报三个页面，白改一轮。
  现在量「**有效**可点区域」（往上找 label / role=button 容器）。
- **判据过严**：要求两维都 ≥28px 时，列头 24×28 的排序按钮被判过小 ——
  但它是**竖向**目标（高够就能点中）。改成「较小者 ≥20 且较大者 ≥28」。

守卫（源码级，跟 `npm test` 一起跑）：
`desktop/tests/ux-queue-and-scroll.test.ts`（13 条）+ `desktop/tests/ux-pages-regression.test.ts`（5 条）。
**每条都做过变异验证**（把修复改回坏写法，确认对应断言真的变红）——
没验过会红的守卫不算守卫。

## 8. 已知陷阱

> **以下均为已实测 / 已核实的结论：从第一个提交起就把它当作设计约束，不是待踩的坑。**
> 8.1 来自删码前的实测（不因代码重建而失效，重写时照做）；
> 8.2 来自 Pi 包内 grep 与官方 issue，多数尚未在打包产物里验证——**票 03 是它的总验证关口**。

### 8.1 基础设施（实测结论，代码从零写也照此执行）

- **Python 环境**：本机裸 `python`/`py` 指向已删除的 `D:\Code\PythonEvm`（残留注册项，报 `0x80070003`）；
  真实解释器为 `D:\Code\PythonEvm312\python.exe`(3.12.7)。**全程用 `uv` 锁定 Python 3.12**，文档只写 `uv run`，**不要去改注册表**。
- **Windows 中文编码**：
  1. 源码运行态：spawn 时传 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` + `PYTHONUNBUFFERED=1`，所有文件读写显式 `encoding="utf-8"`。
  2. **打包态：上面这些 env 无效**——PyInstaller bootloader 设了 `Py_IgnoreEnvironmentFlag`，
     实测打包产物 `sys.flags.utf8_mode=0`、`sys.stdout.encoding='gbk'`。
     **必须在 Python 层 `reconfigure(encoding="utf-8")`**（`server/app/console.py` 的 `install_utf8_stdio()`，在 `main.py` 最早期调用）。
  3. 不要试图只靠 env 解决打包态乱码——那条路是死的，会白花半天。
- **PyInstaller 打包**：必须 `--onedir`（**不用 `--onefile`**，冷启动可达 10s+）；
  须 `--collect-all sqlite_vec --collect-all fastembed` + `--add-data resources`，否则运行期找不到 `.dll`/模型文件。
  **每加一个原生/数据依赖就重打一次包验证**，别攒到最后。
- **PyInstaller spec 的 `collect_all` 返回值**：必须在 `Analysis(...)` 之前收集并作为参数传入（接受 2 元组）；
  **不能**事后 `a.datas += collect_all(...)`——那时 `a.datas` 已是 3 元组，会 `ValueError: not enough values to unpack`。
- **sidecar 生命周期**：Python 绑 `127.0.0.1:0` 由系统分配端口，用 **stdout 单行 JSON** 握手
  （`{"event":"ready","port":…,"pid":…}`）；**stdout 只许输出这行 JSON**，日志全走 stderr。
  Electron 退出时必须杀进程树（Windows `taskkill /PID <pid> /T /F`），否则孤儿进程残留占端口。
  另两条设计陷阱（重写时避开）：`restart()` **不能复用 `stop()`**（`stop()` 会把 `shuttingDown` 置 true，
  导致之后崩溃不再自动重启）；`onExit()` 会先把 `this.child` 置 null，**必须在置空前先取 pid**。
- **stdio 管道分片**：Node 的 `data` 事件可能把握手 JSON 切成半行，必须缓冲到 `\n` 再 parse；
  非 JSON 行**只记日志、绝不当错误**。
- **重打包 `WinError 5`**：上次验证留下的 sidecar 仍持有产物 `.pyd`/`.dll` 时，PyInstaller 清 `dist/` 会失败——
  打包前先 taskkill 自愈。
- **UI 验收不要靠截图**：本机截图受前台窗口/DPI 影响，常截到别的窗口。用 CDP 读真实 DOM 做断言
  （`K12_DEBUG_PORT` 默认关闭，勿让分发包带调试入口）。报告用的展示性截图需确认窗口正确前置后当场核对。
- **Starlette 中间件是洋葱结构**：最后 `add_middleware` 的在最外层。
  **渲染进程不直连 sidecar，浏览器侧跨源那一整类故障在设计上消失**；但执行文档 §6.3 仍保留
  **一段最小显式来源的 CORS 作纵深防御（禁止 `*`）**，所以顺序纪律照旧：CORS 必须**最后** `add_middleware`，
  否则鉴权提前 return 的 401 不带 `Access-Control-Allow-Origin`，浏览器会把 401 伪装成 `TypeError: Failed to fetch`。
- **日志脱敏过滤器必须保留 `%s`/`%(name)s` 占位符**：无脑把 `record.msg` 擦成 `***` 会让
  `record.getMessage()` 抛 `TypeError: not all arguments converted during string formatting`。
- **sqlite-vec 加载**：需 `conn.enable_load_extension(True)` → `sqlite_vec.load(conn)` → 立刻 `enable_load_extension(False)`；
  加载失败须回退 FTS5 / numpy 暴力余弦（数千 chunk 暴力余弦毫秒级，可接受）。
- **FTS5 中文分词**：默认分词器不支持中文，**必须 `tokenize='trigram'`**。
- **`chunk_vec` 与 `chunk` 行号错位**：`vec0` 表 rowid 必须与 `chunk.rowid` 对齐，否则**检索结果张冠李戴**。
  写入时显式用 `chunk.rowid`；建索引脚本要**幂等**（先清表再写），否则调试时数据翻倍。
- **embedding BLOB 端序**：存 `Float32Array` 字节时注意 `dtype='<f4'` **小端一致**。
- **依赖图递归 CTE**：`depth` 上限**必须加**（防环死循环）；`from→to` 语义全项目一致（**`from` 是前置、`to` 是后继**）；
  悬空 `to_kp_id` 应**报错而非静默跳过**；依赖图扩展只作补充上下文且**要有数量上限**。
- **掌握度 `mastery_delta` 要限幅**（如 ±0.2），否则一次答题就从 0 到 1。
- **`node --test` 直接跑 .ts 时禁用 TS parameter property**（`constructor(private readonly x)`）——
  Node 的类型擦除模式不支持，会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。写成显式字段 + 赋值。
- **动画生成不稳定**：必须保留「模板优先 + 校验 + 重试 ≤3 → 降级文字/静态图」链路，不能只生成不兜底。
  模板内**不得内联 CDN**（沙箱断网会白屏，动画库须内联进 HTML）；`postMessage` 必须校验 `payload_id` 防多卡片串台；进度回调节流到 ~10Hz。
- **Pyodide**：体积大/加载慢 → **本地自托管 + 懒加载**（进编程卡片才加载）；必须在 Worker 里并加**超时中断**（`setInterruptBuffer`）；
  Monaco 需配 vite worker，**不配会在生产构建报错**；**任何 CDN 引用都会在断网演示时翻车**。
- **弱网 / API 不可用**：需有 UI 优雅降级（`error.degraded`），不要假设 DeepSeek 一定可用。

### 8.2 Pi Agent（包内核实结论，**票 03 是总验证关口**）

- **★ `esbuild` 原生依赖是头号打包风险**：Pi 包**没有 `./sdk` 子路径**，只能从包根导入，
  而包根会 evaluate CLI 的 `main.js`，拖入 `@earendil-works/chord` → **`esbuild`（约 10MB 原生二进制）**。
  Pi 官方 issue **#9286** 正是「在 Electron 里嵌入 SDK」时 `Cannot find package 'esbuild'`。
  **处理**：`asarUnpack` 白名单 + 按架构分发 + 签名；**票 03 就要做 `build:unpack` 冒烟**。
  **Plan B = 改用 Pi RPC 模式**（`pi --mode rpc` 作子进程，不 import SDK）。
- **Node 版本（已解除，勿再当作阻塞项）**：Pi `0.85.1` 声明 `engines.node >= 22.19.0`；
  **Electron 44.4.1 内置 Node 24.21.0**（本机实测 `ELECTRON_RUN_AS_NODE=1 electron -v`），直接满足。
  **不要为它降 Pi 到 `0.74.2`，也不要主动降 Electron**（≤33 才不满足，届时退路才是 `0.74.2`）。
- **★ `session_end` 事件不存在**：全包 grep 0 命中。会话终态用 **`session_shutdown`**；
  一轮结束用 **`agent_end` / `agent_settled`**。**写 `pi.on("session_end", ...)` 会直接不生效。**
- **Pi 共 34 个原生事件**，**不要自建事件总线**（`ModuleEvents` 是重复抽象）。
- **`tool_execution_end` 是只读通知，不能改结果**。动画重试逻辑必须写在 Tool 的 `execute()` 内部，不能指望事件回写；
  重试计数用 Extension 内 `Map<toolCallId, n>`，**不要再放 State**。
- **`before_agent_start` 可返回 `{ systemPrompt }` 替换本轮 system prompt**，多个扩展**链式叠加**
  （后注册的能看到前者结果）。这是学段注入的正确落点。
- **`input` 事件可返回 `{action: "continue" | "transform" | "handled"}`**；
  **`tool_call` 可 `{block, reason, terminate}` 并原地改 `event.input`** —— 这是 Tool 级安全阀的位置。
- **SDK 入口名字**：`createAgentSession` / `AgentSession` / `AgentSessionRuntime` / `ModelRuntime` /
  `SessionManager` / `DefaultResourceLoader` / `defineTool`。
  **不存在 `createAgent` / `PiAgent`** —— 别臆造。
- **Extension 形态**：导出默认工厂 `(pi: ExtensionAPI) => { pi.on(...); pi.registerTool(...) }`。
  **不存在 `registerExtension`，也不是插件清单。** 加载器是 jiti（免编译直跑 TS）。
- **默认 system prompt 会泄漏宿主安装路径**（issue #6308）。**必须设 `systemPromptOverride`。**
- **Pi 会话默认落到 `~/.pi/agent/sessions/--<cwd>--/`**，不放 `agentDir` 就会跨学生混放。
  **必须显式改道 + 加自动化断言**（检测 `students/<id>/` 外的本应用 `.jsonl`）。
- **Pi 是纯 TypeScript，无 Python 绑定**。唯一的 Python 集成路径是 RPC 模式
  （`subprocess.Popen(["pi","--mode","rpc"])`，LF 分隔 JSONL；⚠️ **不能用 `readline`**，它会按 Unicode 分隔符切分 JSON 载荷内部）。
- **Provider 配置**：DeepSeek 是 Pi 一等公民 provider，但**自填 BaseURL/ModelID 必须保留**（需求硬性要求）。
  走 `models.json` 的 `providers.<id>` + `models[].id`；Key 解析顺序：
  **设置页** → CLI `--api-key` → `auth.json` → 环境变量 → `models.json`。
  ⚠️ **`models.json` 里声明一个已存在的内置模型 ID 会丢掉它自己的 `compat`**
  （`provider-composer.js` 的 `applyModelsJson()` 遇同 id 整条替换，`modelFromJson()` 只 merge
  provider 级与 definition 自身的 compat）—— 实测：给 deepseek 写一条 `{id:'deepseek-v4-flash'}`
  会把内置的 `reasoning:true` / `compat.thinkingFormat:"deepseek"` **静默抹掉**。
  所以 **内置 ID 只覆盖 provider 级 `baseUrl`、不写 `models[]`；非内置 ID 才写，并从兄弟模型抄字段**。
  实现见 `desktop/src/main/agent/pi-bootstrap.ts` 的 `buildModelsJsonConfig()`（有单测钉住三分支）。
- **`models.json` 是派生产物，不是用户配置文件**：由设置页经 `writeModelsJson()` 每次重写。
  ⚠️ 它的旧语义是「首次运行写一次、之后一个字节都不动」—— 那让**设置页改了什么都进不去 Pi**
  （P-049）。不要再改回幂等，也不要拿它当「用户手改的配置」来保护。
- **明文 Key 的通路**：设置页的 Key 存在 `config.json`（明文，仅本地），
  主进程经 `GET /api/settings/runtime` 取（**含明文**，token 鉴权）→ `setRuntimeApiKey()` **只进内存**。
  ⚠️ 该接口**只允许主进程调用**：渲染进程没有对应 IPC 通道、preload 没有对应方法，
  架构守卫 **G13** 会断言这一点（往渲染进程加这条链路 = 架构事故）。
  **`GET /api/settings` 必须继续只回掩码**（有对照测试）。
- **不要照搬 `pi-agent-sdk-starter` 的 `bun install` 建议**：那是**某第三方 starter kit** 的 README，
  不是 Pi 官方结论（Pi 官方文档零处提及 electron），且 **Pi 本身不依赖 `better-sqlite3`**。
- **`/resources/animation/*` 不能走 `X-Auth-Token`**（iframe 带不了自定义 header），
  改用**一次性 nonce**（绑定 student_id + kp_id + 有效期），并设 `Cache-Control: no-store`。
  **不允许做成无鉴权的公开路由。**
- **工具调用轨迹导出**（票 08 产出，服务 25% 设计分）：从 `tool_execution_start`/`tool_execution_end`/`tool_call`
  记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}` → `docs/tool-trace.mmd`。
  **这是「设计合理性」维度的核心证据**（取代已作废的状态流转图）。
  ★ **同一条数据还有一条实时通路**：`agent/trace.ts` 的 `onRecord` 回调 → `ipc/handlers-data.ts` 的
  `createTraceProjector` → **`trace:changed` 推送通道** → `stores/trace.ts` → 对话右栏「工具调用」页。
  推的是**快照**（每条记录推一次全量），不是增量 —— 一轮只有几个 Tool，全量替换省掉一整套恢复协议。
  ⚠️ 它与 6 事件词表**并列而非其中之一**：轨迹是工程证据，与对话状态机不是一回事。
  往 6 事件里塞字段会让每个消费方都被迫理解一个它不关心的东西。
- **教材知识库的写入**（唯一会写 kb 的地方）：`POST /api/knowledge/import`（导入一份 Markdown）与
  `POST /api/knowledge/rebuild`（整库重建）。
  ★★ **kb 解析顺序有个标记文件**（`app/rag/retriever.py` 的 `user_rebuild_marker_path`）：
  默认「随包只读库优先于用户库」（升级后不该被旧库遮蔽，`test_kb_bundling.py` 钉着这条），
  但**一旦学生重建过**，就写 `<data-dir>/shared/kb.rebuilt` 把用户库提到最前 ——
  否则打包态下「重建成功但检索到的还是老教材」。用标记文件而不是加配置项：
  删掉它就退回随包库，不需要额外的清理入口。
  ★ 导入的教材落 `<data-dir>/knowledge-user/<学段>/`；重建时把它与随包 `knowledge/` 合成到
  `shared/knowledge-staging/` 再喂给 `build()`（**用户导入覆盖同名**）。
  ★ **重建是同步重活**（分块 + ONNX 嵌入，实测 ~6s）→ 必须 `run_in_threadpool`，
  且主进程侧用**长超时**（`KNOWLEDGE_LONG_TASK_TIMEOUT_MS` = 180s）——
  用 `bridge/client.ts` 的 8s 兜底会把一次**成功**的重建报成「响应超时」（最难查的假失败）。
  ★ 统计接口的 `vecReady` 有个坑：`chunk_vec` 是 `vec0` 虚表，**不先加载 sqlite-vec 扩展**连
  `COUNT(*)` 都会抛，于是行数恒为 0、界面会谎报「向量不可用」。`_vec_ready()` 负责加载并重数。
> ★★ **通道总数只认 `npm run check:docs` 打出来的数**（它直接数 `channels.ts`，
> 本文件里**不要写死**）：2026-09-19 的三批是数据面 18 + 会话 4 + 分支 1 + 开场引导复用
> `profile` 取数层；更早的基线见 `index.html`。
> ⚠️ 本文件里曾经同时躺着「54 条」与「52 条」两个互相打架的数（856 行那处漏改）——
> 那就是写死的代价，所以现在一律引用命令、不引用数字。
> **推送通道 9 条**（`PUSH_CHANNELS`）—— 新增推送时别忘了登记，G7 会断言。

- **数据面 IPC 通道**（本轮新增，18 条；细则见 `src/main/ipc/channels.ts` 的注释）：
  画像/推荐/学段证据（`profile:read` / `profile:recommendation` / `grade:signals` / `grade:history`）·
  闯关（`quiz:bank` / `quiz:grade` / `quiz:progress`）· 编程（`code:template` / `code:hint` / `code:run-hint`）·
  动画（`animation:templates` / `animation:render` / `animation:host`）·
  教材知识库（`knowledge:stats` / `knowledge:points` / `knowledge:import` / `knowledge:rebuild`）·
  学生身份（`student:get`）。
  ★ 2026-09-19 又补了 **4 条会话通道**（`session:open` / `session:new` / `session:state`
    + 推送 `session:changed`）与 **1 条开场引导**（复用 `profile:opening` 的取数层，
    没有新增通道）。
  ★★ **通道数不要写死在这一节里**：唯一口径是 `npm run check:docs` 打出来的那个数
    （它直接数 `channels.ts`）。本轮之前本文件里同时躺着「54 条」与「52 条」两个
    互相打架的数（856 行那处漏改），就是写死的代价。要引用就引用命令，不引用数字。
  ★ **双视角（D-063）也不新增通道**：`stores/viewMode.ts` 走 localStorage
    （纯界面偏好，不进 `config.json`、不新增 IPC）—— 这是刻意的：
    通道总数被架构守卫 / doc-facts / 文档三处同时盯着，为一个人机工程开关动它不划算。
  ★★ 三条不许走样的纪律：
  ① **学生 id 一律由主进程决定**（`resolveActiveStudentId()`），**绝不读渲染进程递来的值** ——
     与 `chapter:get/set` 同一条：身份一旦可指定，就是「读别人的画像与学习记录」；
  ② **题库的学段由主进程注入**（取自当前会话），前端递不进来 ——
     否则「只取不高于学生学段的内容」这条隔离就被绕开了；
  ③ **没有「执行代码」的通道**：`code:run-hint` 送的是**已经跑完**的代码与 stdout/stderr，
     只用来做中文报错归一 + 定下一级提示。执行仍然只在渲染进程的 Pyodide Worker 里
     （`code:execute` / `code:result` 那条老链路）。
- **窗口控制通道**（4 条，`window:*`）：`window:minimize` / `window:toggle-maximize` /
  `window:close` / `window:maximize-changed`（推送）。
  ★★ 窗口是 **`frame: false`**（无边框，见 `main/index.ts` 的说明）：Windows 原生标题栏
  与设计不是一套视觉，且会压掉一行纵向空间 —— 所以三个键做进页面（`components/WindowControls.vue`，
  在顶栏最右端，由 `AppShell` 挂载）。
  **三条硬约束（少任何一条窗口就会变得不好用）**：
  1. **拖拽区**：`AppShell` 的 `.shell__head` 是 `-webkit-app-region: drag`，
     其内**每个可交互元素**必须 `no-drag`，否则点击会被当成拖窗口吞掉且**不报错**（P-069）。
     新增顶栏控件时别忘了这一条。
  2. **最大化状态必须推送**：双击拖拽区、`Win+↑/↓`、拖到屏幕上边缘、系统菜单都会改变它，
     渲染进程一个都观察不到 —— 不推的话按钮图标永远画错。
  3. 三条 invoke 都**不接受参数**：作用对象由主进程从 `event.sender` 反查窗口，
     渲染进程指不了别的窗口。`window:close` 走 `window.close()`（**不是** `destroy()`），
     这样 `before-quit` 里的 `session.dispose()` 与 sidecar 收尾照常执行。
  ★ **尺寸**：默认 **1440×900**（设计基准），`minWidth` **1120** ——
  与 `assets/base.css` 的 `#app { min-width: 1120px }` 对齐，
  免得「窗口能缩到多小」与「界面能排到多小」是两个数。
  ⚠️ Windows 会给无边框窗口留约 7px **不可见缩放边框**：`GetWindowRect` 量到 1454×909
  而内容区是 1440×900，**这不是 bug**，写验收脚本时别按外框断言。
  ★ `/api/animation/*` 是 `include_in_schema=False` 的内部端点 → 不进 OpenAPI，
  所以 `AnimationTemplatesView` / `AnimationHostView` / `QuizProgressView` 三个类型是
  **手写的**（`api/data.ts` 里逐条写了为什么）—— Python 侧本来就只是 `JSONResponse` 的字面量 dict，
  手写它们**不违反**「契约唯一来源」。哪天 Python 侧给它们补了 pydantic 模型，这三处就该换成生成类型。
- **接线冒烟脚本**：`cd desktop && npm run smoke:wire`（**需先起 sidecar**）——
  它覆盖的是 `npm test` 与 `server/tests` **都盖不到的那一层**：主进程取数层真连一次 Python，
  验路径拼接、超时、错误归一化，以及几条易破的硬约束（题库无 `answer`、代码模板无 `solution`、
  动画 HTML 无外部地址、RAG 命中带节级正文、学段隔离不越级）。跑法见脚本头部注释。
  ★★ **起 sidecar 时 `--data-dir` 必须传，且必须不是 `server/_data`**（脚本头部有现成命令行）：
  不传或传默认目录都会被判成「未显式传入」，profile / grade / 判分 / 动画托管
  **一共 7 条会红成 503** —— 那是**跑法不对**，不是产品坏了。
  用 `mktemp -d` 建一个临时 data-dir 并拷一份 `kb.sqlite` 进去，21 条全绿且不污染仓库。

## 9. Git / 远程仓库工作流

- **origin**：`https://github.com/IceFireIcer/K12AgentProject.git`（**PRIVATE**，`gh` 以 `IceFireIcer` 登录），推送 `master`。
- **提交信息风格**：`type(票号): 中文摘要` + 正文分节列要点，例如
  `feat(票01): 双端脚手架与依赖基线完成`、`feat(票03): Pi 在打包产物中可加载，esbuild 解包验证通过`、
  `docs(v2): 编排迁移至 Pi Agent，执行文档重写为 v2.0`。
- **推送前必做**：确认无 `*.sqlite`（含未成年人学习记录隐私）、`resources/models/`（90MB 模型）、`.venv/`、`*.onnx` 被暂存。
  ⚠️ `.gitignore` 的**模式锚定坑**：含中间斜杠的 pattern 会被锚定到仓库根，写 `resources/models/` **匹配不到**
  `server/resources/models/`，必须用 `**/resources/models/`（此坑已实际踩到，90MB 模型险些入库）。
- **不要提交**：`server/resources/models/`（随安装包分发）、`server/_data*/`、`**/students/`（Pi 会话 JSONL / 学习记录，
  若落在仓库内）、`config.json` / `.env`（含 API Key）、`logs/`、`dist/` / `out/`。
  `uv.lock` 与 `.python-version` **必须提交**（锁定依赖与解释器）。
- **公开前需过一遍**：`AGENTS.md`、`项目执行文档.md` 含完整架构决策与排期（含「砍单」叙事）。
- **换行符**：`.gitattributes` 统一 LF（`* text=auto eol=lf`），中文文档保证 LF 存储。

## 10. 报告素材纪律

`docs/report-material/` **已建立**（`README.md` / `decisions.md` / `pitfalls.md`）：
**决策与踩坑编号从 D-001 / P-001 起、只追加不重排**——**不要引用任何已删除的文件、不要从 git 取旧素材**。
`decisions.md` 是决策正文的唯一去处（执行文档只引用编号，见其 §0.4）。
⚠️ **编号范围不要写死在文档里**（这里曾写「D-001…D-017 / P-001…P-034」，早已不准）：
要看进度直接查两个文件末尾的编号。

**每天留 30 分钟**把当天的截图 / 关键决策 / 踩坑与解决写进去：
`decisions.md`（决策 → 理由 → 被否决方案）、
`pitfalls.md`（现象 → 根因 → 解决 → 报告用法；可直接引用第 8 节结论，但**必须补上你复现/验证的过程记录**）。
**素材不攒，第 15 天写不出报告。**

> 「设计合理性」维度的架构证据是**工具调用轨迹图**（`docs/tool-trace.mmd`，票 08 产出），
> 不要贴任何历史状态流转图。

**重建期间必记的三类素材**（汇报直接用）：
1. **Pi 迁移的真实代价与解决过程**（esbuild 打包、Node 版本、导入图）——主动讲代价比被问出来可信。
2. **为什么保留 Python sidecar 而不是全单进程**——这是主动权衡，不是妥协。
3. **混合后端的边界如何防止两套实现**——数据/编排各只有一处实现，怎么用契约 + 守卫测试挡住「两边各写一遍」的漂移。

**演示前必做演练**（每条都是现场翻车点）：断网演练、**卸载 Ollama 演练**、
冷启动演练、重启后数据延续演练、**★ 打包产物冷启动演练**（Pi 的 esbuild 加载是最可能翻车的一步）。

**进度落后时的砍单顺序**（从先到后）：
高中深度内容 → 交互式题型 → 动画自由生成 → 编程模板 → **学段自动推断的第二层（LLM 复核，只留第一层规则信号）** → 教师导出。
（**注意**：D-037 之后**手动入口不在砍单序列里** —— 它是需求原文「学生可选择所在学段」的直接兑现，
砍它等于把需求那句再丢一次；能砍的仍然只有第二层 LLM 复核。）
（**注意**：原第 5 档写作「只保留显式选择」—— 该退路**已不存在**，人工入口在 2026-09-16 的翻转中一并取消。）

---

## Agent skills

### Issue tracker

工作切片以本地 markdown 存放于 `docs/tickets/issues/`（一票一文件，按依赖顺序编号；当前 23 票清单见第 2 节），
不使用外部 tracker；约定见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个规范角色的默认词表（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`），
记录在各票 `Status:` 行；约定见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：领域语言与决策以 `项目执行文档.md` + `docs/` 为准（消费方式见 `docs/agents/domain.md`）；
`CONTEXT.md` 尚未创建，缺失时静默跳过，需要时由 `/domain-modeling` 惰性生成。
