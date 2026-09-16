"""路由层（**只做 HTTP 边界**：解析请求、校验、调服务、序列化响应）。

业务规则不写在这里 —— 数据/检索在 `app/rag`、`app/store`，学段规则在 `app/grade`。

| 路由 | 落地票 |
| --- | --- |
| `health` | 票 01 |
| `settings` | 票 07 |
| `students` / `profile` | 票 09 / 票 20 |
| `rag` | 票 11 |
| `graph` | 票 12 |
| `quiz` | 票 14 / 票 15 |
| `code` | 票 19 |
| `grade` | 票 21 |
| `resources`（动画 HTML + nonce） | 票 16 |
"""
