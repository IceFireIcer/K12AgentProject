# 02 — Sidecar 生命周期与端口握手

**What to build:** 让 Electron 主进程可靠地管理 Python sidecar 的一生：spawn → 单行 JSON 握手 → token 鉴权 → `/health` 探活 → 崩溃重启一次 → 退出杀进程树；并用 PyInstaller `--onedir` 冒烟证明「打包后仍能跑」。**这是关卡 A 的落点，也是 D1 的风险关口**——打不出包或进程杀不干净属于架构性问题，必须在最早暴露。它解阻塞 03（Pi 打包冒烟必须叠在可用的 sidecar 生命周期之上）。

**Blocked by:** 01 双端脚手架与依赖基线

**Status:** ready-for-agent

- [ ] `desktop/src/main/sidecar/manager.ts` 负责 spawn（开发态走 `uv run`，打包态走 `resources/server/k12-agent-server.exe`）；`sidecar/protocol.ts` 只放纯逻辑：行缓冲、握手解析、重启决策——**可在 `node --test` 下单测**
- [ ] 握手：Python 绑 `127.0.0.1:0` 由系统分配端口，**stdout 只输出一行** `{"event":"ready","port":N,"pid":P}`，其余日志（含 uvicorn）全部走 stderr；出现第二行 stdout 即判失败
- [ ] Node 的 `data` 事件可能把握手 JSON 切成半行：必须缓冲到 `\n` 再 parse；**非 JSON 行只记日志、绝不当错误**（用单测注入「半行 + 半行」与「夹一行日志」两种输入验证）
- [ ] 每次启动生成随机 hex token 经 `--token` 传入；`server/app/security.py` 校验所有 `/api/*` 的 `X-Auth-Token`，缺失/不符返回 401；`/health` 允许匿名（探活用）
- [ ] 探活：轮询 `/health` 直到 `{status, version, embedder_ready}` 就绪；超时 30s 时给出可读错误提示，**不是白屏**
- [ ] 崩溃重启：监听 `exit`，非正常退出重启一次，再失败则提示用户并把日志写 `userData/logs/`；**`restart()` 不得复用 `stop()`**（`stop()` 会置 `shuttingDown`，之后崩溃不再自动重启）
- [ ] 退出清理：`before-quit` 用 `taskkill /PID <pid> /T /F` 杀进程树；**`onExit` 里要在把 `this.child` 置空之前先取 pid**；同时调用 `session.dispose()` 的钩子位置在此预留（真正接线归票 06）
- [ ] `--data-dir` 指向 `userData`：`config.json` 与 SQLite 都落此处，不写工作区、不写用户主目录
- [ ] ★ **关卡 A（打包）**：`uv run python scripts/build_server.py` 走 PyInstaller `--onedir`（**不用 `--onefile`**，冷启动 10s+ 不可接受），参数含 `--collect-all sqlite_vec --collect-all fastembed --add-data "resources;resources"`；spec 里 `collect_all` 的返回值必须在 `Analysis(...)` **之前**收集并作为参数传入（事后 `a.datas +=` 会 `ValueError: not enough values to unpack`）
- [ ] ★ **关卡 A（产物证据）**：打包产物在**未装 Python 的机器**上（或临时移出 PATH 的等价环境）双击可跑：握手单行 JSON 正确、`GET /health` 返回 200、stderr 里的中文是合法 UTF-8（打包态 `sys.flags.utf8_mode` / `sys.stdout.encoding` 由 `console.py` 的 `reconfigure(encoding="utf-8")` 兜住，**env 在此无效**）
- [ ] ★ **关卡 A（无泄漏）**：关闭应用后 `tasklist | findstr k12-agent-server` 无残留；连续启动/退出两次不因端口占用或文件锁失败；**重打包前先 taskkill 上次遗留进程**（否则 PyInstaller 清 `dist/` 报 `WinError 5`）
- [ ] `uv run python scripts/smoke_api.py` 在不启动 Electron 的情况下验证「起进程 → 读握手 → 打 `/health` → 杀进程」全链路，作为回归用一键冒烟

> **关卡 A 判据**：onedir 产物握手 JSON 正确 + `/health` 200 + stderr 中文为合法 UTF-8；退出后无孤儿进程；未装 Python 的机器能跑。**关卡不过，不进下一阶段**（03 / 04 都不得开工）。

## 进度

（在此记录关键决策与踩坑）
