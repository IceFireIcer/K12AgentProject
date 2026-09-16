# 11 — RAG 四级降级链 + 学段隔离

**What to build:** `POST /api/rag/search` 在 Python 侧**一次调用内**完成四级降级（vector → cloud → FTS5 → 依赖图/大纲），并在 SQL 层强制学段隔离、向上兼容时标 `compat`，结果带 `degraded` 字段。为什么在这个顺序：10 已把 chunk/向量/FTS5 入库、04 已冻结 `Citation` 契约，本票才谈得上检索；它是**关卡 C**，也是 12（依赖图）与 13（`rag_search` Tool）的前置。**编排层不得感知降级过程**（否则 TS 要重复实现一遍）。

**Blocked by:** 10 教材骨架四学段 + 分块入库、04 契约冻结 + OpenAPI→TS 防漂移链

**Status:** ready-for-agent

- [ ] `server/app/routes/rag.py` + `server/app/rag/{retriever,fallback}.py`：`POST /api/rag/search` 入参含 `grade_level`，返回 `Citation[]`；**降级链整条留在 Python 侧一次调用内完成**，TS 只读结果里的 `degraded`
- [ ] 主路径：fastembed 查询向量 + sqlite-vec KNN；加载方式固定为 `enable_load_extension(True)` → `sqlite_vec.load(conn)` → `enable_load_extension(False)`
- [ ] **学段过滤写在 SQL 层**（`WHERE grade_level = :grade`；向上兼容时显式放开条件并在结果标 `compat=true`）——**只在应用层筛会被 KNN top-k 提前截断，等于没隔离**
- [ ] 四级降级：`vector` → `cloud`（用户自填云端 embedding API，`EmbeddingConfig.mode=cloud_api`）→ `fts`（FTS5 trigram 关键词）→ `outline`（依赖图 + 章节大纲直接注入）；结果带 `degraded: "vector" | "cloud" | "fts" | "outline"`
- [ ] 第 1 级内的子兜底：sqlite-vec 加载失败时走 numpy 暴力余弦（数千 chunk 毫秒级，可接受），同样计入 `degraded="vector"`
- [ ] 父子 chunk 生效：命中子块后经 `parent_chunk_id` 取父块，**注入 LLM 上下文的是父块完整内容而非碎片**
- [ ] 检索延迟**百毫秒级**：记录实测数值（写入票尾 `## 进度`），超标就查索引与向量加载
- [ ] ★ **关卡 C（学段隔离）**：构造一个高中专有名词的查询、以初中学段发出，断言返回结果 `gradeLevel` **不含 `senior`**；再构造向上兼容查询，命中时 `compat=true`
- [ ] ★ **关卡 C（降级可触发）**：① 把 `server/resources/models/fastembed/` 改名 → 自动降级 FTS5 仍能检索；② 注释掉 `sqlite_vec.load` → numpy 兜底仍能检索；③ 断网 + 无云端配置 → 走到 `outline`；三个实验各留一份结果记录（**每一级都要能现场演示**）
- [ ] `server/scripts/smoke_api.py` 增加检索用例；`server/tests/` 增加「学段泄漏」回归用例（初中查询断言结果集无 senior chunk）
- [ ] `degraded` 与 `compat` 落到 `Citation` 出参里（13 的 `citation` 事件与轨迹图要用）
- [ ] 提交一次 + 报告素材一条：降级链的现场演示方式（改名/注释两招）

> **关卡 C 判据**：初中提问不返回高中内容、向上兼容带 `compat`；四级降级链逐级可触发并带 `degraded`。**关卡不过，不进下一阶段**（13 与 15 不得开工）。

## 进度

（在此记录关键决策与踩坑）
