"""SQLite 数据层：连接、迁移器、仓储。

**规划（落地票见括号）**：

- ``connections.py``：连接工厂。必须显式完成
  ``enable_load_extension(True)`` → ``sqlite_vec.load(conn)`` → ``enable_load_extension(False)``。
- ``migrations.py``：``schema_version`` + 幂等迁移器（票 10）。
  **不用 Alembic**：本地 SQLite、一人一库、随包分发，迁移器只要能把库建出来并幂等重跑即可。
- 仓储：``kb.sqlite``（全局只读）与 ``learning.db``（一人一份）分开。

**三处存储的边界**（执行文档 §8.1）：
教材 chunk / 依赖图 / 题库 → ``kb.sqlite``；画像 / 掌握度 / 学习历史 → ``learning.db``；
**对话正文归 Pi 的 JSONL 会话树，SQLite 不存对话内容**。
"""
