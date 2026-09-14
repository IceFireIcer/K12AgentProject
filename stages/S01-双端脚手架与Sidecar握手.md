# Stage 01 · 双端脚手架 + Sidecar 握手

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D1** |
| 关卡 | ✅ **关卡 A（最高风险）** |
| 前置 | S00 完成 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

**双击一个打包好的 .exe，Electron 自动拉起 Python sidecar，窗口里显示 `握手成功 port=xxxxx`。**

这个 Stage 的全部价值在于：**在第一天就把 PyInstaller 的坑炸出来**，而不是拖到 D14 才发现打不了包。

---

## 2. 任务清单

### 2.1 后端

- [ ] `app/main.py`：FastAPI 应用
  - [ ] 启动参数：`--port`（默认 0 = 系统分配）、`--token`、`--data-dir`
  - [ ] 绑定 `127.0.0.1`
  - [ ] **端口握手**：uvicorn 起好后，向 stdout 打**单行 JSON**：`{"port": 8756, "pid": 1234}`，然后 flush
  - [ ] `GET /health` → `{"status":"ok","version":"...","embedder_ready":bool}`（`/health` 免鉴权）
  - [ ] 中间件：所有 `/api/*` 校验 `X-Auth-Token`，不符返回 401
- [ ] `.python-version` / `pyproject.toml` 就绪（S00）
- [ ] UTF-8 强制：`os.environ.setdefault("PYTHONUTF8","1")`

### 2.2 前端

- [ ] `desktop/`：electron-vite + Vue3 + TS + Pinia 脚手架
- [ ] 最简窗口（`src/main/index.ts`）
- [ ] `src/main/sidecar.ts`：
  - [ ] 生成随机 hex token（`crypto.randomBytes(32).toString('hex')`）
  - [ ] `spawn` Python（dev 用 `uv run`，prod 用打包产物），传 `--port 0 --token X --data-dir <userData>`
  - [ ] **spawn 时显式注入 env**：`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`、`PYTHONUNBUFFERED=1`
  - [ ] stdout 逐行读，解析握手 JSON 拿到 port
  - [ ] 轮询 `/health` 直到就绪（超时 30s → 显示可读错误，**不许白屏**）
  - [ ] `exit` 事件 → 非正常退出重启一次，再失败写日志到 `userData/logs/`
  - [ ] `before-quit` → `taskkill /PID <pid> /T /F` 杀进程树
- [ ] preload 白名单：只暴露 `getSidecarInfo()` 等最小接口
- [ ] 渲染层显示握手结果

### 2.3 打包（本 Stage 的核心）

- [ ] PyInstaller `--onedir` 打包 server
- [ ] 打包产物能被 Electron 拉起并握手成功

---

## 3. 关键命令

```bash
# 后端单跑（不依赖 Electron，可 curl 验证）
cd server
uv run python -m app.main --port 0 --token devtoken --data-dir ./_data
curl -H "X-Auth-Token: devtoken" http://127.0.0.1:<port>/health

# 前端
cd desktop
npm create @quick-start/electron@latest . -- --template vue-ts
npm install
npm run dev

# 打包后端（--onedir，绝不用 --onefile）
cd server
uv run pyinstaller --noconfirm --onedir --name k12-agent-server \
  --collect-all sqlite_vec --collect-all fastembed \
  --add-data "resources;resources" \
  app/main.py
```

> **`--onedir` 而非 `--onefile`**：onefile 每次启动解压到临时目录，冷启动 10s+，演示体感极差。

---

## 4. 涉及文件

```
server/app/main.py              # FastAPI 入口 + 握手 + 鉴权
desktop/src/main/index.ts       # 窗口与生命周期
desktop/src/main/sidecar.ts     # ★ 进程管理
desktop/src/preload/index.ts    # contextBridge 白名单
desktop/src/renderer/App.vue    # 显示握手结果
```

---

## 5. 验收标准（DoD / 关卡 A）

- [ ] `uv run python -m app.main --port 0` 能在 stdout 打出一行合法 JSON，含 port
- [ ] `curl /health` 免 token 可访问；`/api/*` 无 token 返回 401
- [ ] `npm run dev` → 窗口显示「sidecar 就绪 port=xxxxx」
- [ ] **PyInstaller 打包后**，产物目录里 `k12-agent-server.exe` 能独立启动并握手
- [ ] Electron 指向打包产物（而非 `uv run`）时，**握手依然成功** ← **这才是关卡 A**
- [ ] 关闭窗口后，任务管理器里**没有残留 python 进程**
- [ ] 二次启动不报端口占用
- [ ] 人为杀掉 sidecar → Electron 能重启一次；再失败显示错误提示而非白屏

---

## 6. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **打包后找不到 sqlite_vec 的 .dll** | 必须 `--collect-all sqlite_vec`。这是风险表 #1，本 Stage 必须验证。 |
| 2 | **打包后 fastembed 找不到模型/ONNX** | `--collect-all fastembed` + `--add-data resources`。 |
| 3 | **中文乱码** | 打包后子进程不继承全局 `PYTHONUTF8`，**必须在 spawn 时显式传 env**。 |
| 4 | 端口竞态 | 用 `--port 0` 让 OS 分配，握手回传，绝不自己扫端口。 |
| 5 | 孤儿进程 | `before-quit` + `taskkill /T /F`（`/T` 杀子进程树，缺它会漏）。 |
| 6 | stdout 被缓冲 | Python 侧 `print(..., flush=True)`；spawn 时设 `PYTHONUNBUFFERED=1`。 |
| 7 | Electron 原生模块 | **绝不引入任何原生 DB 模块**，Electron 只是 UI 壳 + 进程管理。 |

---

## 7. 产出记录

| 项 | 结果 |
| --- | --- |
| 打包产物体积 | （待填） |
| 冷启动耗时 | （待填） |
| PyInstaller 踩坑 | （待填 → 报告素材） |
| 关卡 A 通过时间 | （待填） |
