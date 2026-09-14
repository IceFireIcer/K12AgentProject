# Stage 08 · 练习 SubAgent + 出题批改

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D8** |
| 关卡 | —（关卡 D 的前半） |
| 前置 | S04 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

实现**出题 + 批改**的基本能力：预置题库优先，LLM 变式补充；客观题走规则判分，主观题走 LLM 判分。

---

## 2. 任务清单

### 2.1 题库

- [ ] `server/resources/quiz-bank/*.json`：按 `kp_id` 组织的预置题库
- [ ] 题型：**选择题 `choice` / 填空题 `blank` / 代码填空题 `code_blank`**
- [ ] 题量：每学段核心知识点至少 2–3 题

### 2.2 出题

- [ ] `app/agents/quiz_agent/gen.py`：
  - [ ] 先查题库（`QuizPayload.source='bank'`）
  - [ ] 未命中 → LLM 生成变式（`source='generated'`）
  - [ ] 输出严格 JSON，失败重试/兜底
- [ ] `quiz_gen` 节点接入 graph

### 2.3 批改

- [ ] `app/agents/quiz_agent/grade.py`：
  - [ ] 客观题：规则判分（`scored_by='rule'`），归一化（去空格/大小写/全半角）
  - [ ] 主观题：LLM 判分（`scored_by='llm'`），要求输出 JSON（correct + feedback）
  - [ ] 计算 `mastery_delta`
- [ ] `POST /api/quiz/grade` 端点

### 2.4 掌握度落库

- [ ] 批改后更新 `mastery` 表（score / attempts / correct / last_seen_at）
- [ ] 写 `learning_history`（activity='quiz'）

---

## 3. 验收标准（DoD）

- [ ] 请求出题 → 返回结构合法的 `QuizPayload`
- [ ] 选择题答对/答错都能正确判分，反馈文案是**面向学生的中文**
- [ ] 代码填空题能做基本的归一化判分（空白/引号差异不应误判）
- [ ] 掌握度随答题变化，且**写进了 student 库**（可查表验证）
- [ ] 断网时 LLM 生成不可用 → 题库兜底仍能出题（不崩）

---

## 4. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **LLM 出题 JSON 不合法** | 用 pydantic 校验 + 重试；失败则退回题库。 |
| 2 | 客观题误判 | 归一化要做：trim / 全角转半角 / 大小写 / 中英文标点。 |
| 3 | **答案泄漏** | 发给前端的 `QuizQuestion` **绝不能带 `answer`**；判分只走后端。 |
| 4 | 题面超纲 | 生成时把学段写进 prompt，并在校验层检查术语难度。 |
| 5 | LLM 判分不稳定 | 同一答案多次判分结果漂移 → prompt 里给评分细则与示例。 |
| 6 | 掌握度过冲 | `mastery_delta` 要限幅（如 ±0.2），否则一次答题就从 0 到 1。 |

---

## 5. 产出记录

| 项 | 结果 |
| --- | --- |
| 题库题量 | （待填） |
| 生成→判分闭环验证 | （待填） |
| 踩坑 | （待填） |
