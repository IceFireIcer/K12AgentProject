"""路由层（**只做 HTTP 边界**：解析请求、校验、调服务、序列化响应）。

业务规则不写在这里 —— 数据/检索在 `app/rag`、`app/store`，学段规则在 `app/grade`。
所有出参都必须是 `app/contracts.py` 里的契约模型（camelCase 由 pydantic alias 统一转）。

| 路由 | 落地票 | 状态 |
| --- | --- | --- |
| `health` | 票 01 | 已落地 |
| `settings` | 票 04 契约 + 掩码语义 / 票 07 落盘与探测 | 契约已冻结，探测返回 501 |
| `students` | 票 04 契约 / 票 09 一人一库落盘 | 契约已冻结，存储为占位实现 |
| `profile` | 票 20 | 待落地 |
| `rag` | 票 11 | 待落地 |
| `graph` | 票 12 | 待落地 |
| `quiz` | 票 14 / 票 15 | 待落地 |
| `code` | 票 19 | 待落地 |
| `grade` | 票 21 | 待落地 |
| `resources`（动画 HTML + nonce） | 票 16 | 待落地 |
"""
