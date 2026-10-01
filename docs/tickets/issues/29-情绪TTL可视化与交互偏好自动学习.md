# 29 — 情绪 TTL 可视化 + 交互偏好自动学习（`tone` / `challenge_level`）

**What to build:** 两件 v2 档的事 ——
① **情绪 TTL 可视化**：标签卡展示短期情绪标签（`emotion` / `intensity` / `trigger`）时，
把「它随时会过期」这件事做成可见的只读信息；过期即**从界面消失**（不是灰态、不是降权）。
② **交互偏好自动学习**：从行为观察更新 `tone` / `challenge_level`（`source=observed`，低置信度起步），
每个标签可一键撤销。

**Blocked by:** 26（对话式五问）、27（AI 判定注入画像 —— 需要投影面与 persona 管线已定）

**Status:** ready-for-agent

## ① 情绪 TTL 可视化

- [ ] 标签卡对 `EPHEMERAL_TAGS` 三个键显示只读的过期口径（例如「3 轮内有效」），**不显示倒计时压力**；
  文案走 `@shared/profile-tags` 的中文常量，组件里不另写一份映射
- [ ] ★ **过期即消失**：调 `/api/profile/{sid}/tags` 返回的 `tags` 已按 TTL 过滤（G-E），
  UI 不许把过期标签画成灰态或「已过期」—— 「读不到」是红线实现，不是展示问题
- [ ] 学生面不得出现技术词 / 内部 id / 字段名（双视角纪律 D-063）；`emotion` 用 `EMOTION_LABELS` 的中文
- [ ] 心理诊断红线（禁做 #12）：界面不出现「诊断」「症状」「评估」这类临床措辞，只有「最近的心情」这种日常说法

## ② 交互偏好自动学习

- [ ] `tone` / `challenge_level` 可由行为观察写入（`source=observed`，置信度从低起步），
  写入前过 `isLlmVisibleTag`（守卫 G-A）
- [ ] ★ **L3 不写 L1**：自动学习**只能**动白名单内的风格 / 交互类键，绝不许写 `grade_band` / `mastery` /
  `knowledge_point` / `error_type` 这类客观量（`source=inferred` 的允许集合见后端 `INFERRED_ALLOWED_TAG_KEYS`，禁做 #10）
- [ ] 每个自动学到的标签带**来源与置信度**，界面看得见「这是猜的，x%」
- [ ] ★ **一键撤销**：`DELETE /api/profile/{sid}/tags/{key}` → 回最新 `ProfileTagsOut`；撤销后该标签不再出现
  （撤销是信任基础，不是附加功能）
- [ ] `memory_switch=0` 时**不写任何标签**（G-F，闸在后端写原语）；`parent_consent=0` 时前端读不到画像（G-G）
- [ ] 验收：连续 N 轮同向行为观察后 `tone` 变化可复现；过期情绪标签在 API 与 UI 两侧都读不到；
  撤销后同一行为不再把它自动写回来

## 进度

- **2026-09-28**：地基（票 25）已提供 `EPHEMERAL_TAGS` / `EMOTION_LABELS` / `ProfileTagOut.confidence` /
  `source` 与撤销端点所需的契约面；票 26/27 的数据管线落定后本票即可开工。
- 风险：自动学习最容易滑成「系统替学生下结论」——所有写入必须是 `observed` 且可撤销，
  绝不覆盖学生 `declared` 的值（D-020 的教训）。
