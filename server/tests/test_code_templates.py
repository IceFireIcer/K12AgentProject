# -*- coding: utf-8 -*-
"""编程 Extension 的**服务端**部分：代码模板 + 报错感知 + 分级提示（票 19）。

本文件盯住六条不能被「顺手改坏」的红线：

1. ★ **参照实现不出后端**：模板里的 ``solution`` 只存在于 Python 侧，
   接口响应 JSON 里零命中（用唯一哨兵串端到端验证，与题库 ``answer`` 同一手法）；
2. ★ **本模块不执行任何学生代码**：源码里不出现 ``exec`` / ``eval`` / ``compile`` /
   ``subprocess`` / ``os.system`` 等执行原语 —— 执行只在渲染进程的 Pyodide Worker 里
   （执行文档 §11.3 / §12 的硬约束，这条断言是它的服务端证据）；
3. **四类常见错误都要翻译成人话**：缩进 / 名字未定义 / 类型 / 索引越界，
   每类留一条「原始报错 → 中文反馈」样例行（票 19 明确点名）；
4. **分级提示不跳级**：``level`` 1→2→3 递进，且 ``resolve_hint_level`` 永远不超过
   ``当前级 + 1``（学生反复点求助也不能一步看到骨架）；
5. **模板离线可用且与教材对齐**：``kp_id`` 必须真实存在于 ``server/knowledge/``，
   三份随包模板（变量 / 循环 / 列表，全部初中）逐个实测「填完 TODO 即可通过」；
6. **坏模板不抛异常**：坏 JSON / 缺字段只跳过，取模板链路不整条挂掉。

夹具用真的 ``server/resources/code-templates/`` 与真的 ``server/knowledge/``
（模板是随包分发的内容资产，测试要盯住的正是它的内容质量）。
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import KNOWLEDGE_DIR, build_runtime_config  # noqa: E402
from app.knowledge.library import load_library  # noqa: E402
from app.main import create_app  # noqa: E402
from app.routes.code import (  # noqa: E402
    CODE_TEMPLATES_DIRNAME,
    ERROR_PLAYBOOK,
    MAX_HINT_LEVEL,
    TEMPLATES_DIR_STATE_ATTR,
    build_code_error,
    default_templates_dir,
    error_label,
    find_template,
    line_phrase,
    load_templates,
    looks_interrupted,
    next_hint_level,
    parse_python_error,
    resolve_hint_level,
    router as code_router,
    template_grade_ok,
    to_code_template,
    translate_python_error,
)

TEMPLATES_DIR = default_templates_dir()
CODE_ROUTE_FILE = ROOT / "app" / "routes" / "code.py"

#: ★ 哨兵：只可能来自模板里的参照实现。它一旦出现在响应里，就说明参照实现泄漏了。
SENTINEL_SOLUTION = "哨兵参照实现-SOL91-不得出现在响应里"

#: ★ 随包**必需**的三份模板（全部初中）：变量（平均分）/ 循环（冒泡排序）/ 列表（BMI 特征）。
#: 用的是教材里真实存在的 kp_id（``server/knowledge/junior/``），不是现编的名字。
#: 2026-09-22 起目录里还有内容包导入的其余模板（数量不做限制：用户裁决，见 D-078），
#: 本清单只登记「缺了必红」的三份底座，**不再是**「目录里恰好这几份」。
#:
#: ⚠️ 旧知识库那一代还有两份非编程概念的模板（决策树 / 神经网络），
#: 已随旧知识库一起删除 —— 新库（K12KnowledgeBase）里没有对应的编程正文，
#: 硬留着会变成「有模板、没正文」的悬空资产
#: （``test_every_template_kp_id_exists_in_knowledge_library`` 会当场变红）。
REQUIRED_TEMPLATES = {
    "prog-variable-jr": "变量",
    "prog-loop-jr": "循环",
    "prog-list-jr": "列表",
}


class CodeCase(unittest.TestCase):
    """带临时 userData 目录的基类（不碰真实数据目录）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.app = create_app(build_runtime_config(data_dir=self.tmp))
        # 数据轨的路由由 main.py 挂载（票 04 维护）；本文件显式挂载以便端到端跑到 HTTP 层。
        self.app.include_router(code_router)
        self.client = TestClient(self.app)


# ====================================================================== *
# 1. 模板资产：与教材对齐、格式合格
# ====================================================================== *


class CodeTemplateAssetTests(unittest.TestCase):
    """模板**内容资产**本身的检查（不需要起应用）。"""

    def setUp(self) -> None:
        self.report = load_templates(TEMPLATES_DIR)

    def test_templates_dir_is_code_templates_not_animation_templates(self) -> None:
        """目录名必须是 ``code-templates``（``templates/`` 被动画模板占用，混用会读错文件）。"""
        self.assertEqual(CODE_TEMPLATES_DIRNAME, "code-templates")
        self.assertEqual(TEMPLATES_DIR.name, "code-templates")

    def test_required_templates_present(self) -> None:
        """随包**必需**的三份模板（变量 / 循环 / 列表）必须都在：少一份即红。

        判据是「清单里的每一份都要在」，**不再是**「目录集合恰好等于清单」——
        内容包落地后目录里有 200+ 份模板，「不许有清单外的第四份」在合法内容上
        必然恒红（模板数不做限制：用户裁决，见 D-078）。

        旧判据写成集合相等，是因为「清单里的都在」在**清单被打空**时恒成立
        （连「把模板目录整个删掉」的 bug 都能全绿）。这个顾虑现在拆成两头盯，
        哪一头都不依赖另一头：

        - 目录侧：写死的 ``len(found) >= 3`` **不读清单** —— 清单被清空后逐份
          ``assertIn`` 恒成立，只有不依赖清单的下限还能发现「目录被删空」；
        - 清单侧：``len(REQUIRED_TEMPLATES) >= 3`` 盯住清单自己不被打空
          （打空清单 = 把上面的循环整体废掉）。

        另有两条**不依赖本清单**的交叉兜底：``test_every_solution_reaches_expected_output``
        要求 ``records > 0``（目录整体空了必红），以及
        ``test_every_template_kp_id_exists_in_knowledge_library``
        要求每份模板的 kp_id 都在教材库里（凭空编 id 必红）。
        """
        found = sorted({record.kp_id for record in self.report.records})
        for kp_id, label in REQUIRED_TEMPLATES.items():
            with self.subTest(kp=label):
                self.assertIn(kp_id, found, f"缺少「{label}」模板（{kp_id}）")
        # 下限写死、不读清单：清单一旦被打空，逐份 assertIn 恒成立，
        # 只有这个不依赖清单的下限还能盯住「目录被删空」（旧「集合相等」拦的就是它）。
        self.assertGreaterEqual(
            len(found), 3, f"模板集合只剩 {len(found)} 份 kp —— 随包必需的三份不该缺席"
        )
        # 清单自己也不许被打空（打空后上面的循环一次都不进 = 本测试整体失效）。
        self.assertGreaterEqual(
            len(REQUIRED_TEMPLATES),
            3,
            "REQUIRED_TEMPLATES 被打空了（它是随包三份的冻结登记，不是可裁剪的配置）",
        )

    def test_every_template_kp_id_exists_in_knowledge_library(self) -> None:
        """★ 模板不许凭空造知识点：``kp_id`` 必须与教材 front matter 逐字一致。"""
        known = {doc.kp_id for doc in load_library(KNOWLEDGE_DIR)}
        self.assertGreater(len(known), 0, "教材库没读到任何 kp_id，夹具路径可能不对")
        for record in self.report.records:
            with self.subTest(kp=record.kp_id):
                self.assertIn(
                    record.kp_id,
                    known,
                    f"模板 {record.source_file} 的 kp_id「{record.kp_id}」在 server/knowledge/ 里不存在",
                )

    def test_template_grade_matches_knowledge_front_matter(self) -> None:
        """模板声明的学段要与教材一致（学段写错会让兼容链判错）。"""
        grade_of = {doc.kp_id: doc.grade_level for doc in load_library(KNOWLEDGE_DIR)}
        for record in self.report.records:
            with self.subTest(kp=record.kp_id):
                self.assertEqual(
                    record.grade_level,
                    grade_of.get(record.kp_id),
                    f"模板 {record.source_file} 的 grade_level 与教材不一致",
                )

    def test_every_template_has_todo_marks_and_three_hints(self) -> None:
        """每个模板：≥2 处 TODO、恰好 3 级提示（1/2/3 不缺不重）。"""
        for record in self.report.records:
            with self.subTest(kp=record.kp_id):
                self.assertGreaterEqual(
                    record.scaffold.count("TODO"), 2, f"{record.kp_id} 的 scaffold 里 TODO 标记少于 2 处"
                )
                self.assertIn("____", record.scaffold, f"{record.kp_id} 的 scaffold 里没有留白处")
                levels = sorted(int(item["level"]) for item in record.hints)
                self.assertEqual(levels, [1, 2, 3], f"{record.kp_id} 的提示级别不是 1/2/3")
                self.assertEqual(record.max_hint_level, MAX_HINT_LEVEL)
                self.assertTrue(record.expected_behavior.strip(), f"{record.kp_id} 缺 expected_behavior")
                self.assertTrue(record.expected_output.strip(), f"{record.kp_id} 缺 expected_output")

    def test_hints_are_graduated_and_never_leak_the_full_answer(self) -> None:
        """★ 分级提示只保留两条**结构性**判据：三级两两不同，且 level 1 不许泄漏代码。

        - 三级文本必须互不相同（同一句话复制三遍等于没有分级）；
        - level 1 不得出现 ``for `` / ``if `` / ``return `` / ``= `` / ``np.`` / ``range(``
          这类可直接照抄的片段 —— 那一级只该指方向，这是对学生的真实承诺
          （学生拿到 hint 1 就被直接给了答案 = 提示机制失守）。

        **长度不作判据**：「越往后越长」只是「越往后越具体」的代理指标，而内容包的
        实际风格是「L1 指方向 → L2 给关键代码行 → L3 给下一行」—— L3 常比 L2 短，
        代理会在**合法内容**上假红（干跑 228 份模板：442 条长度红、实质红只有
        2 条 L1 泄漏），把真正的缺陷淹在噪声里。裁决见 D-078。
        """
        code_markers = ("for ", "if ", "return ", "= ", "np.", "range(")
        for record in self.report.records:
            with self.subTest(kp=record.kp_id):
                hints = [record.hint_at(level).hint for level in (1, 2, 3)]  # type: ignore[union-attr]
                self.assertEqual(len(set(hints)), 3, f"{record.kp_id} 的三级提示有重复")
                for marker in code_markers:
                    self.assertNotIn(
                        marker,
                        hints[0],
                        f"{record.kp_id} 的 level 1 出现了代码片段「{marker}」—— 那一级只该指方向",
                    )


# ====================================================================== *
# 2. 「填完 TODO 即可通过」：真跑参照实现，比对 expected_output
# ====================================================================== *


class SolutionRunnabilityTests(unittest.TestCase):
    """★ 票 19 的实测口径：每个模板的 ``solution`` 必须真能跑出 ``expected_output``。

    这里**跑的是参照实现**（模板自带的 ``solution``），不是学生代码 ——
    本测试文件在开发机上跑，与「学生代码只在 Pyodide Worker 里执行」不冲突
    （那条约束管的是**运行时链路**，不是内容资产的离线校验；
    ``server/app/routes/code.py`` 里依然一个执行原语都没有，见下面第 6 组的守卫）。

    用 ``runpy`` 之外的最朴素办法：``exec`` 到一个干净命名空间里并捕获 stdout。
    """

    def _run(self, code: str) -> str:
        import contextlib
        import io

        buffer = io.StringIO()
        namespace: dict = {"__name__": "__template__"}
        with contextlib.redirect_stdout(buffer):
            exec(compile(code, "<solution>", "exec"), namespace)  # noqa: S102 - 只跑随包分发的参照实现
        return buffer.getvalue()

    def test_every_solution_reaches_expected_output(self) -> None:
        report = load_templates(TEMPLATES_DIR)
        self.assertGreater(len(report.records), 0, "一个模板都没加载到")
        for record in report.records:
            with self.subTest(kp=record.kp_id):
                self.assertTrue(record.solution.strip(), f"{record.kp_id} 没有 solution，无法验证可运行性")
                self.assertEqual(
                    self._run(record.solution),
                    record.expected_output,
                    f"{record.kp_id} 的 solution 实际输出与 expected_output 不一致",
                )

    def test_three_required_basics_run(self) -> None:
        """三份随包模板（变量 / 循环 / 列表）逐个跑通 —— 报告里引用这一条。"""
        report = load_templates(TEMPLATES_DIR)
        for kp_id, label in REQUIRED_TEMPLATES.items():
            with self.subTest(kp=label):
                record = find_template(report.records, kp_id)
                self.assertIsNotNone(record, f"找不到 {label} 模板")
                assert record is not None
                self.assertEqual(self._run(record.solution), record.expected_output)

    def test_scaffold_has_holes_but_solution_does_not(self) -> None:
        """脚手架必须留空（有 TODO 与空白），参照实现必须没有 TODO（否则等于没做完）。"""
        for record in load_templates(TEMPLATES_DIR).records:
            with self.subTest(kp=record.kp_id):
                self.assertIn("TODO", record.scaffold)
                self.assertNotIn("TODO", record.solution)


# ====================================================================== *
# 3. ★ 报错感知：四类常见错误 → 中文反馈
# ====================================================================== *


class ErrorTranslationTests(unittest.TestCase):
    """``原始报错 → 面向学生的中文``（票 19 点名四类：缩进 / 名字未定义 / 类型 / 索引越界）。"""

    #: ★ 四类**必覆盖**错误，每类一条「原始报错 → 中文反馈」样例。
    #: 这些样例是**实测抓来的真实 Pyodide traceback**（Electron + Pyodide 314.0.7），
    #: 不是照着 CPython 格式手编的 —— 手编的样例会漏掉真实格式里那些"意外之处"
    #: （见下面 ``interrupt`` 那条：``KeyboardInterrupt`` 后面**没有冒号**）。
    SAMPLES: dict[str, tuple[str, str, int]] = {
        "indentation": (
            'Traceback (most recent call last):\n'
            '  File "/lib/python314.zip/_pyodide/_base.py", line 539, in eval_code\n'
            "    .run(globals, locals)\n"
            "     ~~~^^^^^^^^^^^^^^^^^\n"
            '  File "<exec>", line 3, in <module>\n'
            "    print(total)\n"
            "    ^\n"
            "IndentationError: unexpected indent\n",
            "IndentationError",
            3,
        ),
        "name": (
            'Traceback (most recent call last):\n'
            '  File "/lib/python314.zip/_pyodide/_base.py", line 539, in eval_code\n'
            "    .run(globals, locals)\n"
            '  File "<exec>", line 2, in <module>\n'
            "NameError: name 'totl' is not defined\n",
            "NameError",
            2,
        ),
        "type": (
            'Traceback (most recent call last):\n'
            '  File "/lib/python314.zip/_pyodide/_base.py", line 366, in run\n'
            "    coroutine = eval(self.code, globals, locals)\n"
            '  File "<exec>", line 4, in <module>\n'
            "TypeError: unsupported operand type(s) for +: 'int' and 'str'\n",
            "TypeError",
            4,
        ),
        "index": (
            'Traceback (most recent call last):\n'
            '  File "<exec>", line 5, in <module>\n'
            "IndexError: list index out of range\n",
            "IndexError",
            5,
        ),
    }

    #: ★★ 死循环被中断的**实测原文**（Electron + Pyodide 314.0.7，`while True: pass`，
    #: 主线程写 SIGINT 后 1014 ms 中断）。注意末行**只有类名**。
    REAL_INTERRUPT_TRACEBACK = (
        'Traceback (most recent call last):\n'
        '  File "/lib/python314.zip/_pyodide/_base.py", line 539, in eval_code\n'
        "    .run(globals, locals)\n"
        "     ~~~^^^^^^^^^^^^^^^^^\n"
        '  File "/lib/python314.zip/_pyodide/_base.py", line 366, in run\n'
        "    coroutine = eval(self.code, globals, locals)\n"
        '  File "<exec>", line 2, in <module>\n'
        "KeyboardInterrupt\n"
    )

    def test_parse_extracts_type_line_and_message(self) -> None:
        """解析出 ``(错误类名, 说明, 行号)`` —— 四类逐个验。"""
        for name, (raw, expected_type, expected_line) in self.SAMPLES.items():
            with self.subTest(case=name):
                error_type, _message, line = parse_python_error(raw)
                self.assertEqual(error_type, expected_type)
                self.assertEqual(line, expected_line)

    def test_real_interrupt_traceback_is_recognised(self) -> None:
        """★★ 实测的 ``KeyboardInterrupt`` 原文必须被认出来（**末行没有冒号**）。

        这条是踩过的坑：最初的正则强制要求 ``"类名: 说明"``，
        于是死循环中断（Pyodide 抛的 ``KeyboardInterrupt`` 后面什么都没有）
        被判成"认不出的错误"，文案退回通用兜底 —— 头号演示场景当场失真。
        """
        error_type, _message, line = parse_python_error(self.REAL_INTERRUPT_TRACEBACK)
        self.assertEqual(error_type, "KeyboardInterrupt")
        self.assertEqual(line, 2, '行号要取最内层出错帧（<exec> 的第 2 行）')
        self.assertTrue(looks_interrupted(self.REAL_INTERRUPT_TRACEBACK))

        error = build_code_error(self.REAL_INTERRUPT_TRACEBACK)
        assert error is not None
        self.assertEqual(error_label(error.type), "程序运行太久，已被中断")
        self.assertIn("停不下来", error.message)
        # 反馈里不能出现 "Traceback (most recent call last)"（那是要消灭的东西）
        self.assertNotIn("Traceback (most recent call last)", error.message)

    def test_parser_does_not_mistake_identifier_lines_for_errors(self) -> None:
        """★ traceback 里的普通标识符行不许被误认成错误类名（正则加了"首字母大写"的约束）。"""
        # 这一行是真实 traceback 里的构造：`coroutine = eval(self.code, globals, locals)`
        # 若正则允许小写开头，"coroutine = eval(...)" 有可能会被当成 `xxxError` 类名
        decoder_error = (
            'Traceback (most recent call last):\n'
            '  File "/lib/python314.zip/_pyodide/_base.py", line 366, in run\n'
            "    coroutine = eval(self.code, globals, locals)\n"
            '  File "<exec>", line 3, in <module>\n'
            "ValueError: invalid literal for int() with base 10: 'abc'\n"
        )
        error_type, message, line = parse_python_error(decoder_error)
        self.assertEqual(error_type, "ValueError", "别把 coroutine / eval(...) 当成错误类名")
        self.assertIn("invalid literal", message)
        self.assertEqual(line, 3)

    def test_no_duplicated_line_wrapper_in_feedback(self) -> None:
        """★★ 回归：文案里不许出现「第 第 3 行 行」这种重复。

        真实踩到的 bug：``_line_phrase`` 返回「第 3 行」这个**完整短语**，
        而 _ERROR_PLAYBOOK 的模板又自带一层「第 {line} 行」外壳，
        两处都拼 → 学生看到「第 第 3 行 行附近的缩进不对…」（在真实 HTTP 回执里抓到的）。

        修法是把模板里的占位符统一成 ``{line}``（占位符自带完整短语）。
        这条断言盯住两头：既防重复，也防有人把 ``_line_phrase`` 改回返回纯数字。
        """
        self.assertEqual(line_phrase(3), "第 3 行", "_line_phrase 必须返回完整短语")
        self.assertEqual(line_phrase(None), "出错的那一行")

        for name, (raw, _type, line) in self.SAMPLES.items():
            with self.subTest(case=name):
                message = build_code_error(raw)
                assert message is not None
                text = message.message
                self.assertNotIn("第 第", text, f"{name} 的文案出现重复的「第 第」")
                self.assertNotIn("行 行", text, f"{name} 的文案出现重复的「行 行」")
                self.assertIn(f"第 {line} 行", text, f"{name} 的文案没能正确点出行号")

        # 四类 + 中断，全量扫一遍（防某一条模板漏改）
        for error_type, entry in ERROR_PLAYBOOK.items():
            with self.subTest(entry=error_type):
                rendered = entry["message"].format(line="第 7 行")
                self.assertNotIn("第 第", rendered, f"{error_type} 的模板有重复的「第」")
                self.assertNotIn("行 行", rendered, f"{error_type} 的模板有重复的「行」")

    def test_translation_is_friendly_chinese_and_mentions_the_line(self) -> None:
        """★ 每条反馈都是中文、说到具体行号、**且不是原始 traceback 的复读**。"""
        for name, (raw, _type, line) in self.SAMPLES.items():
            with self.subTest(case=name):
                error = build_code_error(raw)
                self.assertIsNotNone(error)
                assert error is not None
                message = error.message
                self.assertTrue(re.search(r"[\u4e00-\u9fff]", message), f"{name} 的反馈没有中文")
                self.assertIn(f"第 {line} 行", message, f"{name} 的反馈没点到行号")
                # 不许把原始 traceback 直接当成反馈（那正是要消灭的东西）
                self.assertNotIn("Traceback (most recent call last)", message)
                self.assertNotIn('File "<exec>"', message)
                # 原始报错要**留档**（供家长/教师排查），但只在 raw_traceback 里
                self.assertIn("File \"<exec>\"", error.raw_traceback)
                self.assertEqual(error.line, line)

    def test_four_required_categories_have_distinct_labels(self) -> None:
        """四类错误的中文标签各不相同（否则学生看不出这是不同的毛病）。"""
        labels = [
            error_label("IndentationError"),
            error_label("NameError"),
            error_label("TypeError"),
            error_label("IndexError"),
        ]
        self.assertEqual(len(set(labels)), 4, f"标签有重复：{labels}")
        self.assertEqual(error_label("IndentationError"), "缩进错误")
        self.assertEqual(error_label("IndexError"), "索引越界")

    def test_unknown_error_type_falls_back_without_pretending(self) -> None:
        """认不出的类名：给通用建议 + 附上程序原话，**不假装认出来了**。"""
        raw = 'File "<exec>", line 7, in <module>\nWeirdCustomError: something odd happened'
        error = build_code_error(raw)
        assert error is not None
        self.assertEqual(error.type, "WeirdCustomError")
        self.assertEqual(error_label("WeirdCustomError"), "运行时出错")
        self.assertIn("第 7 行", error.message)
        # 原话附在后面（截断），供家长/老师一眼定位
        self.assertIn("something odd happened", error.message)

    def test_interrupt_is_not_reported_as_a_wrong_answer(self) -> None:
        """★ 死循环中断的文案**必须区别于「写错了」** —— 这是票 18 的演示场景。"""
        raw = 'File "<exec>", line 2, in <module>\nKeyboardInterrupt: '
        self.assertTrue(looks_interrupted(raw))
        error = build_code_error(raw)
        assert error is not None
        self.assertEqual(error.type, "KeyboardInterrupt")
        self.assertIn("停不下来", error.message)
        self.assertNotIn("大多数同学都遇到过", error.message)

    def test_empty_stderr_means_success(self) -> None:
        """没有报错 → 没有 ``CodeError``（成功路径与失败路径不能混）。"""
        self.assertIsNone(build_code_error(""))
        self.assertIsNone(build_code_error("   \n  "))

    def test_traceback_is_truncated_but_kept(self) -> None:
        """超长 traceback 要截断（不能把 IPC 与 DOM 撑爆），但原文要在。"""
        raw = 'File "<exec>", line 1, in <module>\nValueError: ' + "x" * 20_000
        error = build_code_error(raw)
        assert error is not None
        self.assertLess(len(error.raw_traceback), 20_000)
        self.assertIn("已截断", error.raw_traceback)


# ====================================================================== *
# 4. 分级提示：递进、不跳级、封顶
# ====================================================================== *


class HintLevelTests(unittest.TestCase):
    """``CodingHint.level`` 的推进规则（★ 不许跳级是票 19 的硬要求）。"""

    def test_level_follows_consecutive_failures(self) -> None:
        """第 1 次失败给 level 1，第 2 次 level 2，第 3 次 level 3。"""
        self.assertEqual(resolve_hint_level(1), 1)
        self.assertEqual(resolve_hint_level(2), 2)
        self.assertEqual(resolve_hint_level(3), 3)

    def test_level_never_exceeds_max(self) -> None:
        """失败很多次也停在最高级（不越界、不报错）。"""
        self.assertEqual(resolve_hint_level(4), MAX_HINT_LEVEL)
        self.assertEqual(resolve_hint_level(99), MAX_HINT_LEVEL)

    def test_never_skips_a_level(self) -> None:
        """★★ 不跳级：已知只给过 level 1 时，这一次最多到 level 2 —— 即使失败次数很大。"""
        self.assertEqual(resolve_hint_level(9, current_level=1), 2)
        self.assertEqual(resolve_hint_level(9, current_level=0), 1)
        self.assertEqual(resolve_hint_level(9, current_level=2), 3)
        # 已经到顶就停在顶
        self.assertEqual(resolve_hint_level(9, current_level=3), 3)

    def test_unknown_current_level_falls_back_to_failure_count(self) -> None:
        """调用方不知道给过几级（``current_level=None``，即本路由的默认）→ 按失败次数定级。

        ★ 这是**无状态路由**的正确行为：它只拿到契约里的 ``attempt``，
        不能凭空假设「学生上一次看到的是第几级」（那会让 ``attempt=3`` 永远给不出 level 3）。
        护栏交给**有状态的那一侧**（``coding.ts`` 的 ``hintLevel``）按知识点记忆后再传进来。
        """
        self.assertEqual(resolve_hint_level(1, current_level=None), 1)
        self.assertEqual(resolve_hint_level(3, current_level=None), 3)

    def test_respects_template_actual_hint_count(self) -> None:
        """模板只写到 2 级时不许造出第 3 级（那会返回空提示）。"""
        self.assertEqual(resolve_hint_level(9, max_level=2), 2)
        self.assertEqual(resolve_hint_level(1, max_level=2), 1)
        # 没有提示的模板 → 0（调用方据此返回 next_hint=None）
        self.assertEqual(resolve_hint_level(3, max_level=0), 0)

    def test_manual_help_button_walks_up_one_level(self) -> None:
        """手动点「求助」：每次升一级，到顶就停。"""
        self.assertEqual(next_hint_level(0), 1)
        self.assertEqual(next_hint_level(1), 2)
        self.assertEqual(next_hint_level(2), 3)
        self.assertEqual(next_hint_level(3), 3)
        self.assertEqual(next_hint_level(0, max_level=1), 1)
        self.assertEqual(next_hint_level(1, max_level=1), 1)

    def test_hint_texts_are_three_distinct_texts(self) -> None:
        """同一个 kp 的三级提示文本互不相同（前端展示差异的证据）。"""
        report = load_templates(TEMPLATES_DIR)
        for record in report.records:
            with self.subTest(kp=record.kp_id):
                texts = [record.hint_at(level).hint for level in (1, 2, 3)]  # type: ignore[union-attr]
                self.assertEqual(len(set(texts)), 3)
                # 长度不作「递进」的代理：内容包风格是 L1 指方向 → L2 关键代码行 →
                # L3 下一行，L3 常比 L2 短（详见 test_hints_are_graduated…，D-078）


# ====================================================================== *
# 5. HTTP 端点：契约合规 + ★ 参照实现不泄漏
# ====================================================================== *


class CodeRouteTests(CodeCase):
    """两条端点的端到端行为（真发 HTTP、真序列化）。"""

    def _use_templates_dir(self, path: Path) -> None:
        setattr(self.app.state, TEMPLATES_DIR_STATE_ATTR, str(path))

    # ---------------------------------------------------- GET templates --
    def test_get_template_returns_contract_shape(self) -> None:
        response = self.client.get("/api/code/templates/prog-loop-jr")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        # 契约字段（camelCase 出参）
        # ★ 2026-09-30：`title` / `expectedOutput` 也进契约 —— 学生看简报最需要的两样
        #   （「要写什么」与「做完程序打印什么」）；`solution` / `hints` 仍然不出后端。
        self.assertEqual(
            set(body.keys()),
            {"kpId", "language", "scaffold", "expectedBehavior", "title", "expectedOutput"},
        )
        self.assertEqual(body["kpId"], "prog-loop-jr")
        self.assertEqual(body["language"], "python")
        self.assertIn("TODO", body["scaffold"])
        self.assertTrue(body["expectedBehavior"])
        self.assertTrue(body["title"], "任务名必须有（面向学生说清「要写什么」）")
        self.assertTrue(body["expectedOutput"], "期望输出必须有（「做完长什么样」）")

    def test_solution_never_appears_in_response(self) -> None:
        """★★ 参照实现不出后端：把哨兵写进 solution，端到端确认响应里零命中。"""
        with tempfile.TemporaryDirectory() as tmp:
            record = json.loads((TEMPLATES_DIR / "prog-loop-jr.json").read_text(encoding="utf-8"))
            record["solution"] = SENTINEL_SOLUTION
            (Path(tmp) / "prog-loop-jr.json").write_text(
                json.dumps(record, ensure_ascii=False), encoding="utf-8"
            )
            self._use_templates_dir(Path(tmp))
            response = self.client.get("/api/code/templates/prog-loop-jr")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertNotIn(SENTINEL_SOLUTION, response.text, "参照实现泄漏到了响应里")

    def test_projection_drops_internal_fields(self) -> None:
        """投影是**白名单**：内部模型多出任何字段都不会带出去。

        ★ 2026-09-30：`title` 与 `expected_output` **有意**从内部转成对外字段（学生看简报
        需要「要写什么」与「做完长什么样」，见 `to_code_template` 的注释）。所以这里
        改为断言「它们在契约里」，而参照实现（`solution`）与提示（`hints`）仍然一个都不出。
        """
        record = load_templates(TEMPLATES_DIR).records[0]
        payload = to_code_template(record)
        self.assertFalse(hasattr(payload, "solution"))
        self.assertFalse(hasattr(payload, "hints"))
        self.assertIn("expected_output", type(payload).model_fields)
        self.assertIn("title", type(payload).model_fields)
        self.assertNotIn("solution", payload.model_dump_json())
        self.assertNotIn("hints", payload.model_dump_json())

    def test_missing_template_returns_readable_404(self) -> None:
        response = self.client.get("/api/code/templates/no-such-kp")
        self.assertEqual(response.status_code, 404)
        detail = response.json()["detail"]
        self.assertIn("no-such-kp", detail)
        self.assertIn("code-templates", detail)

    def test_grade_level_filter_is_opt_in(self) -> None:
        """★ 学段过滤是**显式开关**：传了就按兼容链卡，不传就不过滤（有意取舍，见路由注释）。"""
        # 不传学段 → 取得到
        self.assertEqual(self.client.get("/api/code/templates/prog-variable-jr").status_code, 200)
        # 传了更低学段 → 卡住（小学高年级取不到初中的决策树模板）
        blocked = self.client.get("/api/code/templates/prog-variable-jr?gradeLevel=primary_high")
        self.assertEqual(blocked.status_code, 404)
        self.assertIn("高于当前学段", blocked.json()["detail"])
        # 传了本学段 → 取得到
        self.assertEqual(
            self.client.get("/api/code/templates/prog-variable-jr?gradeLevel=junior").status_code, 200
        )
        # 非法学段 → 422
        self.assertEqual(
            self.client.get("/api/code/templates/prog-loop-jr?gradeLevel=college").status_code, 422
        )

    def test_broken_template_is_skipped_not_fatal(self) -> None:
        """坏模板只跳过：同目录里好的那个仍然取得到（演示时不该被一条手滑记录拖垮）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "broken.json").write_text("{不是合法 JSON", encoding="utf-8")
            (root / "nofields.json").write_text('{"kp_id": "x"}', encoding="utf-8")
            (root / "prog-loop-jr.json").write_text(
                (TEMPLATES_DIR / "prog-loop-jr.json").read_text(encoding="utf-8"), encoding="utf-8"
            )
            self._use_templates_dir(root)
            report = load_templates(root)
            self.assertEqual(len(report.records), 1)
            self.assertEqual(len(report.skipped), 2)
            self.assertEqual(self.client.get("/api/code/templates/prog-loop-jr").status_code, 200)

    def test_all_templates_reachable_over_http(self) -> None:
        """每个落地的模板都能经 HTTP 取到（离线可用的证据：纯本地文件读取）。"""
        for record in load_templates(TEMPLATES_DIR).records:
            with self.subTest(kp=record.kp_id):
                response = self.client.get(f"/api/code/templates/{record.kp_id}")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertIn("TODO", response.json()["scaffold"])

    # ------------------------------------------------------- POST run-hint --
    def test_success_path_returns_stdout_and_no_error(self) -> None:
        """运行成功：``ok=true``、stdout 原样回传、没有 error、没有 hint。"""
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "print('60 75 88')",
                "language": "python",
                "stdout": "60 75 88\n",
                "stderr": "",
                "attempt": 1,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["stdout"], "60 75 88\n")
        self.assertIsNone(body["error"])
        self.assertIsNone(body["nextHint"])
        self.assertTrue(body["feedback"])

    def test_failure_path_returns_structured_error_and_hint(self) -> None:
        """运行失败：结构化 error（中文 message + 原文留档）+ 第 1 级提示。"""
        raw = 'File "<exec>", line 3\n    print(total)\nIndentationError: unexpected indent'
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "if True:\nprint(1)",
                "stdout": "",
                "stderr": raw,
                "attempt": 1,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["type"], "IndentationError")
        self.assertEqual(body["error"]["line"], 3)
        self.assertIn("缩进", body["error"]["message"])
        self.assertIn("File \"<exec>\"", body["error"]["rawTraceback"])
        self.assertEqual(body["nextHint"]["level"], 1)

    def test_hint_level_advances_with_attempt(self) -> None:
        """逐次失败 → 提示级别 1→2→3，且文本各不相同（端到端，不只是纯函数）。"""
        stderr = 'File "<exec>", line 2, in <module>\nNameError: name \'x\' is not defined'
        seen: list[tuple[int, str]] = []
        for attempt in (1, 2, 3):
            response = self.client.post(
                "/api/code/run-hint",
                json={
                    "studentId": "student_001",
                    "kpId": "prog-loop-jr",
                    "code": "print(x)",
                    "stdout": "",
                    "stderr": stderr,
                    "attempt": attempt,
                },
            )
            body = response.json()
            seen.append((body["nextHint"]["level"], body["nextHint"]["hint"]))
        self.assertEqual([level for level, _ in seen], [1, 2, 3])
        self.assertEqual(len({text for _, text in seen}), 3, "三级提示文本有重复")

    def test_run_hint_does_not_execute_code(self) -> None:
        """★★ 端点**不执行**代码：故意传一段「会写文件 / 死循环」的代码，进程纹丝不动。

        判据是行为而不是声明：若这个端点真去跑了，`open(...,'w')` 会建出文件、
        `while True` 会把测试挂死。两者都没发生 = 它真的只是做文本处理。
        """
        marker = self.tmp / "should-not-exist.txt"
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": f"open({str(marker)!r}, 'w').write('x')\nwhile True: pass",
                "stdout": "",
                "stderr": "",
                "attempt": 1,
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(marker.exists(), "端点竟然执行了学生代码（写文件成功了）")

    def test_interrupted_run_gets_interrupt_wording(self) -> None:
        """★ 死循环被中断：反馈说的是「停不下来」，并且给出第 1 级提示。"""
        stderr = 'File "<exec>", line 2, in <module>\nKeyboardInterrupt: '
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "while True:\n    pass",
                "stdout": "",
                "stderr": stderr,
                "attempt": 1,
            },
        )
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["error"]["type"], "KeyboardInterrupt")
        self.assertIn("停不下来", body["feedback"])
        self.assertEqual(body["nextHint"]["level"], 1)

    def test_long_output_is_truncated(self) -> None:
        """超长输出要截断并标明（不截断会把 IPC 与 DOM 撑爆）。"""
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "print('x' * 100000)",
                "stdout": "x" * 100_000,
                "stderr": "",
                "attempt": 1,
            },
        )
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertIn("已截断", body["stdout"])
        self.assertLess(len(body["stdout"]), 100_000)

    def test_oversized_code_is_rejected_readably(self) -> None:
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "x = 1\n" * 20_000,
                "stdout": "",
                "stderr": "",
                "attempt": 1,
            },
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("代码过长", response.json()["detail"])

    def test_unknown_kp_still_gets_feedback_without_hint(self) -> None:
        """没有模板也要给反馈（报错翻译与模板无关），只是没有分级提示。"""
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "some-other-kp",
                "code": "print(1)",
                "stdout": "",
                "stderr": 'File "<exec>", line 1, in <module>\nTypeError: bad types',
                "attempt": 1,
            },
        )
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIsNotNone(body["error"])
        self.assertTrue(body["feedback"])
        self.assertIsNone(body["nextHint"])

    def test_invalid_attempt_is_rejected_by_contract(self) -> None:
        """``attempt`` 契约是 ``ge=1``：0 或负数应在契约层被拒（422）。"""
        response = self.client.post(
            "/api/code/run-hint",
            json={
                "studentId": "student_001",
                "kpId": "prog-loop-jr",
                "code": "print(1)",
                "stdout": "",
                "stderr": "",
                "attempt": 0,
            },
        )
        self.assertEqual(response.status_code, 422)


# ====================================================================== *
# 6. ★ 守卫：本模块不含任何执行原语（「学生代码不在服务端执行」的静态证据）
# ====================================================================== *


class NoCodeExecutionGuardTests(unittest.TestCase):
    """★ 执行文档 §12 硬约束的服务端一半。

    「学生代码绝不在主进程执行」由渲染进程的 Pyodide Worker 保证；
    这一条是它的**对偶**：服务端也不许成为第二条执行路径 ——
    否则编排层只要愿意，就能把任意代码送进一个真 Python 进程（那正是要避免的）。
    """

    #: 一旦出现在 ``routes/code.py`` 的可执行代码里就是越界。
    #:
    #: ⚠️ ``compile`` 要排除 ``re.compile(...)``：正则编译是纯文本处理，
    #: 与「把字符串当代码编译」是两回事（本模块**大量**用正则解析 traceback）。
    #: 所以判据是「**裸调用**」（前面没有点号）而不是「字面出现」——
    #: 这也是为什么断言写在这里而不是靠肉眼：``re.compile`` 太像越界了。
    FORBIDDEN_PATTERNS = (
        (r"(?<![.\w])exec\s*\(", "exec()"),
        (r"(?<![.\w])eval\s*\(", "eval()"),
        (r"(?<![.\w])compile\s*\(", "compile()（裸调用，非 re.compile）"),
        (r"subprocess", "subprocess"),
        (r"os\.system", "os.system"),
        (r"os\.popen", "os.popen"),
        (r"runpy", "runpy"),
        (r"(?<![.\w])__import__\s*\(", "__import__()"),
        (r"pty\.spawn", "pty.spawn"),
    )

    def test_route_module_has_no_execution_primitive(self) -> None:
        source = CODE_ROUTE_FILE.read_text(encoding="utf-8")
        # 去掉文档字符串与注释里「解释为什么不能执行」的说明文字，只看可执行代码
        # （注释里写「这里不出现 exec(」是好注释，不该被判违规 ——
        #   与 desktop 侧守卫的 stripComments 同一口径）。
        code = re.sub(r'"""(?:.|\n)*?"""', " ", source)
        code = re.sub(r"#.*", " ", code)
        offenders = [label for pattern, label in self.FORBIDDEN_PATTERNS if re.search(pattern, code)]
        self.assertEqual(
            offenders,
            [],
            f"routes/code.py 里出现执行原语 {offenders} —— 学生代码绝不在服务端执行（§12）",
        )

    def test_route_module_does_not_import_a_subprocess_or_runpy(self) -> None:
        """import 层面也要干净（少写一个 ``import subprocess`` 就绕过了上面的字面量扫描）。"""
        source = CODE_ROUTE_FILE.read_text(encoding="utf-8")
        imports = re.findall(r"^\s*(?:import|from)\s+([\w.]+)", source, flags=re.MULTILINE)
        banned = {"subprocess", "runpy", "pty", "shlex", "asyncio.subprocess"}
        hits = sorted(set(imports) & banned)
        self.assertEqual(hits, [], f"routes/code.py 导入了执行相关模块：{hits}")

    def test_route_module_exposes_no_run_endpoint(self) -> None:
        """端点集合是冻结的三条：取模板 + 取提示 + 评估结果。**没有**「执行代码」的端点。

        ★ 这条断言的价值在于"新加端点必须过这里"：将来有人想加
        ``POST /api/code/run``（在服务端跑代码）时，这条测试会当场变红，
        逼他面对 §12 的硬约束 —— 这是把安全边界写成**可执行断言**而不是口头纪律。
        """
        # ★ 去重是按**路径**去重：同一条路径上挂两个方法（如生成题的 POST 存 / GET 列）
        #   在这条守卫里只算一条 —— 它管的是「路径集合里有没有执行代码的入口」。
        paths = sorted(
            {
                route.path
                for route in code_router.routes
                if getattr(route, "path", "").startswith("/api/code")
            }
        )
        self.assertEqual(
            paths,
            # ★ 2026-09-26（D-089）新增三条：**存 / 列 / 取 / 取提示**，都不执行任何代码 ——
            #   它们是「学生自己的生成编程题」的落点（随包模板目录是只读的，生成题要有别处可存）。
            #   代码执行仍在渲染进程的 Pyodide Worker（§12），这一条边界一个字没动。
            # ⚠️ 这里必须与 `sorted(...)` 同序（上面那行取的就是排序后的路径）。
            [
                "/api/code/generated/{student_id}",
                "/api/code/generated/{student_id}/{saved_id}",
                "/api/code/generated/{student_id}/{saved_id}/hint",
                "/api/code/hint/{kp_id}",
                "/api/code/run-hint",
                "/api/code/templates/{kp_id}",
            ],
            "端点是冻结的：/api/code 下不该出现任何「执行代码」的路径",
        )
        # 双保险：任何端点路径都不许长得像"执行"
        for path in paths:
            with self.subTest(path=path):
                self.assertNotIn("exec", path.lower())
                self.assertNotRegex(path.lower(), r"/run/?$", "只有 run-hint（评估），没有 run（执行）")


if __name__ == "__main__":
    unittest.main()
