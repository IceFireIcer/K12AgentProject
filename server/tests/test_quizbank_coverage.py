# -*- coding: utf-8 -*-
"""题库覆盖率守卫：**闯关路径上的每个知识点都必须有题**（关卡 E 的缺口修复）。

这道缺口的真实形态（历史实测）：

- 知识主线早已从 33 个知识点扩到 **228 个**（新库 K12KnowledgeBase：57 个概念 × 四学段），
  而 ``server/resources/quizbank/*.json`` 只覆盖了其中一部分；
- 关卡路径按**依赖图拓扑序**走一遍，于是路径上有多少关就有多少关可能取不到题（404），
  解锁链在某一关断掉；
- 没有 API Key 时编排层没有 LLM 兜底 → 学生撞上死胡同
  （25% 多模态 + 15% 体验分的闭环断了）。

★ 后续修复（同一缺口的第二层）：题库补齐之后，**关卡路径仍可能走全图**，
  而取题按学段隔离 —— 于是 ``primary_high`` 学生的路径里会混进初中/高中内容，
  取题全部 404（普通游玩即可走到）。修法是**把路径与解锁也按学生学段过滤**
  （与 :func:`select_questions` 同一个 ``compatible_grades`` 判据），
  见 ``test_quiz_loop.py::TestPathIsScopedToTheStudentsGrade`` 的真实走查。
  本文件补上**跨学段那一半**的守卫：该学生兼容范围内的 kp 必须**取得出来**，
  范围外必须**取不到**（隔离不许被放宽）。

★★ **题库分片形态换了一代（2026-09-19，随 K12KnowledgeBase 接入）**：
  旧形态是「一学段一文件」（``primary_low.json`` … ``senior.json``，现已删除），
  新形态是「**一章节一文件**」（``ch01.json`` … ``ch08.json``，共 684 题）——
  章分片**一个文件横跨四学段**，结构上给不出文件级 ``grade_level``，
  于是每题的学段由它自己的 ``kp_id`` 后缀决定（``<slug>-<pl|ph|jr|sr>``）。
  下面第 0 组把**两种形态都能读**这件事单独立成断言：漏掉新形态的后果实测过 ——
  五份章分片全被整文件跳过，覆盖率静默掉到 0/228。

题库加载器（``load_bank``）对坏题**只跳过、不抛异常**——这是为现场演示做的取舍，
但它带来一个副作用：**一条写错的题会静默消失**，覆盖率悄悄掉一格而没人发现。
所以本文件盯住四件事：

1. ★ **覆盖率**：教材里每个 kp 在题库里至少 2 题（不达标即红）；
2. ★ **不许静默丢题**：原始 JSON 的题数必须等于加载成功的题数（``skipped`` 为空）,
   每一条都单独 ``model_validate`` 过一遍 —— 某个字段拼错会**当场炸**，而不是被跳过;
3. ★ **结构上不泄漏答案**：把**每一条**题库记录经 ``QuizPayload.from_internal``
   投影成对外载荷，再**递归遍历嵌套键**（不是只看顶层）断言没有 ``answer``;
   并附反向对照（内部模型确实有 ``answer``），证明这个「没有」不是字段压根不存在;
4. ★ **覆盖率断言不是空转**：临时造一份「少一个知识点」的题库，
   断言覆盖率检查**真的会变红**（``mutation check``）—— 少了这条，
   一个把 kp 集合读成空集的 bug 也能让「全覆盖」全绿。

夹具用**真的** ``server/resources/quizbank/`` 与真的 ``server/knowledge/``：
要盯住的正是这两份内容资产之间的覆盖关系，用假数据测不出缺口。
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import KNOWLEDGE_DIR  # noqa: E402
from app.contracts import QuizPayload, QuizQuestion, QuizQuestionOut  # noqa: E402
from app.knowledge.library import GRADE_LEVELS, compatible_grades, load_library  # noqa: E402
from app.routes.quiz import (  # noqa: E402
    default_bank_dir,
    grade_from_kp_id,
    load_bank,
    select_questions,
)

BANK_DIR = default_bank_dir()

#: 每个知识点至少要有的题数（票 15 的验收口径：一关至少要练两道才算「过关」）。
MIN_QUESTIONS_PER_KP = 2

#: 对外题目**封闭字段集**（``QuizQuestionOut``）。多一个都算契约外字段，少一个前端就缺信息。
OUTWARD_QUESTION_FIELDS = {"qid", "kpId", "type", "stem", "options", "explanation"}

#: ★ 答案类的**键名**（不管出现在哪一层，都不许进对外载荷）。
#: 与 ``test_contracts.py`` 的答案泄漏哨兵同源：契约里查的就是这几个字段名。
#: ``explanation`` 不在此列 —— 它是契约字段，本来就要发给学生当反馈。
LEAK_KEY_NAMES = {
    "answer",
    "answers",
    "referenceanswer",
    "reference_answer",
    "correctanswer",
    "correct_answer",
    "answerkey",
    "answer_key",
    "solution",
    "rubric",
}

#: 三种允许的题型（第一版范围）。题库文件里出现第四种（例如 ``multi_choice``）
#: 虽然会被 ``load_bank`` 挡成坏题，但那属于「静默丢失」，这里要正面判一次。
ALLOWED_TYPES = {"choice", "blank", "code_blank"}


# --------------------------------------------------------------------------- #
# 覆盖率判据（唯一实现：测试与 mutation check 共用同一个函数，避免两份口径）
# --------------------------------------------------------------------------- #
def knowledge_points() -> dict[str, str]:
    """教材里全部知识点 → 学段。"""
    return {doc.kp_id: doc.grade_level for doc in load_library(KNOWLEDGE_DIR)}


def questions_per_kp(bank_dir: Path | str) -> dict[str, int]:
    """题库里每个 kp 有几道题（**只统计加载成功的**）。"""
    counts: dict[str, int] = {}
    for entry in load_bank(bank_dir).entries:
        counts[entry.question.kp_id] = counts.get(entry.question.kp_id, 0) + 1
    return counts


def uncovered_kp_ids(bank_dir: Path | str, *, minimum: int = MIN_QUESTIONS_PER_KP) -> list[str]:
    """题数少于 ``minimum``（含 0 = 完全没题）的知识点，按 id 排序。

    这是**本文件唯一的覆盖率判据**：``TestBankCoverage`` 与 mutation check
    都调它，所以「测试怎么算覆盖」和「变异检查怎么算覆盖」不可能漂移成两套。
    """
    counts = questions_per_kp(bank_dir)
    return sorted(
        kp_id for kp_id in knowledge_points() if counts.get(kp_id, 0) < minimum
    )


def raw_questions(bank_dir: Path | str) -> list[tuple[str, dict]]:
    """原始 JSON 里的题目（**不经过 pydantic**），返回 ``(文件名, 原始条目)``。

    用途：和加载成功的题数对账。一条字段拼错的题会被 ``load_bank`` 静默跳过，
    只有拿原始文件数对比才能发现「少了一道」。
    """
    out: list[tuple[str, dict]] = []
    for path in sorted(Path(bank_dir).glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        for item in raw.get("questions") or []:
            out.append((path.name, item))
    return out


# --------------------------------------------------------------------------- #
# 0. ★ 两种分片形态都能读（章分片 / 一学段一文件）
# --------------------------------------------------------------------------- #
class TestBankReadsBothShardForms(unittest.TestCase):
    """★ ``load_bank`` 必须同时认两种分片形态，且**都不许静默丢题**。

    形态 ①（旧）：**一学段一文件** —— 文件级 ``grade_level``，文件里所有题同属一个学段；
    形态 ②（新，2026-09-19 起随包分发）：**一章节一文件** —— 文件级 ``chapter``，
    文件横跨四学段，每题的学段由 ``kp_id`` 后缀推导（``<slug>-<pl|ph|jr|sr>``）。

    为什么两种都要留着测：① 是**已发布过的格式**（学生自己导入的题库、
    旧的手写题库文件都长这样），loader 回退到只认一种就会把另一边整文件丢掉；
    ② 是**当前随包格式**。丢任何一种的表现都是「取题 404」，而 ``skipped`` 里只有一行字。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    @staticmethod
    def _question(qid: str, kp_id: str, *, qtype: str = "blank") -> dict:
        body: dict = {
            "qid": qid,
            "kp_id": kp_id,
            "type": qtype,
            "stem": f"{qid} 的题干",
            "answer": "答案",
            "explanation": "讲解。",
        }
        if qtype == "choice":
            body["options"] = ["选项甲", "选项乙"]
        return body

    def _write(self, name: str, payload: dict) -> Path:
        path = self.tmp / name
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def test_legacy_grade_level_file_still_loads(self) -> None:
        """① 一学段一文件：文件级 ``grade_level`` 决定整文件的学段。"""
        self._write(
            "junior.json",
            {
                "version": 1,
                "grade_level": "junior",
                "questions": [
                    self._question("legacy-jr-q1", "prog-loop-jr", qtype="choice"),
                    self._question("legacy-jr-q2", "ai-definition-jr"),
                ],
            },
        )
        report = load_bank(self.tmp)
        self.assertEqual(report.skipped, [], "一学段一文件的形态被整文件跳过了")
        self.assertEqual(len(report.entries), 2)
        self.assertEqual({entry.grade_level for entry in report.entries}, {"junior"})

    def test_chapter_shard_loads_and_derives_grade_from_kp_id(self) -> None:
        """② 章分片：文件级没有 ``grade_level``，每题学段由 ``kp_id`` 后缀推导。"""
        self._write(
            "ch99.json",
            {
                "version": 1,
                "chapter": "第99章 测试用章",
                "notes": "夹具",
                "questions": [
                    self._question("shard-pl-q1", "ai-definition-pl"),
                    self._question("shard-sr-q1", "ai-definition-sr"),
                ],
            },
        )
        report = load_bank(self.tmp)
        self.assertEqual(report.skipped, [], "章分片被整文件跳过了（每题的学段推不出来？）")
        grades = {entry.question.qid: entry.grade_level for entry in report.entries}
        self.assertEqual(
            grades,
            {"shard-pl-q1": "primary_low", "shard-sr-q1": "senior"},
            "章分片的学段必须逐题按 kp_id 后缀推导（不是整文件一个学段）",
        )

    def test_both_forms_load_in_one_directory(self) -> None:
        """两种形态**共存**也要全部读到（切格式期间两份文件会同时在目录里）。"""
        self._write(
            "junior.json",
            {
                "version": 1,
                "grade_level": "junior",
                "questions": [self._question("mixed-legacy-q1", "prog-loop-jr")],
            },
        )
        self._write(
            "ch99.json",
            {
                "version": 1,
                "chapter": "第99章 测试用章",
                "questions": [self._question("mixed-shard-q1", "prog-loop-ph")],
            },
        )
        report = load_bank(self.tmp)
        self.assertEqual(report.skipped, [])
        self.assertEqual(len(report.entries), 2)
        self.assertEqual(
            {entry.question.qid for entry in report.entries},
            {"mixed-legacy-q1", "mixed-shard-q1"},
        )

    def test_chapter_shard_with_unrecognisable_kp_suffix_is_skipped_and_reported(self) -> None:
        """★ 章分片里 ``kp_id`` 推不出学段 → **必须跳过并报出来**，不许默认成某个学段。

        默认学段是「学段隔离开天窗」的形态：小学低年级的题可能被当成高中的题取出去。
        所以这张网要一直张着（``skipped`` 里必须能看到它），而不是静默收下。
        """
        self._write(
            "ch98.json",
            {
                "version": 1,
                "chapter": "第98章 测试用章",
                "questions": [self._question("bad-suffix-q1", "no-grade-suffix")],
            },
        )
        report = load_bank(self.tmp)
        self.assertEqual(report.entries, [], "推不出学段的题不该被收下")
        self.assertEqual(len(report.skipped), 1, f"跳过要报出来：{report.skipped}")
        self.assertIn("bad-suffix-q1", report.skipped[0])

    def test_shipped_bank_is_chapter_sharded_and_every_grade_matches_the_library(self) -> None:
        """★ 随包题库是**章分片**，且逐题推出来的学段与教材 front matter 一致。

        这条把「后缀约定」与「教材真实学段」钉在一起：后缀写错（``ai-definition-pl``
        写成 ``ai-definition-jr``）会让「按学段取题」取到超纲或取不到，图上看不出来。
        """
        report = load_bank(BANK_DIR)
        self.assertTrue(report.entries, "随包题库空，这条断言会空转")
        self.assertEqual(report.files, sorted(report.files), "文件清单应按文件名稳定排序")
        doc_grade = {doc.kp_id: doc.grade_level for doc in load_library(KNOWLEDGE_DIR)}
        for entry in report.entries:
            with self.subTest(qid=entry.question.qid):
                derived = grade_from_kp_id(entry.question.kp_id)
                self.assertIsNotNone(
                    derived, f"{entry.question.qid}: kp_id {entry.question.kp_id!r} 没有学段后缀"
                )
                self.assertEqual(
                    entry.grade_level,
                    derived,
                    f"{entry.question.qid}: 文件的学段与 kp_id 后缀推导出来的不一致",
                )
                self.assertEqual(
                    derived,
                    doc_grade.get(entry.question.kp_id),
                    f"{entry.question.qid}: kp_id 后缀推出来的学段与教材里的不一致",
                )


# --------------------------------------------------------------------------- #
# 1. 题库自身干净：没有坏题、没有静默丢失
# --------------------------------------------------------------------------- #
class TestBankEntriesAreAllValid(unittest.TestCase):
    """★ 反向对照：一条题都不许在加载时被悄悄丢掉。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = load_bank(BANK_DIR)
        cls.raw = raw_questions(BANK_DIR)

    def test_bank_dir_exists_and_is_not_empty(self) -> None:
        self.assertTrue(BANK_DIR.is_dir(), f"题库目录不存在：{BANK_DIR}")
        self.assertTrue(self.report.entries, f"题库空：{BANK_DIR}")

    def test_no_entry_was_skipped(self) -> None:
        """加载器跳过的每一条都是**静默丢失**：现场演示不崩，但学生少一道题。"""
        self.assertEqual(self.report.skipped, [], f"题库有坏题被跳过：{self.report.skipped}")

    def test_raw_question_count_matches_loaded_count(self) -> None:
        """原始 JSON 的题数 == 加载成功的题数。

        这是「不许静默丢题」的**对账**：``skipped`` 为空只说明**已知的**坏题没有，
        而这条能发现「加载器根本没读到某个文件 / 某个文件 questions 不是数组」这类
        整体丢失。两条一起才闭环。
        """
        self.assertEqual(
            len(self.raw),
            len(self.report.entries),
            f"原始题数 {len(self.raw)} != 加载成功 {len(self.report.entries)}",
        )

    def test_every_raw_entry_parses_as_quiz_question(self) -> None:
        """逐条单独校验（不经 load_bank 的 try/except）。

        这是本文件里**唯一会为「字段拼错」当场失败**的断言：拼错 ``kpId``、
        写错 ``type``、漏掉 ``answer`` 都会抛 ``ValidationError``，
        而不是被跳过之后只在覆盖率上悄悄少一格。
        """
        for filename, item in self.raw:
            qid = item.get("qid") if isinstance(item, dict) else "?"
            with self.subTest(file=filename, qid=qid):
                question = QuizQuestion.model_validate(item)
                self.assertTrue(question.qid, f"{filename}/{qid}: qid 为空")
                self.assertTrue(question.kp_id, f"{filename}/{qid}: kpId 为空")
                self.assertTrue(question.stem, f"{filename}/{qid}: 题干为空")
                self.assertTrue(
                    question.explanation.strip(),
                    f"{filename}/{qid}: explanation 为空（它是面向学生的反馈，不能缺）",
                )

    def test_question_types_are_within_release_scope(self) -> None:
        """题型只许是第一版范围的三种。"""
        for filename, item in self.raw:
            with self.subTest(file=filename, qid=item.get("qid")):
                self.assertIn(
                    item.get("type"),
                    ALLOWED_TYPES,
                    f"{filename}/{item.get('qid')}: 题型 {item.get('type')!r} 超出第一版范围",
                )

    def test_choice_questions_have_at_least_two_options(self) -> None:
        """选择题必须真的能选：少于两个选项学生没法作答。"""
        for filename, item in self.raw:
            if item.get("type") != "choice":
                continue
            options = item.get("options") or []
            with self.subTest(file=filename, qid=item.get("qid")):
                self.assertGreaterEqual(
                    len(options), 2, f"{filename}/{item.get('qid')}: 选项不足两个"
                )

    def test_qids_are_unique_across_all_files(self) -> None:
        """qid 全局唯一：判分按 qid 查库，重号会让「做题 A、判分用 B 的答案」。"""
        qids = [item.get("qid") for _, item in self.raw]
        self.assertEqual(
            len(qids), len(set(qids)), f"题库里有重复 qid：{sorted(qids)}"
        )


# --------------------------------------------------------------------------- #
# 2. ★ 覆盖率：每个知识点至少 2 题
# --------------------------------------------------------------------------- #
class TestBankCoverage(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.kps = knowledge_points()
        cls.counts = questions_per_kp(BANK_DIR)

    def test_knowledge_base_is_non_empty(self) -> None:
        """先确认教材读到了东西 —— 否则下面的「全覆盖」是空集的真命题。"""
        self.assertGreater(len(self.kps), 0, f"教材里一个知识点都没读到：{KNOWLEDGE_DIR}")

    def test_every_knowledge_point_has_enough_questions(self) -> None:
        """★ 本文件的头号断言：教材里 228 个知识点一个都不能少。"""
        missing = uncovered_kp_ids(BANK_DIR)
        detail = "\n".join(
            f"  - {kp_id}（{self.kps.get(kp_id, '?')}）：现有 {self.counts.get(kp_id, 0)} 题"
            for kp_id in missing
        )
        self.assertEqual(
            missing,
            [],
            f"有 {len(missing)} 个知识点题数不足 {MIN_QUESTIONS_PER_KP} 道"
            f"（闯关路径会 404）：\n{detail}",
        )

    def test_no_question_points_at_a_dangling_kp(self) -> None:
        """题目的 kpId 必须能在教材里找到 —— 悬空引用是「查得到题但进不了关」。"""
        dangling = sorted(set(self.counts) - set(self.kps))
        self.assertEqual(
            dangling, [], f"题库里有题指向不存在的知识点：{dangling}"
        )

    def test_every_kp_question_lives_in_its_own_grade_file(self) -> None:
        """逐题学段必须与知识点学段一致，否则「按学段取题」会取不到或越级。

        ★ 判据换了一代：旧题库是「一学段一文件」，所以断言的是
          「``entry.grade_level`` 等于该题 kp 在教材里的学段」；新题库是**章分片**
          （一个文件横跨四学段），``entry.grade_level`` 是 loader 从 ``kp_id`` 后缀
          逐题推出来的 —— 于是这条断言的实际含义变成：
          **推导出来的学段 == 教材里那个知识点的学段**（教材是那个权威）。
          后缀写错、教材改了学段而题库没跟上，都会在这里当场变红。
        """
        docs = {kp_id: grade for kp_id, grade in self.kps.items()}
        for entry in load_bank(BANK_DIR).entries:
            with self.subTest(qid=entry.question.qid):
                self.assertEqual(
                    entry.grade_level,
                    docs.get(entry.question.kp_id),
                    f"{entry.question.qid}: 推导出的学段是 {entry.grade_level}，"
                    f"知识点却属于 {docs.get(entry.question.kp_id)}",
                )

    def test_every_grade_level_has_questions(self) -> None:
        """四个学段每个都要有题（整段缺失会让那个学段的学生拿到空题库）。"""
        grades = {entry.grade_level for entry in load_bank(BANK_DIR).entries}
        self.assertEqual(
            grades, set(GRADE_LEVELS), f"缺少学段的题：{set(GRADE_LEVELS) - grades}"
        )


# --------------------------------------------------------------------------- #
# 3. ★★ 学段可达性：题库的「可取出范围」必须与学段隔离一致（跨学段断言）
# --------------------------------------------------------------------------- #
class TestGradeReachabilityMatchesIsolation(unittest.TestCase):
    """★★ 「覆盖率」不能只看**题库里有题**，还要看**这个学段的学生取不取得到**。

    这是覆盖率守卫的**跨学段那一半**：上面的 ``test_every_knowledge_point_has_enough_questions``
    统计的是全库题数，而 ``/api/quiz/bank`` 走的是
    :func:`app.routes.quiz.select_questions` —— **按学段隔离取题**
    （本学段 + 更低学段，见 ``knowledge.library.compatible_grades``）。

    两者错位的失效形态正是本仓库踩过的那个死胡同：关卡路径若跨了学段，
    「覆盖率 33/33 全绿」也挡不住「路径上的某一关 404」。所以这里对四个学段各断言：

    1. ★ 该学生**兼容范围内**的每个知识点，都能经**真实取题函数**取到
       ≥ :data:`MIN_QUESTIONS_PER_KP` 道题（不是「库里存在」，而是「取得出来」）；
    2. ★ 该学生**兼容范围外**（= 更高学段）的知识点，取题结果为 **0** ——
       证明隔离没有被放宽（放宽隔离会把上一条变成「什么都取得到」的假绿）。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = load_bank(BANK_DIR)
        cls.kps = knowledge_points()

    def test_every_kp_in_scope_is_reachable_and_out_of_scope_is_not(self) -> None:
        self.assertTrue(self.report.entries, "题库为空，这条断言会空转")
        for grade_level in GRADE_LEVELS:
            allowed = set(compatible_grades(grade_level))
            with self.subTest(grade=grade_level):
                unreachable: list[str] = []
                leaked: list[str] = []
                for kp_id, kp_grade in sorted(self.kps.items()):
                    picked = select_questions(
                        self.report,
                        kp_id=kp_id,
                        grade_level=grade_level,
                        count=MIN_QUESTIONS_PER_KP,
                    )
                    if kp_grade in allowed:
                        if len(picked) < MIN_QUESTIONS_PER_KP:
                            unreachable.append(
                                f"{kp_id}（{kp_grade}）：只取到 {len(picked)} 道"
                            )
                    elif picked:
                        leaked.append(f"{kp_id}（{kp_grade}）：{grade_level} 学生取到了 {len(picked)} 道")

                self.assertEqual(
                    unreachable,
                    [],
                    f"★ {grade_level} 学生的兼容范围里有知识点取不到题"
                    f"（闯关路径会 404）：\n  "
                    + "\n  ".join(unreachable),
                )
                self.assertEqual(
                    leaked,
                    [],
                    f"★ 学段隔离被放宽了：{grade_level} 学生取到了更高学段的题：\n  "
                    + "\n  ".join(leaked),
                )

    def test_a_real_cross_grade_pair_is_blocked(self) -> None:
        """★ 具名复现：`primary_low` 取高中 kp 必须是空的（最强对照：小学低年级 ↔ 高中）。

        上一条是遍历式的；这一条把**真实存在的跨学段对子**写死，
        让「隔离真的卡在这条边上」这件事**不依赖遍历逻辑写对**也能被看见。
        """
        # 最强的那个对照：同一个概念的两端（小学低年级 ↔ 高中）
        self.assertEqual(self.kps.get("ai-definition-pl"), "primary_low")
        self.assertEqual(self.kps.get("ai-definition-sr"), "senior")

        blocked = select_questions(
            self.report, kp_id="ai-definition-sr", grade_level="primary_low", count=3
        )
        self.assertEqual(
            blocked, [], "★ 小学低年级学生不该取到高中的题（初中提问不得返回高中内容同理）"
        )
        ok = select_questions(
            self.report, kp_id="ai-definition-sr", grade_level="senior", count=3
        )
        self.assertGreaterEqual(
            len(ok), MIN_QUESTIONS_PER_KP, "前提：高中学生本来取得到这个 kp（否则上一条是空转）"
        )

        # 相邻学段那一对（小学高年级 → 初中）同样要卡住：这是「死胡同」里最常见的一跳
        self.assertEqual(self.kps.get("ai-definition-ph"), "primary_high")
        self.assertEqual(self.kps.get("ai-definition-jr"), "junior")
        self.assertEqual(
            select_questions(
                self.report, kp_id="ai-definition-jr", grade_level="primary_high", count=3
            ),
            [],
            "★ 小学高年级学生不该取到初中的题",
        )
        self.assertGreaterEqual(
            len(
                select_questions(
                    self.report, kp_id="ai-definition-jr", grade_level="junior", count=3
                )
            ),
            MIN_QUESTIONS_PER_KP,
            "前提：初中学生本来取得到这个 kp",
        )

        # 向上兼容方向仍然有效（高中生回看小学低年级的内容 = 复习，不是越级）
        review = select_questions(
            self.report, kp_id="ai-definition-pl", grade_level="senior", count=3
        )
        self.assertGreaterEqual(
            len(review), MIN_QUESTIONS_PER_KP, "★ 隔离不该把「回看更低学段」也一起卡掉"
        )


# --------------------------------------------------------------------------- #
# 4. ★★ 结构上不泄漏答案（逐条、递归遍历嵌套键）
# --------------------------------------------------------------------------- #
class TestOutwardPayloadNeverLeaksTheAnswer(unittest.TestCase):
    """把**每一条**题库记录投影成对外载荷，递归查嵌套键里有没有 ``answer``。

    ``test_quiz.py`` 已经有一条哨兵断言，但那条走的是**一条真题 + 一份临时题库**；
    这里补齐「**全部 684 条**题目逐条过一遍」，
    这样新加的内容若不小心改了投影路径（例如给 ``QuizQuestionOut`` 加了字段），
    当场就会被抓住。
    """

    @staticmethod
    def _all_keys(node) -> list[str]:
        """递归收集 JSON 里出现过的**所有**键名（含嵌套的 dict 与 list）。"""
        found: list[str] = []
        if isinstance(node, dict):
            for key, value in node.items():
                found.append(str(key))
                found.extend(TestOutwardPayloadNeverLeaksTheAnswer._all_keys(value))
        elif isinstance(node, list):
            for item in node:
                found.extend(TestOutwardPayloadNeverLeaksTheAnswer._all_keys(item))
        return found

    @classmethod
    def setUpClass(cls) -> None:
        cls.report = load_bank(BANK_DIR)

    def test_outward_model_has_no_answer_field(self) -> None:
        """模型层面：``QuizQuestionOut`` 结构上就没有 ``answer``。"""
        self.assertNotIn("answer", QuizQuestionOut.model_fields)
        self.assertNotIn("answer", QuizPayload.model_fields)

    def test_internal_model_really_has_the_answer(self) -> None:
        """★ 反向对照：内部模型**有** ``answer``。

        少了这条，上面那句「对外模型没有 answer」可能只是因为字段压根没被定义过 ——
        断言看着有、其实没有判别力。
        """
        self.assertIn("answer", QuizQuestion.model_fields)

    def test_no_answer_key_anywhere_in_any_projected_payload(self) -> None:
        """★ 逐条投影 + 递归遍历键名：684 条里任何一条都不许出现 ``answer`` 类键。

        ⚠️ 这里查的是**键名**，不是答案文本。原因：``explanation``（解析）按契约
        **本来就要发给学生**（``QuizQuestionOut`` 的字段之一，答题后当反馈用），
        而解析里天然会提到那个术语 —— 现有题库一直如此，做文本比对会误报。
        答案泄漏在本项目里的定义是「**结构上**存在一个装着标准答案的字段」，
        所以判据必须落在键名上。
        """
        self.assertTrue(self.report.entries, "题库为空，这条断言会空转")
        for entry in self.report.entries:
            question = entry.question
            payload = QuizPayload.from_internal(
                kp_id=question.kp_id, source="bank", questions=[question]
            )
            raw = payload.model_dump_json(by_alias=True, exclude_none=False)
            keys = self._all_keys(json.loads(raw))
            with self.subTest(qid=question.qid):
                leaks = sorted(set(keys) & LEAK_KEY_NAMES)
                self.assertEqual(
                    leaks, [], f"★ {question.qid} 的对外载荷出现答案类键：{leaks}\n{raw}"
                )
                # 白名单：题目字段必须**恰好**是那 6 个（多一个都算契约外字段）
                self.assertEqual(
                    set(payload.questions[0].model_dump(by_alias=True)),
                    OUTWARD_QUESTION_FIELDS,
                    f"{question.qid}: 对外字段集被改动",
                )

    def test_structural_guard_catches_a_hypothetical_leaky_projection(self) -> None:
        """★ 反向验证递归遍历**真的能发现**泄漏。

        造一个「把 answer 塞进 options 的注释里」的假载荷 —— 顶层键没有 ``answer``，
        但嵌套里有一个带 ``answer`` 的 dict。遍历器必须报出来，
        否则上面那条「全部没有」可能只是遍历器写错了。
        """
        leaky = {
            "kpId": "prog-loop-jr",
            "source": "bank",
            "questions": [
                {
                    "qid": "leak-q1",
                    "type": "blank",
                    "meta": {"answer": "哨兵答案"},
                    "options": [{"label": "A", "answer": "哨兵答案"}],
                }
            ],
        }
        keys = self._all_keys(leaky)
        self.assertIn("answer", keys, "递归遍历器漏掉了嵌套的 answer 键")


# --------------------------------------------------------------------------- #
# 5. ★ mutation check：覆盖率断言不能是空转
# --------------------------------------------------------------------------- #
class TestCoverageCheckIsNotVacuous(unittest.TestCase):
    """★ 把加载器指向一份「少一个知识点」的题库，覆盖率检查必须变红。

    变异检查想防的失效模式很具体：覆盖率函数如果把「教材的 kp 集合」读成了空集
    （路径写错 / 解析静默返回空），``uncovered == []`` 会**恒成立**，
    整组测试全绿而缺口还在——那才是最难发现的一类假绿。

    做法：把真题库复制到临时目录，删掉某一个 kp 的全部题目，
    然后断言 :func:`uncovered_kp_ids` 恰好报出那一个 kp。用完即删（``addCleanup``）。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _fixture_missing(self, drop_kp_id: str) -> Path:
        """复制真题库到临时目录，并删掉 ``drop_kp_id`` 的全部题目。"""
        target = self.tmp / "bank-mutated"
        target.mkdir()
        for path in sorted(BANK_DIR.glob("*.json")):
            raw = json.loads(path.read_text(encoding="utf-8"))
            raw["questions"] = [
                item
                for item in raw.get("questions") or []
                if item.get("kp_id") != drop_kp_id
            ]
            (target / path.name).write_text(
                json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        return target

    def test_real_bank_is_fully_covered(self) -> None:
        """底座：真题库确实是全覆盖的（否则下面那条变异断言就没有对照）。"""
        self.assertEqual(uncovered_kp_ids(BANK_DIR), [])

    def test_dropping_one_kp_makes_the_coverage_check_go_red(self) -> None:
        """★ 变异：删掉一个 kp 的题 → 覆盖率检查必须报出**恰好那一个**。"""
        covered = sorted(questions_per_kp(BANK_DIR))
        self.assertTrue(covered, "真题库一道题都没有，变异检查无从谈起")
        victim = covered[0]

        mutated = self._fixture_missing(victim)

        # ① 夹具真的被改了（不是复制失败/路径写错导致对着原库测）
        self.assertEqual(raw_questions(mutated), [
            (name, item)
            for name, item in raw_questions(BANK_DIR)
            if item.get("kp_id") != victim
        ], "变异夹具没有正确删掉目标知识点")
        self.assertNotIn(victim, questions_per_kp(mutated))

        # ② 覆盖率判据变红，且只报这一个
        self.assertEqual(
            uncovered_kp_ids(mutated),
            [victim],
            f"★ 覆盖率检查没有发现被删掉的知识点 {victim}（断言空转）",
        )

    def test_emptying_the_bank_makes_every_kp_uncovered(self) -> None:
        """★ 极端变异：题库全空 → **每一个** kp 都必须被判为未覆盖。

        这条挡的是「覆盖率函数把 kp 集合读成空集」那类假绿：
        真出了那种 bug，这里的期望值（228 个 kp）与实测值（0 个）会对不上。
        """
        empty = self.tmp / "bank-empty"
        empty.mkdir()
        self.assertEqual(
            uncovered_kp_ids(empty), sorted(knowledge_points()), "空题库必须全员告缺"
        )

    def test_the_actual_coverage_assertion_goes_red_on_the_mutated_bank(self) -> None:
        """★★ 让 ``TestBankCoverage`` 的**那条真题**在变异题库上跑一遍，必须失败。

        上面两条只验证了共用判据函数 ``uncovered_kp_ids`` 会变红；
        但真正的守卫是 ``TestBankCoverage.test_every_knowledge_point_has_enough_questions``。
        如果那条测试哪天被改成「读一个常量」或者「永远 assertEqual([], [])」，
        共用函数再灵敏也白搭。这里用 ``mock`` 把 ``BANK_DIR`` 换成变异目录，
        **直接调用那条测试方法**，断言它抛 AssertionError。
        """
        victim = sorted(questions_per_kp(BANK_DIR))[0]
        mutated = self._fixture_missing(victim)

        case = TestBankCoverage("test_every_knowledge_point_has_enough_questions")
        saved = (TestBankCoverage.kps, TestBankCoverage.counts)
        self.addCleanup(
            lambda: setattr(TestBankCoverage, "kps", saved[0])
            or setattr(TestBankCoverage, "counts", saved[1])
        )
        with mock.patch.object(sys.modules[__name__], "BANK_DIR", mutated):
            case.setUpClass()  # 重新按变异目录算 counts —— 这一步是断言的前提
            self.assertIn(victim, uncovered_kp_ids(mutated), "夹具没生效")
            with self.assertRaises(AssertionError) as ctx:
                case.test_every_knowledge_point_has_enough_questions()

        self.assertIn(victim, str(ctx.exception), "报错信息里应带上缺失的 kp id")

    def test_bank_dir_resolution_is_the_default_one(self) -> None:
        """确认测试盯的就是**随包分发**的那份题库（不是某个临时覆盖目录）。

        ``default_bank_dir()`` 会读 ``K12_QUIZ_BANK_DIR`` 环境变量（演示排障用）。
        如果 CI/本机残留了这个变量，本文件的全部断言会对着另一份题库跑 ——
        那等于没测。
        """
        self.assertEqual(
            Path(BANK_DIR).resolve(),
            (ROOT / "resources" / "quizbank").resolve(),
            "default_bank_dir() 没指向随包题库（检查 K12_QUIZ_BANK_DIR 是否被设置）",
        )


if __name__ == "__main__":
    unittest.main()
