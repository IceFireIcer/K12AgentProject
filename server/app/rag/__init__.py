"""检索与嵌入（**降级链的唯一归属地**）。

**规划（落地票见括号）**：

- ``embedder.py``：fastembed 封装（票 11）。模型 ``BAAI/bge-small-zh-v1.5``，**512 维**，
  维度常量取 ``app/config.EMBEDDING_DIM``，不要就地写死。
- ``retriever.py``：sqlite-vec KNN + **学段隔离（过滤必须写在 SQL 层）** + 父子 chunk（票 11）。
- ``fallback.py``：FTS5（``tokenize='trigram'``，默认分词器不吃中文）+ numpy 暴力余弦兜底（票 11）。
- ``chunker.py``：节级 300–600 token 分块（票 10）。

★ **四级降级链必须在本进程内一次调用完成**，结果里带
``degraded: "vector" | "cloud" | "fts" | "outline"``。
编排层（TypeScript）**只读这个字段，不感知降级过程** ——
否则同一套降级逻辑就要在两种语言里各写一遍（执行文档 §0.2）。
"""
