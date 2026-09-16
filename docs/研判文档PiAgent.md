# 多模态 K12 人工智能通识课教学助手对话智能体
## 项目研判报告（Pi Agent 架构版）

**项目编号**：JBGS-2026-02
**发榜单位**：中国移动通信集团浙江有限公司
**报告性质**：基于五十三轮技术研讨 + Pi Agent 架构迁移后的完整研判报告
**日期**：2026年9月16日

---

> ## ⚠️ 归档说明与核实批注（2026-09-16 由开发代理追注）
>
> 本文件是**架构迁移提案的原始存档**，保留原文以留痕。但其中若干技术事实经独立核实后**有误**，
> 若不批注就直接引用，会把错误结论带进实现与答辩。
>
> **本文件的地位**：**提案/依据**，不是执行权威。执行时以 `项目执行文档.md` 为准；冲突时以执行文档为准。
>
> **核实方法**：读取 npm 正式发布产物 `@earendil-works/pi-coding-agent@0.85.1` 的 tarball
> （内含 README、`docs/*.md` 30 篇、全部 `dist/**/*.d.ts`）、npm registry 元数据、GitHub REST API、
> `pi.dev` 实际服务端 HTML。**凡下文标 ⚠️ 处，均为实测与原文不符之处**，逐条修正见文末附录 A。
>
> **一句话结论**：Pi Agent 作为编排底座**可行且优于 LangGraph 的地方成立**（`before_agent_start`
> 可改 systemPrompt、Tool 注册机制、JSONL 会话树、DeepSeek 原生 provider 均已确认），
> 但**它不是 Python 生态、不提供 Python 绑定**，且其包根导入会拖入 `esbuild` 原生二进制——
> 这与本仓库既有硬约束「Electron 侧不得引入任何原生数据库模块」存在张力。**该决策见附录 B。**

---

## 一、项目概述

本项目旨在基于大语言模型，构建一个面向 K12 阶段（小学至高中）人工智能通识课程的对话智能体，为学生提供交互式、多模态、个性化的在线学习体验，充当“7×24 小时在线 AI 教师”。智能体需具备学段自适应能力，支持多模态内容生成与交互，通过对话、动画、编程实践、游戏化练习等形式辅助学生学习编程与人工智能知识，并形成个性化学习闭环。

经过五十三轮技术研讨及后续 Pi Agent 架构迁移调研，项目组已完成技术选型、架构设计、模块划分和接口契约的完整定义。本报告系统梳理这些共识，形成可指导开发的完整方案。


## 二、核心架构变更说明

### 2.1 从 LangGraph 到 Pi Agent

项目原定采用 LangGraph 作为 Agent 编排框架。经过调研，Pi Agent 作为以 Extension 机制为核心的生产级 Agent 运行时底座，与本项目需求契合度更高，因此完成架构迁移。

Pi Agent 是 @earendil-works 开源的 Agent SDK，MIT 协议，定位为“生产级 AI Agent 的运行时底座”，OpenClaw 等产品即基于它构建，GitHub 累计 9.3 万星。核心设计哲学为 “Primitives, not features” ——默认只提供 4 个核心工具，所有可选功能通过 Extension 机制实现。

> ⚠️ **核实修正**：
> - **星数**：实际 **105,766**（约 10.6 万），非 9.3 万。仓库 `earendil-works/pi`，MIT，Python 无关，纯 TypeScript。
> - **「默认只提供 4 个核心工具」表述不完整**：**默认启用**的是 4 个（`read` / `bash` / `edit` / `write`），
>   但**内置可用**共 **8 个**（另有 `powershell` / `grep` / `find` / `ls`）。`createCodingTools()` 返回那 4 个，
>   `createReadOnlyTools()` 返回 `read/grep/find/ls`。
> - **「Primitives, not features」确认无误**，是 `pi.dev` 首页的实际 `<h2>` 标题原文。
> - **OpenClaw 的关系需降级表述**：双方互相致谢属实（pi.dev 首页点名 OpenClaw 为 SDK 实例；
>   OpenClaw README 致谢 Mario Zechner），但**集成方式无法从公开来源证实**——
>   OpenClaw 自己的 `docs/concepts/agent.md` 明确写「The runtime is OpenClaw-owned」，
>   且其根 `package.json` 只依赖 `@earendil-works/pi-tui`，**不含** `pi-coding-agent`。
>   **故不可写成「OpenClaw 用 Pi SDK 进程内嵌入」**，答辩时这是可被问穿的。

### 2.2 架构迁移对照

| 维度 | 原方案（LangGraph） | 新方案（Pi Agent） |
|------|-------------------|-------------------|
| 编排层 | LangGraph 状态图 + 节点路由 | Pi Agent Core + Extension 机制 |
| SubAgent 实现 | 独立 Node.js 模块，状态图编排 | 每个 SubAgent 一个 Pi Extension，通过 Tool 注册暴露能力 |
| 主 Agent 路由 | 状态图条件边 | LLM 通过 Tool 调用自主决定路由 |
| 跨模块通信 | 事件总线 + 统一接口契约 | Pi Event System + Tool Result 机制 |
| 会话持久化 | LangGraph Checkpointer | Pi JSONL Session Tree（天然支持分支和回放） |
| System Prompt | 固定构建 | 每轮动态拼装，通过 before_agent_start 钩子注入 |

**关键设计决策**：让 LLM 通过 Tool 调用自主决定路由，而非代码级显式路由。主 Agent 不设 `intent` 字段，路由由 LLM 根据 Tool 描述和 System Prompt 中的 `systemGuidelines` 自主完成。对话答疑不封装为 Tool，LLM 在“无工具可调用”时自然生成回答。

> ⚠️ **核实修正**：
> - **「天然支持分支和回放」**：**分支/分叉已确认**（`SessionManager.branch()` / `branchWithSummary()` /
>   `navigateTree()` / `forkFrom()` / `createBranchedSession()`，条目以 `id`/`parentId` 构成树）。
>   **「回放（replay）」全库无一等 API 或文档用此词，属 UNVERIFIED**，应改述为「分支 + 分叉 + 恢复 + JSONL 导入导出」。
> - **会话落盘位置需注意**：默认 `~/.pi/agent/sessions/--<cwd>--/<时间戳>_<uuid>.jsonl`，
>   可经 `settings.sessionDir` / `DefaultResourceLoader({ agentDir })` 改道。
>   **本项目要求「一人一库」，必须显式改道，不可落在用户全局目录。**
> - **「主 Agent 不设 intent 字段」与既有契约冲突**：现 `项目执行文档.md` §6 的 `TutorState` 含 `intent: Intent`，
>   且已冻结的 SSE 事件含 `payload.kind ∈ {animation,coding,quiz}`。是否保留显式 `intent` 见附录 B 决策。

### 2.3 Extension API 精确形态（原文未给出，此处补齐）

> 原文只说「通过 Tool 注册暴露能力」，未给 API。**实际形态已核实如下**，实现必须照此写：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Extension = 导出默认工厂函数，不是插件清单、不存在 registerExtension
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    return { systemPrompt: buildGradePrompt(grade) };   // ← 可改本轮 systemPrompt
  });
  pi.registerTool({ /* ToolDefinition */ });
  pi.registerCommand("name", { /* ... */ });
  pi.registerShortcut("ctrl+x", { /* ... */ });
  pi.registerFlag("my-flag", { /* ... */ });
}
```

`registerTool` 真实签名：

```typescript
registerTool<TParams extends TSchema, TDetails, TState>(
  tool: ToolDefinition<TParams, TDetails, TState>
): void;
```

`ToolDefinition` 字段：`name` / `label` / `description` / `promptSnippet?` / `promptGuidelines?` /
`parameters`（TypeBox `TSchema`）/ `constrainedSampling?` / `renderShell?` / `prepareArguments?` /
`executionMode?` / `execute(...)` / `renderCall?` / `renderResult?`。

**Extension 加载位置**（四种，本项目用第 4 种）：
1. `~/.pi/agent/extensions/*.ts` 与 `*/index.ts`（全局）
2. `.pi/extensions/*.ts`（项目内，需 trust）
3. `settings.json` 的 `"extensions": [...]` / `"packages": ["npm:...", "git:..."]`
4. **`DefaultResourceLoader({ additionalExtensionPaths, extensionFactories })`（SDK 嵌入推荐，本项目采用）**

加载器为 **jiti**（免编译直跑 TS）。

## 三、总体技术方案

### 3.1 技术选型汇总

| 类别 | 选型 | 理由 |
|------|------|------|
| 部署形态 | Electron 全本地化单应用 | 前后端统一，无需服务器 |
| Agent 运行时 | Pi Agent SDK（`@earendil-works/pi-coding-agent`） | Extension 机制灵活，生产级底座 |
| 嵌入模式 | SDK 嵌入模式 | 直接嵌入 Electron 主进程 |
| 前端框架 | Vue 3 + Pinia | 轻量，中文社区活跃，TypeScript 支持好 |
| 主模型 | DeepSeek 云端 API | 能力强，支持自填配置，流式输出 |
| 向量存储 | SQLite + sqlite-vec | 嵌入式，零依赖，纯 C 实现 |
| 嵌入模型 | BGE-M3（本地，通过 Ollama） | 中文效果好，本地可运行 |
| 知识图谱 | 邻接表 + 内存缓存 + 递归 CTE | 写入简单，查询够用 |
| 动画库 | Anime.js（MIT，可商用） | 轻量，DOM/SVG 动画 |
| 动画沙箱 | sandboxed iframe | 安全隔离，支持 DOM 操作 |
| 编辑器 | Monaco Editor | 功能完整，VS Code 同款 |
| 编程运行 | Pyodide + Web Worker | 浏览器内运行，安全隔离 |
| ASR | sherpa-zipformer-zh-14m（25MB） | Apache 2.0，CPU 流式识别 |
| TTS | Piper zh_CN-huayan-medium（63MB） | MIT，CPU 实时合成 |
| 语音运行时 | ONNX Runtime CPU | 纯 CPU，无需显卡 |
| 动画资源服务 | 本地 HTTP 服务（127.0.0.1） | 大 HTML 传输无序列化开销，可缓存 |
| 接口契约 | 严格 TypeScript 接口 | 并行开发集成基准 |

> ⚠️ **核实修正（三处与既有硬约束冲突，逐条见附录 B）**：
> 1. **嵌入模型 BGE-M3 + Ollama**：与既有决策 **D-002** 直接冲突（既有文档刻意移除 Ollama 与 torch，
>    改 `fastembed bge-small-zh-v1.5`，512 维 / 90MB）。**原文未给出回退理由**，仅沿用旧研判文字。
>    实测 Pi 侧无任何嵌入模型要求，**该改动与 Pi 迁移无关**。
> 2. **向量存储 `SQLite + sqlite-vec` 放在 Electron 主进程**：`sqlite-vec` 是原生扩展，
>    **与 `AGENTS.md` §4「Electron 侧不得引入任何原生数据库模块」冲突**。
>    且 Pi 包根导入已会拖入 `esbuild` 原生二进制（见 §4.1 批注），再叠 `sqlite-vec` 会显著加重 asar/签名负担。
> 3. **接口契约「严格 TypeScript 接口」**：与既有决策冲突（现为 **pydantic 唯一契约来源 → OpenAPI → TS 生成**）。
>    TypeScript 接口无法约束 Python 侧；若后端确定全量迁到 Electron，则此条才成立。
>
> **另需注意 DeepSeek BaseURL 差异**：Pi 内置 deepseek provider 的 `baseUrl` 是
> **`https://api.deepseek.com`（无 `/v1` 后缀）**，而现有 `LlmConfig` 默认写的是 `https://api.deepseek.com/v1`。
> 两者都能用（`openai-completions` API 会自行拼 `/chat/completions`），但**自填 BaseURL 时必须明确约定**，
> 否则会出现「默认值能跑、用户改成带 `/v1` 就连不上」这类现场故障。详见附录 A #11。

### 3.2 分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron 应用                              │
│  ┌─────────────────────────────────────────────────────────┐│
│  │               Vue 3 前端 (Pinia)                          ││
│  │  对话优先布局 │ 内联卡片+全屏切换 │ 流式输出展示          ││
│  └──────────────────────┬──────────────────────────────────┘│
│                         │ IPC / postMessage                   │
│  ┌──────────────────────▼──────────────────────────────────┐│
│  │        Electron 主进程 (Pi Agent SDK 嵌入)                ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────┐   ││
│  │  │           Pi Agent Core (主 Agent)                │   ││
│  │  │   System Prompt 动态拼装 │ Tool 注册 │ 事件流     │   ││
│  │  └──────────────────────┬───────────────────────────┘   ││
│  │                         │                                ││
│  │  ┌──────────┬──────────┼──────────┬──────────┐          ││
│  │  │          │          │          │          │          ││
│  │  ▼          ▼          ▼          ▼          ▼          ││
│  │ 动画Ext   编程Ext    练习Ext   画像Ext   学段Ext        ││
│  │ (Tool)    (Tool)    (Tool)    (Tool)    (Hook)          ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────┐   ││
│  │  │     SQLite (sqlite-vec + 依赖图 + 画像)           │   ││
│  │  │     每个学生独立数据库文件                         │   ││
│  │  └──────────────────────────────────────────────────┘   ││
│  │                                                          ││
│  │  ┌──────────────────────────────────────────────────┐   ││
│  │  │     本地 HTTP 服务 (动画资源, 127.0.0.1)          │   ││
│  │  └──────────────────────────────────────────────────┘   ││
│  └──────────────────────────────────────────────────────────┘│
│  ┌──────────────────────────────────────────────────────────┐│
│  │         沙箱环境                                          ││
│  │  sandboxed iframe (Anime.js) │ Pyodide Worker             ││
│  └──────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

> ⚠️ **此图若要照建，需先回答附录 B 的 B-1**：`SQLite(sqlite-vec)` 与「每学生独立 DB」
> 目前画在 **Electron 主进程内**，这要求引入原生 SQLite 模块（原文 §4.1 正是因此才要 `bun install`）。
> **本仓库既有硬约束禁止此事**（`AGENTS.md` §4），且既有 S01/S02 已交付「Electron + Python sidecar」
> 握手、token 鉴权、契约生成链。两条路只能选一条。

### 3.3 核心设计原则

1. **学段自适应判定**：学段由系统从对话中自动推断，不设前端按钮。SQLite 画像是权威源，System Prompt 中的学段指令是它的投影。
2. **主 Agent 负责路由和对话答疑**：LLM 通过 Tool 调用自主决定路由，对话答疑在无工具可调用时自然生成。
3. **所有跨模块调用经过 Pi Tool 注册**：SubAgent 能力通过 `pi.registerTool()` 暴露给 LLM。
4. **知识库检索严格按学段隔离，允许向上兼容但明确标注**。
5. **内容安全只做后端审核，流式输出 + 最终审核**。
6. **知识点依赖图同时服务于推荐路径规划和检索上下文扩展**。
7. **Pi 原生 JSONL 存储会话历史 + SQLite 只存学习记录**。

> ⚠️ **第 1 条与 `AGENTS.md` §5.1 直接冲突**：
> 现约束是「**学段由前端按钮切换**并随请求传入；主 Agent 在 `profile_load` 注入，SubAgent 不得自行推断」。
> 第 1 条改为「不设前端按钮、系统自动推断」。**这不是措辞问题**：
> 既有验收标准含「**同一问题在四学段下回答的深度与语气可明显区分**（留四张对比截图）」，
> 那是 20% 教育适配性得分的现场演示动作；改为自动推断后，演示脚本须改成「展示学段自动演化轨迹」，
> 且**冷启动默认值会决定学生首次体验**（原文承认冷启动默认「小学高年级」或「初中」）。
> 二选一决策见附录 B 的 B-3。


## 四、Pi Agent 集成方案

### 4.1 SDK 嵌入模式

采用 Pi SDK 嵌入模式，通过 `@earendil-works/pi-coding-agent` 直接嵌入 Electron 主进程。Electron 自带 Node.js Runtime，可以直接使用 Pi SDK，无需额外运行时。

**已有验证案例**：`pi-agent-sdk-starter` 验证了 Electron 主进程嵌入 Pi SDK 的可行性，Pi SDK 负责 Agent 运行时、工具执行、流式输出、状态和提供商路由，Electron 和 React 仅作为应用壳。`damocles` 项目验证了 Vue 3 + Pinia 前端 + Pi Runtime 后端的架构可行性。

**注意事项**：使用 `bun install` 而非 `npm install`，因为 `electron-rebuild` 与当前 Electron 版本不兼容，Bun 直接使用预编译的 `better-sqlite3` 二进制文件。

> ⚠️ **核实修正（本段 6 处事实问题，逐条给证据）**：
>
> | 原文 | 核实结果 |
> |---|---|
> | `pi-agent-sdk-starter` 验证了 Electron 嵌入 | ❌ **`badlogic/pi-agent-sdk-starter` 与 `earendil-works/pi-agent-sdk-starter` 均 404**。真实仓库是 **`vanzan01/pi-agent-sdk-starter`**（23★，MIT），且它是 **React 19，不是 Vue**；其 Electron 主进程嵌入代码在 `src/main/lib/pi-session.ts`，用的是 `createAgentSession` + `SessionManager.inMemory()` + `DefaultResourceLoader`。**「Electron 嵌入可行」这个结论仍然成立**，但引用来源必须改正。 |
> | `damocles` 验证了 Vue3+Pinia + Pi Runtime | ⚠️ **依赖属实**（`@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-server` / `pi-tui` 均 `^0.85.0`，且确有 `vue@^3.5.0` + `pinia@^3.0.4`），**但它是 VS Code 扩展，不是 Electron 应用**（devDeps 含 `@types/vscode`）。可引用为「Vue3+Pinia 与 Pi 共存可行」，**不可**说成 Electron 验证。 |
> | 「使用 `bun install` 而非 `npm install`」 | ⚠️ **属实但出处不是 Pi 官方**。这是 **starter kit 自己 README** 的话（原文：「The native-module rebuild step (electron-rebuild) is incompatible with current Electron versions... Bun uses the prebuilt better-sqlite3 binary directly」）。**Pi 官方全部 30 篇文档 grep "electron" 零命中**，issue tracker 无此议题。 |
> | 「因为 electron-rebuild 不兼容」 | ⚠️ **Pi 本身不依赖 `better-sqlite3`**（`grep -c better-sqlite3 npm-shrinkwrap.json` = **0**）。`better-sqlite3` 是 starter kit 自己的选择。**若本项目不引入原生 DB，这条注意事项根本不适用。** |
> | 「Electron 自带 Node.js Runtime，可以直接使用」 | ⚠️ **过于乐观，有真实坑**：Pi 包 `exports` **没有 `./sdk` 子路径**，只能从**包根**导入，而包根 `dist/index.d.ts` 首行即 re-export CLI 的 `main`。Pi 官方 issue **#9286**（标题即「We embed the coding-agent SDK in an Electron desktop app」）记录：根导入会 evaluate CLI `main.js` → 拖入 `@earendil-works/chord` → **`esbuild` 硬原生依赖**，在 Electron 里报 `Cannot find package 'esbuild'`（0.85.0 崩，0.85.1 靠下架实验代码缓解，但根导出仍加载 `main.js`）。**必须为该二进制做 asar 解包/按架构打包/签名处理。** |
> | 另有 Pi issue **#6308** | ⚠️ 「SDK 嵌入时默认 system prompt 会泄漏宿主应用安装路径」。**本项目必须用 `systemPromptOverride`**，否则会把本地路径喂给模型（也违反「禁止暴露内部实现」的 prompt 规则）。 |
>
> **SDK 入口真实名字**（原文未给，勿臆造）：`createAgentSession(options)` / `AgentSession` / `AgentSessionRuntime` /
> `ModelRuntime` / `SessionManager` / `DefaultResourceLoader` / `defineTool`。
> **不存在** `createAgent` / `PiAgent` 这类名字。
>
> ```typescript
> import { createAgentSession, ModelRuntime, SessionManager,
>          DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
>
> const modelRuntime = await ModelRuntime.create({ authPath, modelsPath });
> const { session } = await createAgentSession({
>   sessionManager: SessionManager.inMemory(),
>   modelRuntime,
>   resourceLoader: new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride }),
> });
> session.subscribe((event) => { /* → SSE */ });
> await session.prompt(userInput);
> ```
>
> **★ 必须照抄的一条工程实践**：starter kit 把应用配置与用户全局 Pi CLI 配置**隔离**
> （`ModelRuntime.create({ authPath, modelsPath })` 指向 `~/.pi-sdk/`，
> `DefaultResourceLoader({ agentDir })` 同理），并明确注明此举「avoids reading or mutating the user's
> global Pi CLI config at `~/.pi/agent`」。本项目**必须做同样隔离**，否则会污染用户机器上已有的 Pi 配置，
> 且与本仓库「API Key 仅本地存储、不入日志」的约束相冲。
>
> **运行环境要求**：`engines.node >= 22.19.0`（0.75.0+）；纯 ESM（`"type": "module"`）；
> 解包体积约 **21.9MB / 1056 文件**。旧版 `legacy-node20` tag 停在 0.74.2。

### 4.2 Extension 架构

每个功能模块封装为一个独立的 Pi Extension：

| Extension | 职责 | 注册内容 |
|-----------|------|----------|
| 动画 Extension | 生成动画代码、容错重试、降级处理 | `generate_animation` Tool |
| 编程 Extension | 提供代码模板、生成提示、评估代码 | `get_code_template`、`get_coding_hint`、`evaluate_code` Tool |
| 练习 Extension | 生成题目、批改答案、生成变式 | `generate_quiz`、`submit_quiz`、`generate_variants` Tool |
| 画像 Extension | 读取学习画像 | `get_student_profile` Tool |
| 学段 Extension | 学段自适应判定与注入 | `before_agent_start` Hook + 信号提取逻辑 |
| 学习记录 Extension | 订阅工具执行事件，写入 SQLite | `tool_execution_end`、`session_end` Hook |

**Extension 状态隔离**：Pi Extension 运行在与 Agent 相同的进程中，拥有完整系统权限。`pi-subagents` 扩展提供了“in-process & native”的子代理机制，子代理在隔离的会话中运行，各自拥有独立的工具、System Prompt、模型和思考层级。对于本项目，学段判定、学习记录等 Extension 的内存状态（如 `signalBuffers`、`gradeLevelCache`）按 `studentId` 隔离，存储在 Map 中，切换学生时清理或重新加载。

> ⚠️ **核实修正（3 处）**：
> 1. **`session_end` 不存在**。全包 1056 文件 grep `session_end` = **0 命中**。
>    真实终态钩子是 **`session_shutdown`**，以及用于「一轮跑完」的 **`agent_end`** / **`agent_settled`**。
>    **按原文写会直接编译不过。**
> 2. **`pi-subagents` 不是官方扩展**。Pi 官方哲学明确写着 **「No sub-agents」**
>    （原文：*"**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own
>    with extensions, or install a package that does it your way."*），只提供一个 `subagent/` **示例**。
>    「in-process & native」这句**确切存在，但属于第三方包 `@gotgenes/pi-subagents`**
>    （自述：*"In-process & native — agents run inside the same pi runtime (no spawned subprocesses)"*）。
>    另有 `pi-subagents`（nicobailon，3602★）——但那个**不是**进程内，后台子代理跑在分离的 runner 进程里。
>    **引入任一者都是引入第三方依赖，需在报告中如实标注为非官方。**
> 3. **Extension 拥有完整系统权限**——这句是对的，且**风险必须写进报告**：
>    Extension 与 Agent 同进程，无沙箱。学生代码若被误执行在 Extension 路径上等于裸奔。
>    **本项目仍须坚持「Monaco/Pyodide 在独立 Worker + sandboxed iframe」的既有隔离约束，不可因 Pi 而放松。**

### 4.3 关键 Hook 使用

**`before_agent_start`**：在用户提交 prompt 后、Agent Loop 启动前触发，可以注入消息和修改 System Prompt。`event.systemPrompt` 和 `ctx.getSystemPrompt()` 反映的是链式 System Prompt 的当前状态，后续的 `before_agent_start` 处理器可以继续修改它。本项目的学段指令注入即通过此 Hook 实现。

**`tool_execution_end`**：工具执行完成后触发。学习记录 Extension 订阅此事件，从 `submit_quiz`、`evaluate_code`、`generate_animation` 等工具的结果中提取学习数据，写入 SQLite。

**`session_end`**：会话结束时触发。学习记录 Extension 在此提取会话级摘要，写入 SQLite。

**`input`**：用户输入进入 Agent Loop 前触发。学段 Extension 在此执行轻量级信号预判（词汇复杂度、问题类型检测），不阻塞主流程。

> ⚠️ **核实修正**：
> - **`before_agent_start` ✅ 确认存在，且确实能改 systemPrompt**。真实返回类型：
>   ```typescript
>   export interface BeforeAgentStartEventResult {
>     message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
>     /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
>     systemPrompt?: string;
>   }
>   ```
>   文档原文：*"Fired after user submits prompt, before agent loop. Can inject a message and/or modify the
>   system prompt."* **多个扩展同时返回时按链式叠加**（后加载的可看到前者的修改）。
>   **这是学段语气/深度自适应的正确落点**，也是 Pi 相比 LangGraph 的实质优势——**每轮**可换，无需重建会话。
> - **`tool_execution_end` ✅ 确认存在**，但是**只读通知**，不能改结果。
> - **`session_end` ❌ 不存在**，改用 `session_shutdown`（会话关闭）或 `agent_end`（一轮结束）。
> - **`input` ✅ 确认存在**，且**可修改**：返回 `{action: "continue" | "transform" | "handled"}`。
> - 补充：Pi 共 **34 个事件**。可变更类含 `tool_call`（可 `{block, reason, terminate}` 并原地改 `event.input`）、
>   `tool_result`、`context`（改 `messages`）、`message_end`、`before_provider_request`（**可在请求头/体层做注入与审计**）。
>   **`before_provider_request` 对「LLM 与嵌入模型不得明文写入日志」这条合规约束有用**：
>   可在 provider 边界统一做脱敏与审计，而不是散在各处。


## 五、学段自适应判定机制

### 5.1 总体流程

学段判定分为**初始冷启动判定**和**后续精准修正**两个阶段，全程无需前端按钮触发。

**初始判定触发条件**：累计达到3轮有效对话后执行首次判定，若信号置信度不足，延至第5轮做补充判定。

**冷启动默认值**：首次使用时画像中无学段数据，默认使用“小学高年级”或“初中”——位于K12中间区间，对低龄学生不会造成过大认知压力。

### 5.2 判定信号来源

学段判定信号参考 ECNUClaw 的五维学习者画像设计，该系统“从学生-伴侣对话中每轮提取信号”，覆盖认知、行为、情感、元认知、情境五个维度，其中“情境”维度明确包含年级。本项目的学段判定信号归纳为四类：

**第一，词汇复杂度信号**：学生使用的词汇是否包含专业术语（“神经网络”“梯度下降”），还是日常用语（“电脑怎么认图片”）。

**第二，问题深度信号**：学生问的是“什么是AI”（概念感知）、“神经网络怎么学习的”（原理理解），还是“反向传播的链式法则怎么推导”（算法推导）。

**第三，答题表现信号**：学生在游戏化练习中的正确率、解题速度、是否需要提示。连续答对当前学段题目3次以上考虑向上修正，连续答错或表示“太难了”触发向下修正。

**第四，元认知表达信号**：学生是否表达“听不懂”“再讲一遍”“换个说法”，这通常是低学段或受挫信号。

### 5.3 双层判定机制

采用 **“LLM 信号提取 + 规则引擎决策”** 的双层机制，避免纯依赖 LLM 做学段判定存在的不稳定性。

**第一层：轻量预判**。每轮输入后同步执行，不调用额外 LLM，仅做规则检测（正则匹配专业术语、问题类型），将信号写入内存缓冲区。

**第二层：LLM 信号提取**。在第3轮或第5轮触发，通过独立的轻量 LLM 调用对最近几轮对话做系统性学段判定，返回结构化信号（`suggestedAdjustment`、`confidence`）。

**规则引擎决策**：接收 LLM 信号，结合历史记录做最终决策。核心约束包括：置信度阈值（< 0.6 不调整）、方向一致性（连续3个信号同方向）、冷却期（调整后5轮内不重复调整）。

### 5.4 与学习画像的同步

学段是 `StudentProfile` 的一个字段，自适应判定的结果需要原子性写入 SQLite 画像。学段调整后，System Prompt 中的学段指令会在下一轮 LLM 调用时通过 `before_agent_start` Hook 自动更新。学生不会感知到“学段切换”事件，只会在下一轮回答中感受到教学风格的微妙变化。

**学段变化轨迹记录**：教师/家长导出学习报告时，展示学段的变化轨迹（如“第3轮判定为小学高年级，第12轮调整为初中”），这对理解学生学习进展有价值。

> ⚠️ **本节整体是一套自洽、可实现的机制，技术判断成立**，且「规则引擎做最终决策而非纯 LLM」是正确的稳健性设计。
> **但它改变的是产品行为，不只是实现**：
> - 与 `AGENTS.md` §5.1（学段由前端按钮切换、SubAgent 不得推断）冲突。
> - 与验收标准「同一问题四学段对比截图」冲突——该演示动作将不再成立。
> - 与赛题原文「**学生可选择所在学段**……智能体根据选择自动匹配」的表述**存在张力**：
>   赛题是「学生可选择」，「自动推断」是超出要求的能力。**建议做法是「显式选择为主 + 自动推断为辅」**：
>   保留按钮作为权威来源与冷启动默认值（保住演示与验收），把自动推断作为**可选增强**并在报告中作为创新点。
>   这样两边都不丢分。**最终由决策人拍板（附录 B 的 B-3）。**
> - 若采用自动推断：冷启动默认值必须**在 UI 上可被学生/家长纠正一次**，否则误判会长期锁死体验（原作给了冷却期，但没给「人工纠偏」出口）。


## 六、核心模块设计

### 6.1 对话问答

- **交互形式**：对话优先布局，主界面为大对话区域，功能以卡片形式内联，支持展开/全屏。
- **流式输出**：DeepSeek API 逐 token 推送，前端实时显示。
- **内容安全**：流式输出 + 最终审核，生成结束后整段送审，违规则撤回并替换为安全提示。
- **学段适配**：通过 `before_agent_start` Hook 注入学段指令，LLM 根据学段调整语言风格和知识深度。

### 6.2 动画讲解

- **执行环境**：主线程 sandboxed iframe，通过 `sandbox` 属性限制权限。
- **动画库**：Anime.js（MIT 协议，可商用），操作 DOM/SVG。
- **生成策略**：大模型一次性生成完整 HTML 代码，System Prompt 内置少量高质量示例。
- **容错策略**：Worker 捕获错误后自动重试 3 次，仍失败则降级为文字 + 静态图讲解。
- **资源服务**：本地 HTTP 服务托管动画 HTML，绑定 127.0.0.1，路由带 `studentId` 实现学生隔离。
- **缓存策略**：每个学生目录内同一知识点只保留最近一份动画缓存，metadata.json 记录映射关系。
- **通信协议**：完整 RPC 式协议（play/pause/restart/progress/error），通过 postMessage 在宿主页面和 iframe 之间通信。

> ⚠️ **「生成策略」与既有决策 D-004 冲突**：既有文档明确改为「**模板优先 + 生成补充**」，
> 理由正是「原方案自认『LLM 一次性生成完整 HTML 失败率高』是头号风险」。
> **本节等于把已被否决的方案改回来了，且未给理由。** 建议维持 D-004。见附录 B 的 B-4。
> 另：`sandbox="allow-scripts"` **禁止加 `allow-same-origin`** 这条既有硬约束必须保留（`AGENTS.md` §5.7）。

### 6.3 编程环境

- **编辑器**：Monaco Editor（VS Code 同款）。
- **运行环境**：Pyodide（浏览器内 WebAssembly），单独开 Web Worker 与动画沙箱隔离。
- **预置包**：numpy、matplotlib 等常用包预打包进应用，离线可用。
- **代码模板**：按知识点类型预置不同模板（排序算法、神经网络、决策树等）。
- **求助机制**：自动感知报错 + 手动求助按钮结合，学生连续失败 N 次后主 Agent 主动介入。`pi-learning` 项目的实现规范明确指出“不允许模型直接生成任意 HTML/JS 作为题目 UI，模型只能调用预定义 Learning Tools，前端根据结构化 payload 渲染组件”。本项目编程环境的代码提交和反馈也遵循此原则。

> ⚠️ **`pi-learning` 项目未经核实**，本文件无法确认其存在与出处（`earendil-works/pi` 组织下未见此仓库）。
> **但这条「模型只调用预定义 Tool，前端按结构化 payload 渲染，不允许模型直出 HTML/JS」的原则本身正确**，
> 与本仓库既有契约（`AnimationPayload` / `QuizPayload` 等强类型 payload + 沙箱渲染）完全一致，
> **应予保留，但引用来源需替换为可查证的依据**，或直接作为本项目自定原则陈述。

### 6.4 游戏化练习

- **题目来源**：预置题库 + 大模型变式生成。
- **题型**：选择题、填空题 + 交互式题型（拖拽排序、连线匹配、代码填空）。
- **批改策略**：混合方案——客观题用专门逻辑批改，主观题由大模型辅助判断。
- **反馈机制**：自动批改，即时反馈，记录知识点掌握度变化。

> 与既有文档一致（既有文档第一期只做选择/填空/代码填空，拖拽与连线为 P1）。**建议维持既有裁剪。**


## 七、知识库与 RAG 方案

### 7.1 知识库构建

- **教材格式**：Markdown 正文 + 配套元数据文件（声明学段、章节、知识点标签、依赖关系）。
- **分块策略**：按教材结构分块（章→节→段落三级），节级 chunk 控制在 300-600 token。
- **元数据 Schema**：`chunk_id`、`text`、`embedding`、`grade_level`、`chapter_title`、`section_title`、`knowledge_point`、`content_type`、`parent_chunk_id`、`token_count`。
- **父子 chunk 机制**：小子 chunk 做 embedding 检索，命中后返回父 chunk 作为生成上下文。

### 7.2 向量存储与检索

- **向量数据库**：SQLite + sqlite-vec（嵌入式，零依赖）。
- **嵌入模型**：BGE-M3（本地，通过 Ollama 拉取）。
- **检索流程**：学生查询 → 学段判定结果注入 → BGE-M3 生成查询向量 → sqlite-vec KNN 查询（WHERE 约束学段）→ 命中子 chunk → 通过 `parent_chunk_id` 获取完整节内容 → 注入 LLM 上下文。
- **学段策略**：严格隔离 + 允许向上兼容，兼容内容明确标注。

### 7.3 知识点依赖图

- **存储方式**：邻接表 + 内存缓存 + 递归 CTE 查询。
- **表结构**：`knowledge_dependencies (from_kp_id, to_kp_id, relation, weight)`。
- **用途**：推荐路径规划（根据依赖图推荐下一步学习内容）+ 检索上下文扩展（将前置知识点纳入检索范围）。
- **循环检测**：教材元数据导入阶段用 DFS 遍历检测环。

> ⚠️ **7.1 / 7.3 与既有文档一致，可直接沿用**（元数据 schema、300–600 token、父子 chunk、依赖图双用途均已冻结）。
> ⚠️ **7.2 两处冲突**：
> 1. **嵌入模型改回 BGE-M3 + Ollama** —— 与 D-002 冲突，见附录 B 的 B-2。
> 2. **降级链消失**：既有文档要求「**sqlite-vec + FTS5(trigram) + numpy 暴力余弦** 三级兜底」，
>    本节只剩「sqlite-vec KNN」单点。**在原方案里 Ollama 不可用即全链路失效**，
>    这正是既有文档要加 FTS5 与 numpy 兜底的原因。**无论最终选哪个嵌入模型，三级降级链都应保留。**
> 3. 若沿用 Python sidecar（附录 B 的 B-1 选项一），`sqlite-vec` 在 Python 中需
>    `enable_load_extension(True)` → `sqlite_vec.load(conn)` → 立刻关回 False；打包需 `--collect-all sqlite_vec`。


## 八、数据存储与隔离

### 8.1 数据分工

| 数据源 | 存储内容 | 格式 |
|--------|---------|------|
| Pi Session Tree | 对话历史、工具调用记录 | JSONL（Pi 原生） |
| SQLite（每学生独立） | 学习画像、答题记录、知识点依赖图、题库 | SQLite |
| 本地 HTTP 服务缓存 | 动画 HTML 资源 | 文件（每学生独立目录） |

**SQLite 不存储对话内容本身**，只存储从对话中提取的结构化学习数据。对话历史归 Pi JSONL，学习记录归 SQLite，两者通过 `studentId` 和 `sessionId` 关联。

### 8.2 目录结构

```
userData/
  ├── students/
  │     ├── student_001/
  │     │     ├── learning.db          # SQLite 学习记录
  │     │     ├── pi-agent/            # Pi JSONL 会话
  │     │     │     └── sessions/
  │     │     └── animations/          # 动画缓存
  │     └── student_002/
  │           ├── learning.db
  │           ├── pi-agent/
  │           └── animations/
  └── shared/
        └── knowledge.db               # 全局知识库（只读）
```

### 8.3 学习记录同步

学习记录 Extension 订阅 Pi 的生命周期事件，在 `tool_execution_end` 中将答题记录、代码评估结果、动画观看行为写入 SQLite；在 `session_end` 中写入会话摘要。学习记录的写入使用 SQLite 事务机制，确保原子性。

> ⚠️ **核实修正 + 一致性提醒**：
> - **`session_end` 不存在**，应改为 `session_shutdown` / `agent_end`（同 §4.3）。
> - **目录结构设计正确且优于原方案**：把 Pi 的 JSONL 会话放进 `students/<id>/pi-agent/`，
>   正好满足「一人一库、不得跨学生共享」。**但必须显式配置**（`DefaultResourceLoader({ agentDir })`
>   或 `settings.sessionDir`），否则 Pi 默认写到 `~/.pi/agent/sessions/--<cwd>--/`，
>   **一个学生的对话会与另一个学生混在同一目录里**——这是合规硬伤（`AGENTS.md` §5.8）。
> - **`knowledge.db` 与既有命名 `kb.sqlite` 不一致**。双库设计本身（全局只读知识库 + 每人私有库）
>   与既有决策 **D-003 完全一致**，只是文件名要统一，避免文档两套叫法。
> - **对话历史归 Pi JSONL、SQLite 只存结构化学习数据** 这条划分是对的，
>   且**解决了既有文档里 `SqliteSaver` 与「一人一库」的冲突**（原 `P-005` 预判的那个坑）。
>   这是 Pi 迁移的**实质收益之一**，报告应作为亮点写。


## 九、接口契约

### 9.1 共享基础类型

```typescript
type GradeLevel = 'primary_low' | 'primary_high' | 'junior' | 'senior';

interface ChatMessage {
  id: string;
  role: 'student' | 'assistant' | 'system';
  content: string;
  contentType: 'text' | 'animation_card' | 'code_card' | 'quiz_card';
  payload?: unknown;
  timestamp: number;
  gradeLevel: GradeLevel;
}

interface StudentProfile {
  studentId: string;
  name: string;
  gradeLevel: GradeLevel;
  knowledgeMastery: Record<string, number>;
  errorPoints: string[];
  preferences: {
    preferredModalities: ('text' | 'animation' | 'code' | 'quiz')[];
    pacePreference: 'slow' | 'normal' | 'fast';
  };
  gradeHistory: { level: GradeLevel; turn: number; timestamp: number }[];
  createdAt: number;
  updatedAt: number;
}

type ModuleResult<T> =
  | { success: true; data: T }
  | { success: false; error: ModuleError };

interface ModuleError {
  code: string;
  message: string;
  retryable: boolean;
}
```

### 9.2 Tool 注册契约

**动画 Tool**：`generate_animation(knowledgePoint, gradeLevel, additionalContext?) → AnimationPayload`

**编程 Tool**：`get_code_template(knowledgePoint, gradeLevel) → CodeTemplate`；`get_coding_hint(code, error, knowledgePoint, gradeLevel, attemptCount) → CodingHint`；`evaluate_code(code, output, knowledgePoint, gradeLevel) → CodeEvaluation`

**练习 Tool**：`generate_quiz(knowledgePoint, gradeLevel, count, excludeIds, studentId) → QuizPayload`；`submit_quiz(quizId, answer, studentId) → QuizResult`；`generate_variants(originalQuizId, studentId) → QuizPayload`

**画像 Tool**：`get_student_profile(includeHistory?, knowledgePoint?) → StudentProfile | { isNewStudent: true }`

### 9.3 事件总线

```typescript
interface ModuleEvents {
  'quiz:submitted': { studentId: string; quizId: string; result: QuizResult };
  'coding:success': { studentId: string; knowledgePoint: string };
  'coding:failed': { studentId: string; error: string; attemptCount: number };
  'animation:completed': { studentId: string; knowledgePoint: string };
  'grade:changed': { studentId: string; from: GradeLevel; to: GradeLevel };
  'report:export': { studentId: string; format: 'pdf' | 'image' };
}
```

> ⚠️ **契约层需与既有成果对齐，不可双轨**：
> - **这些 Tool 的 I/O 类型名与既有 pydantic 契约一致**（`AnimationPayload` / `CodeTemplate` /
>   `CodingHint` / `CodeEvaluation` / `QuizPayload` / `QuizResult`）——**这是好事，说明两边可收敛**。
> - **但契约来源不能改成 TypeScript 手写**（见 §3.1 批注）。既有链路是
>   **pydantic 唯一来源 → OpenAPI → `openapi-typescript` 生成 TS → typecheck 即漂移告警**，
>   且已落地 `--check` 字节校验与架构守卫测试。**若改为 TypeScript 手写接口，这套防漂移机制整体作废**，
>   代价极大。**推荐：保留 pydantic 为唯一来源，Pi 侧的 Tool `parameters` 用 TypeBox 定义后
>   由 pydantic 模型生成或做一致性断言。** 见附录 B 的 B-5。
> - **Tool 参数/返回若直接从 TypeScript interface 生成 TypeBox `<TSchema>`**，需注意 Pi 用 TypeBox 做参数校验，
>   与 JSON Schema 并非逐字段等价（如 `Record<string, number>`、`unknown` 的映射）。
> - **`ModuleResult<T>` / `ModuleError` 与既有契约无对应物**。既有设计用「pydantic 强类型 payload +
>   `error.degraded` SSE 事件」表达失败，**不要新增第二套错误语义**，否则前端要处理两种失败形态。


## 十、开发策略与实施计划

### 10.1 开发策略

- **并行推进**：对话、动画、编程、练习四个模块同时开发。
- **接口先行**：先定义严格的 TypeScript 接口契约，各模块严格遵循。
- **集成节奏**：定期联调，发现不匹配及时调整。
- **文档策略**：先完成系统原型，最后统一撰写项目报告。
- **路由测试**：搭建路由测试台，输入学生问题后展示 LLM 选择调用了哪个 Tool、传了什么参数、返回了什么结果，快速迭代路由描述。

> 与既有文档一致（既有为 pydantic 为先）。**「路由测试台」是个好补充**，
> 且 Pi 侧有现成抓手：`session.subscribe(...)` 能拿到 `tool_execution_start/end` 与 `tool_call` 事件，
> 可直接把「选了哪个 Tool、参数、结果」渲染成调试面板。建议纳入。

### 10.2 里程碑

| 阶段 | 时间 | 交付物 |
|------|------|--------|
| 接口契约设计 + Pi Agent 集成验证 | 第1周 | TypeScript 接口定义、Pi SDK 嵌入验证 |
| Extension 并行开发 | 第2-6周 | 六个 Extension 独立可运行 |
| 学段自适应机制开发 | 第4-7周 | 信号提取、规则引擎、画像同步 |
| 集成联调 | 第7-8周 | 完整应用可运行，端到端流程打通 |
| 优化与测试 | 第9-10周 | 性能优化、安全审核、用户体验打磨 |
| 报告撰写 | 第11-12周 | 项目报告、演示视频、部署文档 |

### 10.3 团队分工

| 角色 | 职责 |
|------|------|
| 架构师 | 接口契约、Pi Extension 编排、集成联调 |
| 前端开发 | Vue 3 界面、对话布局、卡片系统 |
| 动画模块 | Anime.js 生成、iframe RPC、容错降级、HTTP 服务 |
| 编程模块 | Monaco Editor、Pyodide Worker、代码模板 |
| 练习模块 | 题库建设、变式生成、混合批改 |
| 知识库 | 教材编写、元数据标注、依赖图构建 |
| 学段模块 | 信号提取、规则引擎、画像同步 |
| 语音模块 | sherpa-onnx 集成、按键说话逻辑 |

> ⚠️ **时间线与团队与既有执行文档冲突**：既有文档是**单人 · 15 天极限冲刺**，
> 此处是 **11–12 周 + 8 人分工**。**这是两套完全不同的排期假设**，
> 必须确认以哪套为准，否则任务卡、关卡、砍单顺序全部作废。见附录 B 的 B-6。


## 十一、风险分析与应对

| 风险 | 影响 | 应对措施 |
|------|------|---------|
| 动画代码生成失败率高 | 学生体验差 | 内置高质量示例，自动重试 3 次，降级文字+静态图 |
| SQLite 向量检索规模瓶颈 | 知识库扩大后性能下降 | 按学段/学科分区，必要时升级向量库 |
| 语音模型中文效果不达预期 | 低学段体验受损 | 备选 sherpa-paraformer-bilingual-zh-en |
| DeepSeek API 不稳定 | 对话中断 | 支持用户自填其他供应商 |
| Pi Extension 崩溃影响主 Agent | 系统不稳定 | Pi Extension 为独立模块，严重错误可隔离 |
| 学段判定误判 | 教学风格不匹配 | 规则引擎的连续信号一致性约束 + 冷却期 |
| 并行开发集成冲突 | 返工 | 严格 TypeScript 接口契约，定期联调 |
| 本地 HTTP 服务端口冲突 | 动画无法加载 | 端口检测 + 降级到随机端口 |

> ⚠️ **风险表需补 4 条（原文漏掉了 Pi 迁移引入的新风险，都是实测已知的）**：
> 1. **`esbuild` 原生依赖导致 Electron 打包失败**（Pi 官方 issue #9286 正是此症状：
>    `Cannot find package 'esbuild'`）。应对：asar 解包白名单 + 按架构分发 + 签名验证；
>    **并在最早阶段就做一次 Electron 打包冒烟**（沿用既有「关卡 A」的做法）。
> 2. **Pi 包根导入触发 CLI `main.js` 副作用**。应对：固定版本能缓解但未根治；
>    需在集成验证阶段确认导入图，必要时优先评估 RPC 模式。
> 3. **默认 system prompt 泄漏宿主安装路径**（Pi issue #6308）。应对：强制 `systemPromptOverride`。
> 4. **会话落盘位置未改道导致跨学生数据混放**（合规硬伤）。
>    应对：显式配置 `agentDir`/`sessionDir`，并加**自动化断言**（类似既有的 UI/打包自检），
>    检测 `students/<id>/` 之外是否出现 `.jsonl`。
> 5. **「Extension 与 Agent 同进程、拥有完整系统权限」是新的攻击面**。
>    应对：坚持既有沙箱约束（iframe 无 `allow-same-origin`、Pyodide 独立 Worker），
>    Extension 不得执行学生提供的代码。


## 十二、创新点与优势

1. **Pi Agent 多 Extension 协作架构**：以 Pi Agent 为运行时底座，各功能模块封装为独立 Extension，通过 Tool 注册和事件系统协作，架构清晰且可扩展。
2. **学段自适应判定机制**：从对话中自动推断学段，两阶段判定（初始冷启动 + 后续精准修正），双层机制（LLM 信号提取 + 规则引擎决策），无需学生手动选择。
3. **SQLite + sqlite-vec 嵌入式 RAG**：零依赖、纯 CPU、轻量高效，适合边缘部署。
4. **知识点依赖图双用途**：同时驱动推荐路径规划和检索上下文扩展。
5. **学生隔离的全链路设计**：SQLite 数据库、Pi JSONL 会话、动画缓存均按学生独立存储。
6. **动画生成容错体系**：自动重试 + 降级策略，保证学生始终有内容可看。
7. **纯 CPU 语音交互**：sherpa-onnx + Piper，25MB ASR + 63MB TTS，低延迟、可商用。

> ⚠️ **答辩风险提示（创新点 1、2 需加固表述）**：
> - 创新点 1「Pi Agent 多 Extension 协作」：**Pi 的官方哲学恰恰是「No sub-agents」**，
>   且主 Agent 路由是「LLM 自主选 Tool」而非确定性路由。
>   **评委若问「这算架构设计吗，还是把路由交给了模型？」需有答案**：
>   应答「以 Tool 描述 + promptGuidelines 约束可选空间，关键约束（学段隔离、安全终审、沙箱）仍在代码层强制」，
>   并说明**为什么选非确定性路由**（更贴近真实教学对话的多意图混合）。
> - 创新点 2 若采用自动推断，**必须准备「误判如何纠偏」的答案**（否则是减分项，不是创新点）。
> - 创新点 3「零依赖」若保留 BGE-M3 + Ollama，**「零依赖」一词不再成立**（用户须装 Ollama）。
>   这是自相矛盾，须修。


## 十三、结论

本项目经过五十三轮技术研讨及 Pi Agent 架构迁移调研，已形成完整、可落地的技术方案。方案以 Electron 全本地化为部署形态，以 Pi Agent SDK 为运行时底座，以 Extension 机制实现模块化协作，以 SQLite + sqlite-vec 为数据底座，聚焦对话问答、动画讲解、编程环境、游戏化练习四种核心交互方式，辅以学段自适应判定机制和本地语音交互，构建了一个符合 K12 教育场景需求的 AI 通识课教学助手。

技术选型充分考虑了比赛要求、硬件约束、开发效率和合规安全，具备较高的可行性和创新性。建议按照接口契约先行、Extension 并行开发、定期集成联调的策略启动开发，确保在比赛周期内交付高质量的系统原型和项目报告。

> **归档方结论**：Pi Agent 作为编排底座的**技术方向成立**，且解决了原方案的一个真实痛点
> （把对话历史交给 Pi JSONL 会话树，绕开了 `SqliteSaver` 与「一人一库」的绑定冲突）。
> 但本报告**不能直接作为执行依据**，须先解决附录 B 的六项决策——
> 其中 B-1（Python sidecar 去留）会决定这份文档里大约一半的章节是保留还是重写。

---

# 附录 A · 事实核实明细（14 项）

核实方式：读取 npm 正式发布产物 `@earendil-works/pi-coding-agent@0.85.1` 的 tarball（含 README、
`docs/*.md` 30 篇、`dist/**/*.d.ts`）、npm registry 元数据、GitHub REST API、`pi.dev` 服务端 HTML。

| # | 原文/预设 | 核实结果 | 证据 |
|---|---|---|---|
| 1 | GitHub 9.3 万星 | ⚠️ **105,766** | GitHub REST API `repos/earendil-works/pi`；MIT；`pushed_at` 2026-09-15 |
| 2 | `session_end` 钩子 | ❌ **不存在**（全包 0 命中） | 真实为 `session_shutdown` / `agent_end` / `agent_settled` |
| 3 | 内置工具「4 个」 | ⚠️ 默认启用 4 个，**内置共 8 个** | `defaultActiveToolNames = ["read","bash","edit","write"]`；`docs/settings.md` 列 8 个 |
| 4 | `before_agent_start` 存在且可改 systemPrompt | ✅ **确认** | `BeforeAgentStartEventResult.systemPrompt`，支持链式 |
| 5 | `tool_execution_end` / `input` | ✅ **确认** | `input` 可返回 `{action: "continue"\|"transform"\|"handled"}` |
| 6 | `pi.registerTool()` + 默认导出工厂 | ✅ **确认**；无 `registerExtension`、非插件清单 | `dist/core/extensions/types.d.ts` |
| 7 | 「Primitives, not features」 | ✅ **原文标题** | `https://pi.dev/` 的 `<h2 class="section-title">` |
| 8 | SDK 入口 `createAgent` / `PiAgent` | ❌ **不存在**；实为 `createAgentSession` / `AgentSession` / `AgentSessionRuntime` | `docs/sdk.md`、`dist/index.d.ts` |
| 9 | `badlogic/pi-agent-sdk-starter` | ❌ **404**；实为 `vanzan01/pi-agent-sdk-starter`（**React**，非 Vue） | GitHub 搜索仅 1 条结果 |
| 10 | `damocles` = Electron + Vue3 + Pinia | ⚠️ 依赖属实，但**是 VS Code 扩展** | `AizenvoltPrime/damocles` `package.json` |
| 11 | Pi 依赖 `better-sqlite3` | ❌ **0 命中**；是 starter kit 自己的依赖 | `grep -c better-sqlite3 npm-shrinkwrap.json` |
| 12 | `electron-rebuild` 不兼容是 Pi 官方结论 | ❌ **非官方**；是 starter kit README | Pi 全部文档 grep `electron` 零命中 |
| 13 | OpenClaw 基于 Pi 构建 | ⚠️ 互认属实，**集成方式不可证实** | pi.dev 点名；OpenClaw README 致谢；但其 `docs/concepts/agent.md` 称 runtime 自研，且仅依赖 `pi-tui` |
| 14 | `pi-learning` 引用 | ❌ **未能证实存在** | 原则本身正确，须换可查证依据 |

**额外发现（原文未提，但影响实现）**：

- **DeepSeek 是 Pi 一等公民 provider**：内置 `deepseek` provider，`baseUrl` = **`https://api.deepseek.com`（无 `/v1`）**，
  鉴权走 `DEEPSEEK_API_KEY` 环境变量或 `auth.json`；目录内含 `deepseek-v4-flash` / `deepseek-v4-pro` 等，
  `contextWindow: 1000000`。**任意 OpenAI 兼容端点也可**：`models.json` 里配
  `{ "baseUrl": "...", "api": "openai-completions", "apiKey": "...", "models": [{ "id": "..." }] }`，
  支持 `api` 取值 `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`。
  **Key 解析顺序**：CLI `--api-key` → `auth.json` → 环境变量 → `models.json`。
  → **完全满足本项目「供应商名称/BaseURL/APIKey/ModelID 可自填」要求。**
- **纯 Python 集成只能走 RPC 模式**：无 Python 绑定。官方提供
  `subprocess.Popen(["pi", "--mode", "rpc", "--no-session"])`，LF 分隔 JSONL 走 stdin/stdout
  （文档明确警告**不能用 `readline`**，因其会按 Unicode 分隔符切分 JSON 载荷内部）。
- **包根导入会拖入 `esbuild`**（`@earendil-works/chord` 把它列为正式依赖）→ asar 解包/签名负担。
- **`before_provider_request` / `before_provider_headers` 事件**可在 provider 边界统一做脱敏审计，
  对「不得明文写入日志」的合规约束有用。

---

# 附录 B · 需决策人拍板的 6 项（阻塞开工）

> 这些是**架构分叉**，不是措辞问题。选错会让文档写第二遍，故先列出。

| # | 决策点 | 选项 | 影响 |
|---|---|---|---|
| **B-1** | **Python sidecar 去留** | ① **保留 sidecar，Pi 只管编排**（RAG/DB/嵌入模型仍在 Python，Pi Tool 的 `execute` 发 HTTP 调用）<br>② **完全单进程**（Pi + `better-sqlite3`/原生 SQLite 全进 Electron，删 Python）<br>③ **Pi 走 RPC 模式**（不 import SDK，`pi --mode rpc` 作子进程） | **决定本文档一半章节是保留还是重写。**<br>选②须主动废除 `AGENTS.md` §4「Electron 侧不得引入任何原生数据库模块」，并放弃既有 sidecar 握手/token 鉴权/契约生成链成果（S01+S02 已交付）；选①/③保住既有成果，代价是保留双进程。<br>**注**：本仓库已有决策 **D-001 的核心理由是「原生模块风险归零」**，选②等于推翻 D-001 |
| **B-2** | **嵌入模型** | ① 保留 `fastembed bge-small-zh-v1.5`（512 维/90MB/无 Ollama）<br>② 改回 `BGE-M3` + Ollama（1024 维/2.24GB） | 选②须改 `vec0` 维度并重建索引，且**「零依赖」创新点不再成立**；与 D-002 冲突。原文**未给回退理由**，且该改动**与 Pi 迁移无关** |
| **B-3** | **学段判定** | ① 前端按钮为主 + 自动推断为辅<br>② 完全自动推断，去掉按钮 | 选②与 `AGENTS.md` §5.1 冲突，且**验收标准「同一问题四学段对比截图」失效**，演示脚本须改写；须补「误判如何人工纠偏」 |
| **B-4** | **动画生成策略** | ① 维持「模板优先 + 生成补充」（D-004）<br>② 改回「LLM 一次性生成完整 HTML」 | 选②与 D-004 冲突，且 D-004 的理由（原方案自认头号风险）未被回应 |
| **B-5** | **契约来源** | ① 维持 pydantic 唯一来源 → OpenAPI → TS 生成<br>② 改 TypeScript 手写接口 | 选②**整套防漂移机制（`--check` 字节校验 + 架构守卫测试）作废**。建议①，并让 Pi 的 TypeBox `parameters` 与 pydantic 模型做一致性断言 |
| **B-6** | **排期与团队** | ① 维持「单人 · 15 天」<br>② 改为「8 人 · 11–12 周」 | 决定 `stages/` 全部任务卡、关卡 A–E、砍单顺序是否作废 |

**开工前的最小验证清单**（无论选哪条路，都建议先做，成本低、风险高）：

1. **Electron 打包冒烟**：把 Pi SDK 装进 Electron 主进程，跑一次 `electron-builder`，
   确认 `esbuild` 原生二进制的 asar 解包与签名问题是否可解（对应既有「关卡 A」的做法）。
2. **导入图确认**：核实从包根导入时实际 evaluate 了哪些模块、是否触发 CLI `main.js` 副作用。
3. **会话落盘改道验证**：确认 `agentDir`/`sessionDir` 能落到 `students/<id>/`，
   并有断言防止 `~/.pi/agent/sessions/` 出现学生数据。
4. **Tool 契约一致性**：拿一个真实 Tool，验证 TypeBox `parameters` ↔ pydantic 模型的一致性可自动化断言。
