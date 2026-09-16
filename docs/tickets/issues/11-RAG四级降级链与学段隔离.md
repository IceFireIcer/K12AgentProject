# 11 — RAG 四级降级链 + 学段隔离

**What to build:** `POST /api/rag/search` 在 Python 侧**一次调用内**完成四级降级（vector → cloud → FTS5 → 依赖图/大纲），并在 SQL 层强制学段隔离、向上兼容时标 `compat`，结果带 `degraded` 字段。为什么在这个顺序：10 已把 chunk/向量/FTS5 入库、04 已冻结 `Citation` 契约，本票才谈得上检索；它是**关卡 C**，也是 12（依赖图）与 13（`rag_search` Tool）的前置。**编排层不得感知降级过程**（否则 TS 要重复实现一遍）。

**Blocked by:** 10 教材骨架四学段 + 分块入库、04 契约冻结 + OpenAPI→TS 防漂移链

**Status:** ready-for-human

- [x] `server/app/routes/rag.py` + `server/app/rag/{retriever,fallback}.py`：`POST /api/rag/search` 入参含 `grade_level`，返回 `Citation[]`；**降级链整条留在 Python 侧一次调用内完成**，TS 只读结果里的 `degraded`
- [x] 主路径：fastembed 查询向量 + sqlite-vec KNN；加载方式固定为 `enable_load_extension(True)` → `sqlite_vec.load(conn)` → `enable_load_extension(False)`
- [x] **学段过滤写在 SQL 层**（`WHERE grade_level = :grade`；向上兼容时显式放开条件并在结果标 `compat=true`）——**只在应用层筛会被 KNN top-k 提前截断，等于没隔离**
- [x] 四级降级：`vector` → `cloud`（用户自填云端 embedding API，`EmbeddingConfig.mode=cloud_api`）→ `fts`（FTS5 trigram 关键词）→ `outline`（依赖图 + 章节大纲直接注入）；结果带 `degraded: "vector" | "cloud" | "fts" | "outline"`
- [x] 第 1 级内的子兜底：sqlite-vec 加载失败时走 numpy 暴力余弦（数千 chunk 毫秒级，可接受），同样计入 `degraded="vector"`
- [x] 父子 chunk 生效：命中子块后经 `parent_chunk_id` 取父块，**注入 LLM 上下文的是父块完整内容而非碎片**
- [x] 检索延迟**百毫秒级**：记录实测数值（写入票尾 `## 进度`），超标就查索引与向量加载
- [x] ★ **关卡 C（学段隔离）**：构造一个高中专有名词的查询、以初中学段发出，断言返回结果 `gradeLevel` **不含 `senior`**；再构造向上兼容查询，命中时 `compat=true`
- [x] ★ **关卡 C（降级可触发）**：① 把 `server/resources/models/fastembed/` 改名 → 自动降级 FTS5 仍能检索；② 注释掉 `sqlite_vec.load` → numpy 兜底仍能检索；③ 断网 + 无云端配置 → 走到 `outline`；三个实验各留一份结果记录（**每一级都要能现场演示**）
- [x] `server/scripts/smoke_api.py` 增加检索用例；`server/tests/` 增加「学段泄漏」回归用例（初中查询断言结果集无 senior chunk）
- [x] `degraded` 与 `compat` 落到 `Citation` 出参里（13 的 `citation` 事件与轨迹图要用）
- [x] 提交一次 + 报告素材一条：降级链的现场演示方式（改名/注释两招）

> **关卡 C 判据**：初中提问不返回高中内容、向上兼容带 `compat`；四级降级链逐级可触发并带 `degraded`。**关卡不过，不进下一阶段**（13 与 15 不得开工）。

## 进度

### ✅ 关卡 C 通过

**单入口** `RagService.search()`：vector → cloud → fts → outline **在一次调用内完成**，
调用方只读 `degraded` 字段，不感知降级过程（执行文档 §0.2 的边界规则）。

★ **学段隔离写在 SQL 的 `WHERE` 里**——这是对 §8.3 DDL 的一处**有意偏离**：
`chunk_vec` 建为 `vec0(embedding float[512], grade_level TEXT)`，多带一个元数据列。
原因：sqlite-vec 在 KNN **内部**应用该过滤，而 JOIN 过滤发生在 top-k 截断**之后**
—— 后者正是「学段泄漏」陷阱的成因。

**关卡 C 判据实测**（真模型、真 kb.sqlite）：

| 提问学段 | 返回的学段集合 | 是否返回更高学段 |
| --- | --- | --- |
| primary_low | `[primary_low]` | 否 ✓ |
| primary_high | `[primary_high, primary_low]` | 否 ✓ |
| junior | `[junior, primary_high, primary_low]`（跨学段项 `compat=True`） | 否 ✓ |
| senior | `[junior, senior]` | 否 ✓ |

**四级降级链逐级实测**：① sqlite-vec 加载失败 → 仍 `degraded=vector`（numpy 暴力余弦兜底）；
② 模型目录不可用 → `degraded=fts`（FTS5 trigram，**中文整句提问也命中**）；
③ 再叠加关键词查不到 → `degraded=outline`。检索耗时 9–11ms。

**三个被实测抓出并修掉的 bug**（都有回归测试）：outline 上下文按 `grade_level`
**字母序**排（导致初中生先拿到小学内容）；中文整句找不到 n-gram 使 FTS 层空转；
FTS 接受「只匹配一个片段」的命中（现要求约 1/3 词覆盖，否则老实降到 outline）。

> ⚠️ **与契约侧的一处语义需对齐**：`Citation.compat` 的文档措辞是「取用了更高学段内容」，
> 但本实现**永不返回更高学段**；`compat=True` 的实际含义是「用到了**更低**学段内容」
> （关卡 C 要求「初中提问不得返回高中内容」）。若要真做向上泄漏需新增标志并做产品决策。

