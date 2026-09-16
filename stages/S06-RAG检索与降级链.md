# Stage 06 · RAG 检索层 + 四级降级链

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D6** |
| 关卡 | ✅ **关卡 C：RAG 检索正确且学段隔离（最高风险）** |
| 前置 | S05 |
| 状态 | ⬜ 未开始 |
| 备注 | **全在 Python 侧，与 Pi 解耦** —— Pi 集成受阻时**本 Stage 可继续推进** |

---

## 1. 目标

把 S05 的教材变成**可检索的向量库**，并把**降级链**做实。

## 2. 任务清单

### 2.1 分块与索引

- [ ] `app/rag/chunker.py`：Markdown → 父子 chunk（节级 300–600 token；子块做 embedding）
- [ ] `scripts/build_index.py`：分块 → 嵌入 → 写 `chunk` / `chunk_vec` / `chunk_fts`
- [ ] **维度写成配置常量**（`EMBED_DIM = 512`），不散落硬编码
- [ ] **建索引脚本要幂等**（先清表再写，否则调试时数据翻倍）

### 2.2 检索

- [ ] `app/rag/retriever.py`：sqlite-vec KNN + **学段隔离（写在 SQL 层）** + 父子 chunk
- [ ] `app/rag/fallback.py`：云端 Embedding → **FTS5(trigram)** → 依赖图/大纲 → numpy 暴力余弦
- [ ] **降级链在一次调用内完成**，结果带 `degraded: "vector" | "cloud" | "fts" | "outline"`

### 2.3 接入（**v2 形态**）

- [ ] `POST /api/rag/search` 端点（供 Pi 的 `rag_search` Tool 调用）
- [ ] 返回 `Citation[]`（带 `chunkId`/`chapterTitle`/`gradeLevel`/`compat`/`degraded`）
- [ ] 前端对话里显示引用来源卡片

## 3. 降级链（必须逐级可现场演示）

```
学生提问
  → 学段确定（显式选择优先，否则用画像中的推断值）
  → [1] 主路径：fastembed 本地向量 → sqlite-vec KNN（学段约束）
  → [2] 降级1：云端 Embedding API（若用户自填）
  → [3] 降级2：FTS5(trigram) 关键词检索   ← 必须实现，永不失败
  → [4] 兜底：依赖图 + 章节大纲注入
  → 命中子 chunk → 取父块 → 注入 LLM
```

> **降级链必须留在 Python 侧**（一次调用内完成四级降级），**不要让编排层感知降级** ——
> 否则 TS 侧要重复实现一遍同样的逻辑。

## 4. 验收标准（DoD / 关卡 C）

- [ ] 提问能命中相关 chunk，回答里体现教材内容
- [ ] **学段隔离可验证**：初中提问不返回高中 chunk；向上兼容命中时 `compat=true` **且前端有标注**
- [ ] **父子 chunk 生效**：注入的是父块完整内容而非碎片
- [ ] **降级链可现场演示**：
      - [ ] 把模型目录改名 → 自动降级 FTS5，仍能检索
      - [ ] 注释掉 `sqlite_vec.load` → numpy 暴力余弦兜底，仍能检索
- [ ] 检索延迟**百毫秒级**

## 5. 陷阱

**完整清单见 `docs/业务陷阱清单.md` 第 2 节**。要点：

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **FTS5 中文分词** | 默认分词器不支持中文，**必须 `tokenize='trigram'`**。 |
| 2 | **`chunk_vec` 与 `chunk` 行号错位** | `vec0` 的 rowid 必须与 `chunk.rowid` 对齐，否则**结果张冠李戴**。写入时显式用 `chunk.rowid`。 |
| 3 | **学段泄漏** | 过滤必须写在 **SQL 层**，应用层筛会被 KNN top-k 提前截断。 |
| 4 | embedding BLOB 端序 | `Float32Array` 注意 `dtype='<f4'` **小端一致**。 |
| 5 | sqlite-vec 加载三连 | `enable_load_extension(True)` → `sqlite_vec.load(conn)` → `enable_load_extension(False)`。 |
| 6 | 维度硬编码 | 512 集中成常量；升级需**同步改 `vec0` 维度并重建索引**。 |

---

## 6. 产出记录

| 项 | 结果 |
| --- | --- |
| chunk 总数（各学段） | （待填） |
| 索引体积 | （待填） |
| 检索延迟 | （待填） |
| 降级链演示结果 | （待填） |
| 关卡 C 通过时间 | （待填） |
