# Stage 08 · 练习 Extension + 出题批改

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D8** |
| 关卡 | —（关卡 D 的前半） |
| 前置 | S04 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

出题 + 批改：预置题库优先，LLM 变式补充；客观题规则判分，主观题 LLM 判分。

## 2. 任务清单

### 2.1 题库

- [ ] `server/resources/quiz-bank/*.json`：按 `kp_id` 组织
- [ ] 题型：**选择题 `choice` / 填空题 `blank` / 代码填空题 `code_blank`**
      （拖拽排序、连线匹配属 **P1**）
- [ ] 题量：每学段核心知识点至少 2–3 题

### 2.2 出题（Pi 侧 Extension）

- [ ] 练习 Extension 注册 `generate_quiz` / `submit_quiz` / `generate_variants`
- [ ] 先查题库（`QuizPayload.source='bank'`）→ 未命中走 LLM 变式（`source='generated'`）
- [ ] 输出严格 JSON，**pydantic 校验 + 重试，失败退回题库**

### 2.3 批改（Python 侧）

- [ ] 客观题：规则判分（`scored_by='rule'`），**归一化**（trim / 全半角 / 大小写 / 中英标点）
- [ ] 主观题：LLM 判分（`scored_by='llm'`），prompt 里**给评分细则与示例**
- [ ] 计算 `mastery_delta`（**限幅 ±0.2**）
- [ ] `POST /api/quiz/grade` 端点

### 2.4 落库

- [ ] 更新 `mastery`（score / attempts / correct / last_seen_at）
- [ ] 写 `learning_history`（`activity='quiz'`，带 `session_id`）

## 3. 验收标准（DoD）

- [ ] 请求出题 → 返回结构合法的 `QuizPayload`
- [ ] 选择题答对/答错都能正确判分，反馈文案是**面向学生的中文**
- [ ] 代码填空题能做基本归一化判分（**空白/引号差异不应误判**）
- [ ] 掌握度随答题变化，且**写进了 `learning.db`**（可查表验证）
- [ ] **★ 发给前端的 `QuizQuestion` 不带 `answer`**（答案泄漏检查）
- [ ] **断网时 LLM 生成不可用 → 题库兜底仍能出题（不崩）**

## 4. 陷阱

**完整清单见 `docs/业务陷阱清单.md` 第 4 节**。要点：

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **★ 答案泄漏** | 发给前端的 `QuizQuestion` **绝不能带 `answer`**；判分只走后端。 |
| 2 | **LLM 出题 JSON 不合法** | pydantic 校验 + 重试；失败**退回题库**。 |
| 3 | 客观题误判 | 归一化四件套不能省。 |
| 4 | LLM 判分不稳定 | prompt 里给评分细则与示例。 |
| 5 | 掌握度过冲 | `mastery_delta` **限幅**。 |
| 6 | 题面超纲 | 学段写进 prompt + 校验层检查术语难度。 |

---

## 5. 产出记录

| 项 | 结果 |
| --- | --- |
| 题库题量 | （待填） |
| 生成→判分闭环验证 | （待填） |
| 踩坑 | （待填） |
