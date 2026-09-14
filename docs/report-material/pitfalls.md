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
