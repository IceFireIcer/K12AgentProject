"""SQLite 数据层：连接、迁移器、仓储（票 10 已落地）。

| 模块 | 职责 |
| --- | --- |
| ``connections.py`` | 连接工厂；``sqlite-vec`` 按 ``enable_load_extension(True)`` → ``sqlite_vec.load`` → ``False`` 加载 |
| ``migrations.py`` | ``schema_version`` + 幂等迁移器（**不用 Alembic**：本地 SQLite、一人一库、随包分发）；kb / learning 两套 DDL |
| ``kb.py`` | ``kb.sqlite``（全局只读）仓储：chunk / 向量 BLOB / FTS5 / 知识点 / 依赖边 |
| ``learning.py`` | ``learning.db``（**每人一份**）仓储：画像 / 掌握度 / 学习历史 / 学段信号 |

**三处存储的边界**（执行文档 §8.1）：
教材 chunk / 依赖图 / 题库 → ``kb.sqlite``；画像 / 掌握度 / 学习历史 → ``learning.db``；
**对话正文归 Pi 的 JSONL 会话树，SQLite 不存对话内容**。

**扩展其他轨道请注意**：新表请在 ``migrations.py`` 里加一条 ``Migration``，
用 ``ensure_migrated(conn, [...], set_name="<你的轨道>")`` 记账，
不要另起一套 ``CREATE TABLE``、也不要改已发布的那条迁移。

两条**跨模块**的纪律（踩过坑，改这些文件前先读）：

1. **迁移里不许用 ``conn.executescript``**：它会隐式 COMMIT，让「失败整体回滚」
   变成假的（半应用 + 不记账）。多条 SQL 用 ``migrations.execute_script``。
2. 连接上统一开了 ``PRAGMA foreign_keys = ON``（见 ``connections.connect``），
   所以 ``REFERENCES`` 是真的在生效：**清表顺序必须先引用方后被引用方**
   （``knowledge_dependencies`` → ``kp``），悬空 kp_id 会在写入时直接报错而不是静默入库。
"""
