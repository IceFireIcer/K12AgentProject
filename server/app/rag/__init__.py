"""检索与嵌入（**降级链的唯一归属地**，票 10/11 已落地）。

| 模块 | 职责 |
| --- | --- |
| ``chunker.py`` | 节级 300–600 token 父块 + 检索用子块（父子两阶段检索） |
| ``embedder.py`` | fastembed 封装（``bge-small-zh-v1.5`` / 512 维 / CPU / 离线）；云端 embedding 作为降级级 2 |
| ``retriever.py`` | **唯一入口**：一次调用跑完四级降级 + 学段隔离 + 父子 chunk + 依赖图扩展 |
| ``fallback.py`` | FTS5(trigram) + numpy 暴力余弦 + 章节大纲兜底 |
| ``contracts_bridge.py`` | 契约取用桥（优先 ``app.contracts``，缺失时才用 ``_contract_fallback``） |

★ **四级降级链必须在本进程内一次调用完成**，结果里带
``degraded: "vector" | "cloud" | "fts" | "outline"``。
编排层（TypeScript）**只读这个字段，不感知降级过程** ——
否则同一套降级逻辑就要在两种语言里各写一遍（执行文档 §0.2）。

★ **学段隔离写在 SQL 的 WHERE 里**（``chunk_vec`` 的 ``grade_level`` 元数据列 + ``chunk`` 表的过滤）。
只在应用层筛是错的：KNN 的 top-k 截断发生在过滤之前，
初中生问高中专有名词时 top-k 会被高中内容占满，筛完可能一条不剩。
"""
