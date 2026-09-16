# 05 — 设置页接通 ModelRuntime + 连通性探测

**What to build:** 用户在设置页填入自己的供应商信息后，保存即生效、且能立刻知道填得对不对。赛题硬要求「供应商名称 / BaseURL / APIKey / ModelID 可自填」，而这里有一个**必然踩到的现场故障**：DeepSeek 官方 baseUrl 不带 `/v1`，而前端默认值习惯带 `/v1`。

**Blocked by:** 02 — Pi 可加载性 + 最小流式会话

**Status:** ready-for-agent

- [ ] 设置页的四项配置接通 `ModelRuntime`，自填后真实生效（不是只存进 config.json）
- [ ] **保存时做一次真实连通性探测**（`GET /models` 或发一条 1-token 请求），把失败原因回显到设置页
- [ ] 明确约定默认 BaseURL 形式，并处理「默认值能跑、用户改一下就连不上」的差异
- [ ] API Key **仅本地存储**，**不写入日志**；确认日志脱敏过滤器保留 `%s` / `%(name)s` 占位符（无脑擦除会抛 `TypeError`）
- [ ] 探测失败时 UI 给出可读提示，而非静默失败或崩溃

## 进度

（在此记录关键决策与踩坑）
