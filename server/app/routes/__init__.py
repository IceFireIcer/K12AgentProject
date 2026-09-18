"""路由层（**只做 HTTP 边界**：解析请求、校验、调服务、序列化响应）。

业务规则不写在这里 —— 数据/检索在 `app/rag`、`app/store`，学段规则在 `app/grade`。
所有出参都必须是 `app/contracts.py` 里的契约模型（camelCase 由 pydantic alias 统一转）。

| 路由 | 落地票 | 状态 |
| --- | --- | --- |
| `health` | 票 01 | 已落地 |
| `settings` | 票 04 契约 + 掩码语义 / 票 07 落盘与探测 | 已落地（探测与拉取模型均可用，不再返回 501） |
| `students` | 票 04 契约 / 票 09 一人一库落盘 | 已落地（`LearningDbStudentStore`，内存实现只在无 `--data-dir` 时兜底） |
| `profile` | 票 20 | 已落地 |
| `rag` | 票 11 | 已落地 |
| `graph` | 票 12 | 已落地 |
| `quiz` | 票 14 / 票 15 | 已落地 |
| `code` | 票 19 | 已落地 |
| `grade` | 票 21 | 已落地 |
| `resources`（动画 HTML + nonce） | 票 16 | 已落地 |
| `safety` / `animation` | 票 16 / 票 22 | 已落地 |

★ **拿不准某个路由「落地没有」时以 `app/main.py` 的 `include_router` 与对应测试为准**，
不要照抄本表的历史括注（这张表漂移过一次：settings 的 501 与 students 的「占位实现」
都早已被真实实现取代，却还挂在上面）。
"""
