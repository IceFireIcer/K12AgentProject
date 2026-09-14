# Stage 06 · RAG 检索层 + 三级降级链

| 项 | 内容 |
| --- | --- |
| 对应排期 | **D6** |
| 关卡 | ✅ **关卡 C：RAG 检索正确且学段隔离（最高风险）** |
| 前置 | S05 数据就绪 |
| 状态 | ⬜ 未开始 |

---

## 1. 目标

把 S05 的教材变成**可检索的向量库**，并把 **三级降级链**做实。做完之后 `qa_answer` 节点就能带着引用作答。

---

## 2. 任务清单

### 2.1 分块与索引

- [ ] `app/rag/chunker.py`：Markdown → 父子 chunk（节级 300–600 token；子块做 embedding）
- [ ] `app/db/` 建库脚本：创建 `kb.sqlite`（DDL 见执行文档 8.2）
- [ ] `scripts/build_index.py`：分块 → 嵌入 → 写 `chunk` / `chunk_vec` / `chunk_fts`
- [ ] **维度写成配置常量**（`EMBED_DIM = 512`），不散落硬编码

### 2.2 检索

- [ ] `app/rag/embedder.py`：fastembed 封装（含加载失败降级）
- [ ] `app/rag/retriever.py`：
  - [ ] sqlite-vec KNN 查询
  - [ ] **学段隔离**：`WHERE grade_level = :grade`；向上兼容命中后标 `compat=true`
  - [ ] 父子 chunk：命中子块 → 经 `parent_chunk_id` 取父块作上下文
- [ ] `app/rag/fallback.py`：
  - [ ] 降级1：云端 Embedding API（若用户自填）
  - [ ] 降级2：**FTS5(trigram)** 关键词检索
  - [ ] 降级3：依赖图 + 章节大纲直接注入
  - [ ] 附加兜底：**numpy 暴力余弦**（sqlite-vec 扩展加载失败时）

### 2.3 接入

- [ ] `qa_answer` 节点调 retriever，注入上下文
- [ ] SSE 新增 `event: citation`（带 chunkId/chapterTitle/gradeLevel/compat）
- [ ] 前端对话里显示引用来源卡片

---

## 3. 降级链（必须逐级可演示）

```
学生提问
  → 主 Agent 确定学段
  → [1] 主路径：fastembed 本地向量 → sqlite-vec KNN（学段约束）
  → [2] 降级1：云端 Embedding API
  → [3] 降级2：FTS5(trigram) 关键词检索   ← 必须实现，永不失败
  → [4] 兜底：依赖图 + 章节大纲注入
  → 命中子 chunk → 取父块 → 注入 LLM
```

---

## 4. 验收标准（DoD / 关卡 C）

- [ ] 提问能命中相关 chunk，回答里体现出了教材内容
- [ ] **学段隔离可验证**：初中提问不返回高中 chunk；向上兼容命中时 `compat=true` 且前端有标注
- [ ] **父子 chunk 生效**：注入的是父块完整内容而非碎片
- [ ] **降级链可现场演示**：
  - [ ] 把 fastembed 模型目录改名 → 自动降级 FTS5，仍能检索
  - [ ] 把 `sqlite_vec.load` 注释掉 → numpy 暴力余弦兜底，仍能检索
- [ ] 检索延迟可接受（本地向量检索应在百毫秒级）

---

## 5. 陷阱与注意

| # | 陷阱 | 说明 |
| --- | --- | --- |
| 1 | **FTS5 中文分词** | 默认分词器不支持中文，必须 `tokenize='trigram'`。 |
| 2 | **chunk_vec 与 chunk 行号错位** | `vec0` 表的 rowid 必须与 `chunk.rowid` 对齐，否则检索结果张冠李戴。写入时显式用 `chunk.rowid`。 |
| 3 | 维度硬编码 | 512 要集中成常量；升级到 bge-base(768) 必须同步改 `vec0` 维度并**重建索引**。 |
| 4 | sqlite-vec 加载 | 统一走 `enable_load_extension(True) → sqlite_vec.load(conn) → enable_load_extension(False)`。 |
| 5 | 学段泄漏 | 过滤必须写在 **SQL 层**，不能只在应用层筛，否则早被 KNN 的 top-k 截断掉。 |
| 6 | embedding BLOB 端序 | 存 `Float32Array` 字节时注意 `dtype='<f4'` 小端一致。 |
| 7 | 重跑建索引幂等 | 脚本要能重复执行（先清表再写），否则调试时数据翻倍。 |

---

## 6. 产出记录

| 项 | 结果 |
| --- | --- |
| chunk 总数（各学段） | （待填） |
| 索引体积 | （待填） |
| 检索延迟 | （待填） |
| 降级链演示结果 | （待填） |
| 关卡 C 通过时间 | （待填） |
