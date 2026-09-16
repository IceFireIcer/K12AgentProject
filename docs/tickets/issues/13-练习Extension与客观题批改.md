# 13 — 练习 Extension + 客观题批改

**What to build:** 学生能拿到练习、作答、立刻得到批改与讲解。第一期只做三类文本题型（选择 / 填空 / 代码填空），拖拽排序与连线匹配属 P1。

**Blocked by:** 07 — 主 Agent + 6 个 Extension 骨架 + rag_search→citation

**Status:** ready-for-agent

- [ ] 三个 Tool 可用：`generate_quiz` / `submit_quiz` / `generate_variants`，映射 `kind="quiz"`
- [ ] 题库结构落 `kb.sqlite`；LLM 变式生成以 `QuizPayload.source` 区分 `bank` / `generated`
- [ ] 题型仅 `choice` / `blank` / `code_blank`
- [ ] 客观题走规则判分（`scored_by='rule'`）；归一化做 trim / 全角转半角 / 大小写 / 中英文标点
- [ ] **★ `QuizQuestion` 下发前端时绝不能带 `answer`**，判分只走后端
- [ ] LLM 出题用 pydantic 校验 + 重试；失败则**退回题库**，不崩
- [ ] **断网时 LLM 生成不可用 → 题库兜底仍能出题**
- [ ] 反馈文案是**面向学生的中文**；掌握度变化写入学生库

## 进度

（在此记录关键决策与踩坑）
