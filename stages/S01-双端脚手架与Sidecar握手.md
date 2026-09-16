# Stage 01 · 双端脚手架 + Sidecar 握手

| 项 | 内容 |
| --- | --- |
| 对应排期 | D1 |
| 关卡 | ✅ **关卡 A（最高风险）—— 已通过** |
| 前置 | S00 |
| 状态 | ✅ **已完成**（代码已归档） |

---

## 1. 目标（已达成）

Electron 能拉起 Python sidecar 并显示握手结果；**打包产物里也能跑通**。

## 2. 交付结果（**报告核心数据**）

| 项 | 实测值 |
| --- | --- |
| 打包产物体积 | **226.1 MB**（含 90.8MB 嵌入模型） |
| **冷启动耗时** | **0.66–0.82 s**（`--onedir` + `frozen=true`） |
| 整包体积 | `win-unpacked/` 内 `resources/server` = **228 MB** |
| 单测 / 类型检查 | **31/31 通过** / `typecheck` 通过 |
| **关卡 A 通过时间** | **D1 当天**（刻意不拖到 D14 —— PyInstaller 的坑必须第一天暴露） |

> **完整数据与踩坑见** `docs/阶段实测记录-S00至S02.md` 第 2 节。

## 3. 已确立的架构不变式（**v2 仍然全部有效**）

1. **端口**：Python 绑 `127.0.0.1:0`，OS 分配端口，**stdout 单行 JSON** 握手
   （`{"event":"ready","port":N,"pid":P}`）；**stdout 只许输出这行 JSON**，日志全走 stderr。
2. **鉴权**：Electron 生成随机 hex token 经 `--token` 传入，所有 `/api/*` 须带 `X-Auth-Token`。
3. **退出清理**：`before-quit` 杀进程树（`taskkill /PID <pid> /T /F`），**`/T` 不可省**。
4. **编辑器侧无原生模块**：Electron 只是 UI 壳 + 进程管理，**不引入任何原生 DB 模块**。
5. **UI 验收用 CDP 读真实 DOM**（`verify-ui.mjs`），**不靠截图**。

## 4. 陷阱（**已归档为 P-006/P-007/P-008**）

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **★ 打包后中文变 GBK** | PyInstaller bootloader 设置 `Py_IgnoreEnvironmentFlag`，`PYTHONUTF8`/`PYTHONIOENCODING` **被完全忽略**（实测 `utf8_mode=0`、`encoding='gbk'`）。**必须在 Python 层 `reconfigure(encoding="utf-8")`** —— 仅 spawn 传 env **不够**。 |
| 2 | `WinError 5` 重打包失败 | 残留 sidecar 进程占用产物 `.pyd`/`.dll` → 打包脚本自动 taskkill 自愈。 |
| 3 | `collect_all` 返回值 | 必须在 `Analysis(...)` **之前**收集并传入；事后 `a.datas +=` 会因元组长度不一致而崩。 |
| 4 | stdio 管道分片 | Node `data` 事件按内核缓冲切分，可能把握手 JSON 切成半行 → 必须缓冲到换行符再 parse。 |
| 5 | 非 JSON 的 stdout | 第三方库直接 print 会污染握手通道 → **只记日志、绝不当错误**。 |
| 6 | 端口竞态 / 孤儿进程 | `--port 0` + `taskkill /T /F`。 |
| 7 | 调试端口泄漏 | `K12_DEBUG_PORT` **默认关闭**，勿让分发包带调试入口。 |

### 生命周期细节（**改 sidecar 逻辑前必读**）

- `restart()` **不能复用 `stop()`**：`stop()` 会把 `shuttingDown` 置 true，
  而 `shuttingDown=true` 会让之后**崩溃不再自动重启**。
- `onExit()` 会先把 `this.child` 置 null → **必须在置空前先取 pid**，否则进程树不会被回收。
- 需防「旧进程的异步事件覆盖新进程状态」——用 `isStale(child)` 守卫。

## 5. 与 v2 的关系

**本 Stage 全部继续有效**（sidecar 握手、鉴权、进程树清理、UI 验收方法均不受 Pi 迁移影响）。

**v2 新增关注点**：Pi 运行在 Electron 主进程内，**不增加进程**；但主进程崩溃会同时带走 UI 与 Agent
→ **Pi 侧所有 Tool 的 `execute()` 必须自行兜异常**，且 `session.dispose()` 要在 `before-quit` 调用。
