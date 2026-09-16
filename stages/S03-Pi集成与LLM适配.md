# Stage 03 · Pi Agent 集成 + LLM 适配

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D3** |
| 关卡 | ✅ **关卡 B：能与大模型流式对话，且打包产物里 Pi 正常加载** |
| 前置 | S02（代码需先从 `archive/s02-full-code` 恢复） |
| 状态 | ⬜ **未开始（下一步）** |
| **★ 风险等级** | **最高** —— 同时压着执行文档风险 #15 / #16 / #17 |

---

## 1. 目标

把 Pi Agent SDK 嵌进 Electron 主进程，接上 DeepSeek，拿到流式回复；
**并证明它在打包产物里能加载**（这一步是本 Stage 的实质关口，不是「顺便验一下」）。

## 2. 任务清单（**按序做，不要跳**）

- [ ] **T1 · 验运行时**（30 分钟，失败就切 Plan B）
      `npm view @earendil-works/pi-coding-agent version engines`
      确认 Electron 内置 Node **>= 22.19**（Pi 0.75+ 的 `engines` 要求）。
      ⚠️ S01 实测本机 Electron 是 **39.8.10**（非文档里写的 ^33），很可能已满足 —— **但仍要实测确认**。
      退路：升 Electron，或降到 Pi **0.74.2**（`legacy-node20` tag，要求 >= 20.6）。**两个都能接受，别纠结。**
- [ ] **T2 · 清理旧依赖 + 重建 lock**（v2 必做）
      `uv remove langgraph langgraph-checkpoint-sqlite langchain-openai`
      → `uv sync` 重建 `uv.lock` → 重跑 `scripts/build_server.py` 验证打包产物仍正常。
      **别直接复用旧的 `.venv`。**
- [ ] **T3 · 装 Pi 并跑通最小会话**（不接 UI）
      `npm i @earendil-works/pi-coding-agent@^0.85`
      用 `createAgentSession` + `ModelRuntime.create({ authPath, modelsPath })` 配 DeepSeek，发一句话拿流式回复。
      - **必须设 `systemPromptOverride`**（防宿主安装路径泄漏，Pi issue #6308）
      - **`authPath` / `modelsPath` 指向本项目目录，不得读写 `~/.pi/agent`**
- [ ] **T4 · ★ 打包冒烟（本 Stage 的核心关口，风险 #15）**
      `npm run build:unpack` → 从产物启动，实测 **Pi 能否加载、`esbuild` 原生依赖是否被正确解包**。
      **过不了就启用 Plan B（Pi RPC 模式）或回退评估 —— 必须在 D3 内决定，不能拖到 D14。**
- [ ] **T5 · 事件通道改造**：渲染进程↔主进程 **SSE → IPC**，
      **6 事件词表（`delta|citation|payload|blocked|done|error`）一字不改**。
- [ ] **T6 · 跑架构守卫测试**，确认 `EventSource` 断言仍生效。
- [ ] **T7 · 设置页接 `ModelRuntime`**：自填 供应商/BaseURL/APIKey/ModelID 必须保留；
      **保存时做真实连通性探测**（注意 DeepSeek BaseURL 的 `/v1` 分歧，见 P-107）。
- [ ] **T8 · 文档**：落 `decisions.md` 的 D-008/D-009；把 `pitfalls.md` 的 P-101/P-102/P-107 验完转正。

## 3. 验收标准（DoD / 关卡 B）

- [ ] 能与 DeepSeek 流式对话，**中文无乱码**
- [ ] **★ 打包产物启动后 Pi 正常加载**（`build:unpack` 通过）
- [ ] `systemPromptOverride` 已设，**system prompt 不含本机安装路径**
- [ ] 配置读写**未污染 `~/.pi/agent`**
- [ ] 6 事件经 IPC 到达渲染进程
- [ ] 后端 `uv.lock` 已移除 langgraph 系依赖，打包产物仍通过自检
- [ ] `npm run typecheck` 通过

## 4. 陷阱

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **★ `esbuild` 原生依赖** | Pi 包**没有 `./sdk` 子路径**，只能从**包根**导入，而包根会 evaluate CLI 的 `main.js` → `@earendil-works/chord` → **`esbuild`（约 10MB 原生二进制）**。需 `asarUnpack` + 按架构分发 + 签名。见 `pitfalls.md` P-101。 |
| 2 | **Node 版本不满足** | 见 `pitfalls.md` P-102。 |
| 3 | **包根导入副作用** | 锁 `^0.85.1`（0.85.0 在 Electron 里因 esbuild 崩）。 |
| 4 | **SDK 入口名字别臆造** | 是 `createAgentSession` / `AgentSession` / `AgentSessionRuntime` / `ModelRuntime` / `SessionManager` / `DefaultResourceLoader`。**不存在 `createAgent` / `PiAgent`。** |
| 5 | **DeepSeek BaseURL 的 `/v1`** | Pi 内置 provider 是 `https://api.deepseek.com`（**无 `/v1`**），前端默认值习惯带 `/v1`。统一约定 + **保存时探测连通性**。见 P-107。 |

## 5. 本卡不做

Extension 注册与 Tool 实现（S04）、RAG（S06）、学段推断（S12）。

---

## 6. 产出记录

| 项 | 结果 |
| --- | --- |
| Pi 版本 / Node 版本 | （待填） |
| 打包冒烟结果（esbuild 是否可加载） | （待填） |
| 是否启用 Plan B | （待填） |
| 关卡 B 通过时间 | （待填） |
