# AGENTS.md

面向后续编码代理的仓库说明：只记**本仓库特有、从代码/脚本/CI 才能核出来**的事实。
与 `项目执行文档.md` 冲突时**以执行文档为准**，并顺手修正本文件。

## 权威顺序

| 来源 | 角色 |
| --- | --- |
| `项目执行文档.md` | **唯一规格权威**（范围、契约、DDL、排期、验收、演示） |
| `docs/tickets/` + `docs/tickets/README.md` | 任务视图（一票一文件 `NN-*.md` + `Blocked by`）；**不**放 `.scratch/`（见 `docs/agents/issue-tracker.md`） |
| `docs/业务陷阱清单.md` | 领域陷阱与业务验收口径（动手前扫一眼） |
| `docs/report-material/{decisions,pitfalls}.md` | 决策 D-xxx / 踩坑 P-xxx **唯一正文**；只追加、不重排编号、不写死范围 |
| `docs/agents/*.md` | tracker / triage 词表 / 领域文档消费方式 |
| 可执行源 | `desktop/package.json` scripts、`.github/workflows/*`、守卫测试 —— **与 prose 冲突时信可执行源** |

已归档/部分过时、**不要照实现**：`docs/研判文档PiAgent.md`、`docs/研判文档Qwen3.7.md`。
历史决策不要从 git 或 `archive/s02-full-code` 取实现；**禁止 checkout 恢复删码前代码**（有意决策）。

## 架构一句话

**混合后端（刻意取舍，不是半成品）**：Python 管数据/RAG/嵌入/判分/学习记录；TypeScript（Electron 主进程）管编排/LLM/Prompt/Tool/6 事件映射。两端只经冻结契约通信。

```
渲染(Vue) ⇄ IPC 6事件/preload白名单 ⇄ 主进程(TS/Pi) ⇄ 127.0.0.1 HTTP+token ⇄ Python sidecar
     sandboxed iframe(动画)          Pyodide Worker(学生代码)
```

**四条硬边界（违反即架构事故，守卫：`desktop/tests/architecture-guards.test.ts`）**

1. **数据域只在 Python**：SQLite、四级降级链（vector→cloud→fts→outline，**一次调用内走完**）、嵌入、判分 —— TS 不碰 DB/SQL/向量。
2. **编排域只在 TypeScript**：Pi、Prompt、Tool、事件映射；**Python 不装 langgraph/langchain、不调 LLM**（`server/pyproject.toml` 有注释钉死）。
3. **契约面只走 pydantic**：`server/app/contracts.py` → OpenAPI → 生成 TS（`npm run gen:api` / `check:api`）；TypeBox Tool 参数须与 pydantic 一致（`check:tool-schema`）。唯一手写例外：`desktop/src/shared/provider-catalog.ts`（Pi 目录，无凭证）。
4. **执行面只在渲染进程**：学生代码只在 Pyodide Worker；绝不在主进程/Python。

传输冻结：**无 SSE / EventSource**；事件词表 `delta|citation|payload|blocked|done|error`（`src/shared/ipc-events.ts`）。通道名单唯一来源 `src/main/ipc/channels.ts`；**通道总数只认 `npm run check:docs`**（别写死）。

## 必背约束（高频踩点）

- **`ChatSendRequest` 字段恰好 `['text']`（G6c）**。学段 `grade:set`、章节 `chapter:set`、学生 id **绝不混进对话请求**；学生 id 由主进程决定。
- **学段**：默认自动 + 学生手动（冷却 5/10 轮，阈值只在 `server/app/grade/rules.py`）；写学段两处都要清 `current_chapter`；手动不写 `grade_signals`。
- **RAG 学段隔离必须在 SQL 层**；向上兼容标 `compat`；知识库源：`K12KnowledgeBase/` → `import_knowledge.py --write` → `build_kb`。**不要手改 `server/knowledge/`**（下次导入覆盖）；改概念须同步 `SLUGS`。
- **无 vue-router**：导航唯一真相 `stores/ui.ts` 的 `PAGES` + `go(page)`。
- **设计令牌** `--k12-*`：改 `scripts/design/tokens.source.json` → `npm run gen:tokens`；**勿手改** `tokens.generated.css`（CI 查 diff）。字号走 `base.css` `:root` 阶梯，**页面不写死 `font-size: Npx`**。
- **视觉边界 = 三件套（D-106）**：底色差（主）+ 两支线（副）+ **只给结构分面**的单侧投影（副）。**任何一条都不能单独拿掉**：`page`/`surface-2` 的不塌陷下限由 `author-tokens.mjs` 派生（对白纸 ≥1.045、两者差 ≥1.01，18 组配色逐组保证）；`border` 1.47:1 / `border-strong` 2.54:1 **都不到 WCAG 3:1**，这是有意的（3:1 会让浅色界面变线框风）。改动前先读 `base.css` 文件头的三件套口径。守卫：`tests/visual-edges.test.ts`（6 条）+ 变异 107–112 + `scripts/design/check-contrast.mjs --strict`（342 项）。**改令牌色值必须同步重建后端动画皮肤**：`cd server && uv run python scripts/build_animation_skins.py`（它读同一份 `tokens.source.json`，漏了红 `test_sandbox_palette`）。
- **阴影只有一处定义**：`--k12-shadow-*` 全在 `base.css` 的 `:root`（`gen-tokens.mjs` 只管两支聚焦环）。**同一个自定义属性出现两处定义时，后加载的静默覆盖前者**（P-158）。
- **品牌**：真源 `src/shared/brand.ts`；`index.html` title 与 `electron-builder.yml` `productName` **须手工同步**。**userData slug 钉死**（`applyStableUserDataSlug`），改名不迁数据。
- **双视角（D-063）**：技术证据进 `<TeacherGate>`；学生面禁技术词/内部 id/kp slug（用 `kpLabel()`）；承诺文案不得超出该路径实际行为。守卫：`student-view-discipline.test.ts` + `npm run ux:student`。
- **三档视角（D-094，2026-09-26）**：`student < teacher < debug`，判据只有「当前档位 ≥ 该页要求的档位」（`stores/ui.ts` 的 `VIEW_MODE_ORDER` / `viewModeAllows` / `requiredViewFor`）。**演示驾驶舱**（`PAGES.demo.nav === 'debug'`）摊开后端隐藏机制，入口在设置页高级区（先切档再跳页）；技术口原文案集中在 `components/diag/evidence.ts`（守卫按文件豁免，凭据在 `tests/demo-mode.test.ts`）。
- **演示数据（D-093/D-095）**：轮次信封走**独立推送通道** `diagnostics:changed`（+ `diagnostics:read` / `diagnostics:clear` 两条 invoke），**不进 6 事件词表**；落盘到 `pi-agent/logs/turn-diagnostics.jsonl` 的是**剥掉正文**的那份（只留长度/哈希/计数/结论），暖机后跨重启可回放。RAG 的 `attempts` / `gradeFilter` 是**只读展示字段**，逐级同源性由 `test_rag.py` 的 trace 用例钉住。守卫：`tests/demo-mode.test.ts` + `npm run ux:demo`。
- **Pi**：锁 `^0.85.1`；**必须** `systemPromptOverride`（防装机路径泄漏）；**`session_end` 不存在**（用 `session_shutdown` / `agent_end`）；会话目录必须改道 `students/<id>/`；`models.json` 是设置页**每次重写**的派生产物；内置模型 ID 不写 `models[]`（会丢 compat）。SDK 无 `createAgent`/`PiAgent`/`registerExtension`。
- **会话**：切换 = **先 dispose 旧再装配新**（或分叉后再 dispose）；`cwd` 统一 `piSessionCwd`；删除当前会话须先换会话再 `unlink`；invoke 通道**不进** `PUSH_CHANNELS`。
- **NSIS**：`deleteAppDataOnUninstall: false`（**勿改 true** —— 会删光学生数据）；引导式 `oneClick: false` 成套配置勿拆。
- **打包依赖**：electron-builder **只收 `dependencies`**；渲染依赖放 `devDependencies`。renderer `emptyOutDir: true` 不能删。`resources/` 只放主进程直读物，防双份进包。
- **渲染进程必须压缩**（2026-09-27，P-148）：`electron.vite.config.ts` 的 renderer 段写死 `minify: 'esbuild'` —— electron-vite 三个目标的默认值是 `minify: false`，关掉它 Monaco chunk 立刻从 2.52MB 涨回 **4.87MB**（报告 §5.1 的 <3MB 验收线从结构上做死）。守卫：`tests/monaco-bundle.test.ts`。新增渲染专用依赖时，同步加进 `tests/bundle-budget.test.ts` 的 `RENDERER_ONLY_PACKAGES`（例：`vue-virtual-scroller`）。
- **本地只构建便携版**（2026-09-22 用户裁决）：日常出包一律 `npm run build:portable`（只出一个 `dist/<name>-<ver>-portable.exe`）。安装器 nsis 由 **CI/nightly** 出；`build:win` 留给手动发版，**本地别跑**。
- **Electron 侧禁原生数据库模块**；Anime.js **锁 v3**；零 CDN（Pyodide/Monaco/动画库本地）。

## 命令（以本表为准）

```bash
# 后端 —— 一律 uv run，禁裸 python（本机 python 路径是坏的）
cd server
uv sync
uv run python scripts/fetch_embedding_model.py    # ~90MB，联网；不入库
uv run python scripts/import_knowledge.py --write # 幂等
uv run python scripts/build_kb.py                 # CI 用 --no-vectors
uv run python scripts/export_openapi.py
uv run python scripts/build_server.py             # --verify / --if-stale
uv run python -m unittest discover -s tests       # 须先建 kb，否则相关用例 skip = 没验

# 桌面
cd desktop
npm install
npm run typecheck          # 契约漂移第一道防线；改契约后立刻跑
npm test                   # node --test + check:api + check:tool-schema + check:docs
npm run dev                # 自动拉起 sidecar（随机端口）
npm run build              # = build:server(--if-stale) → typecheck → electron-vite build
npm run build:portable     # ★ 本地**唯一**的出包命令：只出便携版 exe + 后端新鲜度校验
npm run build:unpack       # 只出 win-unpacked（便携版的中间产物，验 esbuild/Pi）+ 同校验
npm run build:win          # ⚠️ 出 nsis 安装器 + 便携版 —— **本地不跑**，只给手动发版
npm run check:server       # / check:server:packaged / check:bundle / guards:mutation
```

**本地只构建便携版**（2026-09-22 起的口径，用户裁决）：
日常验证一律 `npm run build:portable` → `dist/<name>-<ver>-portable.exe`。
安装器（nsis）由 **CI/nightly** 出（`npx electron-builder --win nsis zip portable`，目标在命令行给、不改 `electron-builder.yml` 的本地默认）。
⚠️ 别用 `build:win` 代替它：那会顺带出一个安装器，多花几分钟，而且真机上会多出一份与本地验证无关的 setup.exe。
★ 出包后若要核对「改动真的进包了」：`grep -a <改动的那段源码特征> dist/win-unpacked/resources/app.asar`（asar 不压缩，字节搜得到）。

**顺序纪律**：契约改动 → `export_openapi` + `gen:api` → `typecheck` → `test`。
`npm run build` **已联动** sidecar 指纹；逃生舱 `K12_SKIP_SERVER_BUILD=1` 会警告后跳过 —— 谨慎。
`check:bundle` / 产物级检查**不属于** `npm test`（要先有产物）。

单测跑法：`cd desktop && node --test tests/foo.test.ts`；后端单文件 `uv run python -m unittest tests.test_xxx -v`。
**TS 单测禁 parameter property**（`constructor(private x)`）→ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。

### UX / 跨层探针（与单测是两件事）

```bash
cd desktop
K12_DEBUG_PORT=9222 npm run dev   # 另一终端
npm run ux:reload                  # ★ 先跑：HMR 不重跑 onMounted
npm run ux | ux:pages | ux:layout | ux:student | ux:scroll | ux:busy
npm run ux:nonce                   # 动画资源请求计数：必须 0 次（一次性 nonce 不许被取第二次，D-084）
npm run ux:stage                   # 动画舞台的屏幕有效字号（缩放/节点字/字幕/步骤条，三视口；D-085）
npm run ux:motion                  # 减少动效三档（自动/开启/关闭）：用 CDP 模拟系统偏好 + 探针动画量时长（D-100）
npm run ux:perf                    # 性能基准线：FCP / LCP / FID + DCL / load（门槛见脚本头；D-102）
npm run smoke:wire                 # 需 sidecar：--data-dir 必须显式且 ≠ server/_data，见脚本头
```

坑：探针默认停在**对话页**且两栏可能默认收起（脚本会展开）；窗口须前台可见（否则几何断言假红）；
按文字点侧栏时标签要与 `PAGES.title` 一致（对话页叫**问问智团团** —— `ux:nonce` 曾因写成「对话」而静默跳过整轮）；
`ux:layout` 用过视口仿真（`Emulation.setDeviceMetricsOverride`）之后，CDP 的键盘事件不再送达渲染进程 ——
键盘类审计（`ux` / `ux:keyboard`）要先跑或重启应用再跑（P-149）；`K12_DEBUG_PORT` 绑不上先查僵尸监听（P-152）；
探针的锚点 / 隔离 / 截图 / axe 类规则统一在 `scripts/probe-lib.mjs`，改组件前先读 `docs/agents/probe-guide.md`；
改守卫后跑 `guards:mutation` 验「真的会红」。

## CI 读法

- `ci.yml`：push/PR 门禁 —— `build_kb --no-vectors` → 后端 unittest；桌面 `typecheck` + `npm test` + tokens diff。**不**下模型、不出包。
- `nightly.yml`：真打包 + Release；push 触发的打包**不发 Release**。`fetch-depth: 30`、`permissions: contents: write`、`shell: bash` 有实义，勿改回默认。
- `release.yml`：**正式发版**，只能 `workflow_dispatch` 手动触发（Actions 页填三段数字版本号，如 `1.0.0`）。它把版本号经 `K12_VERSION` 传给 `build-version.mjs`（显式指定压过 CI 的 run number），发**非 prerelease** 的 `v<版本号>` Release → 自动成为 Latest；nightly 的 `--prerelease` 刻意不抢 Latest，就是留给它的。守卫 `tests/installer-config.test.ts` G21-9 + 变异 123/124。
- 日志里 **`Traceback` ≠ 失败**（故意失败用例）；只认 `Ran N tests` + `OK`/`FAILED`。同分支 cancel-in-progress 的 `X` = 上一轮被取消，不是新失败。

## Git

- remote：`https://github.com/IceFireIcer/K12AgentProject.git`（private），`master`。
- 提交：`type(票NN): 中文摘要`。
- **勿提交**：`*.sqlite` / `*.db`、`**/resources/models/`、`config.json`/`.env`、`server/_data*/`、`students/`、`dist/`/`out/`、`.zcode/`。**要提交** `uv.lock`、`.python-version`、`desktop/build/`（图标被 `build/` 规则误伤，靠 `!` 放回）。
- `.gitignore` 含中间斜杠的 pattern **锚定仓库根**：必须 `**/resources/models/`，不能写 `resources/models/`。
- 换行：`.gitattributes` 强制 LF。

## 基础设施陷阱（实测，当设计约束）

- **stdio 中文**：源码态靠 env；**打包态 env 无效** → 必须 `install_utf8_stdio()`（`app/console.py`）。PyInstaller **`--onedir`**；`collect_all` 须在 `Analysis` 前传入。
- **sidecar**：`127.0.0.1:0` + stdout **单行 JSON** 握手；日志走 stderr；退出 `taskkill /T /F` 杀进程树。
- **sqlite-vec**：load 后立刻 disable extension；FTS5 中文须 `tokenize='trigram'`；`chunk_vec.rowid == chunk.rowid`。
- **动画**：sandboxed iframe **禁 `allow-same-origin`**；资源走 nonce，不走自定义 header；模板优先 + 校验 + 降级。
- **排序**：章节按 `第N章` 数字，不按标题/rowid。
- **偏好/画像注入块须字节稳定**（D-032）：块内不放时间；偏好固定顺序；错题只注入名+次。
- **本机/CI**：Node ≥22.19（CI 用 22 工具链；Electron 内置 24）；不要升 vite 8 / TS 7；Python 钉 3.12（uv）。

## 开工怎么找活

1. 读 `项目执行文档.md` 对应规格 + `docs/tickets/README.md` 的 `Blocked by` 前沿。
2. 开工改票 `Status:`（词表 `docs/agents/triage-labels.md`），完工更新验收与 `docs/report-material/`。
3. 动手前扫 `docs/业务陷阱清单.md`；改契约/事件/通道/打包配置前先跑对应守卫与 `typecheck`。
