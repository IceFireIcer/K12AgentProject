# 16 — 动画沙箱 + RPC 协议 + nonce 资源托管

**What to build:** 做一个「能被人控制、又拿不到宿主权限」的动画沙箱：`<iframe sandbox="allow-scripts">`（绝无 `allow-same-origin`）、Anime.js v3 内联进 HTML、postMessage RPC（播放/暂停/重播/进度/超时）带 `payload_id` 校验与 ~10Hz 节流；动画 HTML 由 Python sidecar 按学生分目录托管，用**一次性 nonce**（绑定 student_id + kp_id + 有效期）放行——因为 iframe 带不了自定义 header，但**不许把它降级成无鉴权的公开路由**。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）

**Status:** ready-for-agent

- [ ] `desktop/src/renderer/src/sandbox/iframe-host.ts` 创建的 iframe 属性为 `sandbox="allow-scripts"`；`desktop/tests/` 的架构守卫测试断言生产代码中**不出现** `allow-same-origin`（陷阱：沙箱失效）
- [ ] Anime.js 锁 `^3.2`：`npm ls animejs` 输出 3.2.x，`package.json` 无 v4 允许范围（陷阱：Anime.js 版本误升）
- [ ] RPC 指令覆盖 `play` / `pause` / `replay` / `ready` / `progress` / `error` / `timeout`，宿主→iframe 与 iframe→宿主两侧都有 handler，指令名与业务陷阱清单第 6 节一致
- [ ] 每条 postMessage 带 `payload_id`，宿主侧校验不匹配即丢弃；**多卡片串台测试**：同屏并排两张动画卡片交替播放，进度互不污染（录屏或两张截图留证）
- [ ] 进度回调节流到 ~10Hz：写一条计数断言（1 秒内收到的 `progress` 消息 ≤ 12 条），实测数值记入票尾
- [ ] 5s 内未收到 `ready` → 判超时，宿主发 `timeout` 并显示降级提示，界面不白屏
- [ ] 资源路由 `GET /resources/animation/{student_id}/{kp_id}?nonce=...` 落在 `server/app/routes/resources.py`：nonce **一次性**、绑定 `student_id + kp_id + 有效期`，校验失败返回 403；**反向用例写死**：无 nonce / 复用已消费的 nonce / 过期 nonce 三种情形均被拒
- [ ] 该路由响应头含 `Cache-Control: no-store`；动画产物落 `students/<id>/animations/`，按学生分目录（跨学生不可互取，用一个反向用例验证）
- [ ] 沙箱强度现场可演示（陷阱：沙箱形同虚设）：iframe 内尝试 `parent.document`、`localStorage`、`fetch("http://127.0.0.1:8756/...")` 三者均抛错，把三条报错截图留档
- [ ] 动画 HTML **零外部引用**：`grep -Ei "https?://|//cdn|unpkg|jsdelivr"` 对生成的 HTML 零命中（沙箱断网不白屏）
- [ ] 动画卡片（`desktop/src/renderer/src/cards/` 内）支持内联展示 + 展开/全屏，播放/暂停/重播按钮可用
- [ ] `npm run typecheck` 与契约 `--check` 通过

## 进度

（在此记录关键决策与踩坑）
