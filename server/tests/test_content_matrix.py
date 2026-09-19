# -*- coding: utf-8 -*-
"""票 23：**四学段 × 八章内容矩阵**（内容资产覆盖，教育适配性 20% 的证据侧）。

为什么要有这个文件：内容资产最容易出现的失败不是「写错」，而是**整条线漏掉** ——
某个章节在某个学段根本没有内容。界面上看着一切正常（照样有问必答），
只有验收方翻到那一格才会发现「初中的『大模型与 Agent』那一章是空的」。
这类缺口在检索层与 UI 层**完全不可见**。

**矩阵来源（2026-09-19 随 K12KnowledgeBase 重建）**：kbp 换成新教材后，执行文档 §10.5 按
旧的 33 个 kp 人工排的那张「知识主线」表已整体作废。新结构是：

    8 个章节 × 57 个概念 × 4 个学段 = 228 个知识点（kp_id 形如 ``<概念slug>-<pl|ph|jr|sr>``）

所以矩阵按**章节 × 学段**组织：每一格**逐个列出**该格应有的概念 slug，
而不是从教材反推（反推出来的表永远与教材一致，等于没有断言）。

判别力来自五处：

1. **逐格点名**：每一格声明自己的概念清单，id 由「概念 slug + 学段后缀」拼出；
   编造 / 写错的 id 会被「文件名 = kp_id」与「id 后缀 = 学段」两道校验挡下；
2. **逐格语义证据**：每一格还要在正文里找到该章该学段的语义关键词 ——
   把某段正文清空、或整体挪到别的学段，这条立刻红；
3. **穷尽性**：教材里每一个 ``kp_id`` 都被某一格认领。新加一篇内容却忘了登记矩阵，
   会被这条抓住（否则矩阵会随教材增长慢慢变成一句空话）；
4. **单一归属**：每个 kp 只属于一个学段、一个章节（重复认领会掩盖「某一格漏了」）；
5. **学段错位自检**：超纲术语 / 错位语气 / 跨学段逐字搬运复用 ``app.knowledge.checker``，
   并额外用**合成的违规文档**反向验证检查器本身没被削弱（否则「全绿」可能只是检查器失效）。

另外两组覆盖：**分块元数据**（入库后没有空字段、父子链完整、父块尺寸契约）与
**依赖图的内容覆盖视角**（无孤立点、每个概念四学段成链、同学段连通、前置不向上跨学段）。
图算法本身的单测在 ``tests/test_graph.py``，这里只看「内容有没有接进图」。
"""

from __future__ import annotations

import statistics
import sys
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import KNOWLEDGE_DIR  # noqa: E402
from app.knowledge import checker  # noqa: E402
from app.knowledge.library import (  # noqa: E402
    GRADE_LEVELS,
    KnowledgeDoc,
    Section,
    grade_index,
    load_library,
    load_manifest,
    load_terminology,
)

#: 学段 → kp_id 后缀。kp_id 的学段**必须**由后缀就能读出来（改了要同步改这里）。
GRADE_SUFFIX: dict[str, str] = {
    "primary_low": "pl",
    "primary_high": "ph",
    "junior": "jr",
    "senior": "sr",
}

#: 每个学段应有的知识点数（= 概念总数）。★ 与 CHAPTERS 的概念数必须一致，
#: 不一致说明「加了概念只改了一处」—— ``test_four_grades_have_the_same_number_of_knowledge_points``
#: 会把两处都算一遍。
EXPECTED_KP_PER_GRADE = 57

# --------------------------------------------------------------------------- #
# 章节 × 学段矩阵（人工维护；改动教材必须同步改这里）
# --------------------------------------------------------------------------- #
# 每一章 = (章节标题, 概念 slug 列表, {学段: 该格正文里必须出现的语义关键词})
# ★ 关键词是「这一格的内容写了没有」的**证据**，不是装饰：选的是只有讲了这一章
#   才会写出来的词，且**逐格**给出（同一章在四个学段的措辞本来就不同）。
# ★ 关键词按 all-of 判：少一个就红 —— 这正是「登记表」的意义，
#   改写正文把某个词改没了，作者要回来显式确认这一格还成立。
_CH1 = "第1章 人工智能的基础概念"
_CH2 = "第2章 人工智能三大底层支柱(AI的构造地基)"
_CH3 = "第3章 核心技术分支"
_CH4 = "第4章 大模型与AI智能体Agent"
_CH5 = "第5章 人工智能主要应用领域"
_CH6 = "第6章 人工智能的局限性"
_CH7 = "第7章 人工智能伦理与安全"
_CH8 = "第8章 编程实践（补充）"

CHAPTERS: tuple[tuple[str, tuple[str, ...], dict[str, tuple[str, ...]]], ...] = (
    (
        _CH1,
        (
            "ai-definition",
            "ai-three-values",
            "narrow-ai",
            "strong-ai-agi",
            "ai-hierarchy",
            "genai",
        ),
        {
            "primary_low": ("人工智能", "智能", "生成式"),
            "primary_high": ("人工智能", "强人工智能", "生成式"),
            "junior": ("人工智能", "强人工智能", "生成式"),
            "senior": ("人工智能", "强人工智能", "生成式"),
        },
    ),
    (
        _CH2,
        (
            "computing-power",
            "training-inference",
            "hardware-accelerator",
            "data",
            "data-processing",
            "algorithm",
        ),
        {
            "primary_low": ("数据", "算法", "算力"),
            "primary_high": ("数据", "算法", "算力"),
            "junior": ("数据", "算法", "算力"),
            "senior": ("数据", "算法", "算力"),
        },
    ),
    (
        _CH3,
        (
            "machine-learning",
            "supervised-learning",
            "unsupervised-learning",
            "reinforcement-learning",
            "deep-learning",
            "artificial-neuron",
            "neural-network",
            "transformer",
            "token",
            "nlp",
            "computer-vision",
            "speech-recognition",
            "speech-synthesis",
        ),
        {
            "primary_low": ("机器学习", "神经网络"),
            "primary_high": ("机器学习", "神经网络"),
            "junior": ("机器学习", "神经网络"),
            "senior": ("机器学习", "神经网络"),
        },
    ),
    (
        _CH4,
        (
            "llm",
            "rag",
            "short-term-memory",
            "long-term-memory",
            "agent-perception",
            "agent-planning",
            "agent-tool-use",
            "agent-action",
            "agent-reflection",
            "prompt",
        ),
        {
            "primary_low": ("大语言模型", "智能体"),
            "primary_high": ("大语言模型", "智能体"),
            "junior": ("大语言模型", "智能体"),
            "senior": ("大语言模型", "智能体"),
        },
    ),
    (
        _CH5,
        (
            "edu-agent",
            "edu-qa",
            "edu-mistake-review",
            "edu-preview-review",
            "edu-notes-mindmap",
            "aigc-media",
            "voice-assistant",
            "autonomous-driving",
            "industrial-inspection",
            "medical-imaging",
        ),
        {
            # ★ 小学低年级不用「医疗」这种书面词（正文写的是「帮医生看片子」的讲法），
            #   证据词必须与那一格实际的语言水平一致，否则等于用一个超纲的尺子量。
            "primary_low": ("错题", "汽车", "助手"),
            "primary_high": ("应用", "医疗"),
            "junior": ("应用", "医疗"),
            "senior": ("应用", "医疗"),
        },
    ),
    (
        _CH6,
        (
            "limit-hallucination",
            "limit-knowledge-cutoff",
            "limit-understanding",
            "limit-interaction",
            "limit-teaching",
        ),
        {
            "primary_low": ("说错", "不懂"),
            "primary_high": ("幻觉", "局限", "理解"),
            "junior": ("幻觉", "局限", "理解"),
            "senior": ("幻觉", "局限", "理解"),
        },
    ),
    (
        _CH7,
        (
            "ethics-information",
            "ethics-privacy",
            "ethics-anti-misuse",
            "ethics-fairness",
        ),
        {
            "primary_low": ("信息", "秘密"),
            "primary_high": ("隐私", "公平", "信息"),
            "junior": ("隐私", "公平", "安全"),
            "senior": ("隐私", "公平", "滥用"),
        },
    ),
    (
        _CH8,
        (
            "prog-variable",
            "prog-loop",
            "prog-list",
        ),
        {
            "primary_low": ("列表", "字典"),
            "primary_high": ("变量", "循环", "列表", "字典"),
            "junior": ("变量", "循环", "列表", "字典"),
            "senior": ("变量", "循环", "列表", "字典"),
        },
    ),
)

#: 每个学段的**正文骨架**（节标题）：四学段不是同一篇改几个数字，各有各的讲法。
#: 实测语料 228/228 篇各只有一节，且节标题与学段一一对应。
GRADE_SKELETON: dict[str, str] = {
    "primary_low": "用生活打比方",
    "primary_high": "是什么、有什么用",
    "junior": "原理与辨析",
    "senior": "机制、边界与关联",
}

#: 正文字数下限（防占位文件）。小学低年级的正文本来就是 100–190 字的口语短篇，
#: 所以下限按「明显短于任何一篇真实正文」取，而不是按某个学段的平均长度取。
MIN_BODY_CHARS = 80


def body_text_of(doc: KnowledgeDoc) -> str:
    """**正文**（小节标题 + 小节正文），**不含**文件头元数据。

    ★ 关键词证据只认正文，不认 ``chapter_title`` / ``knowledge_point`` ——
      否则「第6章 人工智能的**局限**性」这种标题会白送一个证据词，
      正文被整段换掉也照样绿（判别力归零）。
    """
    parts: list[str] = []
    for section in doc.sections:
        parts.append(section.title)
        parts.append(section.text)
    return "\n".join(parts)


def body_of(doc: KnowledgeDoc) -> str:
    """文档全文（元数据 + 正文）—— 语气类断言用，关键词证据请用 :func:`body_text_of`。"""
    parts = [doc.knowledge_point, doc.summary, doc.chapter_title]
    for section in doc.sections:
        parts.append(section.title)
        parts.append(section.text)
    return "\n".join(parts)


class ContentMatrixCase(unittest.TestCase):
    """一次加载教材，供全文件复用。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.docs = load_library(KNOWLEDGE_DIR)
        cls.by_id = {doc.kp_id: doc for doc in cls.docs}
        cls.manifest = load_manifest(KNOWLEDGE_DIR)
        cls.terminology = load_terminology(KNOWLEDGE_DIR)

    # ---------------------------------------------------------------- 小工具 --
    def matrix_ids(self) -> dict[str, tuple[str, str]]:
        """矩阵认领的 ``kp_id`` → ``(章节标题, 学段)``（重复认领会在这里被断言抓住）。"""
        claimed: dict[str, tuple[str, str]] = {}
        for chapter, concepts, _evidence in CHAPTERS:
            for grade in GRADE_LEVELS:
                for concept in concepts:
                    claimed[f"{concept}-{GRADE_SUFFIX[grade]}"] = (chapter, grade)
        return claimed

    def cell_docs(self, chapter: str, grade: str) -> list[KnowledgeDoc]:
        return [
            doc
            for doc in self.docs
            if doc.chapter_title == chapter and doc.grade_level == grade
        ]

    def docs_by_grade(self) -> dict[str, list[KnowledgeDoc]]:
        buckets: dict[str, list[KnowledgeDoc]] = defaultdict(list)
        for doc in self.docs:
            buckets[doc.grade_level].append(doc)
        return buckets


# --------------------------------------------------------------------------- #
# 1. 数量与逐格覆盖
# --------------------------------------------------------------------------- #
class TestGradeCoverage(ContentMatrixCase):
    def test_matrix_is_not_empty(self) -> None:
        self.assertTrue(CHAPTERS, "矩阵为空等于没有断言")
        for chapter, concepts, evidence in CHAPTERS:
            with self.subTest(chapter=chapter):
                self.assertTrue(chapter.strip())
                self.assertTrue(concepts, f"{chapter} 没有登记任何概念")
                self.assertEqual(set(evidence), set(GRADE_LEVELS), "每一格都要给出证据词")

    def test_four_grades_have_the_same_number_of_knowledge_points(self) -> None:
        """★ 四学段的知识点数量必须**相等**（新库的设计：57 概念 × 4 学段）。

        少一个就说明某个概念在某个学段没有正文 —— 那正是「整条线漏掉」的形态：
        检索照样跑、界面照样有问必答，只是那一格永远命中不到东西。
        """
        counts = {grade: len(docs) for grade, docs in self.docs_by_grade().items()}
        declared = sum(len(concepts) for _title, concepts, _ev in CHAPTERS)
        self.assertEqual(
            declared,
            EXPECTED_KP_PER_GRADE,
            f"矩阵登记的概念数（{declared}）与 EXPECTED_KP_PER_GRADE"
            f"（{EXPECTED_KP_PER_GRADE}）不一致：加了概念要两处一起改",
        )
        for grade in GRADE_LEVELS:
            with self.subTest(grade=grade):
                self.assertEqual(
                    counts.get(grade, 0),
                    EXPECTED_KP_PER_GRADE,
                    f"{grade} 有 {counts.get(grade, 0)} 个知识点，"
                    f"应为 {EXPECTED_KP_PER_GRADE}（各学段必须齐平）",
                )
        self.assertEqual(
            sorted(counts),
            sorted(GRADE_LEVELS),
            f"教材目录里出现了契约外的学段：{sorted(counts)}",
        )

    def test_every_chapter_has_content_in_all_four_grades(self) -> None:
        """★ 核心断言：8 章 × 4 学段，每一格都有内容，且**恰好**是矩阵登记的那批 kp。

        这一条同时抓住两种缺口：某一格整格为空（整条主线漏了），
        以及某一格混进了不该属于它的知识点（内容被挪到别的章节）。
        """
        for chapter, concepts, _evidence in CHAPTERS:
            for grade in GRADE_LEVELS:
                with self.subTest(chapter=chapter, grade=grade):
                    cell = self.cell_docs(chapter, grade)
                    self.assertTrue(cell, f"「{chapter} / {grade}」一格没有任何内容")
                    expected = {f"{concept}-{GRADE_SUFFIX[grade]}" for concept in concepts}
                    actual = {doc.kp_id for doc in cell}
                    self.assertEqual(
                        actual - expected,
                        set(),
                        f"「{chapter} / {grade}」出现了矩阵没登记的知识点：{sorted(actual - expected)}",
                    )
                    self.assertEqual(
                        expected - actual,
                        set(),
                        f"「{chapter} / {grade}」缺少这些知识点：{sorted(expected - actual)}",
                    )

    def test_matrix_covers_every_knowledge_point(self) -> None:
        """★ 矩阵必须穷尽教材：新加内容而忘了登记矩阵，这条会红。"""
        all_ids = set(self.by_id)
        claimed = set(self.matrix_ids())
        self.assertEqual(
            all_ids - claimed,
            set(),
            "以下知识点没有被内容矩阵认领（新增内容必须同步登记矩阵）："
            f"{sorted(all_ids - claimed)}",
        )
        self.assertEqual(
            claimed - all_ids,
            set(),
            f"矩阵认领了教材里不存在的知识点：{sorted(claimed - all_ids)}",
        )

    def test_chapter_titles_match_the_library_exactly(self) -> None:
        """章节标题也要穷尽：教材里多出一章 / 改了一个字，矩阵没跟上就红。"""
        in_library = {doc.chapter_title for doc in self.docs}
        declared = {chapter for chapter, _c, _e in CHAPTERS}
        self.assertEqual(
            in_library - declared, set(), f"教材里有矩阵没登记的章节：{sorted(in_library - declared)}"
        )
        self.assertEqual(
            declared - in_library, set(), f"矩阵登记的章节在教材里找不到：{sorted(declared - in_library)}"
        )

    def test_each_knowledge_point_has_exactly_one_grade_and_one_chapter(self) -> None:
        """★ 单一归属：每个 kp 恰好属于一个学段、一个章节。

        三条一起判：① 矩阵里不重复认领（重复会掩盖「某一格漏了」）；
        ② kp_id 后缀与正文声明的学段一致（学段被挪动时会露馅）；
        ③ 正文的章节与矩阵那一格一致（内容被挪到别的章节时会露馅）。
        """
        seen: dict[str, str] = {}
        for chapter, concepts, _evidence in CHAPTERS:
            for grade in GRADE_LEVELS:
                for concept in concepts:
                    kp_id = f"{concept}-{GRADE_SUFFIX[grade]}"
                    with self.subTest(kp=kp_id):
                        self.assertNotIn(
                            kp_id,
                            seen,
                            f"{kp_id} 同时被「{seen.get(kp_id)}」与「{chapter}/{grade}」认领",
                        )
                    seen[kp_id] = f"{chapter}/{grade}"

        for kp_id, cell_name in seen.items():
            doc = self.by_id[kp_id]
            chapter, grade = cell_name.rsplit("/", 1)
            with self.subTest(kp=kp_id):
                self.assertEqual(
                    kp_id.rsplit("-", 1)[1],
                    GRADE_SUFFIX[grade],
                    f"{kp_id} 的后缀与矩阵登记的学段（{grade}）不一致",
                )
                self.assertEqual(
                    doc.grade_level, grade, f"{kp_id} 实际属于 {doc.grade_level}，矩阵记在 {grade} 下"
                )
                self.assertEqual(
                    doc.chapter_title, chapter, f"{kp_id} 实际在第「{doc.chapter_title}」，矩阵记在第「{chapter}」"
                )

    def test_every_cell_carries_its_chapter_evidence(self) -> None:
        """★ 逐格语义证据：那一格的**正文**里必须找得到该章该学段的主题词。

        只断言「文件在、数量对」是不够的 —— 把正文整段换成别的主题
        （或清空、或只剩标题）时行数与 id 都不变，只有证据词会红。
        证据词只认正文（见 :func:`body_text_of`），标题里的字不算。
        """
        for chapter, _concepts, evidence in CHAPTERS:
            for grade, keywords in evidence.items():
                with self.subTest(chapter=chapter, grade=grade):
                    cell = self.cell_docs(chapter, grade)
                    self.assertTrue(cell, f"「{chapter} / {grade}」一格没有任何内容")
                    joined = "\n".join(body_text_of(doc) for doc in cell)
                    for keyword in keywords:
                        self.assertIn(
                            keyword,
                            joined,
                            f"「{chapter} / {grade}」的正文里找不到「{keyword}」——这一格的内容缺失或被改写了",
                        )

    def test_body_length_grows_with_grade(self) -> None:
        """深度分配真实存在：同一批概念在四个学段是四篇不同深度的正文。

        用**中位数**判（各学段的长度分布本来就有重叠），并且只要求单调递增 ——
        这条不替代任何逐格断言，它抓的是「把高中正文直接下放到小学」这类整体性错误。
        """
        medians = {
            grade: statistics.median([sum(len(s.text) for s in doc.sections) for doc in docs])
            for grade, docs in self.docs_by_grade().items()
        }
        ordered = [medians[grade] for grade in GRADE_LEVELS]
        self.assertEqual(
            ordered,
            sorted(ordered),
            f"正文长度中位数没有随学段上升：{ {g: medians[g] for g in GRADE_LEVELS} }",
        )
        self.assertTrue(all(value > 0 for value in ordered), f"有学段的正文长度中位数为 0：{medians}")

    def test_concepts_are_not_reused_across_chapters(self) -> None:
        """同一个概念 slug 不允许出现在两章：那会让「它到底归哪一章」有两个答案。"""
        owner: dict[str, str] = {}
        for chapter, concepts, _evidence in CHAPTERS:
            for concept in concepts:
                with self.subTest(concept=concept):
                    self.assertNotIn(
                        concept, owner, f"概念 {concept} 同时登记在「{owner.get(concept)}」与「{chapter}」"
                    )
                    owner[concept] = chapter


# --------------------------------------------------------------------------- #
# 2. 学段错位（复用 checker，并反向验证检查器有效）
# --------------------------------------------------------------------------- #
class TestGradeDiscipline(ContentMatrixCase):
    def test_no_out_of_scope_terms_or_wrong_tone(self) -> None:
        """超纲术语 / 错位语气 / 跨学段逐字搬运：三项都必须为零（票 10、票 23）。"""
        report = checker.audit_library(self.docs, self.terminology)
        self.assertEqual(report.violations, [], checker.format_report(report))
        self.assertEqual(report.checked_docs, len(self.docs))

    def test_audit_is_not_vacuous(self) -> None:
        """★ 反向验证：真丢一份违规文档进去，检查器必须报出来。

        少了这条，「全绿」可能只是因为检查器失效（词表读空 / 比对方向写反），
        而不是教材干净 —— 这是典型的「断言看起来有、其实没判别力」。
        三类违规各造一份（超纲术语 / 错位语气 / 跨学段逐字搬运）。
        """
        self.assertTrue(self.terminology.get("terms"), "术语文表为空，超纲检查形同虚设")
        self.assertTrue(self.terminology.get("tone_markers"), "语气词表为空，语气检查形同虚设")

        # ① 超纲术语：小学低年级里出现「决策树」（min_grade=junior，新语料的 pl 里本来没有它）
        rogue_low = KnowledgeDoc(
            kp_id="x-rogue-low",
            grade_level="primary_low",
            chapter_title="第X章 违规样例",
            knowledge_point="违规样例",
            content_type="concept",
            summary="用来验证检查器不会漏报超纲词。",
            path=Path("x-rogue-low.md"),
            sections=(Section(index=0, title="一、故意超纲", text="决策树可以帮我们做判断。"),),
        )
        low_report = checker.audit_library([*self.docs, rogue_low], self.terminology)
        low_kinds = {v.kind for v in low_report.violations if v.kp_id == rogue_low.kp_id}
        self.assertIn(checker.VIOLATION_TERM, low_kinds, "超纲术语没被检查出来")

        # ② 错位语气：初中里出现「小朋友」（tone_markers 的 forbidden_in）
        rogue_junior = KnowledgeDoc(
            kp_id="x-rogue-junior",
            grade_level="junior",
            chapter_title="第X章 违规样例",
            knowledge_point="违规样例",
            content_type="concept",
            summary="用来验证检查器不会漏报错位语气。",
            path=Path("x-rogue-junior.md"),
            sections=(Section(index=0, title="一、故意错位", text="小朋友，我们来讲讲机器学习。"),),
        )
        tone_report = checker.audit_library([*self.docs, rogue_junior], self.terminology)
        tone_kinds = {v.kind for v in tone_report.violations if v.kp_id == rogue_junior.kp_id}
        self.assertIn(checker.VIOLATION_TONE, tone_kinds, "错位语气词没被检查出来")

        # ③ 跨学段逐字搬运：把初中一篇的正文原样贴进小学高年级的一篇
        source = self.by_id["machine-learning-jr"]
        copied = KnowledgeDoc(
            kp_id="x-rogue-copy",
            grade_level="primary_high",
            chapter_title="第X章 违规样例",
            knowledge_point="违规样例",
            content_type="concept",
            summary="用来验证检查器不会漏报跨学段逐字搬运。",
            path=Path("x-rogue-copy.md"),
            sections=(Section(index=0, title="一、故意搬运", text=source.sections[0].text),),
        )
        copy_report = checker.audit_library([*self.docs, copied], self.terminology)
        copy_kinds = {v.kind for v in copy_report.violations if v.kp_id == copied.kp_id}
        self.assertIn(checker.VIOLATION_DUPLICATE, copy_kinds, "跨学段逐字搬运没被检查出来")

    def test_every_kp_field_is_non_empty(self) -> None:
        """chunk 元数据三条来源字段（grade_level / knowledge_point / 章节）不得为空。"""
        for doc in self.docs:
            with self.subTest(kp=doc.kp_id):
                self.assertIn(doc.grade_level, GRADE_LEVELS)
                self.assertTrue(doc.knowledge_point.strip())
                self.assertTrue(doc.chapter_title.strip())
                self.assertTrue(doc.summary.strip())
                self.assertTrue(doc.sections, f"{doc.kp_id} 没有任何小节")
                for section in doc.sections:
                    self.assertTrue(section.title.strip(), f"{doc.kp_id} 有小节标题为空")
                # 正文太短说明是占位文件（下限取「明显短于任何一篇真实正文」）
                body_chars = sum(len(section.text) for section in doc.sections)
                self.assertGreater(
                    body_chars,
                    MIN_BODY_CHARS,
                    f"{doc.kp_id} 正文过短（{body_chars} 字），疑似占位",
                )

    def test_chapter_numbers_are_complete_per_grade(self) -> None:
        """每个学段都要走全 8 章（章节号 1..8 连续出现，没有多余章号）。"""
        by_grade: dict[str, set[int]] = defaultdict(set)
        for doc in self.docs:
            head, _, tail = doc.chapter_title.partition("章")
            self.assertTrue(head.startswith("第"), f"{doc.kp_id} 的章节标题没有章号：{doc.chapter_title!r}")
            self.assertTrue(tail.strip(), f"{doc.kp_id} 的章节标题缺少章名：{doc.chapter_title!r}")
            by_grade[doc.grade_level].add(int(head[1:]))
        expected = set(range(1, len(CHAPTERS) + 1))
        for grade, numbers in by_grade.items():
            with self.subTest(grade=grade):
                self.assertEqual(numbers, expected, f"{grade} 的章节号不完整：{sorted(numbers)}")


# --------------------------------------------------------------------------- #
# 3. 分块元数据（入库后没有空字段；父子链完整；父块尺寸契约）
# --------------------------------------------------------------------------- #
class TestChunkMetadata(ContentMatrixCase):
    """入库后的 chunk 元数据没有空字段（票 23 验收明确点名这一条）。"""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        from app.config import EMBEDDING_DIM, EMBEDDING_MODEL_DIR
        from app.rag import chunker
        from app.store.connections import connect, load_sqlite_vec, vec_available
        from app.store.migrations import ensure_kb
        from tests.test_store import FakeEmbedder

        # ★ token 计数优先用**真实分词器**；本机没下模型时退回估算，**不跳过** ——
        #   本类断言的是「打包与拆分遵守了尺寸契约」，而契约是相对**同一个计数器**成立的
        #   （建库与校验用同一个），所以两种计数器下都必须通过。
        counter, note = chunker.resolve_token_counter(EMBEDDING_MODEL_DIR)
        cls.counter_note = note

        cls._tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls._tmp.cleanup)
        kb_path = Path(cls._tmp.name) / "shared" / "kb.sqlite"
        import build_kb  # scripts/build_kb.py

        cls.result = build_kb.build(
            Path(KNOWLEDGE_DIR),
            kb_path,
            embedder=FakeEmbedder(),
            counter=counter,
            print_report=False,
        )
        cls.conn = connect(kb_path, load_vec=False)
        cls.addClassCleanup(cls.conn.close)
        try:
            load_sqlite_vec(cls.conn)
        except Exception:  # noqa: BLE001 - 夹具库不建向量也不影响元数据断言
            pass
        ensure_kb(cls.conn, dim=EMBEDDING_DIM, vec_ready=vec_available(cls.conn))

    def test_chunk_metadata_has_no_empty_fields(self) -> None:
        rows = list(
            self.conn.execute(
                "SELECT chunk_id, grade_level, knowledge_point, chapter_title, section_title, "
                "content_type, token_count FROM chunk"
            )
        )
        self.assertTrue(rows, "chunk 表为空")
        for row in rows:
            with self.subTest(chunk=row["chunk_id"]):
                for field in ("grade_level", "knowledge_point", "section_title", "chapter_title"):
                    self.assertTrue(
                        str(row[field]).strip(),
                        f"{row['chunk_id']} 的 {field} 为空（检索隔离会因此失效）",
                    )
                self.assertGreater(int(row["token_count"]), 0)
                self.assertIn(str(row["grade_level"]), GRADE_LEVELS)

    def test_every_kp_has_chunks_and_parent_child_link_is_intact(self) -> None:
        kp_ids = {
            str(r["knowledge_point"])
            for r in self.conn.execute("SELECT DISTINCT knowledge_point FROM chunk")
        }
        self.assertEqual(
            set(self.by_id) - kp_ids,
            set(),
            f"以下知识点没有入库任何 chunk：{sorted(set(self.by_id) - kp_ids)}",
        )
        orphans = list(
            self.conn.execute(
                "SELECT c.chunk_id FROM chunk c WHERE c.parent_chunk_id IS NOT NULL "
                "AND NOT EXISTS (SELECT 1 FROM chunk p WHERE p.chunk_id = c.parent_chunk_id)"
            )
        )
        self.assertEqual(orphans, [], f"子块的父块不存在：{orphans}")

    def test_every_kp_has_a_parent_block_and_a_searchable_child_block(self) -> None:
        """每个知识点至少一个**父块**（回填上下文）与至少一个**子块**（检索单元）。"""
        rows = self.conn.execute(
            "SELECT knowledge_point, SUM(is_parent) AS parents, SUM(1 - is_parent) AS children "
            "FROM chunk GROUP BY knowledge_point"
        ).fetchall()
        self.assertEqual(len(rows), len(self.by_id), "有知识点没进 chunk 表")
        for row in rows:
            with self.subTest(kp=row["knowledge_point"]):
                self.assertGreaterEqual(int(row["parents"]), 1, "没有父块 → 命中后回填不到完整上下文")
                self.assertGreaterEqual(int(row["children"]), 1, "没有子块 → 该知识点永远检索不到")

    def test_parent_blocks_respect_the_size_contract(self) -> None:
        """节级父块尺寸契约：**不得超上限**；短块只能是「文档唯一块」或「文档最后一块」。

        ★ 口径修正（2026-09-19 接入 K12KnowledgeBase）：旧断言要求**每一个**父块都落进
          300–600 token。新教材小学低年级每篇正文只有 100–190 字，一个节级块本来就只有
          一百多 token；强行凑到 300 只能靠跨知识点拼接或灌水 —— 那会让「命中回父块」
          反而注入无关内容。``chunker.pack_blocks`` 的真实契约是**贪心打包 + 尾部收口**，
          所以允许「整篇只有一块」与「多块文档的最后一块」短于下限（没有可合并的邻居）。
          超上限则任何情况都不允许（超过就要继续拆）。
        """
        from app.rag.chunker import PARENT_MAX_TOKENS, PARENT_MIN_TOKENS

        parents: dict[str, list[tuple[str, int]]] = defaultdict(list)
        for row in self.conn.execute(
            "SELECT chunk_id, knowledge_point, token_count FROM chunk "
            "WHERE is_parent = 1 ORDER BY chunk_id"
        ):
            parents[str(row["knowledge_point"])].append((str(row["chunk_id"]), int(row["token_count"])))
        self.assertTrue(parents, "没有任何父块")

        over = [
            (kp, chunk_id, tokens)
            for kp, blocks in parents.items()
            for chunk_id, tokens in blocks
            if tokens > PARENT_MAX_TOKENS
        ]
        self.assertEqual(over, [], f"超过 {PARENT_MAX_TOKENS} token 的父块（应继续拆分）：{over}")

        # 短块只允许出现在**文档唯一一块**或**文档最后一块**的位置上
        unexplained = []
        for kp, blocks in parents.items():
            for index, (chunk_id, tokens) in enumerate(blocks):
                if tokens >= PARENT_MIN_TOKENS:
                    continue
                if len(blocks) == 1 or index == len(blocks) - 1:
                    continue
                unexplained.append((kp, chunk_id, tokens, index, len(blocks)))
        self.assertEqual(
            unexplained,
            [],
            f"短于 {PARENT_MIN_TOKENS} token 的父块出现在文档中间（既不是唯一块也不是尾块）：{unexplained}",
        )


# --------------------------------------------------------------------------- #
# 4. 依赖图的内容覆盖视角（内容有没有接进图；图算法本身见 tests/test_graph.py）
# --------------------------------------------------------------------------- #
class TestDependencyGraph(ContentMatrixCase):
    def test_no_dangling_edges(self) -> None:
        """悬空引用必须为零（build_kb 会中止，但这里给出更短的反馈回路）。"""
        known = set(self.by_id)
        dangling = [
            f"{edge.from_kp_id}→{edge.to_kp_id}"
            for edge in self.manifest.dependencies
            if edge.from_kp_id not in known or edge.to_kp_id not in known
        ]
        self.assertEqual(dangling, [], f"依赖边引用了不存在的知识点：{dangling}")

    def test_no_isolated_knowledge_points(self) -> None:
        """★ 每个知识点都要接进图：孤立点意味着它永远不会被推荐、也不会被扩展。

        这条对「内容补齐」特别关键 —— 新写的知识点如果没加依赖边，
        它就只能靠检索偶然命中，冷启动关卡路径与推荐路径里都看不到它。
        """
        connected: set[str] = set()
        for edge in self.manifest.dependencies:
            connected.update((edge.from_kp_id, edge.to_kp_id))
        isolated = sorted(set(self.by_id) - connected)
        self.assertEqual(isolated, [], f"以下知识点没有任何依赖边（孤立点）：{isolated}")

    def test_every_concept_has_its_four_grade_chain(self) -> None:
        """★ 每个概念都要有 ``pl → ph → jr → sr`` 的 prerequisite 链。

        这条链是「学段之间的衔接」在内容层的**唯一**证据：缺一环，
        学生从低学段升上去时就少了一条正式的进阶路径（图看起来仍然连通）。
        """
        prerequisite_pairs = {
            (edge.from_kp_id, edge.to_kp_id)
            for edge in self.manifest.dependencies
            if edge.relation == "prerequisite"
        }
        steps = tuple(zip(GRADE_LEVELS, GRADE_LEVELS[1:]))  # (pl, ph) (ph, jr) (jr, sr)
        missing: list[str] = []
        for concept in sorted({kp_id.rsplit("-", 1)[0] for kp_id in self.by_id}):
            for lower, upper in steps:
                pair = (f"{concept}-{GRADE_SUFFIX[lower]}", f"{concept}-{GRADE_SUFFIX[upper]}")
                if pair not in prerequisite_pairs:
                    missing.append("→".join(pair))
        self.assertEqual(missing, [], f"以下概念的四学段链条缺环：{missing}")

    def test_each_grade_subgraph_is_connected(self) -> None:
        """★ 四学段各自是一张**连通图**（不是四个互不相通的孤岛）。

        新库的连法是「概念内四学段成链 + 概念间按同学段 related 相连」，
        所以每个学段内部应当连通。某个学段裂成两块，说明它的概念群没有接起来 ——
        另一块里的知识点在图上「够不着」，推荐路径会中途断掉。
        """
        successors: dict[str, set[str]] = defaultdict(set)
        for edge in self.manifest.dependencies:
            successors[edge.from_kp_id].add(edge.to_kp_id)
            successors[edge.to_kp_id].add(edge.from_kp_id)  # 连通性按无向看

        by_grade = self.docs_by_grade()
        for grade, docs in by_grade.items():
            ids = {doc.kp_id for doc in docs}
            reached = {docs[0].kp_id}
            frontier = [docs[0].kp_id]
            while frontier:
                node = frontier.pop()
                for neighbour in successors.get(node, ()):
                    if neighbour in ids and neighbour not in reached:
                        reached.add(neighbour)
                        frontier.append(neighbour)
            with self.subTest(grade=grade):
                self.assertEqual(
                    sorted(ids - reached),
                    [],
                    f"{grade} 的子图裂开了，这些知识点与其余部分不相通：{sorted(ids - reached)}",
                )

    def test_prerequisites_never_go_upwards_in_grade(self) -> None:
        """★ 严谨性检查：**前置不能是更高学段的内容**。

        方向反了（把「后继」当前置）会让检索扩展把超纲内容补进上下文，
        而图上看起来完全正常 —— 这条断言专门盯住那个静默错误。
        允许同/更低学段互为前置，但不允许「小学的内容前置是高中」。
        """
        offenders: list[str] = []
        for edge in self.manifest.dependencies:
            if edge.relation != "prerequisite":
                continue
            src = self.by_id.get(edge.from_kp_id)
            dst = self.by_id.get(edge.to_kp_id)
            if src is None or dst is None:
                continue
            if grade_index(src.grade_level) > grade_index(dst.grade_level):
                offenders.append(
                    f"{edge.from_kp_id}({src.grade_level}) → {edge.to_kp_id}({dst.grade_level})"
                )
        self.assertEqual(offenders, [], f"前置比后继学段更高（方向疑似写反）：{offenders}")


# --------------------------------------------------------------------------- #
# 5. 语气与骨架分化（四学段不能只改难度数字）
# --------------------------------------------------------------------------- #
class TestToneDifferentiation(ContentMatrixCase):
    """四学段语气必须**真的不同**，不能只改难度数字。

    检查器只能保证「初高中不出现『小朋友』」这类**禁止项**；
    这里补两类正向证据：**正文骨架**（每一学段有自己的节标题）与**语气标记词**。
    """

    #: 学段 → 必须出现的语气标记（any-of；与上的正文骨架互为补充）
    EXPECTED: dict[str, tuple[str, ...]] = {
        "primary_low": ("小朋友", "就像"),
        "primary_high": ("好比", "就像"),
        "junior": ("例如", "我们"),
        "senior": ("工程", "评估"),
    }

    def test_each_grade_has_its_own_body_skeleton(self) -> None:
        """★ 每一篇正文都要用**本学段**的节标题骨架（实测 228/228 篇各只有一节）。

        这条是「语气分化」最硬的结构性证据：四个学段若共用同一套小节，
        就说明内容只是同一篇改了几个数字 —— 那正是 §10.5 明令禁止的。
        """
        for grade, hallmark in GRADE_SKELETON.items():
            docs = [doc for doc in self.docs if doc.grade_level == grade]
            self.assertTrue(docs, f"{grade} 没有任何内容")
            missing = [doc.kp_id for doc in docs if not doc.sections or doc.sections[0].title != hallmark]
            with self.subTest(grade=grade):
                self.assertEqual(
                    missing,
                    [],
                    f"{grade} 的这些正文没有用本学段的骨架「{hallmark}」开头：{missing}",
                )

    def test_each_grade_uses_its_own_register(self) -> None:
        for grade, markers in self.EXPECTED.items():
            corpus = "\n".join(body_of(d) for d in self.docs if d.grade_level == grade)
            with self.subTest(grade=grade):
                self.assertTrue(corpus, f"{grade} 没有任何内容")
                hits = [marker for marker in markers if marker in corpus]
                self.assertTrue(
                    hits,
                    f"{grade} 的正文里找不到任何本学段语气标记 {markers}（语气分化退化成只改难度数字）",
                )

    def test_tone_does_not_collapse_across_grades(self) -> None:
        """高中/初中正文里不得出现小学低年级的口语称呼（对应的正向检查在正文骨架那条）。"""
        for grade in ("junior", "senior"):
            corpus = "\n".join(body_of(d) for d in self.docs if d.grade_level == grade)
            for word in ("小朋友", "宝贝", "小可爱"):
                with self.subTest(grade=grade, word=word):
                    self.assertNotIn(word, corpus, f"{grade} 正文出现「{word}」，学段语气错位")
        # 反向对照：这个称呼在小低语料里**确实存在**，否则上面那条只是「词表里没这个词」
        low = "\n".join(body_of(d) for d in self.docs if d.grade_level == "primary_low")
        self.assertIn("小朋友", low, "小学低年级的语料里没有「小朋友」，语气正向证据缺失")


if __name__ == "__main__":
    unittest.main()
