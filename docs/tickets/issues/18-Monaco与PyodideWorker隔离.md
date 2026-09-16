# 18 — Monaco 与 Pyodide Worker 隔离

**What to build:** 做出编程卡片：Monaco 编辑器 + Pyodide 在**独立 Web Worker** 里执行学生代码，产物自托管、进卡片才懒加载、死循环可中断。**硬约束**：学生代码绝不在 Electron 主进程执行——Pi 的 Extension 与 Agent 同进程且拥有完整系统权限，所以 `evaluate_code` 只能经 IPC 转发到渲染进程的 Pyodide Worker，结果回传。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）

**Status:** ready-for-agent

- [ ] `desktop/src/renderer/src/sandbox/pyodide.worker.ts` 落位：Pyodide 只在 Worker 内加载与执行，主线程与动画 iframe 都不加载它
- [ ] Pyodide 资源**自托管**在 `desktop/resources/`（打包后仍可取到）；`grep -rni "cdn\|unpkg\|jsdelivr\|pyodide.org\|io.pyd" desktop/src` 零命中（陷阱：CDN 断网翻车）
- [ ] 懒加载：仅在进入编程卡片时才发起 Pyodide 资源加载；在加载前后各打一次时间戳，差值即「未提前加载」的证据（记录数值）
- [ ] **超时中断**：`setInterruptBuffer` 就位，`while True: pass` 这类死循环在 5s 内被中断并把控制权交回 UI；实测记录（UI 不卡死，日志含中断时间点）
- [ ] Monaco 的 vite worker 配置完成（`desktop/electron.vite.config.ts` 内配置 renderer worker），生产构建 `npm run build:unpack` **不出现 worker 相关报错**（陷阱：不配会在生产构建失败）
- [ ] **架构守卫断言（硬约束：学生代码绝不在 Electron 主进程执行）**：`desktop/tests/` 新增测试，断言 `desktop/src/main/**` 不存在执行学生代码的路径——不 import pyodide、无 `eval(`/`new Function(`/以 `exec` 跑学生代码、`grep -rni "pyodide" desktop/src/main` 零命中
- [ ] `evaluate_code` 的 `execute()` 只做「经 IPC 请求渲染进程 → 等回传 → 组装结果」，本身不执行代码；请求与响应都带 `requestId`/`toolCallId` 可追踪（Pi 与 UI 同进程，异常必须自己兜住）
- [ ] stdout 与 stderr 都能原样回传并展示；`CodeEvaluation` 字段符合 §6.5（`ok, stdout, error, feedback, next_hint?`），`error` 部分可结构化呈现
- [ ] 三重隔离成立且可陈述：动画 iframe / Pyodide Worker / 主线程互不共享执行环境（与票 16、票 22 的断言互相印证）
- [ ] Worker 未就绪 / 超时 / 崩溃时返回可读中文错误（走 `error` 事件，带 `degraded`），不抛异常、不白屏
- [ ] 预置 `numpy`；`matplotlib` 是否随包按体积决定，**把决策与体积数值记进票尾**（超预算就砍，并写进报告）
- [ ] `npm run typecheck` 通过

## 进度

（在此记录关键决策与踩坑）
