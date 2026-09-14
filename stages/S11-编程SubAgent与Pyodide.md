# Stage 11 · 编程 SubAgent + Monaco + Pyodide

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D12–D13** |
| 关卡 | —（多模态质量 25% 的主力） |
| 前置 | S04 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

让学生**在应用里写 Python、运行、看结果、出错时得到帮助**——全离线，代码跑在浏览器沙箱里，与 sidecar 完全隔离。

---

## 2. 任务清单

### 2.1 编辑器与运行

- [ ] Monaco Editor 接入（vite 插件打包）
- [ ] **Pyodide 独立 Web Worker**（`sandbox/pyodide.worker.ts`）
  - [ ] 资源**本地自托管**于 `desktop/resources/pyodide/`，不依赖 CDN
  - [ ] **懒加载**：进入编程卡片才加载（避免拖慢启动）
  - [ ] 预置 `numpy`；`matplotlib` 视体积决定（超预算则砍）
- [ ] 运行 → 回传 `stdout` / `stderr` / 异常

### 2.2 代码模板

- [ ] `server/resources/code-templates/`：按知识点预置（排序 / 决策树 / 神经网络 / Python 基础）
- [ ] `CodeTemplate`：`scaffold`（含 `TODO` 标记）+ `expected_behavior`
- [ ] LLM 可按知识点生成/挑选模板

### 2.3 求助机制

- [ ] **自动感知报错**：运行出错 → 上报后端 → 返回 `CodeEvaluation`
- [ ] **手动求助按钮**
- [ ] `CodingHint.level` 1→2→3 逐级加深（不直接给答案）
- [ ] **连续失败 3 次 → 主 Agent 主动介入**
- [ ] `POST /api/code/run-hint`

---

## 3. 验收标准（DoD）

- [ ] 编程卡片能加载编辑器并运行 Python，`print` 有输出
- [ ] `numpy` 可用（`import numpy` 成功）
- [ ] 写错代码 → 显示**面向学生的友好提示**（不是裸 traceback）
- [ ] 点求助 → 给出 level 1 提示；再失败 → level 2/3 递进
- [ ] 连续失败 3 次 → 主 Agent 主动介入（对话区出现引导）
- [ ] **断网**下编程功能完全可用
- [ ] iframe/Worker 三层隔离成立（动画沙箱 ≠ Pyodide Worker ≠ 主线程）

---

## 4. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **Pyodide 体积大 / 加载慢** | 必须本地自托管 + 懒加载。 |
| 2 | 误以为两边共享 Python | Pyodide 的 Python 与 sidecar 的 Python 是**两个独立运行时**，学生代码绝不接触 sidecar（安全隔离设计，报告要讲）。 |
| 3 | 无限循环卡死 UI | 运行必须在 Worker 里，且加超时中断（Pyodide 需用 `setInterruptBuffer`）。 |
| 4 | Monaco 与 vite 打包 | 需要 worker 配置；不配会在生产构建报错。 |
| 5 | 直接给答案 | 提示要按 level 递进，教学价值在引导而非给答案。 |
| 6 | CDN 依赖 | 任何 CDN 引用都会在断网演示时翻车。 |

---

## 5. 产出记录

| 项 | 结果 |
| --- | --- |
| Pyodide 资源体积 | （待填） |
| 首次加载耗时 | （待填） |
| 模板数量 | （待填） |
