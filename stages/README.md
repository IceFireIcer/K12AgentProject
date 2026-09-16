# 开发阶段切片（Stages）

> **上游权威**：`项目执行文档.md` v2.0（唯一权威执行文档）
> **本目录性质**：把执行文档第 4 节的 15 天排期，切成**可直接开工的任务卡**。每个 Stage 独立可执行、独立可验收。
> **使用方式**：**一次只做一个 Stage**。做完 → 勾掉 DoD → 更新本页状态 → 提交一次 git → 再开下一个。
> **状态图例**：⬜ 未开始 ｜ 🔄 进行中 ｜ ✅ 完成 ｜ ⛔ 阻塞 ｜ 📦 代码已归档至标签

---

## ⚠️ 两条必读前提

### 1. 当前工作区没有代码（2026-09-16 用户要求删除全部代码，仅保留文档）

`desktop/` 与 `server/` **不存在**。S00–S02 的代码成果全部在附注标签里：

```bash
git tag -l 'archive/*'                                # archive/s02-full-code
git checkout archive/s02-full-code -- desktop server  # 按需恢复
```

> **恢复 embedding 模型（90.8MB，从未入 git）**：备份在仓库外
> `E:\FolderForVibeCoding\Zcode\K12Agent_backup_resources\resources`
> → 需手工拷回 `server/resources/models/fastembed/`。**不做这步，检索跑不起来。**
>
> **开工任何 Stage 前先问用户「是否恢复代码」**，不要默认它存在。

### 2. 本目录已于 2026-09-16 **按 v2（Pi Agent）架构重新切片**

旧任务卡（LangGraph 版）**已删除**，内容经分类抢救：

| 抢救去向 | 内容 |
| --- | --- |
| `docs/阶段实测记录-S00至S02.md` | **已完成阶段的实测数据**（版本矩阵、226MB 体积、0.66s 冷启动、S02 的四个真 bug 与验收证据） |
| `docs/业务陷阱清单.md` | 各模块的**领域陷阱与业务验收口径**（与编排框架无关的部分） |
| 本目录新卡片 | 按 v2 架构重写；业务要求不变，实现手段按执行文档改 |

> **旧卡片仍可从 git 历史取回**：`git show 9f966fd:stages/S04-LangGraph状态机骨架.md`

**v2 关键变化速查**（详见执行文档第 0 节与 13.2 节）：

| 旧（LangGraph 版） | 新（Pi Agent 版） |
| --- | --- |
| LangGraph / `StateGraph` / 条件边 / `TutorState` | Pi Agent + 6 个 Extension + `pi.registerTool()` |
| `SqliteSaver` / `langgraph-checkpoint-sqlite` | **Pi JSONL 会话树**（按学生分目录） |
| `intent` 字段 / 代码级意图路由 | **LLM 自主选 Tool**，无 `intent` 字段 |
| `session_end` 钩子 | **不存在**，用 `session_shutdown` / `agent_end` |
| SSE（`fetch` + `ReadableStream`） | **IPC 事件流**（**6 事件词表不变**） |
| `student-<id>.sqlite` 单库 | **三处分离**：`kb.sqlite` + `learning.db` + Pi JSONL |
| `draw_mermaid()` 状态流转图 | **工具调用轨迹图**（`docs/tool-trace.mmd`） |
| 编排在 Python sidecar | **编排在 Electron 主进程**，Python 退化为数据/RAG 服务 |

**不变的部分**：15 天排期、四学段要求、四种交互、pydantic 契约链、沙箱三重隔离、
嵌入模型（fastembed）、检索降级链、动画模板优先。

---

## 阶段总览

| Stage | 名称 | 对应排期 | 关卡 | 前置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| **S00** | [环境与依赖基线](S00-环境与依赖基线.md) | D1 前置 | — | — | 📦 ✅ |
| **S01** | [双端脚手架 + Sidecar 握手](S01-双端脚手架与Sidecar握手.md) | D1 | ✅ **关卡 A** | S00 | 📦 ✅ |
| **S02** | [契约冻结 + 设置页 + 安全握手 + 事件通道](S02-契约冻结与安全握手.md) | D2 | — | S01 | 📦 ✅ |
| **S03** | [Pi Agent 集成 + LLM 适配](S03-Pi集成与LLM适配.md) | D3 | ✅ **关卡 B** | S02 | ⬜ **下一步** |
| **S04** | [主 Agent + Extension 骨架](S04-主Agent与Extension骨架.md) | D4 | — | S03 | ⬜ |
| **S05** | [教材与知识库数据](S05-教材与知识库数据.md) | D5 | — | S00（**可并行**） | ⬜ |
| **S06** | [RAG 检索层 + 四级降级链](S06-RAG检索与降级链.md) | D6 | ✅ **关卡 C** | S05 | ⬜ |
| **S07** | [知识点依赖图（双用途）](S07-知识点依赖图.md) | D7 | — | S06 | ⬜ |
| **S08** | [练习 Extension + 出题批改](S08-练习Extension与批改.md) | D8 | — | S04 | ⬜ |
| **S09** | [闯关闭环 + 进度徽章 + 个性化](S09-闯关闭环与个性化.md) | D9 | ✅ **关卡 D** | S08+S07 | ⬜ |
| **S10** | [动画 Extension + 沙箱 + RPC](S10-动画Extension与沙箱RPC.md) | D10–D11 | — | S04 | ⬜ |
| **S11** | [编程 Extension + Monaco + Pyodide](S11-编程Extension与Pyodide.md) | D12–D13 | — | S04 | ⬜ |
| **S12** | [学段推断 + 个性化 + 内容安全 + 集成打包](S12-个性化与集成打包.md) | D14 | ✅ **关卡 E** | 全部 | ⬜ |
| **S13** | [交付物：报告 / PPT / 演示视频](S13-交付物与报告.md) | D15 | — | S12 | ⬜ |

> 📦 = 已交付但代码已归档至 `archive/s02-full-code` 标签。

---

## 依赖关系（哪些能并行）

```
S00（环境基线）
 └─▶ S01（关卡 A：能打包）
      └─▶ S02（契约 + 安全握手 + 事件通道）
           ├─▶ S03（关卡 B：能对话 + ★ Pi 打包冒烟）
           │    └─▶ S04（主 Agent + Extension 骨架）
           │         ├─▶ S08 ─▶ S09（关卡 D）
           │         ├─▶ S10（动画）
           │         └─▶ S11（编程）
           └─▶ S05 ─▶ S06（关卡 C）─▶ S07
                                        └─▶ S09
S01~S11 全通 ─▶ S12（关卡 E）─▶ S13
```

> 单人开发，实际只能串行。上图只用于**判断「我现在能不能做这个 Stage」**。
>
> **★ v2 的并行机会**：**S05/S06/S07（教材 + RAG + 依赖图）与 S03/S04（Pi 主线）完全解耦** ——
> RAG 全在 Python 侧，只通过 `rag_search` Tool 的 HTTP 契约交互。
> **若 Pi 集成受阻（如 `esbuild` 无解），可先推 RAG 主线，不空等。**

---

## 不可违反的总规矩

1. **关卡不过，不进下一阶段**。
   - **S01（打包）** 最高风险 → **已过**。
   - **★ S03（Pi 集成 + 打包冒烟）** **是 v2 新增的最高风险关口** —— `esbuild` 原生依赖若炸，
     必须在 D3 暴露而不是 D14。**S03 过不了，不要开 S04。**
   - **S06（检索）** 次高 → FTS5 降级链必须提前启用。
2. **每个 Stage 结束做一次 git 提交**，提交信息写清 Stage 编号与产出，方便回滚。
3. **每天留 30 分钟攒报告素材**（截图 / 决策 / 踩坑），存 `docs/report-material/`，否则 D15 写不出报告。
4. **改了 pydantic 模型必须重跑 OpenAPI → TS 生成**，并跑 **Tool TypeBox 一致性断言**。
