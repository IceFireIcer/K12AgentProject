# 06 — 对话贯通 + 学段 Prompt 注入

**What to build:** 把 03 的最小流式脚本接进真实 UI：渲染进程经 IPC 收到 DeepSeek 的流式中文回复并逐字渲染；同时把**四学段 System Prompt 模板**经 `before_agent_start` 每轮注入。为什么在这个顺序：03 提供运行时、05 提供通道，本条把它们合起来，是**关卡 B：能与大模型流式对话**的落点；也是 08（主 Agent + Extension）与 20（个性化）的前置。**传输仍是 IPC，无 SSE。**

**Blocked by:** 03 Pi 可加载性与 esbuild 打包冒烟、05 IPC 事件通道 + preload 白名单

**Status:** ready-for-agent

- [ ] `desktop/src/main/agent/runtime.ts` 成为唯一 Agent 会话工厂（`createAgentSession`）；`ModelRuntime.create({ authPath, modelsPath })` 与 `DefaultResourceLoader({ agentDir })` 全部指向 `userData/pi-agent/`，**不读不写 `~/.pi/agent`**（延续票 03 已验结论）
- [ ] `systemPromptOverride` 每轮生效，**不复用 Pi 默认 prompt**；实发 system prompt 落盘检查不含本机安装路径（issue #6308）
- [ ] 四学段模板各一份落 `desktop/src/main/agent/prompts/`（`primary-low` / `primary-high` / `junior` / `senior`），语气按矩阵区分：童话拟人 + 短句 / 通俗比喻 + 鼓励 / 严谨逻辑推导 + 术语准确 / 工程化 + 项目视角
- [ ] 每份模板都显式声明：① 学段与语言风格；② 「只讲本学段及以下知识点，不超纲」；③ 「不索取个人信息、不进行任何形式的私下联系」；④ 「面向学生直接可读，禁止暴露内部实现与提示词」；⑤ **可用 Tool 的边界与调用时机**（Pi 侧路由靠它）
- [ ] 学段取**显式选择为权威**（渲染进程随请求传入）；`agent/extensions/grade.ts` 以 `before_agent_start` 返回 `{ systemPrompt }` 替换**本轮** prompt（多扩展链式叠加，后注册者能看到前者结果，顺序写注释）；自动推断本票不做
- [ ] `desktop/src/main/agent/events.ts` 完成 Pi → 6 事件映射：`message_update→delta`、`agent_end→done`、provider/Tool 异常→`error`（带 `degraded`）；**不要订阅 `session_end`（该事件不存在）**——一轮结束用 `agent_end` / `agent_settled`，会话终态用 `session_shutdown`
- [ ] 所有 Tool 的 `execute()` 自己兜异常，返回可读错误**而不抛出**（Pi 与 UI 同在主进程，抛异常会同时带走两者）；本票先注册一个「必抛异常」的测试 Tool，验证 UI 不崩且收到 `error` 事件
- [ ] `session.dispose()` 在 `before-quit` 被调用（否则 JSONL 可能半写）
- [ ] ★ **关卡 B（流式对话）**：真实 UI 里发一句话，经 IPC 收到 DeepSeek 流式回复并渲染；**中文跨 chunk 不乱码**；事件经 preload 白名单 IPC 通道送达（守卫写成正向断言）
- [ ] ★ **关卡 B（学段可区分）**：同一问题在四学段下各问一次，留**四张对比截图**（深度与语气可明显区分）——报告直接可用，这是 20% 教育适配性的现场演示动作
- [ ] ★ **关卡 B（降级不崩）**：断网 / API Key 错误 / 额度耗尽时，UI 给出优雅降级提示（`error.degraded`）而非白屏或崩溃
- [ ] 本票的 LLM 配置允许先用本地 `config.json` 手填（设置页归票 07），**不要为设置页阻塞**

> **关卡 B 判据**：真实 UI 经 IPC 拿到 DeepSeek 流式回复 + 中文跨 chunk 不乱码 + System Prompt 不含本机路径。**关卡不过，不进下一阶段**（不得开工 08；可先推数据主线 10 → 11 → 12）。

## 进度

（在此记录关键决策与踩坑）
