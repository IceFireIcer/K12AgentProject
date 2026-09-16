# AGENTS.md

面向后续 ZCode / 编码代理的工作区说明。只记录本仓库特有、从代码本身看不出来的信息。

> **本文件依据 `项目执行文档.md`（唯一权威）+ `docs/` 现存的 5 份文档重新生成。**
> 若本文件与执行文档冲突，**以执行文档为准**，并顺手修正本文件。

## 0. ⚠️ 先读这一条：当前工作区只有文档，没有代码

**2026-09-16 用户明确要求删除全部代码、仅保留文档**，已提交（`9f966fd`）。当前仓库顶层只有：

```
K12Agent/
├─ AGENTS.md              # 本文件
├─ 项目执行文档.md         # 唯一权威执行文档 v2.0（Pi Agent 架构版，1146 行）
├─ docs/                  # 现存 5 份文档，见第 3 节
└─ .gitignore  .gitattributes
```

**`desktop/` 与 `server/` 不存在。** S00/S01/S02 的代码成果（Electron 壳、sidecar 握手、
pydantic 契约层、SSE 通道、单测与架构守卫）**都不在工作区里**。

**恢复方式**：S02 完整代码在附注标签里，没有丢：

```bash
git tag -l 'archive/*'                              # → archive/s02-full-code
git show archive/s02-full-code --stat | head        # 先看清要带回什么
git checkout archive/s02-full-code -- desktop server
```

> **恢复 embedding 模型（约 90MB，从未入 git）**：已备份到仓库外
> `E:\FolderForVibeCoding\Zcode\K12Agent_backup_resources\resources`，
> 需手工拷回 `server/resources/models/fastembed/`。**不做这一步，检索跑不起来。**

**因此：开工任何 Stage 之前，先问用户「是否要从标签恢复代码」。**
不要默认代码存在，也不要绕过用户直接恢复——删码是用户的有意操作。

> **注意一批「引用了但当前不存在」的文件**：`docs/report-material/{README,decisions,pitfalls}.md`、
> `docs/阶段实测记录-S00至S02.md`、`docs/graph-smoke.mmd` 在 git HEAD 里有、工作区已被删除（未提交）。
> 执行文档第 16 节与报告素材纪律反复引用它们。**需要时先恢复**：
> `git checkout HEAD -- <path>`。不要以为是文档笔误。

## 1. 项目是什么

中国移动浙江公司发榜赛题 **JBGS-2026-02「多模态 K12 人工智能通识课教学助手对话智能体」**。
面向小学低/高年级、初中、高中的 AI 通识课对话教学助手，充当「7×24 在线 AI 教师」，
具备学段自适应、多模态交互、个性化学习路径。

- **交付物**：可运行的 Electron 桌面应用原型（**本期只做 Windows .exe**）、完整源码 + 本地运行说明、项目报告与答辩 PPT、演示视频。
- **约束前提**：**单人开发 · 15 天极限冲刺**。所有排期与范围决策都服从这一前提。
- **评分权重**：设计合理性 25% / 多模态交互质量 25% / 教育适配性 20% / 用户体验 15% / 创新性 15%。

## 2. 当前进度与下一步

| Stage | 内容 | 状态 |
| --- | --- | --- |
| S00 | 环境与依赖基线 | ✅ 代码已删除（成果留档） |
| S01 | 双端脚手架 + Sidecar 握手 | ✅ **关卡 A 已过**（代码已删除，可从标签恢复） |
| S02 | 契约冻结 + 设置页 + 安全握手 + 事件通道 | ✅ 代码已删除，可从标签恢复；**传输层需局部返工（SSE → IPC）** |
| **S03 / D3** | **Pi Agent 集成 + LLM 适配** | ⬜ **下一步**，清单见执行文档第 18 节 |

**S03（D3）是当前风险最高的一天**，同时压着 3 个未验证的致命风险（执行文档第 17 节 #15–#17）：
Pi 的 `esbuild` 原生依赖能否在 Electron 打包后加载、Electron 内置 Node 是否 >= 22.19、包根导入副作用。
**按执行文档第 18 节的顺序做，不要跳。关卡 B 不通过不要开始 D4。**

> **任务分解不单独成文件**：原先的 `stages/` 目录已于 2026-09-16 删除（与执行文档重复）。
> **「今天做什么」看执行文档第 4 节；「能不能开工」看 4.3 前置依赖；「做完没有」看第 14 节验收。**
> 旧卡可从历史取回：`git show 8564e67:stages/S04-主Agent与Extension骨架.md`。

## 3. 文档权威顺序（冲突时以此为准）

| 文件 | 角色 |
| --- | --- |
| `项目执行文档.md` | **唯一权威执行文档 v2.0**（范围、契约、DDL、15 天排期、执行纪律、验收、演示脚本、风险表）。开发时**先查这一份**。Pi 迁移已在本文件裁决完毕。 |
| `docs/业务陷阱清单.md` | 各模块**领域陷阱与业务验收口径**（与编排框架无关）。写代码时**最容易漏掉**，动手前扫一眼。 |
| `docs/研判文档PiAgent.md` | Pi 迁移提案（含核实批注）。已归档，**含 6 项未决分叉的原始陈述**；执行文档第 13.3 节已裁决。**不要再照它实现。** |
| `docs/研判文档Deepseek.md` | 数据层、RAG、教育适配的设计依据。编排部分已被执行文档取代。 |
| `docs/项目简介.md` | 赛题原文与评分标准，需求边界以此为准。 |
| `docs/研判文档Qwen3.7.md` | 早期研判，**部分结论已被取代**。仅背景参考，不要照它实现。 |

**执行文档相对研判文档的关键裁剪**（**不要「恢复」这些，是有意为之**）：
编排改用 **Pi Agent SDK（TypeScript，嵌入 Electron 主进程）**，但 **Python sidecar 保留**为数据/RAG/嵌入服务；
嵌入维持 **fastembed bge-small-zh-v1.5（移除 Ollama/torch）**；契约维持 **pydantic 唯一来源**；
动画维持「模板优先 + 生成补充」；检索加 FTS5 + numpy 兜底；语音降为 P2；
学段改为 **显式选择为主 + 自动推断为辅**。详见执行文档第 0 节与第 13 节。

## 4. 已锁定的技术选型与硬约束

不要擅自替换以下选型，除非用户明确要求：

- 部署形态：**Electron 桌面壳 + Python 后端 sidecar**，全本地化，不做服务器部署。
- 进程模型：**双进程 + 主进程内嵌 Agent 运行时**。
  - **Electron 主进程**：UI 壳 + sidecar 生命周期 + **Pi Agent 编排**（`@earendil-works/pi-coding-agent`）。
  - **Python sidecar**：数据 / RAG / 嵌入 / 学习记录（**无编排、无 LLM 调用**）。
  - 二者经 `127.0.0.1` HTTP 通信（随机 token 鉴权）。
  - **渲染进程 ↔ 主进程**：**IPC 事件流**（`ipcRenderer.on` / `webContents.send`），沿用原 6 事件词表。
- 编排：**Pi Agent SDK**（**锁 `^0.85.1`**，0.85.0 在 Electron 里会崩）。主 Agent 由 LLM **自主选 Tool** 路由
  （**不设 `intent` 字段**），能力经 `pi.registerTool()` 暴露，共 6 个 Extension（动画/编程/练习/画像/学段/学习记录）。
  **不用 LangGraph，不用 `langgraph-checkpoint-sqlite`，不用 `SqliteSaver`。**
- 前端（`desktop/`）：**Electron 33 + electron-vite 3 + Vue 3 + Pinia + TypeScript（strict）**，
  对话优先布局，内联卡片 + 展开/全屏。
  **Electron 侧不得引入任何原生数据库模块**（刻意的风险隔离）——**Pi 迁移不影响此约束**。
- 后端（`server/`）：**Python 3.12（uv 锁定）+ FastAPI + uvicorn + pydantic v2**。
- 契约：**pydantic 模型是唯一契约来源** → FastAPI 自动产出 OpenAPI → `openapi-typescript` 生成前端 TS 类型。
  **Pi Tool 参数用 TypeBox `TSchema` 声明，必须与 pydantic 模型做一致性断言**（防静默漂移）。
- 数据（**三处分离**）：
  - `kb.sqlite`（全局只读）：教材 chunk、embedding、依赖图、题库。
  - `learning.db`（原 `student-<id>.sqlite`，每人一份）：画像、掌握度、学习历史、进度、学段信号与轨迹。
  - **Pi JSONL 会话树**（每人一份）：对话历史、工具调用记录、分支。
  - **必须显式配置 Pi 的 `agentDir` / `sessionDir` 落到 `students/<id>/pi-agent/`**，
    否则会写进用户全局 `~/.pi/agent/`，造成跨学生数据混放（合规硬伤）。**SQLite 不存对话正文。**
- 主模型：**DeepSeek 云端 API**（OpenAI 兼容），必须支持下改供应商名称 / BaseURL / APIKey / Model ID。
  ⚠️ Pi 内置 DeepSeek provider 的 baseUrl 是 `https://api.deepseek.com`（**无 `/v1`**），
  与前端默认值的 `/v1` 形式不同，**保存时必须做真实连通性探测**。
- 嵌入：**fastembed `BAAI/bge-small-zh-v1.5`（512 维，ONNX，约 90MB）**。**不引入 torch，不依赖 Ollama**。
  维度写在配置常量里，勿散落硬编码；升级 `bge-base-zh-v1.5`（768 维）须同步改 `vec0` 维度并重建索引。
- 动画：**Anime.js v3**（**锁 v3，v4 API 不兼容**），运行在 sandboxed iframe。
- 编程：**Monaco Editor** + **Pyodide**（独立 Web Worker，资源本地自托管，不依赖 CDN）。
- 语音：**P2 后置**（Python 下可用 `sherpa-onnx` pip 包低成本回捡）。
- 硬件：**纯 CPU，无 GPU**。所有本地模型/推理必须 CPU 可跑。
- 教材来源：**人工编写的 Markdown + 元数据文件**，**不做 PDF 解析**。
- 范围裁剪：核心只做 4 种交互（对话问答、动画讲解、编程环境、游戏化练习）；**绘本生成、多模态教学资源推荐明确砍掉**。
  **不引入 `pi-subagents`**（非官方第三方包；Pi 官方哲学即「No sub-agents」），SubAgent 用自有 Extension 实现。

## 5. 架构边界与层规则（改动时必须遵守）

1. **学段以显式选择为权威**（前端按钮随请求传入），主 Agent 经 `before_agent_start` 注入；
   **自动推断只写「建议」，不直接改**，须学生确认。SubAgent 不得自行推断学段。
2. **主 Agent 负责路由与对话答疑**：路由交给 LLM 自主选 Tool；
   **但关键约束必须在代码层强制**——学段隔离在 `rag_search` Tool 内由 Python 强制（模型改不了 WHERE），
   安全终审是独立步骤，沙箱是运行时属性，Tool 参数由 TypeBox 校验。**不要把这四条也交给模型。**
3. 所有跨语言/跨模块调用走**冻结的接口契约**（pydantic 唯一来源，前端用生成 TS 类型）；禁止临时加松散字段。
   **Pi Tool 的 TypeBox 参数也必须纳入契约一致性断言。**
4. **RAG 检索严格按学段隔离**，允许向上兼容但必须显式标注 `compat`。
   学段过滤**必须写在 SQL 层**（不能只在应用层筛，否则早被 KNN top-k 截断）。
   **四级降级链（vector → cloud → FTS5 → 依赖图/大纲）必须在 Python 侧一次调用内完成**，
   不要让编排层感知降级；结果带 `degraded: "vector"|"cloud"|"fts"|"outline"` 供轨迹图展示。
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

- **接口先行**：先冻结 pydantic 契约（含 6 个事件枚举），各模块再并行实现；
  改了模型必须重跑 OpenAPI → TS 生成（`--check` 做字节比对），并跑 Tool TypeBox 一致性断言。
- **事件词表固定 6 个**：`delta | citation | payload | blocked | done | error`。
  **传输层已从 SSE 改为 IPC，但词表一字不改**，前端解析/分发语义可复用。
  **`EventSource` 断言保留在架构守卫测试里**，防止有人回退到 SSE 时又踩一次鉴权 header 的坑。
- **事件来源映射（D4 依据）**：`delta`←`message_update`；`citation`←`rag_search` 结果；
  `payload`←`tool_execution_end`（按 Tool 名映射 `kind`）；`blocked`←安全终审；
  `done`←`agent_end`；`error`←provider/Tool 异常或降级。
- **Tool 名 → 事件 `kind` 映射冻结**（新增 Tool 必须同步登记）：
  `generate_animation→animation`；`get_code_template`/`get_coding_hint`/`evaluate_code→coding`；
  `generate_quiz`/`submit_quiz`/`generate_variants→quiz`。
- SubAgent 输出用统一 pydantic Payload（`AnimationPayload` / `CodeTemplate` / `CodingHint` / `CodeEvaluation` / `QuizPayload` / `QuizResult`），不要用松散 dict。
  **不要引入 `ModuleResult<T>` / `ModuleError` 那套 `{success, error}` 包装**——失败统一走 `error` 事件（带 `degraded`），否则前端要处理两套失败形态。
- **`QuizQuestion` 发给前端时绝不能带 `answer`**（答案泄漏），判分只走后端。
- 字段命名：Python `snake_case`，出参统一转 `camelCase`（pydantic alias），前端统一 camelCase。**只做一次约定，不要两边混用。**
- 检索 chunk 元数据 schema 固定：`chunk_id, text, embedding, grade_level, chapter_title, section_title, knowledge_point, content_type, parent_chunk_id, token_count`；
  节级 chunk 控制 300–600 token，父子 chunk（小子块检索、命中回父块作上下文）。
- 数据合规：K12 涉未成年人数据，**最小化采集，不采集生物特征**。
- **中文输出**：仓库文档、面向学生与家长的文案、System Prompt 均为中文；代码标识符与提交信息可用英文。
- **学段语气**：System Prompt 按学段差异化（童话拟人 / 严谨逻辑推导），不要只改难度数字而忽略语气。
  四学段各一份模板放 `desktop/src/main/agent/prompts/`。

## 7. 开发与打包命令

代码恢复后（第 0 节）才有意义：

```bash
# ── 后端（数据/RAG/嵌入）──
cd server
uv sync
uv run uvicorn app.main:app --reload --port 8756     # 开发用固定端口
uv run python scripts/export_openapi.py              # 导出 OpenAPI → 生成 TS 类型

# 后端打包（--onedir，不用 onefile）——统一走脚本，不要手敲 pyinstaller
uv run python scripts/build_server.py

# ── 前端（含 Pi Agent 运行时）──
cd desktop
npm run dev            # electron-vite dev（会自动拉起 uv run 的 server）
npm run typecheck      # vue-tsc --noEmit
npm run build:win      # 打包 .exe（内嵌 server 产物 + Pi 运行时）
npm run build:unpack   # ★ D3 必做：打包后实测 esbuild 是否解包、Pi 能否加载
```

**纪律**：关卡不过不进下一阶段；每天结束做一次 git 提交（写清「天次 + 产出」）；
每完成一步跑一次 `npm run typecheck`（契约漂移的第一道防线，不要攒到最后修）。

## 8. 已知陷阱

### 8.1 基础设施（S01/S02 实测，仍然有效）

- **Python 环境**：本机裸 `python`/`py` 指向已删除的 `D:\Code\PythonEvm`（残留注册项，报 `0x80070003`）；
  真实解释器为 `D:\Code\PythonEvm312\python.exe`(3.12.7)。**全程用 `uv` 锁定 Python 3.12**，文档只写 `uv run`，**不要去改注册表**。
- **Windows 中文编码**：
  1. 源码运行态：spawn 时传 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` + `PYTHONUNBUFFERED=1`，所有文件读写显式 `encoding="utf-8"`。
  2. **打包态：上面这些 env 无效**——PyInstaller bootloader 设了 `Py_IgnoreEnvironmentFlag`，
     实测打包产物 `sys.flags.utf8_mode=0`、`sys.stdout.encoding='gbk'`。
     **必须在 Python 层 `reconfigure(encoding="utf-8")`**（`server/app/encoding.py` 的 `install_utf8_stdio()`，在 `main.py` 最早期调用）。
  3. 不要试图只靠 env 解决打包态乱码——那条路是死的，会白花半天。
- **PyInstaller 打包**：必须 `--onedir`（**不用 `--onefile`**，冷启动可达 10s+）；
  须 `--collect-all sqlite_vec --collect-all fastembed` + `--add-data resources`，否则运行期找不到 `.dll`/模型文件。
  **每加一个原生/数据依赖就重打一次包验证**，别攒到最后。
- **PyInstaller spec 的 `collect_all` 返回值**：必须在 `Analysis(...)` 之前收集并作为参数传入（接受 2 元组）；
  **不能**事后 `a.datas += collect_all(...)`——那时 `a.datas` 已是 3 元组，会 `ValueError: not enough values to unpack`。
- **sidecar 生命周期**：Python 绑 `127.0.0.1:0` 由系统分配端口，用 **stdout 单行 JSON** 握手
  （`{"event":"ready","port":…,"pid":…}`）；**stdout 只许输出这行 JSON**，日志全走 stderr。
  Electron 退出时必须杀进程树（Windows `taskkill /PID <pid> /T /F`），否则孤儿进程残留占端口。
  另：`restart()` **不能复用 `stop()`**（`stop()` 会把 `shuttingDown` 置 true，导致之后崩溃不再自动重启）；
  `onExit()` 会先把 `this.child` 置 null，**必须在置空前先取 pid**。
- **stdio 管道分片**：Node 的 `data` 事件可能把握手 JSON 切成半行，必须缓冲到 `\n` 再 parse；
  非 JSON 行**只记日志、绝不当错误**。
- **重打包 `WinError 5`**：上次验证留下的 sidecar 仍持有产物 `.pyd`/`.dll` 时，PyInstaller 清 `dist/` 会失败——
  打包前先 taskkill 自愈。
- **UI 验收不要靠截图**：本机截图受前台窗口/DPI 影响，常截到别的窗口。用 CDP 读真实 DOM 做断言
  （`K12_DEBUG_PORT` 默认关闭，勿让分发包带调试入口）。报告用的展示性截图需确认窗口正确前置后当场核对。
- **Starlette 中间件是洋葱结构**：最后 `add_middleware` 的在最外层。**CORS 必须最后加**，
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

### 8.2 Pi Agent（v2 新增，**多数尚未实测，动手前先验**）

- **★ `esbuild` 原生依赖是头号打包风险**：Pi 包**没有 `./sdk` 子路径**，只能从包根导入，
  而包根会 evaluate CLI 的 `main.js`，拖入 `@earendil-works/chord` → **`esbuild`（约 10MB 原生二进制）**。
  Pi 官方 issue **#9286** 正是「在 Electron 里嵌入 SDK」时 `Cannot find package 'esbuild'`。
  **处理**：`asarUnpack` 白名单 + 按架构分发 + 签名；**并在 D3 第一天就做 `build:unpack` 冒烟**。
  **Plan B = 改用 Pi RPC 模式**（`pi --mode rpc` 作子进程，不 import SDK）。
- **Node 版本**：Pi `0.75+` 要求 **Node >= 22.19.0**，而 Electron 33 内置 Node 低于此。
  **退路**：升 Electron，或降到 Pi `0.74.2`（`legacy-node20` tag，要求 >= 20.6）。**D3 首日验证。**
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
- **Provider 配置**：DeepSeek 是 Pi 一等公民 provider，但**自填 BaseURL/ModelID 必须保留**（赛题硬要求）。
  走 `models.json` 的 `providers.<name>` + `models[].id`；Key 解析顺序：CLI `--api-key` → `auth.json` → 环境变量 → `models.json`。
- **不要照搬 `pi-agent-sdk-starter` 的 `bun install` 建议**：那是**某第三方 starter kit** 的 README，
  不是 Pi 官方结论（Pi 官方文档零处提及 electron），且 **Pi 本身不依赖 `better-sqlite3`**。
- **`/resources/animation/*` 不能走 `X-Auth-Token`**（iframe 带不了自定义 header），
  改用**一次性 nonce**（绑定 student_id + kp_id + 有效期），并设 `Cache-Control: no-store`。
  **不允许做成无鉴权的公开路由。**
- **工具调用轨迹导出**（D4 产出，服务 25% 设计分）：从 `tool_execution_start`/`tool_execution_end`/`tool_call`
  记录 `{turn, toolName, args摘要, ok, latencyMs, degraded}` → `docs/tool-trace.mmd`。
  **替代原 LangGraph 的 `draw_mermaid()` 状态流转图**。

## 9. Git / 远程仓库工作流

- **origin**：`https://github.com/IceFireIcer/K12AgentProject.git`（**PRIVATE**，`gh` 以 `IceFireIcer` 登录），推送 `master`。
- **提交信息风格**：`type(Stage): 中文摘要` + 正文分节列要点，例如
  `feat(S00): 环境与依赖基线完成，新增任务切片文档`、`docs(v2): 编排迁移至 Pi Agent，执行文档重写为 v2.0`。
- **推送前必做**：确认无 `*.sqlite`（含未成年人学习记录隐私）、`resources/models/`（90MB 模型）、`.venv/`、`*.onnx` 被暂存。
  ⚠️ `.gitignore` 的**模式锚定坑**：含中间斜杠的 pattern 会被锚定到仓库根，写 `resources/models/` **匹配不到**
  `server/resources/models/`，必须用 `**/resources/models/`（此坑已实际踩到，90MB 模型险些入库）。
- **不要提交**：`server/resources/models/`（随安装包分发）、`server/_data*/`、`config.json` / `.env`（含 API Key）、`logs/`。
  `uv.lock` 与 `.python-version` **必须提交**（锁定依赖与解释器）。
- **公开前需过一遍**：`AGENTS.md`、`项目执行文档.md` 含完整架构决策与排期（含「砍单」叙事）。
- **换行符**：`.gitattributes` 统一 LF（`* text=auto eol=lf`），中文文档保证 LF 存储。

## 10. 报告素材纪律

**每天留 30 分钟**把当天的截图 / 关键决策 / 踩坑与解决写进 `docs/report-material/`：
`decisions.md`（决策→理由→被否决方案，格式参考已有 D-001~D-009）、
`pitfalls.md`（现象→根因→解决→报告用法，格式参考已有 P-001~P-008）。
**素材不攒，第 15 天写不出报告。**

> 该目录当前不在工作区（见第 0 节恢复方式）。**`docs/graph-smoke.mmd` 已不是架构证据**
> （LangGraph 状态图作废），「设计合理性」维度改由**工具调用轨迹图**（`docs/tool-trace.mmd`，D4 产出）承担，
> 不要贴旧图进报告。

**v2 期间必记的两类素材**（答辩直接用）：
1. **Pi 迁移的真实代价与解决过程**（esbuild 打包、Node 版本、导入图）——主动讲代价比被问出来可信。
2. **为什么保留 Python sidecar 而不是全单进程**——这是主动权衡，不是妥协。

**演示前必做演练**（每条都是现场翻车点）：断网演练、**卸载 Ollama 演练**、
冷启动演练、重启后数据延续演练、**★ 打包产物冷启动演练**（Pi 的 esbuild 加载是最可能翻车的一步）。

**进度落后时的砍单顺序**（从先到后）：
高中深度内容 → 交互式题型 → 动画自由生成 → 编程模板 → **学段自动推断（只保留显式选择）** → 教师导出。
