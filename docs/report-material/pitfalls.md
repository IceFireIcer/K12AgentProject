# 踩坑与解决（Pitfalls）

> 每条格式：**现象 → 根因 → 解决 → 报告用法**。攒够就是报告第 7 章与答辩问答的原料。

## P-001 · 本机裸 `python` / `py` 全部报错

- **现象**：`python --version` → `Failed to launch 'D:\Code\PythonEvm\python.exe' (0x80070003)`。
- **根因**：`py -0p` 的默认项（带 `*`）指向 `D:\Code\PythonEvm\python3.14t.exe`，而**该目录已不存在**——是 py 启动器的残留注册项。
- **解决**：不动注册表（避免影响其他项目）。真实解释器在 `D:\Code\PythonEvm312`（3.12.7）；全程用 `uv python pin 3.12` 让 uv 自管解释器，所有命令只写 `uv run`。
- **报告用法**：体现"环境不确定性下的工程化取舍"——不修全局环境，而是用工具链隔离，降低对他人机器的假设。

## P-002 · `.gitignore` 模式锚定导致 90MB 模型险些入库

- **现象**：写了 `resources/models/` 却**挡不住** `server/resources/models/`。
- **根因**：含中间斜杠的 pattern 会被锚定到 `.gitignore` 所在目录（仓库根），因此只匹配 `<root>/resources/models/`。
- **解决**：改成 `**/resources/models/`（前缀 `**/` 表示任意层级）。
- **报告用法**：小细节但体现工程严谨；也可作为"为什么要有 `.gitignore` 复验步骤"的例证。

## P-003 · HuggingFace 缓存 symlink 不可用（实际是好事）

- **现象**：下载模型时 HF 警告"machine does not support symlinks，caching works in degraded mode"。
- **根因**：Windows 未开开发者模式 / 非管理员，无法创建符号链接。
- **解决**：无需处理。**反而更有利**——模型落为实体文件，PyInstaller 打包时不会拿到断裂的软链。
- **报告用法**：若不处理会成为打包隐患，此处属"意外的正面结果"，可在"打包策略"里一笔带过。

## P-004 · `langgraph.__version__` 不存在

- **现象**：`getattr(langgraph, "__version__", "?")` 返回 `?`。
- **根因**：该包未在顶层暴露 `__version__` 属性。
- **解决**：统一用 `importlib.metadata.version("langgraph")` 取版本。
- **报告用法**：次要，属自检脚本健壮性问题。

## P-005 · `compile(checkpointer=...)` 与「一人一库」冲突（**预判，尚未踩到**）

- **现象**（预判）：若图只编译一次全局复用，则所有学生会写进同一个 checkpoint 库。
- **根因**：checkpointer 在 `compile()` 时被绑死到图实例上。
- **解决**：按 `student_id` 缓存已编译图（图结构静态，开销极小）；**不要**改用共享 DB + `thread_id` 前缀（会破坏"一人一库"合规叙事）。
- **报告用法**：**答辩必问点**，是"架构设计合理性"的加分项——说明我们对 LangGraph 内部机制有真实理解，而非照抄示例。

---

## P-006 · ★ PyInstaller 打包后中文变 GBK，且 `PYTHONUTF8` 完全失效（S01 实测）

- **现象**：开发态日志是正常 UTF-8 中文；**打包后**同一个 sidecar 的 stderr 输出变成 GBK 字节
  （`启动中` 从 UTF-8 的 `e5 90 af e5 8a a8 e4 b8 ad` 变成 GBK 的 `c6 f4 b6 af d6 d0`）。
  经 Electron 按 UTF-8 解码后写进日志文件 → 全行乱码；更糟的是握手 JSON 里的中文错误信息
  （如「拒绝绑定非回环地址」）可能直接 `UnicodeEncodeError` 崩在 `print` 上，
  表现为「sidecar 启动即失败且原因不可读」。
- **根因**：PyInstaller 的 bootloader 会设置 `Py_IgnoreEnvironmentFlag`，
  因此打包后的进程**完全忽略** `PYTHONUTF8` 与 `PYTHONIOENCODING`。
  实测打包产物：`sys.flags.utf8_mode = 0`、`sys.stdout.encoding = 'gbk'`，
  而 `os.environ` 里两个变量都已正确设置。**环境变量这条路在打包后是死的。**
- **解决**：在 Python 层显式 reconfigure —— 新增 `server/app/encoding.py`，
  在 `main.py` 最早期调用 `install_utf8_stdio()`：把 stdout/stderr `reconfigure(encoding="utf-8",
  errors="replace")`，并把 Windows 控制台代码页设为 65001（CP_UTF8）。
  同时给 `scripts/build_server.py` 加了**回归断言**：起一次打包产物，抓 stderr **原始字节**，
  要求它必须是合法 UTF-8 且能还原出「启动中」。
- **报告用法**：★ **本 Stage 最有价值的踩坑**。它直接修正了执行文档风险表 #3 的表述——
  原文只写「spawn 时传 env 即可」，实测证明**不够**：必须 Python 层兜底。
  可用来体现「文档结论经实测校验后才敢写进报告」，也说明我们真的跑过打包产物而非只跑源码。

## P-007 · PyInstaller 重打包时 `WinError 5 拒绝访问`

- **现象**：第二次打包失败：`PermissionError: [WinError 5] 拒绝访问。: '...\_internal\httptools\parser\parser.cp312-win_amd64.pyd'`。
- **根因**：上一步验证流程起过 sidecar，进程尚未退干净，Windows 仍持有产物里 `.pyd`/`.dll` 的映射；
  PyInstaller 清空 `dist/` 时会删不掉这些文件。
- **解决**：`scripts/build_server.py` 在打包前主动 `taskkill /IM k12-agent-server.exe /F`
  并等 1 秒释放句柄。把「开发者自己去猜」变成脚本自愈。
- **报告用法**：体现「把重复踩的坑变成工具约束」——与 P-006 的回归断言同属一条工程主线。

## P-008 · stdout 分片把握手 JSON 切成两半

- **现象**（潜在）：管道一次 `data` 事件给到的可能是**半行** JSON
  （`{"event":"rea` + `dy","port":8756}`），若直接 `JSON.parse` 必然 失败 → 启动流程整体卡死。
- **根因**：Node 的 stream `data` 事件按内核缓冲区边界切分，与 JSON 的边界无关。
- **解决**：`desktop/src/main/sidecar-logic.ts` 里的 `LineBuffer` 按 `\n` 切分并保留残余，
  跨 chunk 拼接后才交给 `JSON.parse`。并写了**逐字节喂入**的单测
  （最坏情况的流式切分）作为回归防护。
- **报告用法**：说明「进程间握手协议」这类底层代码是写测试的（而 GUI 部分靠端到端断言），
  体现测试投入的取舍判断。

---

# v2 待验清单（Pi Agent 迁移，2026-09-16 立项）

> **状态说明**：以下条目**多数尚未实测**，是「经一手资料核实、但尚未在本机跑通」的风险。
> **动手前先来这里看**，验完一条就把它改成正式编号（P-009 起），补上真实的「现象/根因/解决」。
> **不要把它们当成已解决的问题。**
>
> 已从一手产物核实的事实依据：npm tarball `@earendil-works/pi-coding-agent@0.85.1`
> 的 README / `docs/*.md`（30 篇）/ `dist/**/*.d.ts`、npm registry 元数据、GitHub REST API、`pi.dev` 服务端 HTML。

## P-101 · ★ Pi 的 `esbuild` 原生依赖在 Electron 打包后加载失败（**最高风险，D3 必验**）

- **现象**（据 Pi 官方 issue #9286，标题即「We embed the coding-agent SDK in an Electron desktop app」）：
  在 Electron 里 `import` Pi 包根后报 `Cannot find package 'esbuild'`（0.85.0 崩；
  0.85.1 靠下架实验代码缓解，但**包根导出仍会加载 CLI 的 `main.js`**）。
- **根因**：Pi 包的 `exports` **没有 `./sdk` 子路径**，只能从**包根**导入；
  包根 `dist/index.d.ts` 首行即 re-export CLI 的 `main`。
  而传递依赖 `@earendil-works/chord` 把 **`esbuild`（约 10MB 原生二进制）列为正式依赖**，
  需 asar 解包并按架构分发、参与签名。
- **解决方向（未验证）**：`electron-builder` 配置里对 `esbuild` 做 `asarUnpack` 白名单；
  实测 `npm run build:unpack` 后从产物启动。
  **Plan B：改用 Pi RPC 模式**（`pi --mode rpc` 作子进程，不 import SDK）——形成三进程但绕开该问题。
- **报告用法**：★ 「换框架的真实代价」——比只说收益可信得多。

## P-102 · Pi 要求 Node >= 22.19，Electron 33 内置 Node 不满足

- **现象**（待验）：`npm i` 或运行时报 `engines` 不满足 / 语法不支持。
- **根因**：Pi `engines.node >= 22.19.0`（0.75.0+ 起）；Electron 33 内置 Node 版本低于此。
- **解决方向**：① 升 Electron；② 降到 Pi `0.74.2`（npm 上的 `legacy-node20` tag，要求 >= 20.6）。
  **D3 首日验证，两个选项都能接受，不要在此纠结。**

## P-103 · `pi.on("session_end", ...)` 不生效（**事件名不存在**）

- **现象**（未实测，但已由一手来源确认）：按迁移提案写 `session_end` 钩子，**永远不触发**。
- **根因**：**该事件不存在**。全包 1056 文件 grep `session_end` = **0 命中**。
  真实终态钩子是 **`session_shutdown`**；一轮结束用 **`agent_end` / `agent_settled`**。
- **解决**：用正确事件名。学习记录 Extension 写「会话级摘要」应用 `session_shutdown`，
  写「一轮结果」应用 `agent_end`。
- **报告用法**：**引用第三方技术文档前先核对一手产物**的典型案例（对应 D-009）。

## P-104 · Pi 会话默认写到 `~/.pi/agent/`，导致跨学生数据混放（**合规硬伤**）

- **现象**（待验）：不配置 `agentDir` 时，Pi 默认落盘到
  `~/.pi/agent/sessions/--<cwd>--/<时间戳>_<uuid>.jsonl`。
  本项目多个学生共用同一 `cwd` → **所有学生的对话混在同一目录**。
- **根因**：Pi 的默认会话目录是全局的，与「一人一库」的设计不符。
- **解决方向**：显式配置 `DefaultResourceLoader({ agentDir })` 或 `settings.sessionDir`
  指向 `students/<id>/pi-agent/`；
  **并加自动化断言**：检测 `students/<id>/` 之外不得出现本应用的 `.jsonl`。
- **报告用法**：★ 「引入第三方运行时后，如何守住数据隔离这条合规底线」。

## P-105 · Pi 默认 System Prompt 泄漏宿主应用的安装路径

- **现象**（据 Pi 官方 issue #6308）：SDK 嵌入时，默认 system prompt 含宿主应用的安装路径，
  会误导模型，且属信息泄漏。
- **根因**：Pi 的默认 prompt 会描述运行环境。
- **解决**：**必须设 `systemPromptOverride`**（`DefaultResourceLoader({ systemPromptOverride })`）。
  顺带也满足本项目「System Prompt 禁止暴露内部实现」的自有规则。
- **报告用法**：说明「安全边界要在集成阶段就定义，不能等出问题再补」。

## P-106 · `tool_execution_end` 是只读通知，不能改工具结果

- **现象**（未实测，已由类型定义确认）：想用 `tool_execution_end` 回写「重试计数」或修正结果 → 做不到。
- **根因**：该事件的处理函数无返回值语义（通知型）；Pi 的可变更事件是
  `tool_call`（`{block, reason, terminate}` + 原地改 `event.input`）、`tool_result`、
  `context`、`message_end`、`before_provider_request`。
- **解决**：**动画重试逻辑写在 Tool 的 `execute()` 内部**（≤3 次后降级），不依赖事件回写。
  重试计数用 Extension 内的 `Map<toolCallId, number>`，与本轮同生命周期。
- **报告用法**：说明「框架的事件模型要先分清通知型与可变更型，否则设计会写歪」。

## P-107 · DeepSeek BaseURL 的 `/v1` 分歧（**现场防翻车**）

- **现象**（待验）：设置页默认能连通，用户改一下 BaseURL 就连不上。
- **根因**：Pi 内置 `deepseek` provider 的 `baseUrl` 是 **`https://api.deepseek.com`（无 `/v1`）**，
  而本项目前端默认值习惯写 `https://api.deepseek.com/v1`。
  两者都能用（`openai-completions` 会自行拼 `/chat/completions`），但**混用会让人困惑**。
- **解决**：统一默认值为 `https://api.deepseek.com/v1`，并在保存时做**真实连通性探测**
  （`GET /models` 或发一条 1-token 请求），把失败原因回显到设置页。
- **报告用法**：体现「自填配置」这类需求必须配连通性反馈，否则现场必翻车。

