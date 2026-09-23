"""**内容资产**的学生面文案卫生守卫 + 题库判分不变量。

══════════════════════════════════════════════════════════════════════════
这份守卫管什么（以及为什么它必须在 **Python 这一半**）
══════════════════════════════════════════════════════════════════════════

本仓**只有** ``desktop/src/renderer/src/components/ChatMessage.vue`` 的模型回答走
``markdown.ts`` 渲染；其余学生可见文案一律是**裸插值**（``{{ }}`` +
``white-space: pre-wrap``）—— **写了什么就显示什么**。所以 ``**加粗**``、`` `代码` ``、
``——`` 在这里都不是「排版意图」，而是**字面字符**（D-076 口径第 1 条、P-123）。

桌面侧已经有两道同类守卫，**本文件是第三道、也是它们看不见的那一半**：

===========================  ==========================================  ==============================
守卫                          扫什么                                      挡什么
===========================  ==========================================  ==============================
``student-view-discipline``   渲染进程**源码**（``src/renderer/src``）    我们自己写在 .vue / .ts 里的文案
第 ⑰ 节（源码级，CI 能跑）
``scripts/ux-student-view-scan.mjs``  真实 **DOM**（真机跑，``npm run ux:student``）  任何最终印到屏幕上的字
本文件（内容级，CI 能跑）      ``server/resources/**`` 的**内容资产**        JSON 资产里的文案（桌面侧扫不到：那些字不在 .vue 里）
===========================  ==========================================  ==============================

★ 三者的判据必须一致（``**`` / 反引号 / ``——`` 都会原样上屏），但**扫描面无一重复**：
  桌面侧扫的是代码里的字符串，本文件扫的是喂给它的 JSON 内容。

══════════════════════════════════════════════════════════════════════════
扫哪些字段：**逐个核过上屏点**，不是照抄字段名（2026-09-22 复核）
══════════════════════════════════════════════════════════════════════════

``server/resources/templates/*.json``（动画模板）
  · ``title``           → ``Animation.vue`` 模板选片卡 ``{{ t.title }}``
  · ``concept``         → ``Animation.vue`` ``{{ anim.activeTemplate.concept }}`` / ``{{ t.concept }}``；
                          ``AnimationCard.vue`` ``{{ view.concept }}``
  · ``fallback_text``   → ``Animation.vue`` / ``AnimationCard.vue`` 的降级说明（报告 1.8 就是这里）
  · ``body``            → iframe 里的 HTML：**文本节点** + ``title`` / ``aria-label`` / ``alt`` /
                          ``placeholder`` 这类会被人读到的属性（正文样式不在 body 里，无需剔 CSS）
  · **排除** ``script``（iframe 里执行的 JS：``——``/``**`` 在注释与代码里都正当）、
    ``id`` / ``label`` / ``kp_ids`` / ``grade_levels`` / ``duration_ms`` / ``params``
    （``label`` 与 ``params`` 只有模型与后台口径，全仓无渲染点）、``fallback_image``（路径）

``server/resources/code-templates/*.json``（编程模板）
  · ``expected_behavior`` → ``CodingCard.vue`` 的「做到这样就算完成」``{{ view.expectedBehavior }}``
  · ``hints[*].hint``     → ``CodingCard.vue`` ``{{ hint.hint }}``（后端 ``hint_at()`` → ``nextHint``）
  · **排除** ``scaffold`` / ``solution``（进 Monaco 的代码：那里的 ``**`` 是 Python 乘方）、
    ``title`` / ``expected_output``（``routes/code.py`` 的 ``to_code_template`` 白名单只有
    ``kp_id``/``language``/``scaffold``/``expected_behavior``，这两个字段**从不外发**）、
    ``kp_id`` / ``grade_level``

``server/resources/quizbank/*.json``（题库）
  · ``questions[*].stem`` / ``.options[*]`` / ``.explanation``
    （``QuizCard.vue`` 裸插值；``explanation`` 经后端 ``feedback_for()`` 拼进反馈串再上屏）
  · **排除** ``answer``（内部标准答案，契约上永不外发）、``notes``（开发注释，
    ``——`` 在这里正当 —— 本库还剩 7 处全在章级 ``notes`` 里）、``qid``/``kp_id``/``type``

``server/resources/sensitive-words.json``（内容安全词表）
  · ``categories[*].safeText`` → **危机时刻给学生看的那一句**（``guard.py`` 读它 →
    ``blocked`` 事件 → 气泡正文）。中文标点都要读得懂，破折号长句尤其不能有。
  · **排除** ``notes``、``categories[*].label``（只进 ``reason`` 诊断串，而 ``reason`` 只在
    ``BlockedNotice.vue`` 的 ``<TeacherGate>`` 里渲染）、``words[*]``、``patterns``、
    ``severity_levels``

══════════════════════════════════════════════════════════════════════════
判据（与报告第 3 章「破折号专项」一致）
══════════════════════════════════════════════════════════════════════════

· ``**``：按 **Markdown 强调**判 —— ``**X**`` 成对包裹才算命中。
  ★ 不按「出现两个星号」判：``bmi = weight_kg / (height_m ** 2)`` 是 **Python 乘方**，
  而那条 hint 还专门解释了「两个星号是乘方」——守卫不能把**教学内容**判成缺陷（D-076 口径第 3 条）。
  另外补一条：孤立的 ``**`` 只要**紧贴汉字**也算命中（代码运算符两侧一定是标识符/空格，
  不会贴着汉字），这样「写了一半的强调标记」也跑不掉。
· `` ` ``：命中即缺陷（可见文案里没有任何正当用途；进 Monaco 的代码字段已被排除）。
· ``——``：命中即缺陷，**数学区间 / 专有名词**是报告给的唯一豁免口 —— 见下面两张例外表。

══════════════════════════════════════════════════════════════════════════
假守卫的教训（本仓吃过，见 P-116 / P-126）
══════════════════════════════════════════════════════════════════════════

「没验过会红的守卫不算守卫」。所以这份文件里除了两条扫描断言，还有：

1. **扫描面下限**（``test_scanner_surface_is_not_empty``）：字段名写错、资产被挪走时，
   扫描单元数会掉 → 当场变红。少了它，上面两条断言可能只是**空集通过**。
2. **临时副本凭据**（``test_guard_is_red_on_a_temp_copy``）：把坏内容写进
   ``tempfile`` 造的副本再跑同一套扫描函数，证明它**真的会报**（而不是「碰巧是绿的」）。
3. **排除项凭据**（``test_guard_is_blind_to_code_and_dev_fields``）：``script`` / ``scaffold`` /
   ``answer`` / ``notes`` 里有标记时**不许**报 —— 排除是**设计**，不是漏配。
4. **例外必须名副其实**：两张表**按现状封顶为 0 条**，理由是「刚清完，一处都不需要」。
   要加一条，必须先改 ``EXEMPT_CAP`` 那一行（也就是：先承认修不了源码，再写理由 ≥40 字）。

题库的 ``answer ∈ options`` 是**判分机制本身的要求**（不是数据巧合，见 P-124 与本文件末尾那条），
它放在这里是因为**它就是内容资产身上的不变量**：改 ``options`` 忘了同步 ``answer``，判分静默反转。
"""

from __future__ import annotations

import html
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Iterator, NamedTuple

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.routes.code import default_templates_dir  # noqa: E402
from app.routes.quiz import default_bank_dir, normalize_answer  # noqa: E402
from app.routes.resources import templates_dir  # noqa: E402
from app.safety.guard import default_words_path  # noqa: E402

#: 会**原样上屏**的两种排版标记（D-076 口径第 1 条）。
#: ★ 反引号只有在走 ``markdown.ts`` 的通路里才会变成等宽字体；裸插值链路上它就是两个字符。
MARK_SYNTAX: tuple[str, ...] = ("**", "`")

#: 破折号：报告第 3 章认定为**本产品学生文案的 LLM 指纹**，除数学区间 / 专有名词外禁用。
DASH_MARK = "\u2014\u2014"

#: HTML 里会被人读到的属性（``aria-label`` 会被读屏念出来，``title`` 会做悬浮提示）。
VISIBLE_ATTRS: tuple[str, ...] = ("title", "aria-label", "alt", "placeholder")

#: 成对包裹的强调标记：``**X**``（X 非空、且紧贴星号处不是空白）。
#: ★ 判据是「Markdown 强调」而不是「出现两个星号」—— 理由见文件头「判据」一节。
_EMPHASIS_RE = re.compile(r"\*\*(?=\S)([^*]+?)(?<=\S)\*\*")

#: 汉字（判断孤立的 ``**`` 是不是贴在中文里）。
_CJK_RE = re.compile("[\u3400-\u9fff]")


class Hit(NamedTuple):
    """一条命中：文件 + JSON 路径 + 命中的标记 + 原文片段。

    ★ 报错信息必须带 **JSON 路径**（``ch03.json: questions[12].stem``）——
      只报文件名，下一个人还要自己找。
    """

    file: str
    path: str
    mark: str
    text: str

    def describe(self) -> str:
        return f"{self.file}: {self.path} 出现「{self.mark}」 → {self.text}"


# --------------------------------------------------------------------------- #
# 资产读取：每种资产各自的**学生可见字段**（逐个核过上屏点，见文件头）
# --------------------------------------------------------------------------- #
def _body_visible_text(body: str) -> str:
    """取出 HTML 里**会显示出来的文字**（去掉 script/style 与标签，反转义实体）。"""
    stripped = re.sub(r"<(script|style)\b[^>]*>.*?</\1>", " ", body, flags=re.S | re.I)
    return html.unescape(re.sub(r"<[^>]*>", " ", stripped))


def _body_visible_attrs(body: str) -> Iterator[tuple[str, str]]:
    """产出 ``(属性名, 属性值)`` —— 只取 {@link VISIBLE_ATTRS} 里那几种。"""
    for name in VISIBLE_ATTRS:
        for match in re.finditer(r"\s" + name + r'="([^"]*)"', body):
            yield name, html.unescape(match.group(1))


def template_units(templates_root: Path) -> Iterator[tuple[str, str, str]]:
    """动画模板里**学生可见**的文案单元。"""
    for path in sorted(templates_root.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for key in ("title", "concept", "fallback_text"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                yield path.name, key, value
        body = data.get("body")
        if isinstance(body, str):
            text = _body_visible_text(body)
            if text.strip():
                yield path.name, "body", text
            for name, value in _body_visible_attrs(body):
                if value.strip():
                    yield path.name, f"body@{name}", value


def code_template_units(templates_root: Path) -> Iterator[tuple[str, str, str]]:
    """编程模板里**学生可见**的文案单元（代码字段不在内）。"""
    for path in sorted(templates_root.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        behavior = data.get("expected_behavior")
        if isinstance(behavior, str) and behavior.strip():
            yield path.name, "expected_behavior", behavior
        for index, hint in enumerate(data.get("hints") or []):
            if not isinstance(hint, dict):
                continue
            text = hint.get("hint")
            if isinstance(text, str) and text.strip():
                yield path.name, f"hints[{index}].hint", text


def quizbank_units(bank_root: Path) -> Iterator[tuple[str, str, str]]:
    """题库里**学生可见**的文案单元（``answer`` 与 ``notes`` 不在内）。

    ★ ``answer`` 被排除不是「懒得扫」，而是**契约上它永不外发**
      （``QuizQuestionOut`` 结构上没有它）——`answer` 里的 ``——`` 与 ``**`` 到不了学生眼前。
    """
    for path in sorted(bank_root.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for index, question in enumerate(data.get("questions") or []):
            stem = question.get("stem")
            if isinstance(stem, str) and stem.strip():
                yield path.name, f"questions[{index}].stem", stem
            for option_index, option in enumerate(question.get("options") or []):
                if isinstance(option, str) and option.strip():
                    yield path.name, f"questions[{index}].options[{option_index}]", option
            explanation = question.get("explanation")
            if isinstance(explanation, str) and explanation.strip():
                yield path.name, f"questions[{index}].explanation", explanation


def sensitive_safe_text_units(words_path: Path) -> Iterator[tuple[str, str, str]]:
    """内容安全词表里**学生可见**的危机文案（``categories[*].safeText``）。"""
    data = json.loads(words_path.read_text(encoding="utf-8"))
    for category, entry in (data.get("categories") or {}).items():
        if not isinstance(entry, dict):
            continue
        text = entry.get("safeText")
        if isinstance(text, str) and text.strip():
            yield words_path.name, f"categories.{category}.safeText", text


# --------------------------------------------------------------------------- #
# 例外表：**欠债清单，不是许可清单**（与桌面侧 ``MARK_EXEMPT`` / ``DASH_EXEMPT`` 同一条纪律）
# --------------------------------------------------------------------------- #
#: 标记（``**`` / 反引号）的例外：``(文件, JSON 路径, 理由)``。
MARK_EXEMPT: list[tuple[str, str, str]] = []

#: 破折号的例外：报告允许「数学区间 / 专有名词」，但那要**逐条**写清为什么必须用破折号。
DASH_EXEMPT: list[tuple[str, str, str]] = []

#: ★ 按现状封顶：现在是 **0 条**（2026-09-22 把四组内容资产全清了一遍）。
#: 想加一条例外，必须先改这一行 —— 也就是**先承认修不了源码**，再写理由。
#: 这条纪律与桌面侧那两张表一致：表一长，守卫就退化成「例外清单」。
EXEMPT_CAP = 0

#: 扫描面下限（**按现状封顶的下限**）：涨可以，掉下来就说明字段名写错了 / 资产被挪走了。
#: 少了这三个数，上面两条断言可能只是「空集通过」—— 那正是 P-116 说的假守卫。
MIN_UNITS = {
    "templates": 40,  # 8 份 × (title + concept + fallback_text + body 文本) + body 的 aria-label
    "code-templates": 12,  # 3 份 × (expected_behavior + 3 条 hints[*].hint)
    "quizbank": 3075,  # 684 题干 + 1707 选项 + 684 解析
    "sensitive-words": 7,  # 7 类 × safeText
}


# --------------------------------------------------------------------------- #
# 扫描
# --------------------------------------------------------------------------- #
def _is_defect(text: str, mark: str) -> list[str]:
    """``text`` 里**算作缺陷**的 ``mark`` 片段（返回证据串，空列表 = 干净）。"""
    if mark == DASH_MARK:
        return [DASH_MARK] if DASH_MARK in text else []
    if mark == "`":
        return ["`"] if "`" in text else []
    if mark == "**":
        evidence = [f"**{inner}**" for inner in _EMPHASIS_RE.findall(text)]
        # 配对之外剩下的孤立 `**`：只有**紧贴汉字**才算（代码运算符不会贴着汉字，见文件头）
        remainder = _EMPHASIS_RE.sub("", text)
        for match in re.finditer(r"\*\*", remainder):
            before = remainder[match.start() - 1] if match.start() > 0 else ""
            after = remainder[match.end()] if match.end() < len(remainder) else ""
            if _CJK_RE.match(before or " ") or _CJK_RE.match(after or " "):
                evidence.append("孤立的 ** 紧贴汉字")
                break
        return evidence
    raise AssertionError(f"没有为标记「{mark}」定义判据 —— 新加标记时必须同时加判据与凭据用例")


def scan_for_mark(units: Iterator[tuple[str, str, str]], mark: str) -> list[Hit]:
    """在文案单元里找 ``mark``（判据见 {@link _is_defect}）。"""
    hits: list[Hit] = []
    for file, path, text in units:
        for evidence in _is_defect(text, mark):
            hits.append(Hit(file, path, evidence, text.strip()[:110]))
    return hits


def all_student_visible_units(
    *, templates_root: Path | None = None, code_root: Path | None = None,
    bank_root: Path | None = None, words_path: Path | None = None,
) -> Iterator[tuple[str, str, str]]:
    """四组内容资产的**全部学生可见文案单元**（路径可注入 —— 凭据用例拿临时副本跑同一套）。"""
    yield from template_units(templates_root or templates_dir())
    yield from code_template_units(code_root or default_templates_dir())
    yield from quizbank_units(bank_root or default_bank_dir())
    yield from sensitive_safe_text_units(words_path or default_words_path())


def _exempted(hits: list[Hit], table: list[tuple[str, str, str]]) -> list[Hit]:
    """按 ``(文件, JSON 路径)`` **逐条**放行 —— 不是「整个文件不算」。"""
    return [hit for hit in hits if not any(hit.file == f and hit.path == p for f, p, _ in table)]


# --------------------------------------------------------------------------- #
# ① 文案卫生
# --------------------------------------------------------------------------- #
class TestStudentVisibleCopyHygiene(unittest.TestCase):
    """学生可见文案里不许出现**未渲染的** Markdown 标记与破折号连接句。"""

    def test_no_unrendered_markdown_marks_in_student_visible_copy(self) -> None:
        """``**`` 与反引号会**原样上屏**（裸插值），不是排版意图。"""
        for entry in MARK_EXEMPT:
            self.assertGreaterEqual(
                len(entry[2]), 40, f"{entry[0]} 的例外理由太短 —— 要写清「它为什么到不了学生眼前」"
            )
            self.assertTrue(entry[1], f"{entry[0]} 的例外没写 JSON 路径 —— 不许整文件放行")

        hits: list[Hit] = []
        for mark in MARK_SYNTAX:
            hits.extend(scan_for_mark(all_student_visible_units(), mark))
        real = _exempted(hits, MARK_EXEMPT)
        self.assertEqual(
            [hit.describe() for hit in real],
            [],
            "学生看到的会是**字面星号 / 字面反引号**：这些字段走的不是 Markdown 渲染通路\n"
            "（动画降级说明、编程提示、题库题干与选项都是裸插值 `{{ }}` + `white-space: pre-wrap`）。\n"
            "处置：① 去掉包裹（要强调靠措辞）；② 或改用「」界定；③ 代码片段直接裸写。\n"
            "⚠️ Python 乘方（`height_m ** 2`）与 JS 注释不算缺陷 —— 判据只认 Markdown 强调形态\n"
            "   与「孤立 `**` 紧贴汉字」，真有误报请先看判据是不是漏了一种正当写法。\n"
            f"命中 {len(real)} 处：\n  " + "\n  ".join(hit.describe() for hit in real),
        )

    def test_no_dash_joiner_in_student_visible_copy(self) -> None:
        """``——`` 是本产品学生文案的 **LLM 指纹**（报告第 3 章「破折号专项」）。"""
        for entry in DASH_EXEMPT:
            self.assertGreaterEqual(len(entry[2]), 40, f"{entry[0]} 的例外理由太短")
            self.assertTrue(entry[1], f"{entry[0]} 的例外没写 JSON 路径")

        hits = scan_for_mark(all_student_visible_units(), DASH_MARK)
        real = _exempted(hits, DASH_EXEMPT)
        self.assertEqual(
            [hit.describe() for hit in real],
            [],
            "`——` 除「数学区间 / 专有名词」外禁用（报告第 3 章）。\n"
            "处置：改成两句短句、逗号或冒号；⚠️ 换个字符（`–` / `—` 单个）不算修好 —— 读起来还是同一股味。\n"
            "★ 注意：题库 `answer` 与章级 `notes` **不在扫描面内**（前者永不外发、后者是开发注释），\n"
            "   所以那两处留着的 `——` 不是漏网。\n"
            f"命中 {len(real)} 处：\n  " + "\n  ".join(hit.describe() for hit in real),
        )

    def test_exempt_tables_are_capped_and_stay_honest(self) -> None:
        """两张例外表**按现状封顶**（现在 0 条），且用不上的条目必须删掉。"""
        self.assertLessEqual(
            len(MARK_EXEMPT), EXEMPT_CAP,
            f"标记的例外已经有 {len(MARK_EXEMPT)} 条（上限 {EXEMPT_CAP}）—— "
            "超过上限说明多半是「改文案」被换成了「加例外」。要加一条，先改 EXEMPT_CAP。",
        )
        self.assertLessEqual(
            len(DASH_EXEMPT), EXEMPT_CAP,
            f"破折号的例外已经有 {len(DASH_EXEMPT)} 条（上限 {EXEMPT_CAP}）—— 同上。",
        )
        # ★ 例外必须**确实用得上**：源码清干净之后还留着条目，就是一条假豁免（会掩护下一次泄漏）
        units = list(all_student_visible_units())
        for table, marks in ((MARK_EXEMPT, MARK_SYNTAX), (DASH_EXEMPT, (DASH_MARK,))):
            for file, path, _ in table:
                used = any(
                    hit.file == file and hit.path == path
                    for mark in marks
                    for hit in scan_for_mark(iter(units), mark)
                )
                self.assertTrue(
                    used,
                    f"{file}: {path} 的例外已经用不上了（那里找不到标记了）—— 请删掉这条条目，别留着",
                )

    def test_scanner_surface_is_not_empty(self) -> None:
        """★ 反「空集通过」：扫描面掉下来就说明字段名写错 / 资产被挪走了。

        少了这一条，上面两条 ``assertEqual([], ...)`` 只要扫描面是空的就永远绿 ——
        那正是 P-116「守卫被注释满足」的同族问题（**判据锚在了不存在的东西上**）。
        """
        counts = {
            "templates": len(list(template_units(templates_dir()))),
            "code-templates": len(list(code_template_units(default_templates_dir()))),
            "quizbank": len(list(quizbank_units(default_bank_dir()))),
            "sensitive-words": len(list(sensitive_safe_text_units(default_words_path()))),
        }
        for family, minimum in MIN_UNITS.items():
            self.assertGreaterEqual(
                counts[family], minimum,
                f"{family} 只扫到 {counts[family]} 个文案单元（下限 {minimum}）—— "
                "字段名改了？资产被挪走了？先修扫描面，别让守卫空转。",
            )


# --------------------------------------------------------------------------- #
# ② 题库判分不变量：``answer`` 必须与某个 ``option`` 一致
# --------------------------------------------------------------------------- #
def choice_answer_conflicts(bank_root: Path) -> tuple[list[str], list[str]]:
    """返回 ``(normalize 不等价的题, 逐字节不同的题)``（都是 ``文件: qid``）。

    ══════════════════════════════════════════════════════════════════════════
    为什么这是**结构性要求**，不是数据巧合（P-124）
    ══════════════════════════════════════════════════════════════════════════
    客户端提交的**不是字母，而是选项原文**（``QuizCard.vue``：``answers[qid] = option``），
    判分在 ``routes/quiz.py``：
      · ``_choice_variants(value, options)`` 把「字母」与「选项原文」互认 ——
        单字母照下标取回选项原文；选项原文照逐项比较取回字母；
      · ``is_correct_answer()`` 对选择题取 ``accepted ∩ given``。
    **媒介就是 ``answer`` 与某个 option 相等（normalize 之后）**：
    ``answer`` 一旦对不上任何选项，它既拿不到字母、也拿不到原文，
    而学生交上来的原文/字母都只映射到**改过的**选项 → 交集为空 → **判分静默反转**。
    （实测：只改 options、留旧 answer → ``correct=False``，本该 True。）

    所以这里的判据按 ``normalize_answer``（**直接调生产函数**）判等价 ——
    它跟踪的是真实判分口径，而不是本文件自己写一套匹配规则；
    另附一条**逐字节相同**的检查：那是本库现状（569/569）与「人肉同步」的编辑约定，
    比结构要求更强，放宽它要先想清楚。
    """
    structural: list[str] = []
    bytewise: list[str] = []
    for path in sorted(bank_root.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        for question in data.get("questions") or []:
            options = [o for o in (question.get("options") or []) if isinstance(o, str)]
            if not options:
                continue  # 填空题 / 代码填空不适用（判据是逐空比对）
            answers = question.get("answer")
            answer_values = answers if isinstance(answers, list) else [answers]
            answer_values = [a for a in answer_values if isinstance(a, str)]
            if not answer_values:
                continue
            where = f"{path.name}: {question.get('qid')}"
            accepted = {normalize_answer(o) for o in options if normalize_answer(o)}
            if not all(normalize_answer(a) in accepted for a in answer_values):
                structural.append(where)
            if not all(a in options for a in answer_values):
                bytewise.append(where)
    return structural, bytewise


class TestChoiceAnswerStaysInSyncWithOptions(unittest.TestCase):
    """★★ 改 ``options`` 就要**同一处**同步 ``answer``，否则判分静默反转（P-124）。"""

    def test_choice_answer_matches_one_of_its_options(self) -> None:
        structural, bytewise = choice_answer_conflicts(default_bank_dir())
        self.assertEqual(
            structural,
            [],
            "选择题的 `answer` 必须与**某个选项** normalize 之后相等 —— 这是判分机制的要求，不是数据巧合：\n"
            "客户端提交的是**选项原文**（`QuizCard.vue`: `answers[qid] = option`），\n"
            "`routes/quiz.py` 的 `_choice_variants()` 靠「answer 等于某个 option」把字母与原文互认\n"
            "（`is_correct_answer()` 取 `accepted ∩ given`）。对不上 → 交集为空 → **判对变判错**。\n"
            "★ 处置只有一个动作：**改了 `options` 就把 `answer` 一起改成同一个串**。\n"
            f"对不上的 {len(structural)} 题：\n  " + "\n  ".join(structural),
        )
        self.assertEqual(
            bytewise,
            [],
            "本库的编辑约定是 `answer` 与选项**逐字节相同**（现状 569/569）——\n"
            "normalize 等价但写法不同（全角/半角、空白差异）虽然不影响判分，但会让「人肉同步」失去可比性。\n"
            "★ 若确有正当理由要放宽这一条，请**先改这条守卫**并写清为什么，别直接改数据。\n"
            f"逐字节不同的 {len(bytewise)} 题：\n  " + "\n  ".join(bytewise),
        )


# --------------------------------------------------------------------------- #
# ③ 凭据：证明上面这些守卫**真的会红**（用 tempfile 造的副本，不动真资产）
# --------------------------------------------------------------------------- #
_TEMPLATE_WITH_DEFECTS = {
    "title": "**加粗**的标题",
    "concept": "甲——乙",
    "fallback_text": "一串**是 / 否**问题",
    "body": '<h1>看这个`代码`</h1><svg aria-label="丙——丁"></svg>',
    "script": "// 注释里 —— 与 ** 都正当\nvar x = 1 ** 2;",  # 必须**不被**扫到
}
_TEMPLATE_WITH_DEFECTS["body"] += '<span title="孤立**紧贴汉字"></span>'

#: 「排除项凭据」用的干净模板：**可见字段一个字都不带标记**，
#: 标记只出现在 ``script``（iframe 里执行的 JS）—— 报出来就说明排除漏配了。
_TEMPLATE_CLEAN_BUT_SCRIPT_MARKED = {
    "title": "干净的标题",
    "concept": "这一档讲的是什么",
    "fallback_text": "动画没播出来，先看文字要点。",
    "body": '<h1>干净的正文</h1><svg aria-label="图像分块成数字的动画"></svg>',
    "script": "// 注释里 —— 与 ** 都是给开发者看的\nvar area = side ** 2;  // 乘方\n",
}


def _write(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


class TestGuardCredentials(unittest.TestCase):
    """「没验过会红的守卫不算守卫」（P-116 / P-126）：下面用临时副本把它逼红一次。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        (self.root / "templates").mkdir()
        (self.root / "code-templates").mkdir()
        (self.root / "quizbank").mkdir()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _paths(self) -> dict[str, Path]:
        return {
            "templates_root": self.root / "templates",
            "code_root": self.root / "code-templates",
            "bank_root": self.root / "quizbank",
            "words_path": self.root / "sensitive-words.json",
        }

    def test_guard_is_red_on_a_temp_copy(self) -> None:
        """坏内容放进副本 → 四条链路（模板 / 编程 / 题库 / 安全词）逐个必须报出来。"""
        _write(self.root / "templates" / "t.json", _TEMPLATE_WITH_DEFECTS)
        _write(
            self.root / "code-templates" / "c.json",
            {"expected_behavior": "把 A 改成 B——就完成", "hints": [{"level": 1, "hint": "`x` 是变量名"}]},
        )
        _write(
            self.root / "quizbank" / "ch99.json",
            {"questions": [{"qid": "q1", "stem": "甲——乙", "options": ["A", "B"], "answer": "A",
                            "explanation": "记住**这一点**"}]},
        )
        _write(
            self.root / "sensitive-words.json",
            {"categories": {"self_harm": {"label": "自伤/轻生", "safeText": "请告诉大人——现在就说"}}},
        )

        units = list(all_student_visible_units(**self._paths()))
        dash_hits = [hit.describe() for hit in scan_for_mark(iter(units), DASH_MARK)]
        mark_hits = [hit.describe() for hit in scan_for_mark(iter(units), "**")]
        tick_hits = [hit.describe() for hit in scan_for_mark(iter(units), "`")]
        all_hits = dash_hits + mark_hits + tick_hits

        # 四组资产各自被抓到（缺一组就说明那条链路没接上扫描面）
        for expected_file in ("t.json", "c.json", "ch99.json", "sensitive-words.json"):
            self.assertTrue(
                any(expected_file in h for h in all_hits),
                f"{expected_file} 的坏内容**没被抓到** —— 这条链路没接进扫描面。命中：{all_hits}",
            )
        self.assertTrue(any("t.json: fallback_text" in h for h in mark_hits), mark_hits)
        self.assertTrue(any("t.json: concept" in h for h in dash_hits), dash_hits)
        self.assertTrue(any("t.json: body" in h for h in tick_hits), tick_hits)
        self.assertTrue(any("t.json: body@aria-label" in h for h in dash_hits), dash_hits)
        self.assertTrue(any("t.json: body@title" in h for h in mark_hits), dash_hits + mark_hits)
        self.assertTrue(any("c.json: expected_behavior" in h for h in dash_hits), dash_hits)
        self.assertTrue(any("c.json: hints[0].hint" in h for h in tick_hits), tick_hits)
        self.assertTrue(
            any("ch99.json: questions[0].stem" in h for h in dash_hits), dash_hits
        )
        self.assertTrue(
            any("ch99.json: questions[0].explanation" in h for h in mark_hits), mark_hits
        )
        self.assertTrue(
            any("sensitive-words.json: categories.self_harm.safeText" in h for h in dash_hits),
            dash_hits,
        )

    def test_guard_is_blind_to_code_and_dev_fields(self) -> None:
        """``script`` / ``scaffold`` / ``answer`` / ``notes`` / ``label`` 里的标记**不该**报。

        排除是**设计**（那些字到不了学生眼前），不是漏配 —— 所以也要有凭据钉住：
        哪天有人「顺手把扫描面放大」，这条会红，提醒他先想清楚。
        """
        _write(self.root / "templates" / "t.json", _TEMPLATE_CLEAN_BUT_SCRIPT_MARKED)
        _write(
            self.root / "code-templates" / "c.json",
            {
                "expected_behavior": "做到这样就算完成。",
                # scaffold 进 Monaco：`**` 是 Python 乘方，正当
                "scaffold": "bmi = weight_kg / (height_m ** 2)  # 乘方",
                "solution": "print(f'{bmi:.2f}')  # >>> 提示符风格",
                "title": "**模板标题**（不外发）",
                "expected_output": "19.10 —— 期望输出（不外发）",
                "hints": [{"level": 1, "hint": "两个星号是乘方：height_m ** 2"}],
            },
        )
        _write(
            self.root / "quizbank" / "ch99.json",
            {"questions": [{"qid": "q1", "stem": "干净题干", "options": ["A", "B"], "answer": "A",
                            "explanation": "干净解析", "notes": "开发注释 —— 正当"}]},
        )
        _write(
            self.root / "sensitive-words.json",
            {"notes": "词表说明 —— 正当",
             "categories": {"self_harm": {"label": "自伤——轻生（只进 TeacherGate）",
                                          "safeText": "请告诉身边信任的大人。"}}},
        )

        units = list(all_student_visible_units(**self._paths()))
        for mark in (DASH_MARK, "**", "`"):
            hits = [hit.describe() for hit in scan_for_mark(iter(units), mark)]
            self.assertEqual(
                hits, [],
                f"这些字**到不了学生眼前**，不该被扫出来（mark={mark!r}）—— "
                f"排除项是设计不是漏配：\n  " + "\n  ".join(hits),
            )

    def test_python_exponent_is_not_a_markdown_defect(self) -> None:
        """``(height_m ** 2)`` 是**教学内容**，守卫不许把它判成缺陷（D-076 口径第 3 条）。"""
        legit = [
            "bmi = weight_kg / (height_m ** 2)（两个星号是乘方，分母的括号别漏）",
            "把 while 一律改成 for",
            "range(1, 5) 只会到 4",
        ]
        for text in legit:
            self.assertEqual(_is_defect(text, "**"), [], f"误报（正当内容被判成缺陷）：{text}")

        defects = [
            "一串**是 / 否**问题",  # P-123 里那张截图的原文形态
            "**平方**与**乘方**",
            "明白了** 吗",  # 孤立的 `**` 紧贴汉字 = 写了一半的强调标记
        ]
        for text in defects:
            self.assertNotEqual(_is_defect(text, "**"), [], f"漏报（缺陷没被判出来）：{text}")

    def test_choice_answer_guard_is_red_on_a_temp_copy(self) -> None:
        """改 ``options`` 忘了同步 ``answer`` → 必须当场变红（P-124 的复现）。"""
        _write(
            self.root / "quizbank" / "ch99.json",
            {"questions": [
                {"qid": "synced", "type": "choice", "stem": "s", "options": ["甲：乙", "丙"], "answer": "甲：乙"},
                {"qid": "forgot", "type": "choice", "stem": "s", "options": ["甲：乙", "丙"], "answer": "甲——乙"},
                {"qid": "blank-ok", "type": "blank", "stem": "s", "options": [], "answer": ["任意", "都行"]},
            ]},
        )
        structural, bytewise = choice_answer_conflicts(self.root / "quizbank")
        self.assertEqual(structural, ["ch99.json: forgot"], "改了 options 忘了同步 answer，必须报出来")
        self.assertEqual(bytewise, ["ch99.json: forgot"], "逐字节那条也要报")
        # 反面对照：填空题不适用（既没 options、也不该被这条守卫判死）
        self.assertNotIn("ch99.json: blank-ok", structural + bytewise)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
