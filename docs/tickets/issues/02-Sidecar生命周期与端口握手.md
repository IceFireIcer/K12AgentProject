# 02 — Sidecar 生命周期与端口握手

**What to build:** 让 Electron 主进程可靠地管理 Python sidecar 的一生：spawn → 单行 JSON 握手 → token 鉴权 → `/health` 探活 → 崩溃重启一次 → 退出杀进程树；并用 PyInstaller `--onedir` 冒烟证明「打包后仍能跑」。**这是关卡 A 的落点，也是 D1 的风险关口**——打不出包或进程杀不干净属于架构性问题，必须在最早暴露。它解阻塞 03（Pi 打包冒烟必须叠在可用的 sidecar 生命周期之上）。

**Blocked by:** 01 双端脚手架与依赖基线

**Status:** ready-for-human

- [x] `desktop/src/main/sidecar/manager.ts` 负责 spawn（开发态走 `uv run`，打包态走 `resources/server/k12-agent-server.exe`）；`sidecar/protocol.ts` 只放纯逻辑：行缓冲、握手解析、重启决策——**可在 `node --test` 下单测**
- [x] 握手：Python 绑 `127.0.0.1:0` 由系统分配端口，**stdout 只输出一行** `{"event":"ready","port":N,"pid":P}`，其余日志（含 uvicorn）全部走 stderr；出现第二行 stdout 即判失败
- [x] Node 的 `data` 事件可能把握手 JSON 切成半行：必须缓冲到 `\n` 再 parse；**非 JSON 行只记日志、绝不当错误**（用单测注入「半行 + 半行」与「夹一行日志」两种输入验证）
- [x] 每次启动生成随机 hex token 经 `--token` 传入；`server/app/security.py` 校验所有 `/api/*` 的 `X-Auth-Token`，缺失/不符返回 401；`/health` 允许匿名（探活用）
- [x] 探活：轮询 `/health` 直到 `{status, version, embedder_ready}` 就绪；超时 30s 时给出可读错误提示，**不是白屏**
- [x] 崩溃重启：监听 `exit`，非正常退出重启一次，再失败则提示用户并把日志写 `userData/logs/`；**`restart()` 不得复用 `stop()`**（`stop()` 会置 `shuttingDown`，之后崩溃不再自动重启）
- [x] 退出清理：`before-quit` 用 `taskkill /PID <pid> /T /F` 杀进程树；**`onExit` 里要在把 `this.child` 置空之前先取 pid**；同时调用 `session.dispose()` 的钩子位置在此预留（真正接线归票 06）
- [x] `--data-dir` 指向 `userData`：`config.json` 与 SQLite 都落此处，不写工作区、不写用户主目录
- [x] ★ **关卡 A（打包）**：`uv run python scripts/build_server.py` 走 PyInstaller `--onedir`（**不用 `--onefile`**，冷启动 10s+ 不可接受），参数含 `--collect-all sqlite_vec --collect-all fastembed --add-data "resources;resources"`；spec 里 `collect_all` 的返回值必须在 `Analysis(...)` **之前**收集并作为参数传入（事后 `a.datas +=` 会 `ValueError: not enough values to unpack`）
- [x] ★ **关卡 A（产物证据）**：打包产物在**未装 Python 的机器**上（或临时移出 PATH 的等价环境）双击可跑：握手单行 JSON 正确、`GET /health` 返回 200、stderr 里的中文是合法 UTF-8（打包态 `sys.flags.utf8_mode` / `sys.stdout.encoding` 由 `console.py` 的 `reconfigure(encoding="utf-8")` 兜住，**env 在此无效**）
- [x] ★ **关卡 A（无泄漏）**：关闭应用后 `tasklist | findstr k12-agent-server` 无残留；连续启动/退出两次不因端口占用或文件锁失败；**重打包前先 taskkill 上次遗留进程**（否则 PyInstaller 清 `dist/` 报 `WinError 5`）
- [x] `uv run python scripts/smoke_api.py` 在不启动 Electron 的情况下验证「起进程 → 读握手 → 打 `/health` → 杀进程」全链路，作为回归用一键冒烟

> **关卡 A 判据**：onedir 产物握手 JSON 正确 + `/health` 200 + stderr 中文为合法 UTF-8；退出后无孤儿进程；未装 Python 的机器能跑。**关卡不过，不进下一阶段**（03 / 04 都不得开工）。

## 进度

### ✅ 关卡 A 通过（2026-09-16）

| 判据 | 实测证据 |
| --- | --- |
| 握手 JSON 正确 | `{"event":"ready","port":1823,"pid":44456,"version":"0.1.0","frozen":true}`，冷启动 **0.56s** |
| `/health` 200 | `{"status":"ok","version":"0.1.0","embedderReady":false}`（camelCase，与前端 `HealthPayload` 一致） |
| stderr 中文合法 UTF-8 | 解码成功且含「已绑定 127.0.0.1:1823」——**打包态 env 无效，靠 `console.py` 的 reconfigure 兜住** |
| 无孤儿进程 | 两轮「启动 → 就绪 → 优雅退出」后：sidecar 进程消失、端口释放、Electron 清零 |
| 未装 Python 能跑 | 在 **PATH 只剩 `System32`、`PYTHONHOME`/`PYTHONPATH` 已清空** 的环境下启动成功 |

产物：**134.2 MB**（`--onedir`），构建耗时 43.3s。`frozen=true` 证明跑的是冻结产物而非源码。

### 关键实测数据（都值得进报告）

**① 打包态与开发态的 pid 结构完全不同**

| 形态 | `Popen` 报的 pid | 握手自报 pid | 占端口的 pid |
| --- | --- | --- | --- |
| 开发态（`uv run python -m app.main`） | 46964 | **44740** | **44740** |
| 打包态（直接跑 exe） | 44456 | 44456 | 44456 |

开发态下 `Popen` 拿到的是 **`uv` 包装器**的 pid，不是 python 的；**只有握手自报的 pid 才是该杀的那个**。
（本机还发现 **venv 的 `python.exe` 自身也是个 redirector**：`Popen` 报 37432、进程自报 39792 ——
同一类陷阱的第二份证据。）这条已固化为 `smoke_api.py` / `build_server.py` 里的断言
**「握手 pid == 真正监听端口的进程」**，而不是断言「等于 Popen 的 pid」——后者本身就是错的。

**② 握手是在 uvicorn 开始 accept 之前发出的**

`main.py` 自己绑 socket → 打印握手 → 才交给 uvicorn serve。因此在握手发出的一瞬间，
端口**尚未进入 LISTENING 状态**，此时去 `netstat` 查不到它。
Electron 侧正是靠「握手后继续轮询 `/health`」渡过这个窗口 —— 这不是冗余设计。
（踩过一次：把「pid == 占端口进程」的断言放在握手后立刻执行，得到 `None`。）

**③ `subprocess(text=True)` 在 UTF-8 模式下会**静默**吞掉 GBK 输出**

Windows 自带工具（`netstat` / `taskkill`）按**系统代码页（本机 GBK）**输出，而进程处于
UTF-8 模式（`PYTHONUTF8=1`）。`text=True` 的解码线程抛 `UnicodeDecodeError` 后**死掉**，
`stdout` 变成**空字符串而不是报错** —— 症状是「命令看起来跑成功了，但什么都解析不出来」。
修法是显式收字节再 `decode("utf-8", errors="replace")`。**已记入 `pitfalls.md`。**

### 实现要点

- **握手自己实现**：不让 uvicorn 自己绑端口（`--port 0` 的真实端口只有它内部才知道，且绑定失败时它只 `sys.exit(1)` 写 stderr）。自己绑 → 端口已知 → 绑定失败能变成一行可读的 `{"event":"error",...}`，界面才不会只说「进程意外退出」。
- **中间件顺序**：先 `add_middleware(TokenAuthMiddleware)` 再 `add_middleware(CORSMiddleware)`（Starlette 洋葱模型里最后 add 的在最外层）。有回归测试断言 **401 响应仍带 CORS 头**。
- **鉴权做成纯 ASGI 中间件**（不用 `BaseHTTPMiddleware`）：后者包一层 anyio 任务组，对流式响应的取消语义有影响，将来会有流式端点，不想埋雷。
- **常量时间比较走字节**：`secrets.compare_digest` 遇到非 ASCII 的 `str` 会抛 `TypeError`，而请求头内容完全由调用方控制。有单测直接调中间件验证它不会被打崩。
- **token 不出主进程**：`SidecarState` 结构里没有 token 字段，preload 白名单也不含；有架构守卫断言。

### 新增的回归工具（票 23 可直接复用）

| 脚本 | 作用 |
| --- | --- |
| `server/scripts/smoke_api.py` | 源码态一键冒烟：起进程 → 读握手 → 打接口 → 杀进程，15 项断言 |
| `server/scripts/build_server.py` | 打包 + **在无 Python 环境下**自检产物，15 项断言 |
| `desktop/scripts/verify-lifecycle.mjs` | 连跑两轮「启动 → 就绪 → 优雅退出」，断言无孤儿 + 端口释放 + 端口随机分配 |
| `desktop/scripts/verify-sidecar-crash.mjs` | 强杀 sidecar，断言自动重启一次且 `restarts` 计数增加 |

### 测试基线

后端 **25 项**（含鉴权 9 项、握手/绑定/失败上报 8 项），桌面 **30 项**（含行缓冲半行注入、握手解析拒绝畸形 ready、重启决策、日志脱敏、架构守卫）。
崩溃重启实测：强杀 pid `16848` → 新进程 `39508`、新端口 `10924`、`restarts=1`、状态回到 ready。
