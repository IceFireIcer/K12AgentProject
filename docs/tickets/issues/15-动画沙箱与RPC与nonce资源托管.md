# 15 — 动画沙箱 + RPC + nonce 资源托管

**What to build:** 抽象概念能被播放成受控动画——能播放/暂停/重播、能收到进度回调，且动画代码被严格关在沙箱里。本票先解决**沙箱与通道**，生成质量留给下一票。

**Blocked by:** 07 — 主 Agent + 6 个 Extension 骨架 + rag_search→citation

**Status:** ready-for-agent

- [ ] `<iframe sandbox="allow-scripts">` —— **绝对不加 `allow-same-origin`**，否则沙箱形同虚设
- [ ] **可现场演示**：沙箱内无法访问宿主 DOM / `localStorage` / 网络
- [ ] RPC 指令：`play` / `pause` / `replay` / `ready` / `progress` / `error` / `timeout`，全走 `postMessage`
- [ ] 消息必须**校验 `payload_id`**，否则多卡片串台；来源校验不可省
- [ ] **页面 5s 内无 `ready` 判定超时**；进度回调节流到 ~10Hz（高频会卡）
- [ ] 动画库 **Anime.js v3（锁 v3）** 必须**内联进 HTML**，不得引用 CDN（沙箱断网会白屏）
- [ ] 动画 HTML 由 Python sidecar 托管，**按学生分目录**
- [ ] ⚠️ iframe 带不了自定义 header：该路由**不走 `X-Auth-Token`**，改用**一次性 nonce**（绑定 student_id + kp_id + 有效期），并设 `Cache-Control: no-store`
- [ ] **不允许**把该路由做成无鉴权公开路由

## 进度

（在此记录关键决策与踩坑）
