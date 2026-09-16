"""后端测试包。

运行方式（不要用裸 `python`）::

    cd server
    uv run python -m unittest discover -s tests -v

覆盖重点：
- **契约**：camelCase 出参、`extra="forbid"`、6 事件词表冻结（票 04 扩充）
- **鉴权与脱敏**：401 路径、日志脱敏不破坏 `%s` 占位符（票 02 / 票 22）
- **检索**：学段隔离写在 SQL 层、四级降级链、`compat` 标注（票 11）
- **依赖图**：环检测、悬空节点、`depth` 上限（票 12）
"""
