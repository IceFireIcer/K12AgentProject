# 技术决策记录（Decisions）

> 每条格式：**决策 → 理由 → 被否决的方案**。答辩时"为什么这么做"的答案直接从这里取。

## D-001 · 后端改用 Python sidecar（而非原研判的 Node/LangGraph JS）

- **决策**：Electron 仅作 UI 壳 + 进程管理；LangGraph 跑在 Python sidecar（FastAPI）里，经 `127.0.0.1` HTTP + SSE 通信。
- **理由**：
  1. LangGraph 的**参考实现与文档在 Python 侧**，示例密度远高于 JS 版；
  2. **原生模块风险归零**——Electron 侧不再需要 `better-sqlite3` / `sqlite-vec`，`electron-rebuild` 不再是关键路径；
  3. **白送持久化**：`SqliteSaver` 直接满足"跨 Session 记忆"这条硬要求；
  4. **白送流转图**：`draw_mermaid()` 产出报告所需的状态流转图（直接服务 25% 设计分）；
  5. 可脱离 UI 用 `uv run` + curl 调试全部 Agent/RAG 逻辑，单人开发并行度显著提升。
- **被否决**：① 原判研的 Node 内跑 LangGraph JS（生态不成熟，且要自己解决原生 SQLite 打包）；② 手写状态机替代 LangGraph（用户明确授权可用 Python 版 LangGraph，该顾虑不成立）。
- **代价（已接受）**：多一个运行时，安装包体积增大；需管理 sidecar 生命周期；Windows 中文编码须在 spawn 时强制 UTF-8。

## D-002 · 嵌入模型改 `bge-small-zh-v1.5`（fastembed/ONNX）

- **决策**：512 维、约 90MB、ONNX Runtime、纯 CPU。
- **理由**：**彻底移除 Ollama 与 torch 依赖**——原方案"需用户另装 Ollama"是演示现场头号翻车点。安装包体积相比 BGE-M3 方案减少约 2GB。
- **被否决**：BGE-M3（1024 维，2.24GB，需 Ollama + torch）。
- **升级路径**：若实测检索质量不足 → `bge-base-zh-v1.5`（768 维）。**必须同步改 `vec0` 维度并重建索引**，故维度已写成配置常量。

## D-003 · 双库设计（`kb.sqlite` + `student-<id>.sqlite`）

- **决策**：知识库全局一份且只读；每个学生一个私有库（画像/掌握度/历史/进度/checkpoint）。
- **理由**：原研判"每个学生独立数据库"直接照做会把**知识库与向量索引复制 N 份**，浪费且慢。双库保留"一人一库、互不影响"的合规结论，同时知识库只存一份。
- **被否决**：单库 + `student_id` 列过滤（合规叙事弱，答辩容易被问穿）。

## D-004 · 动画「模板优先 + 生成补充」

- **决策**：内置 6–8 个高质量模板；LLM 只负责"选模板 + 填参数 + 生成文案"；自由生成 HTML 仅作补充路径。失败重试 ≤3 次后降级为文字 + 静态图。
- **理由**：原研判自认"LLM 一次性生成完整 HTML 失败率高"是**头号风险**。模板优先把不确定的生成问题转为确定的参数填充问题。
- **被否决**：纯自由生成（演示翻车概率不可接受）。

## D-005 · 时间线从 11–12 周收敛为 15 天

- **决策**：单人 15 天极限冲刺；核心只做 4 种交互，**砍掉绘本生成与多模态资源推荐**。
- **理由**：赛题要求"至少三种多模态"，交付 4 种已超标有余量；评委更认可聚焦而非功能堆砌。砍单顺序已写进执行文档第 4 节作为硬性预案。
- **被否决**：把语音 ASR/TTS 列为核心（降为 P2，因 Python 下 `sherpa-onnx` 有 pip 包，成本大降，保留回捡余地）。

## D-006 · 端口握手用「stdout 单行 JSON」而非 HTTP 回调或固定端口（S01 落地）

- **决策**：sidecar 以 `--port 0` 启动让 OS 分配端口；绑定成功后向 **stdout 打一行 JSON**
  `{"event":"ready","port":N,"pid":...,"version":...}`，Electron 逐行读取解析。
  失败也走同一通道回 `{"event":"error","message":"..."}`。
- **理由**：
  1. **消除端口竞态**：自己「先扫空闲端口再启动」在并发/杀软场景下会撞车；让 OS 分配是原子的。
  2. **stdout 是天然的单向控制通道**，无需 sidecar 反向连 Electron（那会引入第二个端口与额外鉴权面）。
  3. **失败原因可读**：把启动期异常（数据目录不可写、拒绝绑定非回环地址）统一转成一行 JSON，
     Electron 直接拿到中文原因 —— 这是「不许白屏」这条硬要求的前提。
- **被否决**：① 固定端口（演示现场端口占用即翻车）；② sidecar 起 HTTP 后回调 Electron
  （多一个通信方向与鉴权面，复杂度不划算）；③ 写临时文件传端口（有残留与清理问题）。
- **配套约束**：**stdout 只许输出这行 JSON**，uvicorn 日志全部走 stderr；
  Electron 侧对非 JSON 行只记日志、绝不当错误（防第三方库直接 print 打死启动流程）。

## D-007 · 开发期用 `K12_SIDECAR_MODE=packaged` 提前验打包路径（S01 落地）

- **决策**：sidecar 的启动模式由 `K12_SIDECAR_MODE` 覆盖 `app.isPackaged`；
  开发期即可让 Electron 拉起 `server/dist/` 里的真实 exe。
- **理由**：关卡 A 的实质要求是「Electron 指向**打包产物**也能握手」。
  若每次都跑完整的 `electron-builder`（数分钟）才能验一次，改一行 sidecar 逻辑都要等；
  有了这个开关，验证 loop 缩到「打后端（~27s）+ 起 dev」。
  **注意**：这不能替代最终的整包验收 —— 我们仍然跑了 `electron-builder --dir`
  并在 `win-unpacked/` 里双击真实 `.exe` 复验通过（`extraResources` 的路径映射只有整包才能验到）。
- **被否决**：只跑开发态就宣称关卡 A 通过（那样验不到 `extraResources` 与 `resources/server/` 的实际布局）。

## D-008 · 编排框架从 LangGraph 迁移到 Pi Agent SDK（**v2 核心决策，2026-09-16**）

- **决策**：编排层从 **LangGraph（Python，跑在 sidecar 里）** 换成
  **Pi Agent SDK（`@earendil-works/pi-coding-agent`，TypeScript，嵌入 Electron 主进程）**。
  主 Agent 由 LLM **自主选 Tool** 路由（**取消 `intent` 字段**），能力经 `pi.registerTool()` 暴露，
  共 6 个 Extension。
  **但 Python sidecar 保留**，退化为「数据 / RAG / 嵌入 / 学段信号」服务。
- **理由（三条实质理由，不是「框架更新」）**：
  1. **`before_agent_start` 每轮可替换 systemPrompt**（官方返回类型 `BeforeAgentStartEventResult.systemPrompt`，
     多扩展链式叠加）。学段语气/深度的逐轮微调比 LangGraph 的固定图更自然，**且不需要重建会话**。
  2. **会话持久化与「一人一库」的冲突从根上消失**。原方案 `compile(checkpointer=...)` 把 checkpointer
     绑死在图实例上（即 `P-005` 预判的坑），而学生库一人一文件 → 不能全局复用。
     Pi 把对话历史交给原生 JSONL 会话树，**按学生分目录即满足隔离**，还白送分支/分叉/恢复。
  3. **路由方式更贴合真实教学对话**：学生的输入常是多意图混合，确定性条件边需要预先穷举，
     LLM 选 Tool 更自然。
- **代价（已接受，写进报告）**：
  - **失去「原生模块零依赖」**：Pi 包根导入会拖入 `esbuild`（`@earendil-works/chord` 的正式依赖），
    需处理 asar 解包/按架构打包/签名。**这是本决策最大的新增风险**（执行文档风险 #15）。
  - **S01/S02 传输层需局部返工**：渲染进程↔主进程从 HTTP+SSE 改为 IPC（**6 事件词表不变**，前端解析层可复用）。
  - **多语言边界移动**：编排从 Python 移到 TS，`TutorState` 作废。
- **被否决**：① 保留 LangGraph（`P-005` 那个坑要么靠按 student_id 缓存已编译图硬扛，要么破坏合规叙事）；
  ② **Pi + `better-sqlite3` 全进 Electron、删除 Python**——需主动废除 `AGENTS.md` §4
  「Electron 侧不得引入任何原生数据库模块」，并放弃 S01/S02 全部成果，且要把 fastembed 换成
  Ollama/云 API（**等于丢掉「零依赖、开箱即用」这个演示优势**）；
  ③ **Pi 走 RPC 模式**（`pi --mode rpc` 作子进程）——能绕开 `esbuild`，但会形成三进程，
  且 hook 注册要走额外 IPC 层。**保留为 D3 打包冒烟的 Plan B。**
- **★ 一条重要判断（答辩可能被问）**：迁移提案里另有 5 处改动**沿用了旧研判原文，且未给出理由**，
  已分别裁决为「维持既有决策」：**嵌入模型 BGE-M3/Ollama**（维持 fastembed，D-002）、
  **TS 手写契约**（维持 pydantic 唯一来源，D-001 衍生）、**11–12 周排期**（维持单人 15 天）、
  **LLM 一次性生成动画 HTML**（维持模板优先，D-004）、**纯自动推断学段**（改为显式为主+推断为辅）。
  即：**采纳的是与 Pi 迁移真正相关的改动，不是提案里的全部内容。**
- **报告用法**：这是「技术选型不是追新，而是逐条评估收益与代价」的典型案例。
  主动讲代价（失去原生模块零依赖）比被评委问出来更可信。

## D-009 · Pi 迁移提案的事实核实（**方法论素材，2026-09-16**）

- **决策**：提案归档前**先做独立事实核实**，把错误与冲突以批注形式写进
  `docs/研判文档PiAgent.md`，而不是照抄进权威文档。
- **核实方式**：读取 npm 正式发布产物 `@earendil-works/pi-coding-agent@0.85.1` 的 tarball
  （含 README、`docs/*.md` 30 篇、全部 `dist/**/*.d.ts`）、npm registry 元数据、GitHub REST API、
  `pi.dev` 实际服务端 HTML。**不依赖二手描述。**
- **查出 14 项事实问题**（详见该文档附录 A），其中会直接导致返工的 3 项：
  1. **`session_end` 事件不存在**（全包 grep 0 命中）—— 照写会直接不生效。真实为 `session_shutdown` / `agent_end`。
  2. **`pi-agent-sdk-starter` 仓库 404** —— 真实为 `vanzan01/pi-agent-sdk-starter`，且是 **React 不是 Vue**。
  3. **`bun install` 那条注意事项不是 Pi 官方结论** —— 是某第三方 starter kit 的 README；
     且 **Pi 本身不依赖 `better-sqlite3`**（grep 0 命中）。
- **同时确认了 4 项关键事实**（这些是迁移的真正依据）：
  `before_agent_start` 可改 systemPrompt、`pi.registerTool()` + 默认导出工厂、
  「Primitives, not features」是官网原文、**DeepSeek 是 Pi 一等公民 provider**（含自填 OpenAI 兼容端点能力）。
- **报告用法**：★ 很好的「工程严谨性」素材——**引用第三方技术提案前先核实一手来源**。
  也可用于说明「为什么我们的文档里会有一份带批注的提案存档」。
