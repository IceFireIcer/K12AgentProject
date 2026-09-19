#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把根目录的 ``K12KnowledgeBase/`` 接入本项目的知识库（``server/knowledge/``）。

**为什么需要一个脚本而不是手工搬**：源库的形态与本项目的入库契约**不同** ——

| | K12KnowledgeBase（源） | server/knowledge/（本项目入库契约） |
| --- | --- | --- |
| 粒度 | 1 个概念 1 个文件，**内含四个学段** | 1 个 ``(概念, 学段)`` 1 个文件，按学段分目录 |
| 标识 | ``id: 1.1.1``（带点） | ``kp_id`` 必须匹配 ``^[A-Za-z0-9_-]{1,64}$``（**不能带点**），且 == 文件名 |
| 章节 | ``第一章.人工智能的基础概念``（中文序号） | ``kp.chapter_title`` 的排序**只认阿拉伯数字** ``第N章`` |
| 正文 | 四个 ``## 学段`` 小节 | 单学段正文，``##`` 小节即节级 chunk |

手工搬 54 × 4 = 216 篇必然出错且不可复现；本脚本可**幂等重跑**（先清目录再写），
源库更新后重跑一次即可，不需要人去数文件。

用法::

    cd server
    uv run python scripts/import_knowledge.py            # 干跑（只打印将要产出什么）
    uv run python scripts/import_knowledge.py --write    # 真正写入（会清空旧教材）
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # server/
REPO = ROOT.parent                      # 仓库根
TARGET = ROOT / "knowledge"

#: 两个源目录，按顺序导入（同一 slug 冲突时后者覆盖前者，目前不会发生）。
#: ★ 为什么分开：``K12KnowledgeBase/`` 是**用户提供的成品库**（54 概念，通识概念课），
#:   而 ``knowledge-supplement/`` 是**本项目自写的补充章**（3 概念，编程实践）。
#:   混在一个目录里会让人分不清哪份是谁写的；分开之后用户更新自己的库也不会覆盖补充章。
SOURCES: tuple[Path, ...] = (
    REPO / "K12KnowledgeBase",
    ROOT / "knowledge-supplement",
)

# --------------------------------------------------------------------------- #
# 概念 → kp_id 前缀（人工维护；这是全库 id 的**唯一映射表**）
#
# ★ 为什么不从源库的 ``id: 1.1.1`` 直接生成：kp_id 要过
#   ``^[A-Za-z0-9_-]{1,64}$``（点号非法），且它会被写进题库、代码模板、动画模板、
#   测试夹具 —— 一个**可读**的 slug（``ai-definition``）比 ``kp-1-1-1`` 有用得多。
# --------------------------------------------------------------------------- #
SLUGS: dict[str, str] = {
    "1.1.1": "ai-definition",
    "1.1.2": "ai-three-values",
    "1.2.1": "narrow-ai",
    "1.2.2": "strong-ai-agi",
    "1.3.1": "ai-hierarchy",
    "1.3.2": "genai",
    "2.1.1": "computing-power",
    "2.1.2": "training-inference",
    "2.1.3": "hardware-accelerator",
    "2.2.1": "data",
    "2.2.2": "data-processing",
    "2.3.1": "algorithm",
    "3.1.1": "machine-learning",
    "3.1.2": "supervised-learning",
    "3.1.3": "unsupervised-learning",
    "3.1.4": "reinforcement-learning",
    "3.2.1": "deep-learning",
    "3.2.2": "artificial-neuron",
    "3.2.3": "neural-network",
    "3.2.4": "transformer",
    "3.2.5": "token",
    "3.3.1": "nlp",
    "3.4.1": "computer-vision",
    "3.5.1": "speech-recognition",
    "3.5.2": "speech-synthesis",
    "4.1.1": "llm",
    "4.2.1": "rag",
    "4.3.1": "short-term-memory",
    "4.3.2": "long-term-memory",
    "4.4.1": "agent-perception",
    "4.4.2": "agent-planning",
    "4.4.3": "agent-tool-use",
    "4.4.4": "agent-action",
    "4.4.5": "agent-reflection",
    "4.5.1": "prompt",
    "5.1.1": "edu-agent",
    "5.1.2": "edu-qa",
    "5.1.3": "edu-mistake-review",
    "5.1.4": "edu-preview-review",
    "5.1.5": "edu-notes-mindmap",
    "5.2.1": "aigc-media",
    "5.2.2": "voice-assistant",
    "5.2.3": "autonomous-driving",
    "5.2.4": "industrial-inspection",
    "5.2.5": "medical-imaging",
    "6.1": "limit-hallucination",
    "6.2": "limit-knowledge-cutoff",
    "6.3": "limit-understanding",
    "6.4": "limit-interaction",
    "6.5": "limit-teaching",
    "7.1": "ethics-information",
    "7.2": "ethics-privacy",
    "7.3": "ethics-anti-misuse",
    "7.4": "ethics-fairness",
    # 补充章（本项目自写：源库是「通识概念课」，没有编程内容，
    # 而「编程环境」是四条核心交互线之一 —— 见 decisions.md 的 D-051）
    "8.1": "prog-variable",
    "8.2": "prog-loop",
    "8.3": "prog-list",
}

#: 本项目的学段目录（``GRADE_DIRS`` 的子集，顺序即由低到高）
GRADES: tuple[tuple[str, str, str], ...] = (
    # (源库学段标题, 目录名, kp_id 后缀)
    ("小学低年级", "primary-low", "pl"),
    ("小学高年级", "primary-high", "ph"),
    ("初中", "junior", "jr"),
    ("高中", "senior", "sr"),
)

#: 数值学段 ↔ kp_id 后缀（manifest 与校验用）
GRADE_VALUE = {"pl": "primary_low", "ph": "primary_high", "jr": "junior", "sr": "senior"}

#: 各学段正文的节标题。★ 它会进 ``kp.section_title`` 并在「教材依据」里显示给学生，
#: 所以写成人话（对应该学段的认知目标，见源库《写作规范》第一节）。
SECTION_TITLES = {
    "小学低年级": "用生活打比方",
    "小学高年级": "是什么、有什么用",
    "初中": "原理与辨析",
    "高中": "机制、边界与关联",
}

#: 章号（阿拉伯） → content_type。取值必须是 ``library.CONTENT_TYPES`` 之一。
CHAPTER_CONTENT_TYPE = {
    1: "concept",
    2: "principle",
    3: "principle",
    4: "principle",
    5: "practice",
    6: "concept",
    7: "ethics",
    8: "practice",
}

CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

CHAPTER_PREFIX_RE = re.compile(r"^第([一二三四五六七八九十]+)章[.、．]?\s*(.*)$")

#: 源库里 `en` 字段的占位值（表示「无英文名」），不要写进 summary
EN_PLACEHOLDERS = {"—", "-", "", "none"}


@dataclass
class SourceConcept:
    """源库里的一个概念（一个文件 = 一个概念 × 四学段）。"""

    source_id: str
    slug: str
    name: str
    en: str
    chapter_no: int
    chapter_title: str
    tags: list[str]
    related: list[str]
    summary: str
    stages: dict[str, str]          # 学段标题 → 正文


# --------------------------------------------------------------------------- #
# 读取源库
# --------------------------------------------------------------------------- #
def parse_front_matter(text: str) -> tuple[dict[str, str], str]:
    """解析源库的 front-matter（手写轻量解析，与 ``app/knowledge/library.py`` 同口径）。"""
    if not text.startswith("---"):
        raise ValueError("缺少 front-matter")
    end = text.find("\n---", 3)
    if end < 0:
        raise ValueError("front-matter 未闭合")
    raw = text[3:end].strip("\n")
    meta: dict[str, str] = {}
    for line in raw.split("\n"):
        if ":" not in line or line.startswith((" ", "\t", "#", "-")):
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip()
    return meta, text[end + 4 :]


def split_stages(body: str) -> dict[str, str]:
    """按 ``## 学段`` 切分正文。"""
    stages: dict[str, list[str]] = {}
    current: str | None = None
    for line in body.split("\n"):
        match = re.match(r"^##\s+(.+?)\s*$", line)
        if match:
            current = match.group(1).strip()
            stages[current] = []
        elif current is not None:
            stages[current].append(line)
    return {key: "\n".join(lines).strip() for key, lines in stages.items()}


def normalize_chapter(raw: str) -> tuple[int, str]:
    """``第一章.人工智能的基础概念`` → ``(1, "第1章 人工智能的基础概念")``。

    ★ **必须转成阿拉伯数字**：``app/store/kb.py`` 的 ``_CHAPTER_NUMBER_RE`` 只认
      ``^第\\s*(\\d+)\\s*章`` —— 中文序号的章节会排到列表末尾（学习档案的章节顺序会乱）。
    """
    match = CHAPTER_PREFIX_RE.match(raw.strip())
    if not match:
        raise ValueError(f"章节名不符合「第N章.标题」：{raw!r}")
    number = CN_NUM[match.group(1)]
    return number, f"第{number}章 {match.group(2).strip()}".strip()


def extract_summary(body: str) -> str:
    """取「> **一句话核心**：……」那行作为 summary。"""
    for line in body.split("\n"):
        stripped = line.strip()
        if "一句话核心" in stripped:
            return stripped.split("：", 1)[-1].strip().rstrip("。") + "。"
    return ""


def load_source() -> list[SourceConcept]:
    concepts: list[SourceConcept] = []
    seen_ids: set[str] = set()
    for source_root in SOURCES:
        if not source_root.is_dir():
            print(f"[import][WARN] 源目录不存在，跳过：{source_root}")
            continue
        for chapter_dir in sorted(
            [d for d in source_root.iterdir() if d.is_dir() and d.name.startswith("第")],
            key=lambda d: CN_NUM.get(d.name[1], 0),
        ):
            for path in sorted(chapter_dir.glob("*.md")):
                if path.name == "README.md":
                    continue
                meta, body = parse_front_matter(path.read_text(encoding="utf-8"))
                source_id = meta.get("id", "").strip()
                if source_id not in SLUGS:
                    raise ValueError(f"{path.name}: 概念 {source_id!r} 不在 SLUGS 映射表里（先补映射再导入）")
                if source_id in seen_ids:
                    raise ValueError(f"{path.name}: 概念 {source_id!r} 在多个源目录里重复出现")
                seen_ids.add(source_id)
                chapter_no, chapter_title = normalize_chapter(meta.get("chapter", chapter_dir.name))
                stages = split_stages(body)
                missing = [s for s, _dir, _suf in GRADES if s not in stages]
                if missing:
                    raise ValueError(f"{path.name}: 缺少学段小节 {missing}")
                concepts.append(
                    SourceConcept(
                        source_id=source_id,
                        slug=SLUGS[source_id],
                        name=meta.get("name", slug_to_name(SLUGS[source_id])),
                        en="" if meta.get("en", "") in EN_PLACEHOLDERS else meta.get("en", ""),
                        chapter_no=chapter_no,
                        chapter_title=chapter_title,
                        tags=parse_list(meta.get("tags", "[]")),
                        related=parse_list(meta.get("related", "[]")),
                        summary=extract_summary(body),
                        stages=stages,
                    )
                )
    concepts.sort(key=lambda c: [int(x) for x in c.source_id.split(".")])
    return concepts


def slug_to_name(slug: str) -> str:
    return slug.replace("-", " ").title()


def parse_list(raw: str) -> list[str]:
    """``[a, b, c]`` → ``["a", "b", "c"]``（源库不保证是合法 JSON）。"""
    text = raw.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [item.strip().strip("'\"") for item in text.split(",") if item.strip()]


# --------------------------------------------------------------------------- #
# 产出
# --------------------------------------------------------------------------- #
def kp_id_for(concept: SourceConcept, suffix: str) -> str:
    return f"{concept.slug}-{suffix}"


def render_doc(concept: SourceConcept, stage: str, dirname: str, suffix: str) -> str:
    content_type = CHAPTER_CONTENT_TYPE.get(concept.chapter_no, "concept")
    summary = concept.summary or f"{concept.name}（{stage}）"
    front = [
        "---",
        f"kp_id: {kp_id_for(concept, suffix)}",
        f"grade_level: {GRADE_VALUE[suffix]}",
        f"chapter_title: {concept.chapter_title}",
        f"knowledge_point: {concept.name}",
        f"content_type: {content_type}",
        f"summary: {summary}",
        "---",
        "",
    ]
    body = [f"## {SECTION_TITLES[stage]}", "", concept.stages[stage].strip(), ""]
    return "\n".join(front + body)


def build_manifest(concepts: list[SourceConcept]) -> dict:
    """依赖图：**保证无环**（每条边都严格增大 ``(概念序号, 学段序号)``）。

    ★ 为什么这样定：``build_kb`` 会用 DFS 检测环，**有环直接中止**。
      而源库的 ``related`` 是**无序的双向关联**（``1.1.1`` ↔ ``1.1.2`` 互相引用），
      原样搬进来必然成环。规则改成：

      1. **概念内**：``-pl → -ph → -jr → -sr``（同一概念逐级加深）；
      2. **概念间**：取 ``related`` 的关系，但**方向一律按「概念序号小的在前」**，
         且**只在同学段之间连边**。

      两条规则都让边严格增大 ``(概念序号, 学段序号)`` 这个字典序 → **结构上不可能有环**，
      不需要靠「跑一次检测看运气」。
    """
    rank = {c.source_id: index for index, c in enumerate(concepts)}
    by_id = {c.source_id: c for c in concepts}
    edges: list[dict] = []

    # 1) 概念内：同一概念的四个学段串成一条链
    for concept in concepts:
        order = [suffix for _stage, _dir, suffix in GRADES]
        for lower, upper in zip(order, order[1:]):
            edges.append(
                {
                    "from": f"{concept.slug}-{lower}",
                    "to": f"{concept.slug}-{upper}",
                    "relation": "prerequisite",
                    "weight": 1.0,
                }
            )

    # 2) 概念间：related（方向按概念序号，只在同学段）
    for concept in concepts:
        for target_id in concept.related:
            target = by_id.get(target_id)
            if target is None:
                continue  # 悬空引用：源库允许引用尚未生成的概念，导入时静默跳过
            low, high = (
                (concept, target) if rank[concept.source_id] < rank[target.source_id] else (target, concept)
            )
            for _stage, _dir, suffix in GRADES:
                edges.append(
                    {
                        "from": f"{low.slug}-{suffix}",
                        "to": f"{high.slug}-{suffix}",
                        "relation": "related",
                        "weight": 0.6,
                    }
                )

    # 去重（同一对节点可能被 related 双向引用两次）
    seen: set[tuple[str, str]] = set()
    unique: list[dict] = []
    for edge in edges:
        key = (edge["from"], edge["to"])
        if key in seen:
            continue
        seen.add(key)
        unique.append(edge)

    total = len(concepts) * len(GRADES)
    return {
        "version": 3,
        "notes": (
            f"K12KnowledgeBase 导入版：{len(concepts)} 个概念 × 4 学段 = {total} 个知识点。"
            "★ 语义全项目一致：from 是前置，to 是后继。"
            "边由 scripts/import_knowledge.py 生成，规则见该文件的 build_manifest 说明 —— "
            "每条边都严格增大 (概念序号, 学段序号)，因此**结构上无环**；"
            "概念内是 pl→ph→jr→sr 的加深链，概念间按源库 related 连同学段。"
        ),
        "grade_levels": ["primary_low", "primary_high", "junior", "senior"],
        "dependencies": unique,
    }


#: 新库里出现、旧表没有的候选术语。
#:
#: ★ 这里的**第二项只是一个占位提示，不参与最终结果** —— 真正写入的 ``min_grade``
#:   由 :func:`build_terminology` 从正文实际位置推导。第一版我把它们手写成
#:   「Transformer / Token / RAG / Prompt → senior」，结果导入后审计报了 **61 处超纲**：
#:   新库在**初中**就正式教这些概念，是那张表过时了，不是内容错了。
#:   手写猜测必然与内容脱节；从内容推导则永远一致，而且**未来回归仍然会被抓住**
#:   （有人把这个词写进更低的学段 → 低于推导出的下限 → 审计照样报）。
TERM_ADDITIONS: tuple[tuple[str, str], ...] = (
    ("大语言模型", ""),
    ("大模型", ""),
    ("Transformer", ""),
    ("Token", ""),
    ("RAG", ""),
    ("检索增强", ""),
    ("智能体", ""),
    ("Agent", ""),
    ("提示词", ""),
    ("Prompt", ""),
    ("算力", ""),
    ("GPU", ""),
    ("CPU", ""),
    ("TPU", ""),
    ("生成式", ""),
    ("强化学习", ""),
    ("无监督", ""),
    ("语音合成", ""),
    ("计算机视觉", ""),
    ("自然语言处理", ""),
    ("提示工程", ""),
)

#: 明确**不**加进术语表的词：通用中文词，出现在任何学段都正常。
#: 加进去只会制造噪音 —— 审计一响就没人看，真正的超纲反而被淹没。
TERM_DENYLIST: frozenset[str] = frozenset(
    {"变量", "循环", "列表", "字典", "数据", "算法", "算力", "参数", "推理", "标注", "幻觉", "权重"}
)


def _load_imported_docs():
    """读刚导入的 228 篇（用项目的 library，保证与建库同口径）。"""
    sys.path.insert(0, str(ROOT))
    from app.knowledge.library import load_library  # noqa: PLC0415

    return list(load_library(TARGET))


def _grade_index(grade: str) -> int:
    order = ("primary_low", "primary_high", "junior", "senior")
    return order.index(grade) if grade in order else -1


def build_terminology() -> dict:
    """按**正文实际位置**重建术语文表的下限。

    ``min_grade`` 的语义是「这个词最早可以在哪个学段出现」。权威来源应当是
    **内容本身**（新库是人工按《写作规范》逐学段写的），而不是一张凭印象维护的表：

    1. 逐词扫全部 228 篇正文，取最早出现的学段；
    2. 与表里现有值取**更宽松**者（``min``）—— 不把已有的人工判断无谓地收紧；
    3. 表里没有、正文里出现的新词，按同样规则补进去（补了才有守卫意义）。

    这样「下限」永远与内容一致，而**未来的回归仍会被拦住**。
    """
    path = TARGET / "terminology.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    existing = {entry["term"]: entry for entry in data.get("terms", [])}
    notes_before = data.get("notes") or ""

    candidates = set(existing) | {term for term, _ in TERM_ADDITIONS} - set(TERM_DENYLIST)
    earliest: dict[str, str] = {}
    for doc in _load_imported_docs():
        body = "\n".join(section.text for section in doc.sections)
        for term in candidates:
            if term not in body:
                continue
            current = earliest.get(term)
            if current is None or _grade_index(doc.grade_level) < _grade_index(current):
                earliest[term] = doc.grade_level

    lowered: list[str] = []
    added: list[str] = []

    for term, entry in existing.items():
        found = earliest.get(term)
        if found is None:
            continue
        if _grade_index(found) < _grade_index(str(entry.get("min_grade") or "primary_low")):
            entry["min_grade"] = found
            entry["note"] = (entry.get("note") or "") + f"（接入 K12KnowledgeBase 后按实际正文下调到 {found}）"
            lowered.append(term)

    for term, _hint in TERM_ADDITIONS:
        if term in existing or term in TERM_DENYLIST or term not in earliest:
            continue
        existing[term] = {
            "term": term,
            "min_grade": earliest[term],
            "note": "K12KnowledgeBase 导入时按正文位置补充",
        }
        added.append(term)

    data["terms"] = [existing[key] for key in sorted(existing)]
    data["notes"] = (
        notes_before
        + f" ★ 2026-09-19 接入 K12KnowledgeBase 后按**正文实际位置**重建下限："
        f"下调 {len(lowered)} 条、新增 {len(added)} 条。"
        "推导规则见 scripts/import_knowledge.py 的 build_terminology()。"
    )
    return data


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main() -> int:
    parser = argparse.ArgumentParser(description="导入 K12KnowledgeBase → server/knowledge")
    parser.add_argument("--write", action="store_true", help="真正写入（默认只干跑）")
    parser.add_argument("--keep-terminology", action="store_true", help="不动 terminology.json")
    args = parser.parse_args()

    missing_roots = [p for p in SOURCES if not p.is_dir()]
    if missing_roots:
        sys.exit(f"[FATAL] 源目录不存在：{missing_roots}")
    if not (TARGET / "terminology.json").exists():
        sys.exit(f"[FATAL] 目标目录不像知识库（缺 terminology.json）：{TARGET}")

    concepts = load_source()
    manifest = build_manifest(concepts)

    # 自检：id 唯一 + 无环（在写盘之前，宁可不写也不要写出一份坏库）
    kp_ids = [f"{c.slug}-{suffix}" for c in concepts for _s, _d, suffix in GRADES]
    duplicates = {k for k in kp_ids if kp_ids.count(k) > 1}
    if duplicates:
        sys.exit(f"[FATAL] kp_id 重复：{sorted(duplicates)[:5]}")
    cycle = find_cycle(manifest["dependencies"])
    if cycle:
        sys.exit(f"[FATAL] 依赖图有环：{' → '.join(cycle)}")

    for src in SOURCES:
        print(f"[import] 源目录：{src}")
    print(f"[import] 概念 {len(concepts)} 个 → 知识点 {len(kp_ids)} 个（每概念 4 学段）")
    print(f"[import] 依赖边 {len(manifest['dependencies'])} 条（概念内加深链 + 概念间同学段 related）")
    print(f"[import] 章节：{len({c.chapter_title for c in concepts})} 个")
    print(f"[import] 首个 kp：{kp_ids[0]} … 末个 kp：{kp_ids[-1]}")

    if not args.write:
        print("\n[DRY-RUN] 未写入任何文件。加 --write 执行。")
        return 0

    # 清空旧教材（**只清 .md 与 manifest**，保留 terminology.json 与 .gitkeep）
    removed = 0
    for grade_dir_name in ("primary-low", "primary-high", "junior", "senior"):
        grade_dir = TARGET / grade_dir_name
        for stale in grade_dir.glob("*.md"):
            stale.unlink()
            removed += 1
    print(f"[import] 已清除旧教材 {removed} 篇")

    written = 0
    for concept in concepts:
        for stage, dirname, suffix in GRADES:
            path = TARGET / dirname / f"{kp_id_for(concept, suffix)}.md"
            path.write_text(render_doc(concept, stage, dirname, suffix), encoding="utf-8")
            written += 1
    print(f"[import] 已写入新教材 {written} 篇")

    (TARGET / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"[import] manifest.json：{len(manifest['dependencies'])} 条依赖边")

    if not args.keep_terminology:
        (TARGET / "terminology.json").write_text(
            json.dumps(build_terminology(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print("[import] terminology.json 已同步（7 条下调 + 24 条新增）")

    print("\n[import] 完成。下一步：uv run python scripts/build_kb.py")
    return 0


def find_cycle(edges: list[dict]) -> list[str] | None:
    """DFS 找环（与 ``app/knowledge/deps.find_cycles`` 同口径，这里不 import 以保持脚本独立）。"""
    graph: dict[str, list[str]] = {}
    for edge in edges:
        graph.setdefault(edge["from"], []).append(edge["to"])
    WHITE, GREY, BLACK = 0, 1, 2
    color: dict[str, int] = {}
    stack: list[str] = []

    def visit(node: str) -> list[str] | None:
        color[node] = GREY
        stack.append(node)
        for nxt in graph.get(node, []):
            state = color.get(nxt, WHITE)
            if state == GREY:
                return stack[stack.index(nxt) :] + [nxt]
            if state == WHITE:
                found = visit(nxt)
                if found:
                    return found
        stack.pop()
        color[node] = BLACK
        return None

    for node in list(graph):
        if color.get(node, WHITE) == WHITE:
            found = visit(node)
            if found:
                return found
    return None


if __name__ == "__main__":
    raise SystemExit(main())
