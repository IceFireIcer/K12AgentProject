# Stage 10 · 动画 Extension + 沙箱 + RPC

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D10–D11** |
| 关卡 | —（**多模态质量 25% 的主力**） |
| 前置 | S04 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

生成**安全沙箱里运行的讲解动画**，支持播放/暂停/重播，**失败能自动重试并降级**。

## 2. 任务清单

### 2.1 沙箱宿主

- [ ] `desktop/src/renderer/sandbox/`：`<iframe sandbox="allow-scripts">`
      - [ ] **绝不加 `allow-same-origin`**（加了沙箱形同虚设）
- [ ] 宿主与 iframe 走 `postMessage`，消息带 `payload_id` **校验来源**
- [ ] 内联卡片 + 展开/全屏

### 2.2 RPC 协议

- [ ] 指令：`play` / `pause` / `replay` / `ready` / `progress` / `error` / `timeout`
- [ ] 超时取消（页面 **5s** 内无 `ready` 判定超时）
- [ ] **进度回调节流到 ~10Hz**（高频 postMessage 会卡）

### 2.3 生成策略（**模板优先，而非自由生成**）

- [ ] `server/resources/anim-templates/`：内置 **6–8 个高质量模板**
      （排序、神经网络、决策树、梯度下降、循环、变量）
- [ ] LLM 只做：**选模板 + 填参数 + 生成文案**
- [ ] 自由生成 HTML **仅作模板未命中时的补充路径**
- [ ] `AnimationPayload.source = template | generated`
- [ ] **动画库必须内联进 HTML**（沙箱断网会白屏，不能引 CDN）

### 2.4 容错与降级（**在 Tool 的 `execute()` 内部完成**）

- [ ] 校验：HTML 完整性、**无外部网络请求**、无 `allow-same-origin` 依赖
- [ ] 捕获错误 → **自动重试至多 3 次**（计数用 Extension 内 `Map<toolCallId, n>`）
- [ ] 3 次仍失败 → 降级：`fallback_text` + 静态 SVG（`fallback_image`）
- [ ] 界面**绝不白屏**

### 2.5 资源托管与鉴权（**v2 新增，安全要点**）

- [ ] `GET /resources/animation/{student_id}/{kp_id}` 由 Python sidecar 提供，**按学生分目录**
- [ ] **iframe 带不了自定义 header** → 用**一次性 nonce**（绑定 student_id + kp_id + 有效期）
- [ ] **不允许**把该路由做成无鉴权公开路由（否则本机任意进程可读学生数据）
- [ ] 响应设 `Cache-Control: no-store`

### 2.6 前端

- [ ] `cards/AnimationCard.vue`：播放/暂停/重播控件
- [ ] 降级时显示文字 + 静态图，并标注「已降级」

## 3. 验收标准（DoD）

- [ ] 请求「用动画讲排序」→ iframe 内动画正常播放
- [ ] 播放/暂停/重播可用；进度回调正常
- [ ] **人为注入错误**（模板里写个 `throw`）→ 观察自动重试，最终降级为文字+图，**界面不白屏**
- [ ] 沙箱内**无法访问宿主 DOM / `localStorage` / 网络**（**可现场演示**）
- [ ] 模板未命中场景也能有兜底输出
- [ ] **非授权 URL 访问动画资源被拒**（nonce 校验生效）

## 4. 陷阱

**完整清单见 `docs/业务陷阱清单.md` 第 6 节**。要点：

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **★ `allow-same-origin`** | 一旦加上，iframe 内代码可访问宿主，**沙箱失效。绝对不加。** |
| 2 | **Anime.js 版本** | 必须锁 **v3**（`^3.2`）。v4 API 不兼容，误升级会全挂。 |
| 3 | **模板内联 CDN** | 沙箱断网白屏 → 动画库**必须内联进 HTML**。 |
| 4 | postMessage 来源不校验 | 必须校验 `payload_id`，否则**多卡片串台**。 |
| 5 | 重试无上限 | **硬上限 3**，否则死循环烧 API 额度。 |
| 6 | **重试写错位置** | `tool_execution_end` **是只读通知**，不能回写 → 重试必须在 Tool 的 `execute()` 内部。 |

---

## 5. 产出记录

| 项 | 结果 |
| --- | --- |
| 模板数量 | （待填） |
| 自由生成成功率（实测） | （待填） |
| 降级演练结果 | （待填） |
