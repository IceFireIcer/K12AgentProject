# 17 — Monaco + Pyodide Worker 隔离

**What to build:** 学生能写 Python、运行、看到输出与报错——而**这些代码绝不在主进程执行**。因为 Pi 的 Extension 与 Agent 同进程且拥有完整系统权限，「学生代码不在主进程执行」是硬约束，不是优化。

**Blocked by:** 07 — 主 Agent + 6 个 Extension 骨架 + rag_search→citation

**Status:** ready-for-agent

- [ ] Monaco Editor 接入，**vite worker 配置就绪**（不配会在生产构建报错）
- [ ] Pyodide 运行在**独立 Web Worker**，与动画沙箱、主线程三方隔离
- [ ] **Pyodide 资源本地自托管**，不依赖 CDN；**懒加载**（进编程卡片才加载）
- [ ] 加**超时中断**（Pyodide 用 `setInterruptBuffer`），防无限循环卡死 UI
- [ ] **★ `evaluate_code` 绝不在主进程直接执行学生代码**：代码经 IPC 交渲染进程的 Pyodide Worker，结果回传
- [ ] 上述约束**写成架构守卫测试**（断言主进程不含执行学生代码的路径）
- [ ] 能返回 stdout / stderr；报错时学生看到友好提示而非堆栈原文
- [ ] 明确并记录：Pyodide 的 Python 与 sidecar 的 Python 是**两个独立运行时**，学生代码绝不接触 sidecar

## 进度

（在此记录关键决策与踩坑）
