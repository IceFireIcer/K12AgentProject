"""分块：知识点 Markdown → 节级父块（300–600 token）+ 检索用子块。

分块策略（本项目的定版，改动前先读这段）
----------------------------------------
1. 一个 ``##`` 小节 = 一个**节级父块**；超过 600 token 的小节在句子边界拆成多个父块，
   切点尽量落在 300–600 之间（拆出来的块不会小于 300，除非整节本来就这么短）。
2. 每个父块再切成 1–N 个**子块**（目标 ~200 token、上限 300）——**子块才是检索单元**。
3. 命中子块后经 ``parent_chunk_id`` 取父块，**注入 LLM 的上下文是父块完整内容而非碎片**
   （执行文档 §8.5、票 11 验收口径）。

为什么「父块也要切子块」而不是「只给超长小节切」：真实提问命中的往往是节里的某一两句话。
若直接把 300–600 token 的整节当检索单元，向量会被整节稀释，
「问循环→命中变量那一节」这类近似知识点的串扰明显变多；
切成子块检索、回父块注入，两个问题一起解决（精度与上下文完整性各自取最优）。

**父子关系与 ``chunk_id`` 是确定性生成的**：同一个 Markdown 反复建库得到的 id 完全一致
（幂等重跑的前提，业务陷阱清单 §2 第 7 条）。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Protocol

from app.knowledge.library import KnowledgeDoc, Section

# ---------------------------------------------------------------- 尺寸契约 --
# 节级父块（执行文档 §8.3：300–600 token）
PARENT_MIN_TOKENS = 300
PARENT_MAX_TOKENS = 600
# 检索用子块
CHILD_TARGET_TOKENS = 200
CHILD_MAX_TOKENS = 300
CHILD_MIN_TOKENS = 80

# 句子边界（中文标点 + 英文标点）
_SENTENCE_END = "。！？!?；;…\n"
# 次级边界：只在「收尾重排」里用（句级切点落不进窗口时，允许在逗号处断开，
# 这样就不会出现「只差十几 token 却怎么都排不进 300–600」的尾巴）
_CLAUSE_END = "，、：,:"
# 硬拆单个超长句子的粒度（极端情况兜底，正常内容不会用到）
_HARD_SPLIT_CHARS = 240


class TokenCounter(Protocol):
    def __call__(self, text: str) -> int: ...


def heuristic_token_count(text: str) -> int:
    """无分词器时的估算：CJK 每字 1 token + 拉丁词 1 token + 其他可见字符各 1 token。

    对 bge 的中文 BERT 分词器来说这个估算相当准（中文基本一字一 token），
    但**建库时优先用真实分词器**（:class:`HfTokenCounter`），
    估算值只用于单测与「模型还没下载」的场景。
    """
    cjk = latin = other = 0
    in_latin = False
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf":
            cjk += 1
            in_latin = False
        elif ch.isalnum() and ch.isascii():
            if not in_latin:
                latin += 1
            in_latin = True
        elif ch.isspace():
            in_latin = False
        else:
            other += 1
            in_latin = False
    return cjk + latin + other


class HfTokenCounter:
    """用模型自带 ``tokenizer.json`` 精确计数（不需要加载 ONNX）。

    建库写进 ``chunk.token_count`` 的数字应当来自这里 ——
    「节级 300–600 token」这条口径必须用**真实 tokenizer** 说话，估算值经不起追问。
    """

    def __init__(self, tokenizer_json: str | Path) -> None:
        from tokenizers import Tokenizer  # type: ignore[import-not-found]

        self._tok = Tokenizer.from_file(str(tokenizer_json))

    def __call__(self, text: str) -> int:
        return len(self._tok.encode(text).ids)


def find_tokenizer(model_dir: str | Path) -> Path | None:
    """在模型目录里找 ``tokenizer.json``（HF 缓存布局，多层快照目录）。"""
    root = Path(model_dir)
    if not root.is_dir():
        return None
    for path in sorted(root.rglob("tokenizer.json")):
        return path
    return None


def resolve_token_counter(model_dir: str | Path | None = None) -> tuple[TokenCounter, str]:
    """返回 ``(计数器, 说明)``：能用真实分词器就用，否则退回估算（并如实说明）。"""
    if model_dir:
        path = find_tokenizer(model_dir)
        if path is not None:
            try:
                counter = HfTokenCounter(path)
                counter("预热")
                return counter, f"HfTokenCounter({path})"
            except Exception as exc:  # noqa: BLE001 - 分词器坏了不该让建库失败
                return heuristic_token_count, f"heuristic（分词器不可用：{exc}）"
    return heuristic_token_count, "heuristic（未找到 tokenizer.json）"


# --------------------------------------------------------------------------- #
# 文本切分
# --------------------------------------------------------------------------- #
def split_paragraphs(text: str) -> list[str]:
    """按行切段（保留行内文本；Markdown 列表项各自成段）。"""
    out: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            out.append(stripped)
    return out


def split_sentences(text: str, ends: str = _SENTENCE_END) -> list[str]:
    """按中文/英文句读切句，标点保留在句尾。"""
    sentences: list[str] = []
    buf: list[str] = []
    for ch in text:
        buf.append(ch)
        if ch in ends:
            piece = "".join(buf).strip()
            if piece:
                sentences.append(piece)
            buf = []
    tail = "".join(buf).strip()
    if tail:
        sentences.append(tail)
    return sentences


def _atoms(
    text: str,
    counter: TokenCounter,
    *,
    max_tokens: int,
    ends: str = _SENTENCE_END,
) -> list[str]:
    """把文本打散成「不会被再切」的最小单元（句子；超长句子按字数硬拆）。

    标点保留在每个单元结尾，所以用空串拼接可以**逐字还原**原文
    （收尾重排时按逗号切分也不会弄丢标点）。
    """
    atoms: list[str] = []
    for para in split_paragraphs(text):
        for sentence in split_sentences(para, ends):
            if counter(sentence) <= max_tokens:
                atoms.append(sentence)
                continue
            for i in range(0, len(sentence), _HARD_SPLIT_CHARS):
                chunk = sentence[i : i + _HARD_SPLIT_CHARS].strip()
                if chunk:
                    atoms.append(chunk)
    return atoms


def pack_blocks(
    text: str,
    counter: TokenCounter,
    *,
    min_tokens: int,
    max_tokens: int,
    target_tokens: int | None = None,
) -> list[str]:
    """把文本贪心打包成若干个 ``[min_tokens, max_tokens]`` 的块。

    - 到达 ``target_tokens``（默认 ``min_tokens``）即可收口，避免块尾拖出很长的尾巴；
    - 最后一块若小于 ``min_tokens``，先尝试并入前一块（不超 ``max_tokens`` 时），
      否则单独保留 —— **宁可留一个短块，也不要为了凑数把两块无关内容粘在一起**。
    """
    target = target_tokens or min_tokens
    atoms = _atoms(text, counter, max_tokens=max_tokens)
    if not atoms:
        return []

    blocks: list[str] = []
    current: list[str] = []

    for atom in atoms:
        # ★ 一律按**拼接后的文本**重新计数：分词器对每段独立编码会加特殊符号，
        #   逐段累加会系统性地高估（实测：24 个小段落差近 50 token），
        #   结果是块块偏短、300–600 的口径永远对不上。
        candidate = "\n".join([*current, atom])
        if current and counter(candidate) > max_tokens:
            blocks.append("\n".join(current))
            current = []
            candidate = atom
        current.append(atom)
        if counter(candidate) >= target:
            blocks.append("\n".join(current))
            current = []

    if current:
        tail = "\n".join(current)
        tail_tokens = counter(tail)
        if blocks and tail_tokens < min_tokens:
            merged = blocks[-1] + "\n" + tail
            if counter(merged) <= max_tokens:
                blocks[-1] = merged
            else:
                blocks.append(tail)
        else:
            blocks.append(tail)

    return _rebalance_tail(blocks, counter, min_tokens=min_tokens, max_tokens=max_tokens)


def _rebalance_tail(
    blocks: list[str], counter: TokenCounter, *, min_tokens: int, max_tokens: int
) -> list[str]:
    """收尾重排：最后一块过短时，把它与前一块**均分**成两块。

    贪心打包会留下「前一块接近 600、尾巴只有 300 出头」的尾巴，
    这时既并进前一块（超 ``max_tokens``）也不是、留着也不是。
    由于两块合计不超过 ``2 * max_tokens``，均分一定能让两块都落进窗口 ——
    这正是「节级 300–600 token」这条口径最容易漏掉的一种情况（超长小节拆分的尾部）。
    """
    if len(blocks) < 2 or counter(blocks[-1]) >= min_tokens:
        return blocks
    combined = blocks[-2] + "\n" + blocks[-1]
    if counter(combined) > 2 * max_tokens:
        return blocks  # 极端情况（前一块本来就贴着上限）：保持原样，不硬凑

    atoms = _atoms(combined, counter, max_tokens=max_tokens, ends=_SENTENCE_END + _CLAUSE_END)
    # 逐个切点**实测**两侧大小，挑最均衡且两边都落进窗口的那个
    # （不能按原子数累加：分词器对每段独立编码会加特殊符号，累加会高估）
    # 逗号切点用空串拼接 —— 标点都在单元里，拼回去与原文一致，读起来仍然通顺。
    best: tuple[int, str, str] | None = None
    for i in range(1, len(atoms)):
        first_text = "".join(atoms[:i])
        second_text = "".join(atoms[i:])
        first_tokens, second_tokens = counter(first_text), counter(second_text)
        if not (min_tokens <= first_tokens <= max_tokens):
            continue
        if not (min_tokens <= second_tokens <= max_tokens):
            continue
        score = abs(first_tokens - second_tokens)
        if best is None or score < best[0]:
            best = (score, first_text, second_text)
    if best is None:
        return blocks
    return blocks[:-2] + [best[1], best[2]]


def split_parent_blocks(section: Section, counter: TokenCounter) -> list[str]:
    return pack_blocks(
        section.text,
        counter,
        min_tokens=PARENT_MIN_TOKENS,
        max_tokens=PARENT_MAX_TOKENS,
        target_tokens=PARENT_MIN_TOKENS,
    )


# 合并节级块时，多个小节标题的连接符（溯源用：citation.sectionTitle 会显示它）
SECTION_JOINER = " ／ "


def plan_parent_blocks(doc: KnowledgeDoc, counter: TokenCounter) -> list[tuple[str, str, int]]:
    """把一篇文档的小节规划成节级块：``[(section_title, text, 首个小节序号), ...]``。

    规则：

    1. 一个小节 ≤600 token → 它自己就是一块（常规情况，溯源最清楚）；
    2. 一个小节 >600 token → 按句子边界拆成多块（每块尽量落在 300–600）；
    3. **连续多个小节都不足 300 token 时合并**，直到加入下一节会超过 600 为止。
       为什么要合并：节级块口径是「300–600 token」，若放任 200 token 的小节单独成块，
       库里就会出现大量过短的「节级块」，父子两阶段检索的粒度承诺等于没兑现。
       合并后 ``section_title`` 用 :data:`SECTION_JOINER` 连接各节标题，仍然可溯源。
    """
    units = [(section, split_parent_blocks(section, counter)) for section in doc.sections]
    parents: list[tuple[str, str, int]] = []
    buffer: list[tuple[Section, str]] = []
    buffer_tokens = 0

    def flush() -> None:
        nonlocal buffer, buffer_tokens
        if buffer:
            title = SECTION_JOINER.join(s.title for s, _ in buffer)
            text = "\n".join(t for _, t in buffer)
            parents.append((title, text, buffer[0][0].index))
        buffer = []
        buffer_tokens = 0

    for section, blocks in units:
        if len(blocks) == 1:
            tokens = counter(blocks[0])
            if tokens < PARENT_MIN_TOKENS and buffer_tokens + tokens <= PARENT_MAX_TOKENS:
                buffer.append((section, blocks[0]))
                buffer_tokens += tokens
                continue
        flush()
        parents.extend((section.title, block, section.index) for block in blocks)
    flush()
    return parents


def split_child_blocks(parent_text: str, counter: TokenCounter) -> list[str]:
    """父块 → 检索用子块。

    短父块（< 2×``CHILD_MIN_TOKENS``）只产生一个子块：**不为了凑数把 100 token 的节
    砍成两个 50 token 的碎片**，碎片检索出来的相似度没有意义。
    """
    total = counter(parent_text)
    if total < 2 * CHILD_MIN_TOKENS:
        return [parent_text]
    return pack_blocks(
        parent_text,
        counter,
        min_tokens=CHILD_MIN_TOKENS,
        max_tokens=CHILD_MAX_TOKENS,
        target_tokens=CHILD_TARGET_TOKENS,
    )


# --------------------------------------------------------------------------- #
# 落库草稿
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ChunkDraft:
    chunk_id: str
    parent_chunk_id: str | None
    text: str
    grade_level: str
    chapter_title: str
    section_title: str
    knowledge_point: str  # ★ 存 kp_id（依赖图扩展、画像对齐都按它查）
    content_type: str
    token_count: int
    is_parent: bool
    order: int


def chunk_document(doc: KnowledgeDoc, counter: TokenCounter) -> list[ChunkDraft]:
    """一个知识点 → 父块 + 子块（返回顺序即入库顺序）。"""
    drafts: list[ChunkDraft] = []
    order = 0
    for p_idx, (section_title, parent_text, first_section) in enumerate(
        plan_parent_blocks(doc, counter)
    ):
        parent_id = f"{doc.kp_id}::s{first_section}::p{p_idx}"
        drafts.append(
            ChunkDraft(
                chunk_id=parent_id,
                parent_chunk_id=None,
                text=parent_text,
                grade_level=doc.grade_level,
                chapter_title=doc.chapter_title,
                section_title=section_title,
                knowledge_point=doc.kp_id,
                content_type=doc.content_type,
                token_count=counter(parent_text),
                is_parent=True,
                order=order,
            )
        )
        order += 1
        for c_idx, child_text in enumerate(split_child_blocks(parent_text, counter)):
            drafts.append(
                ChunkDraft(
                    chunk_id=f"{parent_id}::c{c_idx}",
                    parent_chunk_id=parent_id,
                    text=child_text,
                    grade_level=doc.grade_level,
                    chapter_title=doc.chapter_title,
                    section_title=section_title,
                    knowledge_point=doc.kp_id,
                    content_type=doc.content_type,
                    token_count=counter(child_text),
                    is_parent=False,
                    order=order,
                )
            )
            order += 1
    return drafts


def chunk_library(
    docs: Iterable[KnowledgeDoc], counter: TokenCounter
) -> list[ChunkDraft]:
    out: list[ChunkDraft] = []
    for doc in docs:
        out.extend(chunk_document(doc, counter))
    return out


def token_report(drafts: Iterable[ChunkDraft]) -> dict[str, float | int]:
    """父块 token 分布 —— 用来核对「节级 300–600 token」这条口径。"""
    parents = [d.token_count for d in drafts if d.is_parent]
    children = [d.token_count for d in drafts if not d.is_parent]
    if not parents:
        return {"parents": 0, "children": 0}
    in_window = [t for t in parents if PARENT_MIN_TOKENS <= t <= PARENT_MAX_TOKENS]
    ordered = sorted(parents)
    return {
        "parents": len(parents),
        "children": len(children),
        "parent_min": ordered[0],
        "parent_median": ordered[len(ordered) // 2],
        "parent_max": ordered[-1],
        "parents_in_window": len(in_window),
        "parents_over_max": len([t for t in parents if t > PARENT_MAX_TOKENS]),
        "child_median": sorted(children)[len(children) // 2] if children else 0,
    }


def discover_knowledge_dir() -> Path:
    """默认教材目录（``server/knowledge``）。"""
    from app.config import KNOWLEDGE_DIR

    return KNOWLEDGE_DIR


__all__ = [
    "CHILD_MAX_TOKENS",
    "CHILD_MIN_TOKENS",
    "CHILD_TARGET_TOKENS",
    "ChunkDraft",
    "HfTokenCounter",
    "PARENT_MAX_TOKENS",
    "PARENT_MIN_TOKENS",
    "chunk_document",
    "chunk_library",
    "discover_knowledge_dir",
    "find_tokenizer",
    "heuristic_token_count",
    "pack_blocks",
    "resolve_token_counter",
    "split_child_blocks",
    "split_parent_blocks",
    "token_report",
]
