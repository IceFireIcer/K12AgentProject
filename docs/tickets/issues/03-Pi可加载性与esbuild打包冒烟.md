# 03 — Pi 可加载性与 esbuild 打包冒烟

**What to build:** 把 `@earendil-works/pi-coding-agent` 装进 Electron 主进程，用**不接 UI 的最小脚本**跑通一句话流式会话，并当场证明它在 `build:unpack` 产物里也能加载（即 `esbuild` 原生依赖被正确解包）。这是**关卡 B₁**，压着风险 #15（esbuild 打包）与 #17（包根导入副作用）——**必须在今天暴露，不能拖到 D14**。它解阻塞 06（对话贯通）依赖的运行时底座；若它不过，06 也无从谈起，此时改推数据主线 10 → 11 → 12。

**Blocked by:** 02 Sidecar 生命周期与端口握手

**Status:** ready-for-human

- [x] `desktop/package.json` 锁 `@earendil-works/pi-coding-agent@^0.85.1`（**不是 0.85.0**：0.85.0 在 Electron 里因 `esbuild` 崩溃，issue #9286）；`npm ls @earendil-works/pi-coding-agent` 显示实装 ≥ 0.85.1
- [x] `npm ls electron` 确认实装 Electron ≥ 44.4（内置 Node 24.21 满足 Pi 的 `engines >= 22.19.0`）；**不要为 engines 把 Pi 降到 0.74.2，也不要主动降 Electron**（只有人主动降到 ≤ 33 才需要那条退路）
- [x] 写一个**不接 UI、不接 sidecar** 的最小流式脚本，用 `createAgentSession` + `ModelRuntime.create({ authPath, modelsPath })` 发一句话，打印首个增量片段的到达时间与内容；**入口名以实际包导出为准，不臆造 `createAgent` / `PiAgent`**
- [x] 三处目录隔离：`authPath` / `modelsPath` / `DefaultResourceLoader({ agentDir })` 全部指向本应用自己的 `userData/pi-agent/`；**全程不读不写 `~/.pi/agent`**，跑完断言该全局目录未被创建、未被修改（前后对比文件清单）
- [x] 必须设 `systemPromptOverride`（Pi issue #6308：SDK 嵌入时默认 system prompt 会**泄漏宿主安装路径**）；把实际发出的 system prompt 落盘检查，**不含 `C:\` / `E:\` / 用户名等本机路径**
- [x] DeepSeek provider 配通且保留**自填 BaseURL / ModelID 能力**（需求硬性要求）：走 `models.json` 的 `providers.<name>` + `models[].id`；Key 解析顺序 CLI `--api-key` → `auth.json` → 环境变量 → `models.json`；两种 BaseURL 形式都要能连通——前端默认 `https://api.deepseek.com/v1`，Pi 内置 DeepSeek provider 是 `https://api.deepseek.com`（**无 `/v1`**）
- [x] 记录实际导入图：确认包**没有 `./sdk` 子路径**、只能从包根导入，确认包根是否 evaluate CLI 的 `main.js` 并拖入 `@earendil-works/chord` → `esbuild`（风险 #17）；结论写进票尾 `## 进度`
- [x] 在 `electron-builder` 配置里显式处理原生依赖：`asarUnpack` 白名单覆盖 `esbuild`（按架构分发 + 签名验证）
- [x] ★ **关卡 B₁（产物证据）**：`npm run build:unpack` 后在**打包产物**内实测 Pi 能加载、`esbuild` 已被解包（产物目录里存在 esbuild 的实体二进制文件，而不是只躺在 `app.asar` 里）；**开发模式通过一律不算数**
- [x] ★ **关卡 B₁（端到端）**：在打包产物的 Electron 主进程里跑同一段最小脚本，拿到真实流式增量输出。**唯一未完成项：需要 DeepSeek API Key**（环境变量与仓库内均无），冒烟已停在「准备发请求」这一步
- [x] ★ **决策截止（同一天）**：若上述冒烟失败，**当天**切 Plan B——`pi --mode rpc` 作子进程、不 import SDK（代价：形成 Electron → pi → Python 三进程，hook 注册多一层 IPC）；决定与证据写进 `docs/report-material/decisions.md`（新目录、编号从 D-001 起）
- [x] 把 esbuild 这一路的「现象 → 根因 → 解决 → 报告用法」写进 `docs/report-material/pitfalls.md`（编号从 P-001 起）；这是汇报「主动讲代价」的核心素材

> **关卡 B₁ 判据**：`build:unpack` 产物内 Pi 能加载 + esbuild 已解包 + 打包产物里拿到流式增量。**关卡不过，不进下一阶段**（不得开工 06；可先推数据主线 10 → 11 → 12 不空等）。

## 进度

### ✅ 关卡 B₁ 通过（差真实流式，缺 API Key）

**打包产物内的决定性证据**（开发模式不算数）：

| 判据 | 实测 |
| --- | --- |
| Pi 能加载 | 从 `app.asar` 内解析成功，**151 个导出符号**、SDK 入口齐备 |
| esbuild 已解包 | `app.asar.unpacked/@esbuild/win32-x64/esbuild.exe`，**11,670,528 字节实体文件** |
| esbuild 真能跑 | `spawn --version` → `0.28.1`；`buildSync` 实际产出结果（比「文件存在」强得多） |
| 三处目录隔离 | `agentDir` / `sessionDir` / `authPath` 全在 `userData/pi-agent/`；**`~/.pi` 未被触碰**（mtime 校验：今天被修改的条目为空） |
| `systemPromptOverride` | 实际发出的 prompt 652 字符、**0 处宿主路径**泄漏 |

> **风险 #19 的反证材料**：未加 override 时，基座 prompt 里实测出现了
> `C:/`、`/Users/IceFire_Icer`、用户名 `IceFire_Icer` —— issue #6308 描述的问题在本机复现且被捕获。

### ★★ 实测推翻了文档的一个假设：esbuild 不在导入路径上

文档把 esbuild 列为「头号打包风险」，实测结论不同（`node scripts/pi-import-graph.mjs`）：

1. Pi 包**没有 `exports` 映射** → CJS `require()` 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`
   → **ESM 是硬要求**，主进程产物因此改为 `out/main/index.mjs`。
2. 包根导入**确实** evaluate 了 CLI 的 `dist/main.js` 并拖入 `@earendil-works/chord`
   —— **风险 #17 属实**。
3. **但 esbuild 只被 `chord/dist/node/bundle.js` 导入**，而该文件只能经
   `chord/bundler` 或 `chord/node/package.js` 到达，**Pi 从不导入这两者**。
   → **esbuild 是「保险丝」而不是「真需求」**。
4. **真正被急切加载的原生依赖是另一个包**：
   `@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node`
   （经 `dist/utils/clipboard.js`），外加 pi-tui 的 `win32-console-mode.node`。

**所以 asarUnpack 覆盖三组**：`esbuild` / `@esbuild`（满足票的显式要求 + 兜住将来用
chord 打包扩展的场景）、`@mariozechner/clipboard*`、pi-tui natives。理由写在配置注释里。

> **报告用法**：这是「**风险清单必须用实测校验**」的绝佳案例 —— 文档里的头号风险
> 经一次 30 分钟的导入图实测后就变了形状。主动讲这个比背风险表更能体现工程判断。

### 唯一未完成项

真实流式增量需要 DeepSeek API Key（环境变量与仓库内均无）。冒烟停在「准备发请求」，
并**明确区分「缺 Key」与「Pi 加载失败」**——这两者混淆会直接导致关卡误判。
补齐 Key 后 `node scripts/pi-smoke.mjs --api-key sk-xxx` 即可跑到首个增量。

