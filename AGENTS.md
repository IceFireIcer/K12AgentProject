# AGENTS.md

面向后续 ZCode / 编码代理的工作区说明。仅记录本仓库特有、从代码本身看不出来的信息。

## 1. 项目是什么

中国移动浙江公司发榜赛题 **JBGS-2026-02「多模态 K12 人工智能通识课教学助手对话智能体」**。
目标：一个面向小学低/高年级、初中、高中的 AI 通识课对话教学助手，充当「7×24 在线 AI 教师」，具备学段自适应、多模态交互、个性化学习路径。

**交付物**：可运行的 Electron 桌面应用原型（**本期只做 Windows .exe**）、完整源码 + 本地运行说明、项目报告与答辩 PPT。

## 2. 当前仓库状态（重要）

已完成 **S00 环境与依赖基线**、**S01 双端脚手架 + Sidecar 握手（关卡 A ✅ 已过）**（见 `stages/README.md`）：

- `desktop/`：**已创建**。electron-vite + Vue3 + TS + Pinia；Electron 能拉起 Python sidecar 并显示握手结果；`electron-builder --dir` 整包已验证。
- `server/`：uv 工程 + **`app/` 应用代码已就绪**（FastAPI 入口、握手协议、token 鉴权、`/health`）。Python 3.12.7（`.python-version` 锁定），依赖见 `server/pyproject.toml` + `server/uv.lock`。
- 嵌入模型在 `server/resources/models/fastembed/`（90.8MB，512 维），**已纳入 `.gitignore`**（体积大，随包分发）。
- Git 已有提交；`master` 分支。
- **尚未有**：`server/app/models.py` 契约（S02）、LangGraph 编排（S04）、RAG（S06）、测试框架（后端侧）、lint 配置、Vue 视图/组件。

**目录结构**（现状）：

```
K12Agent/
├─ AGENTS.md                  # 本文件
├─ 项目执行文档.md             # 唯一权威执行文档
├─ stages/                    # 任务切片（S00–S13），一次做一个
├─ docs/                      # 设计依据与报告素材（report-material/ 逐日累积）
├─ desktop/                   # ★ Electron + Vue 桌面壳
│  ├─ src/main/{index,sidecar,sidecar-logic}.ts   # 窗口 / 进程管理 / 纯逻辑
│  ├─ src/preload/index.ts                        # contextBridge 白名单
│  ├─ src/renderer/src/                           # App.vue + stores/
│  ├─ tests/sidecar-logic.test.ts                 # 单测（node --test）
│  └─ scripts/verify-ui.mjs                       # CDP 读真实 DOM 做 UI 断言
└─ server/                    # ★ Python 后端
   ├─ app/{main,config,encoding}.py + app/api/
   ├─ packaging/k12-agent-server.spec             # PyInstaller 配置
   ├─ resources/models/fastembed/                 # 嵌入模型（git 忽略）
   └─ scripts/{check_env,download_models,smoke_langgraph,export_openapi,build_server}.py
```

**可用命令**（真实命令，勿用占位描述）：

```bash
# ── 后端 ──
cd server
uv run python scripts/check_env.py         # 一屏自检全部后端环境
uv run python scripts/smoke_langgraph.py   # LangGraph 能力冒烟（条件边/持久化/流转图）
uv run python scripts/download_models.py   # 下载/校验嵌入模型
uv sync                                    # 按 uv.lock 还原依赖

uv run python -m app.main --port 0 --token devtoken --data-dir ./_data   # 单跑 sidecar（stdout 会打握手 JSON）
uv run python scripts/build_server.py      # PyInstaller 打包 + 产物自检（握手/health/401/中文编码）
uv run python scripts/build_server.py --verify    # 只自检已有产物

# ── 前端 ──
cd desktop
npm install
npm test                                   # 单测 31 条（node 原生跑 TS，无额外构建）
npm run typecheck                          # tsc + vue-tsc
npm run dev                                # 开发态（自动拉起 uv run 的 sidecar）
K12_SIDECAR_MODE=packaged npm run dev      # 用 server/dist 打包产物验「关卡 A 路径」
K12_DEBUG_PORT=9222 npm run dev            # 开 CDP（默认关闭），配合下面脚本
node scripts/verify-ui.mjs                 # UI 断言：就绪态
node scripts/verify-ui.mjs --expect failed  # UI 断言：失败态不白屏
npm run build:unpack                       # 整包 → dist/win-unpacked/（真正的关卡 A）
```

**验证约定**：UI 验收一律用 `scripts/verify-ui.mjs`（CDP 读真实 DOM）而**不要靠截图**——
本机截图受前台窗口/DPI 影响，常截到别的窗口，无法断言。见 `docs/report-material/pitfalls.md`。

## 3. 文档权威顺序

| 文件 | 角色 |
| --- | --- |
| `项目执行文档.md` | **唯一权威执行文档**（已合并：范围、接口契约、数据层 DDL、15 天排期、验收标准、演示脚本、风险表）。开发时**先查这一份**。 |
| `stages/README.md` | **任务切片索引**（S00–S13 与关卡 A–E）。**开工前先在这里确认「现在做哪个 Stage、前置是否满足」。** |
| `docs/研判文档Deepseek.md` | 架构与选型依据。与执行文档冲突时以执行文档为准，差异见其第 13 节。 |
| `docs/项目简介.md` | 赛题原文与评分标准，需求边界以此为准。 |
| `docs/研判文档Qwen3.7.md` | 早期研判，**部分结论已被取代**。仅作背景参考，不要照它实现。 |

**执行文档相对研判文档的关键裁剪**（不要「恢复」这些，是有意为之）：后端改用 **Python sidecar**；嵌入模型改 **fastembed bge-small-zh-v1.5（移除 Ollama/torch）**；学生库改双库设计；动画改「模板优先+生成补充」；检索加 FTS5 + numpy 两级兜底；语音 ASR/TTS 降为 P2。详见执行文档第 3、5.3、8、13 节。

## 4. 已锁定的技术选型与硬约束

不要擅自替换以下选型，除非用户明确要求：

- 部署形态：**Electron 桌面壳 + Python 后端 sidecar**，全本地化，不做服务器部署。
- 进程模型：**双进程**。Python（FastAPI + LangGraph）负责编排/RAG/DB/嵌入；Electron 只做 UI 壳 + sidecar 生命周期管理。二者经 `127.0.0.1` HTTP + SSE 通信。
- 前端（`desktop/`）：**Vue 3 + Pinia + TypeScript**，对话优先布局，内联卡片 + 展开/全屏。**Electron 侧不得引入任何原生数据库模块**（这是刻意的风险隔离）。
- 后端（`server/`）：**Python 3.12（uv 锁定）+ FastAPI + pydantic v2**。
- 编排：**LangGraph（Python 版）**，主 Agent + 3 个 SubAgent；持久化用 `langgraph-checkpoint-sqlite` 的 `SqliteSaver`。
- 契约：**pydantic 模型是唯一契约来源** → 自动 OpenAPI → 生成前端 TS 类型。
- 数据：**SQLite + sqlite-vec（pip 版）**。**双库**：`kb.sqlite`（全局只读）+ `student-<id>.sqlite`（每人一份）；依赖图用邻接表 + 递归 CTE。
- 主模型：**DeepSeek 云端 API**（OpenAI 兼容），必须支持下改供应商名称 / BaseURL / APIKey / Model ID。
- 嵌入：**fastembed `BAAI/bge-small-zh-v1.5`（512 维，ONNX，约 90MB）**。**不引入 torch，不依赖 Ollama**。维度写在配置常量里，勿散落硬编码。
- 动画：**Anime.js v3**（**锁 v3，v4 API 不兼容**），运行在 sandboxed iframe。
- 编程：**Monaco Editor** + **Pyodide**（独立 Web Worker，资源本地自托管）。
- 语音：**P2 后置**（Python 下可用 `sherpa-onnx` pip 包低成本回捡）。
- 硬件：**纯 CPU，无 GPU**。所有本地模型/推理必须 CPU 可跑。
- 教材来源：**人工编写的 Markdown + 元数据文件**，**不做 PDF 解析**。
- 范围裁剪：核心只做 4 种交互（对话问答、动画讲解、编程环境、游戏化练习）；**绘本生成、多模态教学资源推荐不纳入核心范围**。

## 5. 架构边界与层规则（改动时必须遵守）

1. **学段由前端按钮切换**并随请求传入；主 Agent 在 `profile_load` 注入，SubAgent 不得自行推断学段。
2. **主 Agent 负责意图路由与对话答疑**；SubAgent 按功能维度划分（动画 / 编程 / 练习），互不越权。
3. 所有跨语言/跨模块调用走**冻结的接口契约**（pydantic 为唯一来源，前端用生成的 TS 类型）；禁止临时加松散字段。
4. **RAG 检索严格按学段隔离**，允许向上兼容但必须显式标注 `compat`。
5. **内容安全只做后端审核**，采用「流式输出 + 生成结束后整段终审」，违规则撤回并替换为安全提示。
6. 知识点依赖图**同时**服务于推荐路径规划与检索上下文扩展，两个用途都要保留。
7. 沙箱隔离是硬要求：动画在 sandboxed iframe（**禁止加 `allow-same-origin`**），Pyodide 在独立 Worker，**不得与侧车进程或主线程共享执行环境**。
8. 每个学生独立 `student-<id>.sqlite`，**不得跨学生共享或复用连接/数据**。
9. **LLM 与嵌入模型不得明文写入日志**；API Key 仅本地存储。
10. **Python 代码不得裸 `python` 执行**——本机 `python` 指向损坏路径，一律用 `uv run`。

## 6. 编码约定

- **接口先行**：先冻结 pydantic 契约（含 SSE 事件枚举），各模块再并行实现；改了模型必须重跑 OpenAPI → TS 生成。
- SubAgent 输出用统一 pydantic Payload（`AnimationPayload` / `CodeTemplate` / `CodingHint` / `CodeEvaluation` / `QuizPayload` / `QuizResult`），不要用松散 dict。
- 字段命名：Python `snake_case`，出参统一转 `camelCase`（pydantic alias），前端统一 camelCase。**只做一次约定，不要两边混用。**
- SSE 前端解析必须用 `fetch` + `ReadableStream`，**不能用 `EventSource`**（它不支持自定义 header，带不了鉴权 token）。
- 检索 chunk 元数据 schema 固定：`chunk_id, text, embedding, grade_level, chapter_title, section_title, knowledge_point, content_type, parent_chunk_id, token_count`；节级 chunk 控制 300–600 token，父子 chunk（小子块检索、命中回父块作上下文）。
- 数据合规：K12 涉未成年人数据，**最小化采集，不采集生物特征**。

## 7. 已知陷阱

- **Python 环境**：本机裸 `python` 指向损坏的 `D:\Code\PythonEvm\python.exe`；pip 实际来自 `PythonEvm312`。**全程用 `uv` 锁定 Python 3.12**，文档只写 `uv run`。
- **Windows 中文编码（S01 实测修正，比原描述更棘手）**：
  1. 源码运行态：spawn 时传 `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8`，所有文件读写显式 `encoding="utf-8"`。
  2. **打包态：上面两个 env 无效**——PyInstaller 的 bootloader 设置 `Py_IgnoreEnvironmentFlag`，实测打包产物 `sys.flags.utf8_mode=0`、`sys.stdout.encoding='gbk'`，即便 env 已设对。**必须在 Python 层 `reconfigure(encoding="utf-8")`**，见 `server/app/encoding.py` 的 `install_utf8_stdio()`（已在 `main.py` 最早期调用）。`scripts/build_server.py` 里有对应的回归断言。
  3. 不要试图只靠 env 解决打包态乱码——那是一条死路，会白花半天。
- **PyInstaller 打包**：必须 `--onedir`（**不用 `--onefile`**，冷启动可达 10s+）；须 `--collect-all sqlite_vec --collect-all fastembed`，否则运行期找不到 `.dll`/模型文件。**统一走 `uv run python scripts/build_server.py`**（它做 collect、自检、清理残留进程），不要手敲 pyinstaller 命令。每加一个原生或数据依赖就重打一次包验证。
- **PyInstaller spec 的 `collect_all` 返回值**：必须在 `Analysis(...)` 之前收集并作为参数传入（接受 2 元组）；**不能**事后 `a.datas += collect_all(...)`——那时 `a.datas` 已是 3 元组，会 `ValueError: not enough values to unpack`。
- **sidecar 生命周期**：Python 绑 `127.0.0.1:0` 由系统分配端口，用 **stdout 单行 JSON** 握手（`{"event":"ready","port":…}`，失败回 `{"event":"error","message":…}`）；**stdout 只许输出这行 JSON**，日志全走 stderr。Electron 退出时必须杀进程树（Windows `taskkill /PID <pid> /T /F`），否则孤儿进程残留占端口（开发态 `uv run` 会派生子进程，`/T` 不可省）。
- **stdio 管道分片**：Node 的 `data` 事件可能把握手 JSON 切成半行，必须缓冲到 `\n` 再 parse（`desktop/src/main/sidecar-logic.ts` 的 `LineBuffer`）；非 JSON 行**只记日志、绝不当错误**。
- **重打包 `WinError 5`**：上次验证留下的 sidecar 仍持有产物 `.pyd`/`.dll` 时，PyInstaller 清 `dist/` 会失败。`build_server.py` 已自动 taskkill 自愈。
- **UI 验收不要靠截图**：本机截图受前台窗口/DPI 影响，常截到别的窗口。用 `desktop/scripts/verify-ui.mjs`（CDP 读真实 DOM，可断言、可进 CI）。`K12_DEBUG_PORT` 默认关闭，勿让分发包带调试入口。
- **LangGraph checkpointer 与「一人一库」冲突**：`compile(checkpointer=...)` 把 checkpointer 绑死在图实例上，而学生库是一人一文件，**不能编译一次全局复用**。按 `student_id` 缓存已编译图（推荐），或切学生时重建 saver + 重新 compile。**不要**改用一个共享 DB + `thread_id` 前缀——会破坏合规叙事。
- **sqlite-vec 在 Python 中的加载**：需 `conn.enable_load_extension(True)` → `sqlite_vec.load(conn)` → 立刻 `enable_load_extension(False)`；加载失败须回退 FTS5 / numpy 暴力余弦。
- **动画生成不稳定**：必须保留「模板优先 + 校验 + 重试 3 次 → 降级文字/静态图」链路，不能只生成不兜底。
- **弱网 / API 不可用**：需有 UI 优雅降级（`error.degraded`），不要假设 DeepSeek 一定可用。
- **中文输出**：仓库文档、面向学生与家长的文案、System Prompt 均为中文；代码标识符与提交信息可用英文。
- **学段语气**：System Prompt 按学段差异化（童趣比喻 / 严谨逻辑），实现自适应时不要只改难度数字而忽略语气。
