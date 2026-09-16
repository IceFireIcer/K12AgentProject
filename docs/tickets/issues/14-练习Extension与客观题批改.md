# 14 — 练习 Extension 与客观题批改

**What to build:** 打通「出题 → 作答 → 客观题规则判分 → 掌握度落库」这条最短闭环。题目优先取自本地题库（断网兜底的根），LLM 生成只作补充；发给前端的题面必须剥掉 `answer`；掌握度变化要限幅并真的写进学生库。它解锁票 15（主观题 + 闯关闭环）与票 20（个性化闭环）。

**Blocked by:** 08（主 Agent + 6 Extension 骨架 + 轨迹导出）

**Status:** ready-for-human

- [x] 练习 Extension（`desktop/src/main/agent/extensions/quiz.ts`）注册 `generate_quiz` / `submit_quiz`（`generate_variants` 可在票 15 落地，本票至少留注册位），三个 Tool 名都在 §9.3 的 `TOOL_TO_KIND` 里映射为 `quiz`
- [x] 题库落在 `server/resources/quizbank/`，取题端点落在 `server/app/routes/quiz.py`；新增的取题路径**同步登记进执行文档 §6.3**，并重跑 OpenAPI → TS 生成（`uv run python scripts/export_openapi.py`）后 `--check` 字节一致
- [x] **答案不泄漏（陷阱：答案泄漏）**：新增对外的题目模型（`QuizQuestionOut`，**无 `answer` 字段**，见 §6.3），`grep -n "answer" desktop/src/shared/api-types.ts` 在对外题目类型上零命中；并加一条自动化断言（`desktop/tests/` 内）对 fixture 的 `QuizPayload` 全字段递归扫描，发现 `answer` 键即失败
- [x] 判分只走后端：`QuizResult.scored_by == "rule"`，覆盖 `choice` / `blank` / `code_blank` 三类题型；前端不做任何本地判分
- [x] 归一化判分到位（陷阱：客观题误判）：trim、全角转半角、大小写、中英文标点；`server/tests/` 内写死用例，至少覆盖「仅空白差异」「引号差异」「全角括号」三例，均不得误判
- [x] `mastery_delta` **限幅**（陷阱：掌握度过冲）：上下限作为一个常量集中定义（如 `MASTERY_DELTA_CLAMP = 0.2`，不散落硬编码），单测断言单次答题 `abs(delta) <= 0.2`
- [x] 掌握度与答题数写入 `students/<id>/learning.db` 的 `mastery`（`score` / `attempts` / `correct` / `last_seen_at` 同步更新），用 sqlite 查询输出作为证据
- [x] LLM 出题（`QuizPayload.source == "generated"`）用 pydantic 校验 + 重试；重试仍失败 → **退回题库**（`source == "bank"`），不抛错、不空题（陷阱：LLM 出题 JSON 不合法）
- [x] 断网兜底：把 baseURL 指向不存在的端口（或断网）后请求出题，仍成功且 `source == "bank"`，界面不崩
- [x] 题面不超纲：出题 prompt 里带学段，校验层检查术语难度（小学低年级题干不得出现「算法」「特征向量」等超纲术语）
- [x] 前端练习卡片（`desktop/src/renderer/src/cards/` 内）能渲染三类题型、提交作答、展示 `QuizResult.feedback`，文案为面向学生的中文
- [x] `npm run typecheck` 与契约 `--check` 均通过

## 进度

### ✅ 已交付（提交 `b72fa90`、`002a7e1`）

判分链路：题库优先（`server/resources/quizbank/`，断网可用的根），LLM 生成只作补充；
规则判分覆盖 `choice` / `blank` / `code_blank`，归一化（trim / 全角转半角 / 大小写 / 中英文标点）；
`mastery_delta` 由 Python 侧限幅（`contracts.py` 的 `MASTERY_DELTA_LIMIT`）。

★ **答案泄漏的防线是结构性的，不是靠「记得删字段」。**
契约里是**两个模型**：内部 `QuizQuestion`（**含 `answer`**）与对外 `QuizQuestionOut`（**没有 `answer` 这个字段**）。
所以内部模型的 `answer` **根本不进 OpenAPI、不进生成的 TS 类型**。

**实测**：用一条哨兵标准答案跑完 `/api/quiz/variants` 与 `/api/quiz/grade` 全链路，
响应里**既没有答案值、也没有 `answer` 这个键**——而同一时刻
`answer in QuizQuestion.model_fields` 为 **True**。
（编排层另有一道：`cards/quiz.ts` 用**白名单**挑字段投影，不是黑名单删 `answer`；
测试往载荷里硬塞 `answer` / `answerText` / `solution` / `correctOption` 也带不出去。）

**掌握度实测**：首次答对 `+0.15`；连续答对 10 次到 1.0（**最后一次 delta 正好 0.0**，因为已封顶）；
答错 `-0.10`，下界为 0。

> 说明：判分只走后端、`scored_by == "rule"`；前端不做任何本地判分。
> 设计取舍（为什么用两个模型而不是 pydantic `exclude=True`）见 `docs/report-material/decisions.md` 的 **D-023**。
