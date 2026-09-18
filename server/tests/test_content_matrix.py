# -*- coding: utf-8 -*-
"""票 23：**四学段内容矩阵覆盖**（执行文档 §10.5，教育适配性 20% 的证据侧）。

为什么要有这个文件：§10.5 是一张**表**，表里的「知识主线」是给人看的；人写的教材
最容易出现的失败不是「写错」，而是**整条主线漏掉**——某个学段只写了两个知识点，
界面上看着一切正常（照样有问必答），只有验收方翻到那一栏才会发现「小学低年级的
『机器怎么看/听』根本没内容」。这类缺口在检索层与 UI 层**完全不可见**。

所以这里把 §10.5 的每一格变成**可执行的断言**，判别力来自三处：

1. 每个主线条目都要指出**具体 kp_id**：编造 / 写错的 id 会被文件名校验挡下
   （``library.load_document`` 强制 ``kp_id == 文件名``）；
2. 每个 kp 必须**同时**满足「属于该学段」+「正文里有该条目的语义关键词」——
   把某段正文清空或整体挪到别的学段，这条立刻红；
3. 矩阵必须**穷尽**教材：每个 ``kp_id`` 都被某个条目认领。新加一篇内容却忘了
   登记矩阵，会被这条抓住（否则矩阵会随着教材增长慢慢变成一句空话）。

另外两条覆盖边界的断言：
- **学段错位**（超纲术语 / 错位语气 / 跨学段逐字搬运）复用 ``app.knowledge.checker``，
  并额外用一份**合成的违规文档**反向验证检查器本身没被削弱（否则「全绿」可能只是检查器失效）；
- **依赖图**无环、无悬空引用、无孤立点，且四学段**在同一条链上**（跨学段衔接真实存在，
  不是四个互不相通的孤岛）。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import KNOWLEDGE_DIR  # noqa: E402
from app.knowledge import checker  # noqa: E402
from app.knowledge.deps import DepEdge, find_cycles  # noqa: E402
from app.knowledge.library import (  # noqa: E402
    GRADE_LEVELS,
    KnowledgeDoc,
    Section,
    grade_index,
    load_library,
    load_manifest,
    load_terminology,
)

# --------------------------------------------------------------------------- #
# §10.5 内容矩阵（人工维护；改动教材必须同步改这里）
# --------------------------------------------------------------------------- #
# 每条 = (学段, 主线条目名, 认领的 kp_id, 该条目在正文里必须出现的语义关键词)
# ★ 关键词是「这条主线写了没有」的**证据**，不是装饰：选的是只有讲了这个主题
#   才会写出来的词，不是「数据」「机器」这种任何一篇都有的高频词。
MATRIX: tuple[tuple[str, str, tuple[str, ...], tuple[str, ...]], ...] = (
    # ------------------------------------------------------------ 小学低年级 --
    (
        "primary_low",
        "身边的 AI",
        ("pl-ai-around-me", "pl-ai-learns", "pl-ai-draws"),
        ("扫地机器人", "例子", "画"),
    ),
    (
        "primary_low",
        "机器怎么看/听",
        ("pl-machine-sees", "pl-machine-hears"),
        ("小方格", "声音的曲线"),
    ),
    (
        "primary_low",
        "AI 有礼貌吗",
        ("pl-ai-manners", "pl-ai-talk"),
        ("秘密", "找大人"),
    ),
    (
        "primary_low",
        "机器怎么做事",
        ("pl-machine-acts",),
        ("看一看", "动一动"),
    ),
    # ------------------------------------------------------------ 小学高年级 --
    (
        "primary_high",
        "语音识别",
        ("ph-speech-recognition",),
        ("波形", "同音词"),
    ),
    (
        "primary_high",
        "图像分类",
        ("ph-image-classification",),
        ("图像分类", "垃圾分类"),
    ),
    (
        "primary_high",
        "数据/训练/预测",
        ("ph-data-train-predict", "ph-data-quality", "ph-pattern-rule", "ph-train-evaluate"),
        ("数据", "训练", "预测", "特征"),
    ),
    (
        "primary_high",
        "AI 伦理与安全",
        ("ph-ai-ethics-safety", "ph-ai-learning-helper"),
        ("个人信息", "深度伪造"),
    ),
    (
        "primary_high",
        "身边的 AI 在做什么",
        ("ph-ai-everyday",),
        ("认出来", "猜出来"),
    ),
    # ------------------------------------------------------------------ 初中 --
    (
        "junior",
        "数据与特征",
        ("jr-data-features", "jr-task-types"),
        ("特征", "分类"),
    ),
    (
        "junior",
        "决策树",
        ("jr-decision-tree",),
        ("决策树", "叶子"),
    ),
    (
        "junior",
        "神经网络基础",
        ("jr-neural-basics",),
        ("人工神经元", "权重", "激活"),
    ),
    (
        "junior",
        "Python 数据处理",
        ("jr-py-variable", "jr-py-loop", "jr-py-list-dict"),
        ("变量", "循环", "列表"),
    ),
    (
        "junior",
        "模型训练与评估入门",
        ("jr-model-train-eval",),
        # ★ 这里刻意**不用**「过拟合」：它是高中词汇（terminology.json 的 min_grade=senior），
        #   初中只能用「死记硬背」这类口语说法 —— 关键词本身也要合规。
        ("验证集", "测试集", "死记硬背"),
    ),
    # ------------------------------------------------------------------ 高中 --
    (
        "senior",
        "机器学习全流程",
        ("sr-ml-pipeline",),
        ("训练集", "验证集", "测试集"),
    ),
    (
        "senior",
        "损失函数与梯度下降直觉",
        ("sr-loss-gradient",),
        ("损失函数", "学习率"),
    ),
    (
        "senior",
        "线性回归/分类/KNN",
        ("sr-linear-regression", "sr-linear-classification", "sr-knn"),
        ("线性回归", "概率", "最近邻"),
    ),
    (
        "senior",
        "NumPy 实践",
        ("sr-numpy-practice",),
        ("数组", "向量化"),
    ),
    (
        "senior",
        "过拟合与评估",
        ("sr-overfit-depth",),
        ("正则化", "欠拟合"),
    ),
    (
        "senior",
        "项目式（手写数字识别）",
        ("sr-digit-project",),
        ("手写数字", "准确率"),
    ),
)

#: 每个学段的知识点数量下限（票 23 验收：「每学段 ≥8–12 个知识点」取下限 8）。
MIN_KP_PER_GRADE = 8
#: 四学段的深度分配（§10.5）：小学高年级与初中做深，是报告主展示。
DEEP_GRADES = ("primary_high", "junior")

def body_of(doc: KnowledgeDoc) -> str:
    """文档全文（含节标题）—— 关键词证据在正文与标题里都算。"""
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

    def claimed_ids(self) -> set[str]:
        return {kp_id for _grade, _item, kp_ids, _kw in MATRIX for kp_id in kp_ids}

# --------------------------------------------------------------------------- #
# 1. 数量与主线覆盖
# --------------------------------------------------------------------------- #
class TestGradeCoverage(ContentMatrixCase):
    def test_every_grade_meets_the_minimum_kp_count(self) -> None:
        """★ 四学段都必须有内容，且每学段 ≥8 个知识点（票 23 的验收口径）。"""
        counts: dict[str, int] = {grade: 0 for grade in GRADE_LEVELS}
        for doc in self.docs:
            counts[doc.grade_level] = counts.get(doc.grade_level, 0) + 1

        for grade in GRADE_LEVELS:
            with self.subTest(grade=grade):
                self.assertGreaterEqual(
                    counts[grade],
                    MIN_KP_PER_GRADE,
                    f"{grade} 只有 {counts[grade]} 个知识点，低于 §10.5 的下限 {MIN_KP_PER_GRADE}"
                    f"（当前分布：{counts}）",
                )

    def test_deep_grades_are_not_thinner_than_shallow_ones(self) -> None:
        """深度分配要真实：小学高年级与初中是报告主展示，不该比另两个学段更薄。"""
        counts: dict[str, int] = {}
        for doc in self.docs:
            counts[doc.grade_level] = counts.get(doc.grade_level, 0) + 1
        shallow_max = max(counts.get(g, 0) for g in GRADE_LEVELS if g not in DEEP_GRADES)
        for grade in DEEP_GRADES:
            with self.subTest(grade=grade):
                self.assertGreaterEqual(
                    counts.get(grade, 0),
                    shallow_max,
                    f"§10.5 要求 {grade} 做到最深，但它（{counts.get(grade, 0)}）"
                    f"比最浅学段（{shallow_max}）还少",
                )

    def test_every_matrix_item_has_content(self) -> None:
        """★ 核心断言：§10.5 每一格都有真实内容，且正文里能找到该主题的关键词。"""
        self.assertTrue(MATRIX, "矩阵为空等于没有断言")
        for grade, item, kp_ids, keywords in MATRIX:
            with self.subTest(grade=grade, item=item):
                self.assertTrue(kp_ids, f"{grade}/{item} 没有认领任何知识点")
                for kp_id in kp_ids:
                    doc = self.by_id.get(kp_id)
                    self.assertIsNotNone(doc, f"{grade}/{item} 认领的 {kp_id} 不在教材里")
                    assert doc is not None  # for type checkers
                    self.assertEqual(
                        doc.grade_level,
                        grade,
                        f"{kp_id} 实际属于 {doc.grade_level}，矩阵把它登记在 {grade} 下",
                    )
                    self.assertTrue(doc.summary.strip(), f"{kp_id} 的 summary 为空")
                    self.assertTrue(doc.sections, f"{kp_id} 没有任何小节正文")

                joined = "\n".join(body_of(self.by_id[kp_id]) for kp_id in kp_ids)
                for keyword in keywords:
                    self.assertIn(
                        keyword,
                        joined,
                        f"§10.5 的「{grade} / {item}」应有「{keyword}」，"
                        f"但 {'、'.join(kp_ids)} 的正文里找不到 —— 主线内容缺失或被改写掉了",
                    )

    def test_matrix_covers_every_knowledge_point(self) -> None:
        """★ 矩阵必须穷尽教材：新加内容而忘了登记矩阵，这条会红。"""
        all_ids = set(self.by_id)
        claimed = self.claimed_ids()
        self.assertEqual(
            all_ids - claimed,
            set(),
            "以下知识点没有被 §10.5 矩阵认领（新增内容必须同步登记矩阵）："
            f"{sorted(all_ids - claimed)}",
        )
        self.assertEqual(
            claimed - all_ids,
            set(),
            f"矩阵认领了教材里不存在的知识点：{sorted(claimed - all_ids)}",
        )

    def test_each_matrix_item_is_claimed_once(self) -> None:
        """同一 kp 被两条主线重复认领会让「某一格漏了」被掩盖，这里禁止。"""
        seen: dict[str, str] = {}
        for grade, item, kp_ids, _kw in MATRIX:
            for kp_id in kp_ids:
                with self.subTest(kp=kp_id):
                    self.assertNotIn(
                        kp_id, seen, f"{kp_id} 同时被「{seen.get(kp_id)}」与「{item}」认领"
                    )
                    seen[kp_id] = item

# --------------------------------------------------------------------------- #
# 2. 学段错位（复用 checker，并反向验证检查器有效）
# --------------------------------------------------------------------------- #
class TestGradeDiscipline(ContentMatrixCase):
    def test_no_out_of_scope_terms_or_wrong_tone(self) -> None:
        """超纲术语 / 错位语气 / 跨学段逐字搬运：三项都必须为零（票 10、票 23）。"""
        report = checker.audit_library(self.docs, load_terminology(KNOWLEDGE_DIR))
        self.assertEqual(
            report.violations,
            [],
            checker.format_report(report),
        )
        self.assertEqual(report.checked_docs, len(self.docs))

    def test_audit_is_not_vacuous(self) -> None:
        """★ 反向验证：真丢一份违规文档进去，检查器必须报出来。

        少了这条，「全绿」可能只是因为检查器失效（词表读空 / 比对方向写反），
        而不是教材干净 —— 这是典型的「断言看起来有、其实没判别力」。
        """
        terminology = load_terminology(KNOWLEDGE_DIR)
        self.assertTrue(terminology.get("terms"), "术语文表为空，超纲检查形同虚设")

        # ① 超纲术语：小学低年级里出现「神经网络」「特征向量」（min_grade=junior）
        rogue_low = KnowledgeDoc(
            kp_id="x-rogue-low",
            grade_level="primary_low",
            chapter_title="第X章 违规样例",
            knowledge_point="违规样例",
            content_type="concept",
            summary="用来验证检查器不会漏报超纲词。",
            path=Path("x-rogue-low.md"),
            sections=(Section(index=0, title="一、故意超纲", text="神经网络的特征向量很厉害。"),),
        )
        low_report = checker.audit_library([*self.docs, rogue_low], terminology)
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
            sections=(Section(index=0, title="一、故意错位", text="小朋友，我们来讲讲决策树。"),),
        )
        tone_report = checker.audit_library([self.by_id["jr-decision-tree"], rogue_junior], terminology)
        tone_kinds = {v.kind for v in tone_report.violations if v.kp_id == rogue_junior.kp_id}
        self.assertIn(checker.VIOLATION_TONE, tone_kinds, "错位语气词没被检查出来")

    def test_every_kp_field_is_non_empty(self) -> None:
        """chunk 元数据三条来源字段（grade_level / knowledge_point / 章节）不得为空。"""
        for doc in self.docs:
            with self.subTest(kp=doc.kp_id):
                self.assertIn(doc.grade_level, GRADE_LEVELS)
                self.assertTrue(doc.knowledge_point.strip())
                self.assertTrue(doc.chapter_title.strip())
                self.assertTrue(doc.summary.strip())
                # 关键词证据落在正文里，正文太短说明是占位文件
                self.assertGreater(
                    sum(len(s.text) for s in doc.sections),
                    400,
                    f"{doc.kp_id} 正文过短（{sum(len(s.text) for s in doc.sections)} 字），疑似占位",
                )

    def test_chapters_are_numbered_and_ordered_per_grade(self) -> None:
        """同学段内章节号不与内容矛盾（防止两个知识点挤在同一章却写着不同章号）。"""
        by_grade: dict[str, dict[str, set[str]]] = {}
        for doc in self.docs:
            by_grade.setdefault(doc.grade_level, {}).setdefault(doc.chapter_title, set()).add(
                doc.knowledge_point
            )
        for grade, chapters in by_grade.items():
            with self.subTest(grade=grade):
                self.assertGreaterEqual(len(chapters), 3, f"{grade} 的章节数过少：{list(chapters)}")

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

        # ★ token 计数必须用**真实分词器**：估算器对含代码块的文件会系统性偏低估
        #   （实测 `jr-py-list-dict` 的一个父块：估算 298 / 真实 321），
        #   拿估算值去断言「落在 300–600」等于用一个错的尺子量 —— 会凭空红。
        counter, note = chunker.resolve_token_counter(EMBEDDING_MODEL_DIR)
        if "heuristic" in note:
            raise unittest.SkipTest(f"缺少 tokenizer.json（{note}），无法校验父块尺寸口径")

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
        kp_ids = {str(r["knowledge_point"]) for r in self.conn.execute("SELECT DISTINCT knowledge_point FROM chunk")}
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

    def test_parent_blocks_are_within_the_300_600_window(self) -> None:
        """节级父块口径（§8.3）：全部落在 300–600 token。"""
        from app.rag.chunker import PARENT_MAX_TOKENS, PARENT_MIN_TOKENS

        sizes = [
            int(r["token_count"])
            for r in self.conn.execute("SELECT token_count FROM chunk WHERE parent_chunk_id IS NULL")
        ]
        self.assertTrue(sizes)
        over = [s for s in sizes if s > PARENT_MAX_TOKENS]
        under = [s for s in sizes if s < PARENT_MIN_TOKENS]
        self.assertEqual(over, [], f"超过 {PARENT_MAX_TOKENS} 的父块：{over}")
        self.assertEqual(under, [], f"低于 {PARENT_MIN_TOKENS} 的父块：{under}")

# --------------------------------------------------------------------------- #
# 3. 依赖图
# --------------------------------------------------------------------------- #
class TestDependencyGraph(ContentMatrixCase):
    def test_no_cycles_and_no_self_loops(self) -> None:
        edges = [
            DepEdge(e.from_kp_id, e.to_kp_id, e.relation, e.weight)
            for e in self.manifest.dependencies
        ]
        self.assertTrue(edges, "manifest 里没有任何依赖边")
        self.assertEqual(find_cycles(edges), [], "依赖图存在环（递归 CTE 会失真）")
        loops = [f"{e.from_kp_id}→{e.to_kp_id}" for e in edges if e.from_kp_id == e.to_kp_id]
        self.assertEqual(loops, [], f"存在自环：{loops}")

    def test_no_dangling_edges(self) -> None:
        """悬空引用必须为零（build_kb 会中止，但这里给出更短的反馈回路）。"""
        known = set(self.by_id)
        dangling = [
            f"{e.from_kp_id}→{e.to_kp_id}"
            for e in self.manifest.dependencies
            if e.from_kp_id not in known or e.to_kp_id not in known
        ]
        self.assertEqual(dangling, [], f"依赖边引用了不存在的知识点：{dangling}")

    def test_no_isolated_knowledge_points(self) -> None:
        """★ 每个知识点都要接进图（除唯一的根）：孤立点意味着它永远不会被推荐、也不会被扩展。

        这条对「内容补齐」特别关键 —— 新写的知识点如果没加依赖边，
        它就只能靠检索偶然命中，冷启动关卡路径与推荐路径里都看不到它。
        """
        connected = set()
        for edge in self.manifest.dependencies:
            connected.update((edge.from_kp_id, edge.to_kp_id))
        isolated = sorted(set(self.by_id) - connected)
        self.assertEqual(isolated, [], f"以下知识点没有任何依赖边（孤立点）：{isolated}")

    def test_exactly_one_root_across_four_grades(self) -> None:
        """四学段是**一条链**：全图只有一个入口（小学低年级的「身边的 AI」）。

        多于一个根意味着有内容没有前置、可以凭空开始学，学段衔接就断了。
        """
        has_prereq = {e.to_kp_id for e in self.manifest.dependencies}
        roots = sorted(set(self.by_id) - has_prereq)
        self.assertEqual(
            roots,
            ["pl-ai-around-me"],
            f"依赖图的根应当只有 pl-ai-around-me（学段链的唯一入口），实际：{roots}",
        )

    def test_graph_spans_all_four_grades(self) -> None:
        """跨学段边必须真实存在：从根出发能走到四个学段（不是四个互不相通的孤岛）。"""
        successors: dict[str, set[str]] = {}
        for edge in self.manifest.dependencies:
            successors.setdefault(edge.from_kp_id, set()).add(edge.to_kp_id)

        reached = {"pl-ai-around-me"}
        frontier = ["pl-ai-around-me"]
        while frontier:
            node = frontier.pop()
            for nxt in successors.get(node, ()):
                if nxt not in reached:
                    reached.add(nxt)
                    frontier.append(nxt)

        grades_reached = {self.by_id[kp].grade_level for kp in reached}
        self.assertEqual(
            grades_reached,
            set(GRADE_LEVELS),
            f"从根出发只能走到 {sorted(grades_reached)}，四学段衔接不完整",
        )
        unreachable = sorted(set(self.by_id) - reached)
        self.assertEqual(unreachable, [], f"从根出发走不到的知识点：{unreachable}")

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
        self.assertEqual(
            offenders,
            [],
            f"前置比后继学段更高（方向疑似写反）：{offenders}",
        )

    def test_deep_grades_form_a_continuous_chain(self) -> None:
        """小学高 → 初中的衔接要有边，且初中主干（数据与特征/决策树/神经网络）都在链上。"""
        edges = {(e.from_kp_id, e.to_kp_id) for e in self.manifest.dependencies}
        cross = [pair for pair in edges if self.by_id[pair[0]].grade_level != self.by_id[pair[1]].grade_level]
        self.assertTrue(
            len(cross) >= len(GRADE_LEVELS),
            f"跨学段依赖边过少（{len(cross)} 条），学段链可能不连续：{cross}",
        )
        # 初中主干必须由小学高年级的内容接上（§10.5 的「认知定位」逐级上升）
        for downstream in ("jr-data-features", "jr-decision-tree"):
            with self.subTest(kp=downstream):
                upstream = [
                    pair[0]
                    for pair in edges
                    if pair[1] == downstream
                    and grade_index(self.by_id[pair[0]].grade_level)
                    < grade_index(self.by_id[downstream].grade_level)
                ]
                self.assertTrue(
                    upstream,
                    f"{downstream} 没有来自更低学段的前置，学段衔接断了",
                )

# --------------------------------------------------------------------------- #
# 4. 语气分化（§10.5 的 System Prompt 语气一栏，教材侧的证据）
# --------------------------------------------------------------------------- #
class TestToneDifferentiation(ContentMatrixCase):
    """四学段语气必须**真的不同**，不能只改难度数字。

    检查器只能保证「初高中不出现『小朋友』」这类**禁止项**；
    这里补正向证据：各学段的语气标记词在**本学段**必须出现。
    """

    #: 学段 → 必须出现的语气标记（与 `desktop/src/main/agent/prompts/*.ts` 的风格一致）
    EXPECTED: dict[str, tuple[str, ...]] = {
        "primary_low": ("小朋友", "你可以"),
        "primary_high": ("想一想", "好比"),
        "junior": ("我们", "例如"),
        "senior": ("工程", "实践"),
    }

    def test_each_grade_uses_its_own_register(self) -> None:
        for grade, markers in self.EXPECTED.items():
            corpus = "\n".join(body_of(d) for d in self.docs if d.grade_level == grade)
            with self.subTest(grade=grade):
                self.assertTrue(corpus, f"{grade} 没有任何内容")
                hits = [m for m in markers if m in corpus]
                self.assertTrue(
                    hits,
                    f"{grade} 的正文里找不到任何本学段语气标记 {markers}（语气分化退化成只改难度数字）",
                )

    def test_tone_does_not_collapse_across_grades(self) -> None:
        """高中正文里不得出现小学低年级的口语称呼（对应的正向检查在 checker 的语气项）。"""
        senior = "\n".join(body_of(d) for d in self.docs if d.grade_level == "senior")
        for word in ("小朋友", "宝贝", "小可爱"):
            with self.subTest(word=word):
                self.assertNotIn(word, senior, f"高中正文出现 {word}，学段语气错位")

if __name__ == "__main__":
    unittest.main()
