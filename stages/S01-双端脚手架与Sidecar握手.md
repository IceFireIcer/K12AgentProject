# Stage 01 · 双端脚手架 + Sidecar 握手

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D1** |
| 关卡 | ✅ **关卡 A（最高风险）** |
| 前置 | S00 完成 |
| 状态 | ✅ 完成（关卡 A 通过） |

---

## 1. 目标

**双击一个打包好的 .exe，Electron 自动拉起 Python sidecar，窗口里显示 `握手成功 port=xxxxx`。**

这个 Stage 的全部价值在于：**在第一天就把 PyInstaller 的坑炸出来**，而不是拖到 D14 才发现打不了包。

---

## 2. 任务清单

### 2.1 后端

- [x] `app/main.py`：FastAPI 应用
  - [x] 启动参数：`--port`（默认 0 = 系统分配）、`--token`、`--data-dir`、`--host`、`--log-level`
  - [x] 绑定 `127.0.0.1`（非回环地址**直接拒绝启动**，硬约束）
  - [x] **端口握手**：uvicorn 绑定成功后向 stdout 打单行 JSON `{"event":"ready","port":…,"pid":…,"version":…,"frozen":…}`，然后 flush
  - [x] 启动失败也走同一通道回 `{"event":"error","message":"…"}`（不允许不可读的失败）
  - [x] `GET /health` → `{status,version,embedder_ready,frozen,data_dir}`（`/health` 免鉴权）
  - [x] 中间件：所有 `/api/*` 校验 `X-Auth-Token`，不符返回 401（常量时间比较）
- [x] `.python-version` / `pyproject.toml` 就绪（S00）
- [x] UTF-8 强制：`os.environ.setdefault("PYTHONUTF8","1")` + **`app/encoding.py` 在 Python 层 reconfigure**（见陷阱 #3）
- [x] `app/config.py`：路径解析（开发/打包双形态）、`EMBEDDING_DIM=512` 常量唯一来源

### 2.2 前端

- [x] `desktop/`：electron-vite + Vue3 + TS + Pinia 脚手架（vite 7 / electron 39 / vue 3.5）
- [x] 最简窗口（`src/main/index.ts`）
- [x] `src/main/sidecar.ts`：
  - [x] 生成随机 hex token（`crypto.randomBytes(32).toString('hex')`，每次启动/重启都换新）
  - [x] `spawn` Python（dev 用 `uv run`，prod 用打包产物），传 `--port 0 --token X --data-dir <userData>/data`
  - [x] **spawn 时显式注入 env**：`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`PYTHONUNBUFFERED=1`
  - [x] stdout 逐行读（`LineBuffer` 跨 chunk 拼接），解析握手 JSON 拿到 port
  - [x] 轮询 `/health` 直到就绪（超时 30s → 显示可读错误，**不白屏**）
  - [x] `exit` 事件 → 非正常退出重启一次，再失败写日志到 `userData/logs/`
  - [x] `before-quit` → `taskkill /PID <pid> /T /F` 杀进程树
- [x] `src/main/sidecar-logic.ts`：纯逻辑抽出（行缓冲 / 重启判定 / 日志脱敏），**可脱离 Electron 单测**
- [x] preload 白名单：只暴露 `getSidecarInfo / restartSidecar / onSidecarChanged / getLogPath` 四个
- [x] 渲染层显示握手结果（Pinia store + 状态页，含失败态重试按钮）

### 2.3 打包（本 Stage 的核心）

- [x] PyInstaller `--onedir` 打包 server（spec 在 `server/packaging/`，脚本 `scripts/build_server.py`）
- [x] 打包脚本自带**产物自检**：起一次 exe 验「握手 + /health + 401 + 中文编码」
- [x] 打包产物能被 Electron 拉起并握手成功
- [x] `electron-builder --dir` 整包，`extraResources` 把 server 放进 `resources/server/`

---

## 3. 关键命令

```bash
# ① 后端单跑（不依赖 Electron，可 curl 验证）
cd server
uv run python -m app.main --port 0 --token devtoken --data-dir ./_data
#   stdout → {"event": "ready", "port": 8997, "pid": 34868, ...}
curl http://127.0.0.1:8997/health                          # 200，免鉴权
curl http://127.0.0.1:8997/api/ping                        # 401
curl -H "X-Auth-Token: devtoken" http://127.0.0.1:8997/api/ping   # 200

# ② 打包后端（--onedir，绝不用 --onefile）+ 自动自检
uv run python scripts/build_server.py
uv run python scripts/build_server.py --verify     # 只自检已有产物

# ③ 前端单元测试（Node 原生跑 TS，无额外构建）
cd desktop
npm test

# ④ 前端类型检查
npm run typecheck

# ⑤ 开发态全链路（自动拉起 sidecar 并握手）
npm run dev

# ⑥ 用打包产物验证「关卡 A 的路径」，不必每次跑整包（见 D-007）
K12_SIDECAR_MODE=packaged npm run dev

# ⑦ 自动化 UI 断言（读真实 DOM，非截图）
K12_DEBUG_PORT=9222 npm run dev
node scripts/verify-ui.mjs                 # 断言就绪态
node scripts/verify-ui.mjs --expect failed # 断言失败态不白屏

# ⑧ 整包（真正的关卡 A：win-unpacked 里双击 .exe）
npm run build:unpack
```

> **`--onedir` 而非 `--onefile`**：onefile 每次启动解压到临时目录，冷启动 10s+，演示体感极差。
> 实测本方案冷启动 **0.66–0.82s**。

---

## 4. 涉及文件

```
server/
├─ app/main.py              # FastAPI 入口 + 握手协议 + 鉴权中间件 + 参数解析
├─ app/config.py            # 路径解析（开发/打包）、EMBEDDING_DIM 等常量
├─ app/encoding.py          # ★ 强制 UTF-8 标准流（打包后 env 失效的兜底）
├─ app/api/system.py        # /health、/api/ping、/api/meta
├─ packaging/k12-agent-server.spec   # PyInstaller 配置（含 collect_all 与排除清单）
└─ scripts/build_server.py  # 打包 + 产物自检（握手/health/401/中文编码）

desktop/
├─ src/main/index.ts        # 窗口与生命周期、CDP 开关（默认关）、退出清理
├─ src/main/sidecar.ts      # ★ 进程管理（spawn/握手/探活/重启/杀进程树）
├─ src/main/sidecar-logic.ts# 纯逻辑：行缓冲/重启判定/日志脱敏/错误文案
├─ src/preload/index.ts     # contextBridge 白名单（4 个方法）
├─ src/shared/sidecar-types.ts  # main↔preload↔renderer 共享类型
├─ src/renderer/src/App.vue # 握手结果状态页（就绪/进行中/失败三态）
├─ src/renderer/src/stores/sidecar.ts  # Pinia store
├─ tests/sidecar-logic.test.ts         # 31 条单测
└─ scripts/verify-ui.mjs    # CDP 读真实 DOM 做 UI 断言
```

---

## 5. 验收标准（DoD / 关卡 A）

- [x] `uv run python -m app.main --port 0` 能在 stdout 打出一行合法 JSON，含 port
      → 实测 `{"event": "ready", "port": 8997, "pid": 34868, "version": "0.1.0-dev", "frozen": false}`
- [x] `curl /health` 免 token 可访问（200）；`/api/*` 无 token / 错 token 返回 401、正确 token 返回 200
- [x] `npm run dev` → 窗口显示「握手成功 port=xxxxx」（用 CDP 读真实 DOM 断言，非截图）
- [x] **PyInstaller 打包后**，产物目录里 `k12-agent-server.exe` 能独立启动并握手
      → 冷启动 **0.66–0.82s**，`frozen=true`
- [x] Electron 指向打包产物（而非 `uv run`）时，**握手依然成功** ← **这才是关卡 A**
      → 两种验法都过：① `K12_SIDECAR_MODE=packaged` 拉起 `server/dist/` 产物；
        ② `electron-builder --dir` 整包后在 `win-unpacked/` 里双击真实 `.exe`，UI 显示「握手成功 port=8647」
- [x] 关闭窗口后，任务管理器里**没有残留 python 进程**
      → 开发态（uv+python）与打包态（k12-agent-server.exe）均实测残留 = 0
- [x] 二次启动不报端口占用（`--port 0` 由 OS 分配，实测两次启动端口不同且均正常）
- [x] 人为杀掉 sidecar → Electron 能重启一次；再失败显示错误提示而非白屏
      → 日志见「第 1 次自动重启」；再杀一次后 UI 显示「后端进程意外退出，自动重启后仍未恢复」+ 重试按钮

### 额外验证（超出原计划）

- [x] `npm test` **31/31 通过**：握手行解析（含非法端口/非 JSON 行）、跨 chunk 半行拼接（逐字节喂入）、
      重启判定（关闭中/主动杀/未就绪/配额耗尽）、日志脱敏（token 与 `sk-` 形态）
- [x] `npm run typecheck` 通过（node + web 两套 tsconfig）
- [x] 打包产物自检覆盖：握手 JSON / `/health` / 401 / **中文 UTF-8 未被 GBK 污染**（含 stderr 原始字节断言）
- [x] 嵌入模型随包可用：断网（`HF_HUB_OFFLINE=1`）下 `/health` 仍 `embedder_ready=true`
- [x] **发现并修复一个真实打包 bug**：PyInstaller 忽略 `PYTHONUTF8`，打包后中文按 GBK 输出（详见陷阱 #3）

---

## 6. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **打包后找不到 sqlite_vec 的 .dll** | 必须 `--collect-all sqlite_vec`。这是风险表 #1，本 Stage 必须验证。 |
| 2 | **打包后 fastembed 找不到模型/ONNX** | `--collect-all fastembed` + `--add-data resources`。 |
| 3 | **★ 中文乱码（实测比文档描述的更棘手）** | 执行文档只写「spawn 时传 env」。**实测不够**：PyInstaller 的 bootloader 设置 `Py_IgnoreEnvironmentFlag`，打包后 `PYTHONUTF8`/`PYTHONIOENCODING` **被完全忽略**（`utf8_mode=0`、`encoding=gbk`）。必须在 Python 层 `reconfigure(encoding="utf-8")` 兜底（`app/encoding.py`）。**两条都要做**：env 管源码运行态，reconfigure 管打包态。 |
| 4 | 端口竞态 | 用 `--port 0` 让 OS 分配，握手回传，绝不自己扫端口。 |
| 5 | 孤儿进程 | `before-quit` + `taskkill /T /F`（`/T` 杀子进程树，缺它会漏）。开发态 `uv run` 会派生子进程，**必须 `/T`**。 |
| 6 | stdout 被缓冲 | Python 侧 `print(..., flush=True)`；spawn 时设 `PYTHONUNBUFFERED=1`。 |
| 7 | Electron 原生模块 | **绝不引入任何原生 DB 模块**，Electron 只是 UI 壳 + 进程管理。 |
| 8 | **stdio 管道分片** | Node 的 `data` 事件按内核缓冲切分，可能把握手 JSON 切成半行 → 必须缓冲到 `\n` 再 parse（`LineBuffer`）。 |
| 9 | **非 JSON 的 stdout 输出** | 第三方库直接 print 会污染握手通道；解析失败必须**只记日志、不当错误**，否则启动流程被无关输出打死。 |
| 10 | **重打包 `WinError 5`** | 上次验证留下的 sidecar 仍持有产物 `.pyd`/`.dll`，PyInstaller 清目录失败。`build_server.py` 打包前自动 taskkill 自愈。 |
| 11 | 调试端口泄漏 | `K12_DEBUG_PORT` **默认关闭**，仅在显式设置时开启；打包态开启会打印安全告警。绝不让分发包带调试入口。 |

---

## 7. 产出记录

| 项 | 结果 |
| --- | --- |
| 打包产物体积 | **226.1 MB**（`server/dist/k12-agent-server/`，含 90.8MB 嵌入模型） |
| 冷启动耗时 | **0.66–0.82s**（`--onedir`，`frozen=true`） |
| 整包体积 | `desktop/dist/win-unpacked/` 内 `resources/server` = 228 MB |
| 后端依赖版本 | fastapi 0.141.1 / uvicorn 0.52.4 / pydantic 2.13.5 / pyinstaller 6.22.3 |
| 前端依赖版本 | electron 39.8.10 / electron-vite 5 / vite 7.3.6 / vue 3.5.42 / pinia 3.0.3 / TS 5.9.3 |
| 单测 | **31/31 通过**（`npm test`，Node 原生跑 TS，无需额外构建） |
| 类型检查 | `npm run typecheck` 通过（node + web） |
| 关卡 A 通过时间 | D1（**当天完成，未拖到 D14**） |
| PyInstaller 踩坑 | ① **打包后 `PYTHONUTF8` 被 bootloader 忽略 → 中文按 GBK 输出**（新增 `app/encoding.py` 修复 + 打包脚本加回归断言）；② 重打包 `WinError 5`（残留进程占用 `.pyd`，打包脚本自动 taskkill 自愈）；③ `collect_all` 返回值必须喂给 `Analysis` 而非事后 `a.datas +=`（元组长度不一致会崩） |
| 其他踩坑 | ④ Node stdio 分片把握手 JSON 切半（`LineBuffer` 解决）；⑤ `@quick-start/create-electron` 交互式提示在无 TTY 下不可用，改为直接从 npm 包提取官方模板 |
| 报告素材 | `docs/report-material/pitfalls.md` 新增 P-006~P-008（含 ★ 打包编码坑）；`decisions.md` 新增 D-006（stdout 握手通道）、D-007（`K12_SIDECAR_MODE` 提前验打包路径） |

### 本 Stage 的额外收获

1. **把「进程管理」这块最难测的逻辑抽成纯函数并写测试**（`sidecar-logic.ts`）。
   不依赖 Electron 即可验证，回归成本从「起一次应用」降到毫秒级。
2. **UI 验收改用 CDP 读真实 DOM 而非截图**（`scripts/verify-ui.mjs`）。
   本机截图受前台窗口/DPI 影响，截到的常是别的窗口；DOM 断言是确定性的、可进 CI 的。
   同时支持 `--expect failed` 断言「失败态不白屏」这条硬要求。
3. **确认执行文档风险表 #3 的表述需要修正**：仅「spawn 时传 env」不足以解决打包后的中文问题。

### 下次开工前需知（S02）

- 后端新增 `/api/*` 路由会自动落在现有鉴权中间件下，**无需重复写鉴权**。
- 前端调后端接口时，`X-Auth-Token` 从 `useSidecarStore().info.token` 取；
  **注意 token 每次启动/重启都会换**，不要把它缓存到别处。
- 改完 `server/app/models.py`（S02 建）后必须重跑 OpenAPI → TS 类型生成。
