"""降级链的 3/4 级：FTS5 关键词检索 + numpy 暴力余弦 + 章节大纲兜底。

**为什么必须实现 FTS5**（执行文档 §8.5）：即便 fastembed 随包分发，
也可能因模型文件损坏 / 内存不足 / 向量扩展没打进去而失败。
FTS5 内置于 SQLite，**永不失败**。

★ 两个中文相关的坑（业务陷阱清单 §2）：

1. ``tokenize='trigram'`` —— 默认分词器把整段中文当一个 token，等于不可检索。
2. **trigram 的最小匹配长度是 3 个字符**：``MATCH '"循环"'`` 返回空集。
   而学生的提问大量是「循环」「变量」这种**双字词**，
   所以短词必须回落到 ``LIKE '%循环%'`` 扫描 —— 只做 FTS 的实现在演示时会「什么都没搜到」。
   这条已实测确认（sqlite 3.45.3 / fts5 trigram）。

第 1 级内部的子兜底（numpy 暴力余弦）也在这里：sqlite-vec 加载失败时用它，
**仍然算 ``degraded="vector"``** —— 因为向量是真的算过了，只是引擎换了。
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from app.store.kb import CHUNK_COLUMNS, ChunkRecord, embeddings_by_grade, l2_normalize, outline_chunks

logger = logging.getLogger(__name__)

# FTS5 trigram 的最小匹配长度（实测：少于 3 个字符匹配不到任何行）
TRIGRAM_MIN_CHARS = 3

# FTS 命中的最低覆盖率（≈1/3）：关键词兜底返回一堆不相干的片段比返回空更糟
# （模型会把它当教材讲），所以命不中的块要判掉，达不到就继续降级到大纲。
#
# ★★ 分母是**实词**（内容段）而不是**词条**（n-gram 碎片）—— 真实 kb 上实测出来的：
# 一条 14 字的整句提问会拆出 10+ 个碎片，其中多数是拆分产物（「列表能」「表能用」），
# 而它们在教材里根本不存在；用「碎片总数」当分母时，一个真正相关的块（命中「列表」）
# 也只能拿到 1/11 ≈ 0.09，于是**必然**被判掉 —— 「FTS 永不失败」的兜底就退化成了
# 「长句提问永远返回空」。分母改成实词后，同一块拿到 1/1；而「只蒙中一个碎片」的块
# 仍要过这道线（多个实词的提问里，蒙中一个实词才 1/N）。
MIN_FTS_COVERAGE = 0.33

#: 词条切分的字符类：**中文连续片段** 或 **拉丁/数字词条**。
#: ★ 这是分词依据的**唯一一份**正则：此前模块里另有两个定义了却没人用的常量
#: （``_CJK_RUN`` / ``_LATIN``，除定义处 0 命中），而 ``query_terms`` 自己内联了一份同形正则
#: —— 「看起来有约束其实没有」的死常量，审计发现。现在删掉它们、统一用这一个名字，
#: 改字符范围（例如把 CJK 扩展区纳入）只需动一处。
_TERM_TOKEN_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]+|[A-Za-z0-9_]+")

# 提问里的疑问/语气成分：不删掉的话，「什么是循环」会变成一个 5 字词条，
# 关键词检索直接废掉（中文没有分词器，只能靠这种低成本启发式）。
_QUESTION_PREFIXES = (
    "请问",
    "告诉我",
    "解释一下",
    "什么叫",
    "什么是",
    "是什么",
    "为什么",
    "怎么样",
    "怎么办",
    "如何",
    "怎么",
    "什么",
)
_QUESTION_SUFFIXES = ("呢", "吗", "吧", "呀", "啊", "的")

# 长句拆词用的虚词字符：含这些字的二字/三字片段不可能是关键词（怎么 / 里怎 / 环里），
# 全部丢掉可显著降低噪声匹配。**同一个字符表也用来切「实词」**（见 `_content_units`）：
# 「循环里怎么累加总分」在这里被切成「循环」「累加总分」两个内容段。
_STOP_CHARS = set("的了是吗呢吧呀啊么怎里最会要有你我他它这那和与在到把被让给为就又都也就很")
# 中文连续片段超过这个长度就要拆 n-gram（否则整句当一个词，永远匹配不上）
CJK_MAX_TERM_CHARS = 4
#: 覆盖率分母（实词）的最小长度：单字段（「的」「用」）没有区分度，不进分母。
MIN_UNIT_CHARS = 2


@dataclass(frozen=True)
class Hit:
    """一条命中（**命中的是子块**，父块由检索链解析后再注入 LLM）。"""

    chunk: ChunkRecord
    score: float  # 越大越相关，0..1
    compat: bool  # true = 该条来自比学生学段更低的学段（向上兼容命中）
    level: str  # vector | cloud | fts | outline
    expanded: bool = False  # true = 依赖图补充的前置知识点（不是直接命中）


def query_terms(query: str) -> list[str]:
    """把自然语言提问切成关键词条（无分词器时的低成本方案）。

    - 先剥掉疑问/语气成分（「什么是循环」→「循环」）；
    - **每个中文片段都产出 2-gram**（「循环」「累加」「条件」），超长的再补 3-gram；
    - 片段 ≤4 字时**整词也保留一条**（「梯度下降」这类四字术语在教材里是连写的，
      只留 n-gram 会丢掉它）；
    - 含虚词的碎片丢掉（「里怎」「环里」不可能是关键词）。

    ★★ 为什么**短片段也要拆 2-gram**（这里曾经是「≤4 字整词入列、不拆」，实测踩到）：

    中文没有分词器，而学生提问是**流的**：课本题面里的「循环里怎么累加总分」，
    「累加总分」被当成一个四字词，只生成 3-gram「累加总」「加总分」，
    而教材正文写的是「累加」「总分」—— **一个都匹配不上**（真实 kb 实测：
    20 条常见提问里 6 条在 FTS 级零候选）。更典型的是「什么是条件判断」：
    剥掉「什么是」后剩「条件判断」4 字，教材里根本没有连写的这 4 个字
    （正文写的是「靠**条件**决定停不停」），于是这一级直接空手出局。

    2-gram 是**覆盖优先**的兜底：宁可多产出一些噪声词条（覆盖率会替我们筛掉），
    也不能让一个写在教材里的双字词找不到。

    这是**兜底路径**的分词策略，不追求语言学分词的准确性：
    目标是「整句提问也能找回相关内容」，而不是「切出唯一正确的词」。
    """
    text = query.strip()
    for prefix in _QUESTION_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :]
            break
    for suffix in _QUESTION_SUFFIXES:
        if text.endswith(suffix) and len(text) > len(suffix) + 1:
            text = text[: -len(suffix)]
            break

    terms: list[str] = []
    for match in _TERM_TOKEN_RE.finditer(text):
        token = match.group(0).strip()
        if len(token) < 2:
            continue
        if not _is_cjk(token[0]):
            # 拉丁/数字词条整体使用（英文单词不做 n-gram 切分）
            terms.append(token)
            continue
        terms.extend(_ngrams(token))

    # 去重但保序
    seen: set[str] = set()
    out: list[str] = []
    for t in terms:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _ngrams(token: str) -> list[str]:
    """中文片段 → 拿来匹配的 n-gram 词条（**短片段也拆 2-gram**）。

    这是「一个中文片段该拆成哪些词条」的**唯一实现**：``query_terms``（匹配用）
    与 ``_content_coverage``（判定实词命中用）都走它，
    否则两处拆分口径会各自漂移（「词条里有的碎片判定时却查不到」）。
    """
    fragments: list[str] = []
    if len(token) <= CJK_MAX_TERM_CHARS:
        fragments.append(token)  # 整词也留一条：四字术语在教材里常是连写的
    for size in (3, 2):
        if len(token) <= size:
            continue
        for i in range(len(token) - size + 1):
            fragment = token[i : i + size]
            if any(ch in _STOP_CHARS for ch in fragment):
                continue
            fragments.append(fragment)
    return fragments or [token]


def content_units(query: str) -> list[str]:
    """切出**覆盖率分母**用的实词（不含虚词的长内容段）。

    ★ 为什么不能用 :func:`query_terms` 的结果当分母（真实 kb 实测）：

    ``query_terms`` 的产出是「为了匹配」而拆的 n-gram 碎片，一个 14 字提问能拆出
    10+ 条，其中大半是拆分产物（「列表能」「表能用」），教材里根本不存在。
    拿它当分母，一个真正相关的块也只能得 0.09 —— **分母把正常句子判死了**。

    这里改成按虚词切段（用的是**同一份** ``_STOP_CHARS``，不引入第二套语言假设），
    再剥掉首尾的虚字（「要用列表」→「列表」），所以：

    - 「循环里怎么累加总分」→ ``['循环', '累加总分']``（2 个实词）
    - 「什么是条件判断」→ ``['条件判断']``（1 个实词）
    - 「量子纠缠退相干」→ ``['量子纠缠退相干']``（教材里没有 → 仍然 0 命中）

    提问本身没有实词（「为什么」「怎么办」）时返回空列表 —— 调用方据此**跳过**
    覆盖率过滤：那种查询在教材里本来就不该被当成命中（大概率落到大纲）。
    """
    units: list[str] = []
    for match in _TERM_TOKEN_RE.finditer(query):
        token = match.group(0).strip()
        if not _is_cjk(token[0]):
            # 拉丁/数字词条整体算一个实词（英文不做 n-gram，没有分母膨胀问题）
            if len(token) >= MIN_UNIT_CHARS:
                units.append(token)
            continue
        # 按虚词切段：虚字只当分隔符，切完再剥掉段首尾残留的虚字
        segment = ""
        for ch in token:
            if ch in _STOP_CHARS:
                if len(segment) >= MIN_UNIT_CHARS:
                    units.append(segment)
                segment = ""
                continue
            segment += ch
        if len(segment) >= MIN_UNIT_CHARS:
            units.append(segment)
    return units


def _is_cjk(ch: str) -> bool:
    return "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf"


def _coverage(text: str, terms: Sequence[str]) -> float:
    """命中率：``命中词条数 / 词条总数``（只在没有实词分母时的兜底口径）。"""
    if not terms:
        return 0.0
    hit = sum(1 for t in terms if t in text)
    return hit / len(terms)


def _content_coverage(text: str, units: Sequence[str]) -> float:
    """**实词**命中率 —— 覆盖率过滤真正用的口径（分母不含 n-gram 碎片）。

    一个实词算命中：它本身出现在正文里，**或**它的任一 n-gram 出现在正文里。
    后半条是必需的 —— 中文没有分词器，我们的「实词」是按虚词切的粗段：
    「累加总分」（提问）与教材里的「累加」+「总分」（正文）从来不是同一串字符，
    「条件判断」（提问）与「靠条件决定」（正文）也不是。只认整段相等 =
    退回「长句提问必然 0 命中」的那个 bug。
    """
    hit = 0
    for unit in units:
        if unit in text or any(fragment in text for fragment in _ngrams(unit)):
            hit += 1
    return hit / len(units)


def _fragment_coverage(text: str, terms: Sequence[str]) -> float:
    """**词条**命中率 —— 只用来在实词覆盖率相同时分先后（不进 ``min_coverage`` 判据）。

    ★ 为什么需要它：修复覆盖率分母之后，「实词命中数」变成了一个宽容的判据 ——
    一条只沾到「计算机」这个词的块，与真正讲「计算机视觉」的那一篇，实词覆盖率
    都是一条过线（两边的实词都是 1 个）。旧实现里唯一能分开它们的是「短块优先」，
    而那并不指向相关性（实测：「计算机视觉能做什么」的第一条会被一条更短、
    只是碰巧提到「计算机」的块挤掉）。

    这里改用**词条命中数**当同分时的第一顺位：真正讲那个概念的块会同时命中
    「计算机」「算机」「视觉」等好几个 n-gram，而顺带提及的块只命中一两个。
    与旧实现不同，它**不参与 ``min_coverage`` 判据**（那正是把整句提问判死的原因），
    只当同分时的排序依据 —— 判据与排序分开，两个口径各司其职。
    """
    if not terms:
        return 0.0
    return sum(1 for term in terms if term in text) / len(terms)


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def grade_filter_sql(grade_levels: Sequence[str], column: str = "grade_level") -> str:
    """把学段白名单渲染成**可展示的 WHERE 片段**（``grade_level IN ('junior','primary_high')``）。

    ★★ 它为什么要存在（而不仅是「拼一句话给人看」）：
    演示模式要证明「学段隔离是在 SQL 层强制的」，屏幕上必须出现**那条真实的过滤条件**。
    如果这里手写一句与真正下发的 SQL 无关的文案，那句展示就变成了装饰 ——
    所以本函数收的是**同一份** ``allowed`` 白名单（``RagService.search()`` 把同一个列表
    交给 ``_try_vector`` / ``_try_cloud`` / ``_try_fts`` / ``_try_outline``，
    那四条路径各自把 ``grade_level IN (?, …)`` 拼进自己的 SQL）。

    它与真正执行的 SQL 的**同源性**由 `server/tests/test_rag.py` 的
    `TestGradeFilterTrace` 钉着：那条用例用 ``sqlite3.set_trace_callback`` 抓出**实际执行**的
    SQL，断言占位符个数与顺序都与本函数的输出一致（改一处不改另一处立刻红）。

    ★ 只用于**展示与日志**：判定与过滤仍然只发生在各 ``_try_*`` 的 SQL 里，
      本函数不参与任何查询。
    """
    levels = [str(level) for level in grade_levels]
    if not levels:
        return f"{column} IN (∅)"
    rendered = ",".join(f"'{level}'" for level in levels)
    return f"{column} IN ({rendered})"


def _rows_to_hits(
    rows: Sequence[sqlite3.Row],
    *,
    terms: Sequence[str],
    requested_grade: str,
    level: str,
    top_k: int,
    min_coverage: float = 0.0,
    units: Sequence[str] = (),
) -> list[Hit]:
    scored: list[tuple[float, float, int, Hit]] = []
    for row in rows:
        rec = ChunkRecord.from_row(row)
        # ★ 判据的分母优先用**实词**：没有实词（纯虚词提问）时才退回词条口径。
        coverage = (
            _content_coverage(rec.text, units)
            if units
            else (_coverage(rec.text, terms) if terms else 0.0)
        )
        if coverage < min_coverage:
            continue
        # 排序键：① 实词覆盖率（判据口径）；② **词条命中率**（同分时谁更贴题，
        # 见 `_fragment_coverage`）；③ 短块优先（更聚焦，也避免长篇泛泛而谈的块
        # 把精确的小块挤下去）。sqlite3.Row 无 getattr 语义。
        scored.append(
            (
                coverage,
                _fragment_coverage(rec.text, terms),
                -rec.token_count,
                Hit(
                    chunk=rec,
                    score=round(float(coverage), 4),
                    compat=rec.grade_level != requested_grade,
                    level=level,
                ),
            )
        )
    scored.sort(key=lambda item: (-item[0], -item[1], -item[2]))
    return [hit for _, _, _, hit in scored[:top_k]]


# --------------------------------------------------------------------------- #
# [3] FTS5（trigram）
# --------------------------------------------------------------------------- #
def fts_search(
    conn: sqlite3.Connection,
    *,
    query: str,
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """FTS5 trigram 关键词检索（长词走 MATCH，双字词走 LIKE）。

    **学段过滤写在 SQL 的 WHERE 里**（不是应用层筛）—— 与向量路径同一条纪律。

    ★ 候选集的取法有一条纪律：**SQL 故意取宽**（``OR`` 连接所有词条、过采样 4~8 倍）。
    窄取法（例如只取 ``AND`` 命中的行）在中文整句提问上必然空手 —— 学生的问法里
    总有一两个词不在教材上（「列表**能用来做什么**」），而**判相关性是代码的事**：
    由 :func:`_rows_to_hits` 用实词覆盖率把弱命中判掉（``min_coverage``）。
    两件事分开：SQL 负责「别漏」，Python 负责「别乱」。
    """
    if not grade_levels:
        return []
    terms = query_terms(query)
    if not terms:
        return []
    placeholders = ",".join("?" * len(grade_levels))

    long_terms = [t for t in terms if len(t) >= TRIGRAM_MIN_CHARS]
    rows: list[sqlite3.Row] = []
    if long_terms:
        match_expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in long_terms)
        sql = (
            f"SELECT {', '.join('c.' + col for col in CHUNK_COLUMNS.split(', '))} "
            "FROM chunk_fts f JOIN chunk c ON c.rowid = f.rowid "
            f"WHERE chunk_fts MATCH ? AND c.is_parent = 0 AND c.grade_level IN ({placeholders}) "
            "ORDER BY bm25(chunk_fts) LIMIT ?"
        )
        try:
            rows = conn.execute(
                sql, (match_expr, *grade_levels, max(top_k * 4, 12))
            ).fetchall()
        except sqlite3.Error as exc:
            logger.warning("FTS5 MATCH 失败，回落 LIKE：%s", exc)
            rows = []

    if not rows:
        # ★ 双字词（循环/变量/函数）与 trigram 不足 3 字符的情况走这里。
        where = " OR ".join(f"c.text LIKE ? ESCAPE '\\'" for _ in terms)
        sql = (
            f"SELECT {CHUNK_COLUMNS} FROM chunk c "
            f"WHERE c.is_parent = 0 AND c.grade_level IN ({placeholders}) AND ({where}) "
            "ORDER BY c.token_count ASC LIMIT ?"
        )
        params = [*grade_levels, *[f"%{_escape_like(t)}%" for t in terms], max(top_k * 8, 24)]
        rows = conn.execute(sql, params).fetchall()

    hits = _rows_to_hits(
        rows,
        terms=terms,
        requested_grade=requested_grade,
        level="fts",
        top_k=top_k,
        min_coverage=MIN_FTS_COVERAGE,
        units=content_units(query),
    )
    logger.debug("FTS5 命中 %d 条（terms=%s）", len(hits), terms)
    return hits


# --------------------------------------------------------------------------- #
# [1b] numpy 暴力余弦（sqlite-vec 不可用时的子兜底）
# --------------------------------------------------------------------------- #
def numpy_cosine_search(
    conn: sqlite3.Connection,
    *,
    query_vec: "np.ndarray",
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """全量暴力余弦。几千个 512 维 chunk 是**毫秒级**的，没必要为它上索引。

    向量从 ``chunk.embedding`` BLOB 读（小端 '<f4'），不依赖任何扩展，
    因此 sqlite-vec 的 .dll 没打进去时这条路仍然可用。
    """
    rows, matrix = embeddings_by_grade(conn, grade_levels)
    if not rows or matrix.size == 0:
        return []
    q = l2_normalize(query_vec).astype(np.float32)
    if q.shape[0] != matrix.shape[1]:
        logger.warning("查询向量维度 %s 与库内 %s 不符，跳过 numpy 兜底", q.shape[0], matrix.shape[1])
        return []

    sims = matrix @ q
    order = np.argsort(-sims)[:top_k]
    hits: list[Hit] = []
    for idx in order:
        rec = ChunkRecord.from_row(rows[int(idx)])
        hits.append(
            Hit(
                chunk=rec,
                score=round(max(0.0, float(sims[int(idx)])), 4),
                compat=rec.grade_level != requested_grade,
                level="vector",
            )
        )
    return hits


# --------------------------------------------------------------------------- #
# [4] 大纲/依赖图兜底
# --------------------------------------------------------------------------- #
def outline_search(
    conn: sqlite3.Connection,
    *,
    grade_levels: Sequence[str],
    requested_grade: str,
    top_k: int,
) -> list[Hit]:
    """最后的兜底：直接把该学段的节级块（大纲）当上下文注入。

    **它不是「检索结果」而是「可讲的内容范围」**，所以 score 记 0：
    与其让模型在无检索的情况下胡编，不如明确告诉它「只讲这些节」。
    """
    hits = [
        Hit(
            chunk=rec,
            score=0.0,
            compat=rec.grade_level != requested_grade,
            level="outline",
        )
        for rec in outline_chunks(conn, grade_levels, limit=max(top_k, 5))
    ]
    return hits[:top_k]


__all__ = [
    "Hit",
    "MIN_FTS_COVERAGE",
    "TRIGRAM_MIN_CHARS",
    "content_units",
    "fts_search",
    "numpy_cosine_search",
    "outline_search",
    "query_terms",
]
