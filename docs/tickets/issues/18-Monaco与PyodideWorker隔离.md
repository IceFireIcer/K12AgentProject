# 18 — Monaco 与 Pyodide Worker 隔离

**What to build:** 做出编程卡片：Monaco 编辑器 + Pyodide 在**独立 Web Worker** 里执行学生代码，产物自托管、进卡片才懒加载、死循环可中断。**硬约束**：学生代码绝不在 Electron 主进程执行——Pi 的 Extension 与 Agent 同进程且拥有完整系统权限，所以 `evaluate_code` 只能经 IPC 转发到渲染进程的 Pyodide Worker，结果回传。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）

**Status:** ready-for-human

- [x] `desktop/src/renderer/src/sandbox/pyodide.worker.ts` 落位：Pyodide 只在 Worker 内加载与执行，主线程与动画 iframe 都不加载它
- [x] Pyodide 资源**自托管**在 `desktop/resources/`（打包后仍可取到）；`grep -rni "cdn\|unpkg\|jsdelivr\|pyodide.org\|io.pyd" desktop/src` 零命中（陷阱：CDN 断网翻车）
- [x] 懒加载：仅在进入编程卡片时才发起 Pyodide 资源加载；在加载前后各打一次时间戳，差值即「未提前加载」的证据（**时间戳已埋点，但未记录具体数值**）
- [x] **超时中断**：`setInterruptBuffer` 就位，`while True: pass` 这类死循环在 5s 内被中断并把控制权交回 UI；实测记录（UI 不卡死，日志含中断时间点）
- [x] Monaco 的 vite worker 配置完成（`desktop/electron.vite.config.ts` 内配置 renderer worker），生产构建 `npm run build:unpack` **不出现 worker 相关报错**（陷阱：不配会在生产构建失败）
- [x] **架构守卫断言（硬约束：学生代码绝不在 Electron 主进程执行）**：`desktop/tests/` 新增测试，断言 `desktop/src/main/**` 不存在执行学生代码的路径——不 import pyodide、无 `eval(`/`new Function(`/以 `exec` 跑学生代码、`grep -rni "pyodide" desktop/src/main` 零命中
- [x] `evaluate_code` 的 `execute()` 只做「经 IPC 请求渲染进程 → 等回传 → 组装结果」，本身不执行代码；请求与响应都带 `requestId`/`toolCallId` 可追踪（Pi 与 UI 同进程，异常必须自己兜住）
- [x] stdout 与 stderr 都能原样回传并展示；`CodeEvaluation` 字段符合 §6.5（`ok, stdout, error, feedback, next_hint?`），`error` 部分可结构化呈现
- [x] 三重隔离成立且可陈述：动画 iframe / Pyodide Worker / 主线程互不共享执行环境（与票 16、票 22 的断言互相印证）
- [x] Worker 未就绪 / 超时 / 崩溃时返回可读中文错误（走 `error` 事件，带 `degraded`），不抛异常、不白屏
- [x] 预置 `numpy`；`matplotlib` 是否随包按体积决定，**把决策与体积数值记进票尾**（超预算就砍，并写进报告）
- [x] `npm run typecheck` 通过

## 进度

### ✅ 已交付（提交 `002a7e1`）

★ **头号证据（真实 UI 实测）**：`while True: pass` → 界面显示「已中断（运行 **5002 ms**）」，
且中断期间 **rAF 帧仍在走，实测 1269 帧**（主线程被死循环占住的话这个数会接近 0）。
这就是「学生代码不在主线程、也不在主进程」的**可观察证据**——画面还在动，说明主线程没被占。

★ **差点静默上线的陷阱**：**`setInterruptBuffer` 若由同一个线程写 SIGINT 就完全无效。**
`runPython` 是**同步阻塞**调用，会占满线程的事件循环，**同线程的定时器根本不会触发**——
第一次这样写，测试**直接挂死**（退出码 **124** = 被超时 kill）。
正确结构是**主线程 ↔ Worker 双线程**：定时器归**主线程**，到点往 `SharedArrayBuffer` 写 `SIGINT`，
Worker 里的 Python 轮询到即抛 `KeyboardInterrupt`。
第二个前提：**`SharedArrayBuffer` 在 Electron 渲染进程与 Worker 里默认是 `undefined`**，
需要主进程一行 `app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer')`
（`src/main/index.ts`）。**启动时自检**：拿不到 SAB 就**如实降级**为「只有墙钟超时、无法中断」
并把这件事报给界面，**绝不假装有保护**。

**架构守卫 G18-1（静态，三重隔离的硬证据）**：① 主进程**任何文件**不得 import `pyodide`（连类型都不行）；
② 主进程不得出现 `eval(` / `new Function(` / `node:vm` 等执行原语；③ 正向断言
`evaluate_code` 的执行出口是**可注入的 `codeRunner` 接缝**（经 IPC 交渲染进程 Worker）。

**体积腾挪（实测）**：Monaco **只注册 Python 一个语言贡献**，
砍掉 **~17.4 MB** 用不到的语言 worker；Pyodide 运行时 ~16 MB
（wasm 9.2 MB + stdlib 2.4 MB + numpy 2.8 MB）。
**matplotlib 不预置**：其依赖闭包 12 个包、约 **8.8 MB**（本体 6.98 MB + pillow 1.04 MB），
会让编程模块静态资源从 16 MB 涨到约 25 MB——决策与代价见
`docs/report-material/decisions.md` 的 **D-025**。
Pyodide 资源**全本地自托管**（构建期由 vite 从 `src/renderer/public/pyodide/` 拷入），
`grep` 对 `cdn` / `unpkg` / `jsdelivr` / `pyodide.org` **零命中**；**进卡片才加载**（懒加载）。
