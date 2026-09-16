# 11 — RAG 检索 + 四级降级链（关卡 C）

**What to build:** 学生提问能命中教材内容、回答有据可依，且**检索结果绝不跨学段泄漏**；即便本地模型或向量扩展失效，检索链也能降级并继续工作。这是**关卡 C**：检索跑不通就要提前启用 FTS5 降级链。

**Blocked by:** 10 — 教材骨架 + 分块入库；07 — 主 Agent + 6 个 Extension 骨架 + rag_search→citation

**Status:** ready-for-agent

- [ ] 主路径：fastembed 本地嵌入 → sqlite-vec KNN
- [ ] **学段过滤必须写在 SQL 层**（不能只在应用层筛，否则早被 KNN top-k 截断）
- [ ] 允许向上兼容但命中后必须标 `compat=true`，且前端有标注
- [ ] 命中子 chunk 后经 `parent_chunk_id` 取父块作上下文注入
- [ ] **四级降级链在 Python 侧一次调用内完成**：vector → cloud → FTS5(trigram) → 依赖图/大纲；**不要让编排层感知降级**
- [ ] FTS5 必须 `tokenize='trigram'`（默认分词器不支持中文）
- [ ] `sqlite-vec` 加载走 `enable_load_extension(True)` → `sqlite_vec.load(conn)` → 立刻 `(False)`；失败回退 FTS5 / numpy 暴力余弦
- [ ] 结果带 `degraded: "vector"|"cloud"|"fts"|"outline"` 供轨迹图展示
- [ ] **可现场演示降级**：把模型目录改名仍能检索；注释掉 `sqlite_vec.load` 仍能检索
- [ ] 检索延迟百毫秒级；维度 512 写在配置常量，不散落硬编码

## 进度

（在此记录关键决策与踩坑）
