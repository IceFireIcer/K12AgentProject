# -*- coding: utf-8 -*-
"""动画模板与渲染校验（票 17）：模板内容质量 + 「校验 → 重试 → 降级」链的**服务端一半**。

本文件盯住六条（每条对应票据里的一条验收口径）：

1. ★ **模板落位与覆盖**：模板数量不做限制（用户裁决 2026-09-22，一 KP 一模板会到 200+ 份），
   但**每份都要能被加载**（一个都不许被跳过），且至少覆盖
   「排序 / 神经网络 / 决策树 / 梯度下降 / 循环 / 变量」，
   每个都声明了参数 schema 与**非空降级文案**；
2. ★ **零外部引用**：模板文件与**渲染产物**里都不许出现 `http(s)://` / `unpkg` / `jsdelivr` / `cdn`；
3. ★ **凭据不进产物**：产物里不得出现 API Key、baseURL、宿主绝对路径（票 17 的硬要求）；
4. **库与运行时都内联**：产物里能找到动画库与沙箱运行时的标记，且有 `ready` 上报与 `payload_id`；
5. **结构安全**：产物里没有内嵌 iframe、没有放开沙箱的属性、不碰宿主存储；
6. ★ **降级链**：渲染或校验失败 → `TemplateError`（可读原因）→ 调用方据此重试；
   重试仍失败时**TS 侧**降级为文字 + 静态图（那条在 `desktop/tests/animation-extension.test.ts`）。
   本文件负责证明「坏产物一定被判不合格」，包括**人为注入错误**那条演练路径。

夹具用真的 `server/resources/templates/` 与真的 `server/knowledge/`：
模板是随包分发的内容资产，测试要盯住的就是它的内容质量。
"""

from __future__ import annotations

import json
import os
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
from app.main import create_app  # noqa: E402
from app.routes import resources as R  # noqa: E402

TEMPLATES_DIR = R.templates_dir()

#: ★ 票据点名的六个知识点主题，必须都有模板覆盖。
REQUIRED_THEMES = ("排序", "神经网络", "决策树", "梯度下降", "循环", "变量")

#: 外部引用的判据（与 `resources.py` 的正则同源，测试里独立写一份做交叉验证）。
EXTERNAL_RE = r"https?://|//cdn|unpkg|jsdelivr|cdnjs|googleapis|fonts\.gstatic"

# --------------------------------------------------------------------------- #
# 生成的 206 份（票 A2 重写后的那批）的质量判据
#
# ★ 为什么守卫认「生成的」而不是「全部 214 份」：8 份手作高保真模板（premium）是
#   本票的**质量标尺**，不是被本票重写的对象 —— 它们的脚本用的是自己的 rAF 循环、
#   自己的文案风格，有的（decision-tree）caption 里本来就带「…」。把它们一起扫，
#   要么当场全红、要么就得给它们开豁免，而豁免会把守卫的判据稀释掉。
#   所以判据的扫描面 = 带生成标记的那批，premium 的**质量**由人看（截图 + 评审）。
# --------------------------------------------------------------------------- #

#: 生成器写在脚本第一行的原型标记（`preset-content/_meta/gen_animations.py` 的契约）。
GENERATED_MARKER_RE = re.compile(r"^/\* K12-ARCHETYPE ([a-z_]+) \| skin=([a-z]+) \*/", re.M)

#: 生成器写在第二行的相位数声明：`/* k12:phases min=<最少> default=<默认> */`。
#: 相位数是 JS 字面量时用它，是表达式（`COUNT + 2`）时守卫照**这个声明**判 ——
#: 声明与真实表达式的一致性由 `preset-content/_meta/gen_animations.py` 自己的断言兜住
#: （`build_by_kp()` 里 `phases_expr` 就是 `ARCHETYPES[..]["phases"]` 的第二项）。
PHASES_MARKER_RE = re.compile(r"/\* k12:phases min=(\d+) default=(\d+) \*/")

#: 学段 → 皮肤（**只读**：真源在 `server/app/routes/resources.py::GRADE_TO_SKIN`）。
ILLUSTRATED_GRADES = ("primary_low", "primary_high")

#: 相位下限：插画系（小学）≥ 4，工程系（中学）≥ 5 —— 用户抱怨的原话是「放几个方框、
#: 渐入渐出就草草了事」，4/5 是「有过程可看」的地板，不是目标值（实际 min 见报告）。
MIN_PHASES = {"illustrated": 4, "technical": 5}

#: 每（原型 × 皮肤）的 duration_ms 允许区间 —— **独立副本**（守卫不许读生成器的输出）。
#: ⚠️ 与 `preset-content/_meta/gen_animations.py::DURATION_RANGES` 必须逐字一致：
#: 那张表改了这里不改，本守卫会红；这里改了那边不改，生成器自己的断言会红。
DURATION_RANGES: dict[tuple[str, str], tuple[int, int]] = {
    ("scene", "illustrated"): (6800, 9200),
    ("dialogue", "illustrated"): (6800, 9200),
    ("contrast_kid", "illustrated"): (6600, 9000),
    ("accumulate_kid", "illustrated"): (6600, 9000),
    ("checklist_kid", "illustrated"): (6600, 9000),
    ("flow", "technical"): (4000, 6400),
    ("compare", "technical"): (3800, 6200),
    ("layers", "technical"): (4000, 6400),
    ("loop", "technical"): (4400, 12000),
    ("tree", "technical"): (4400, 7200),
    ("network", "technical"): (4800, 7600),
    ("matrix", "technical"): (4200, 7000),
    ("trace", "technical"): (5400, 9600),
    ("counter", "technical"): (4000, 7200),
    ("scene", "technical"): (4400, 7000),
    ("dialogue", "technical"): (4400, 7000),
    ("contrast_kid", "technical"): (4200, 6800),
    ("accumulate_kid", "technical"): (4200, 6800),
    ("checklist_kid", "technical"): (4200, 6800),
    ("flow", "illustrated"): (6600, 9200),
    ("compare", "illustrated"): (6600, 9200),
    ("layers", "illustrated"): (6600, 9200),
    ("loop", "illustrated"): (7000, 18000),
    ("tree", "illustrated"): (7000, 9600),
    ("network", "illustrated"): (7400, 11000),
    ("matrix", "illustrated"): (7000, 9600),
    ("trace", "illustrated"): (7400, 13000),
    ("counter", "illustrated"): (6800, 9600),
}

#: 可以出现的可动画属性（至少要凑够两种 —— 「只渐变不变化」正是被投诉的那种动画）。
ANIMATABLE_PROPS = (
    "opacity",
    "scale",
    "translateX",
    "translateY",
    "stroke",
    "strokeWidth",
    "rotate",
)

#: 色值字面量判据（与 `_meta/expand_templates.py` 同源）：颜色只许走 CSS 类与变量。
RAW_COLOUR_RE = r"#[0-9a-fA-F]{3,8}\b|rgba?\("

#: 学生面文案的禁忌标记（内容卫生守卫同款，本文件在**动画这一半**再盯一遍）。
FORBIDDEN_MARKS = ("…", "...", "——", "**", "`")

#: 步骤条允许用的位置量词（D-087）：步骤条是**运行时元素**，它必须说内容已经在用的词。
#: 出现新词时这条守卫会红 —— 那是提醒你把它加进来（而不是让步骤条自己造一个说法）。
STEP_UNIT_WORDS = ("站", "轮", "组", "件", "条", "段", "行", "层", "圈", "次", "个问题", "步")


def _generated_templates() -> list:
    """发货目录里**由生成器产出**的那 206 份（带 `K12-ARCHETYPE` 标记）。"""
    return [
        template
        for template in R.load_templates(TEMPLATES_DIR)
        if GENERATED_MARKER_RE.search(template.script)
    ]


def _phases_of(template) -> tuple[int, int]:
    """(最少相位, 默认相位)：字面量取脚本里的真值，表达式取生成器的声明。"""
    match = PHASES_MARKER_RE.search(template.script)
    assert match, f"{template.id} 的脚本里没有相位数声明（生成器契约变了？）"
    return int(match.group(1)), int(match.group(2))


def _write_template(root: Path, payload: dict, name: str | None = None) -> Path:
    """写一份模板 JSON 并返回路径。

    `name` 可以覆盖文件名 —— 「缺字段」这类坏模板连 `id` 都没有，不能拿它当文件名
    （否则测试会先在 `payload['id']` 上抛 KeyError，而我们要验的是 **TemplateError**）。
    """
    path = root / f"{name or payload.get('id') or 'unnamed'}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def _minimal_template(**overrides: object) -> dict:
    """一份**最小可用**模板（用于测试参数解析与校验，不参与「覆盖度」断言）。"""
    base: dict = {
        "id": "unit-minimal",
        "label": "单测模板",
        "title": "单测模板",
        "concept": "单测",
        "kp_ids": ["unit-kp"],
        "grade_levels": ["junior"],
        "duration_ms": 1000,
        "params": {
            "n": {"type": "int", "min": 1, "max": 5, "default": 3, "description": "数量"},
        },
        "body": '<p id="c">{{n}}</p>',
        "script": "Sandbox.play(function () { return null });\nSandbox.ready({ n: {{n}} });",
        "fallback_text": "这是一段足够长的降级文案，用来保证降级后学生仍然能看到讲解内容。",
    }
    base.update(overrides)
    return base


class TestTemplatesDirectory(unittest.TestCase):
    """★ 模板内容质量（票 17 第 1、5、6 项）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.templates = R.load_templates(TEMPLATES_DIR)

    def test_directory_exists_and_every_template_loads(self) -> None:
        """模板目录要在，且**每一份**都要能被 ``load_templates`` 加载。

        模板数量不做限制（用户裁决 2026-09-22，一 KP 一模板会到 200+ 份，
        旧「6–8 个」的上下限已作废）。但「一份都没有」不是数量问题而是事故：
        目录被清空 / 导入没落盘时，本文件里按模板遍历的断言会**空转全绿**
        （循环体一次都不进）。所以下限写死「至少 1 份」兜住空跑，并与
        ``test_required_themes_are_covered``（六个点名主题必须有模板覆盖）
        互为兜底 —— 后者在空目录上同样必红。
        """
        self.assertTrue(TEMPLATES_DIR.is_dir(), f"模板目录不存在：{TEMPLATES_DIR}")
        count = len(list(TEMPLATES_DIR.glob("*.json")))
        self.assertGreater(count, 0, "一个模板都没有（目录被清空了？模板 JSON 没落盘？）")
        self.assertEqual(len(self.templates), count, "有模板被 load_templates 跳过了（模板本身不合格）")

    def test_required_themes_are_covered(self) -> None:
        """票据点名的六个主题必须各有模板（否则「模板优先」在这些知识点上直接落空）。"""
        concepts = {template.concept for template in self.templates}
        labels = {template.label for template in self.templates}
        titles = " ".join(template.title for template in self.templates)
        missing = [
            theme
            for theme in REQUIRED_THEMES
            if not any(theme in text for text in (concepts | labels | {titles}))
        ]
        self.assertEqual(missing, [], f"这些主题没有模板覆盖：{missing}")

    def test_every_template_declares_params_and_fallback(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.id):
                self.assertTrue(template.params, f"{template.id} 没有声明任何参数")
                self.assertGreaterEqual(
                    len(template.fallback_text.strip()), 30, f"{template.id} 的降级文案太短"
                )
                self.assertGreater(template.duration_ms, 0)
                # 参数必须有默认值（模型不填时模板仍能渲染）
                for name, parameter in template.params.items():
                    self.assertIsNotNone(parameter.default, f"{template.id}.{name} 缺 default")
                    self.assertIn(parameter.type, ("int", "float", "str", "bool"))

    def test_每个模板的_kp_ids_都指向真实存在的知识点(self) -> None:
        """★ 模板声明的知识点必须是教材里真有的 —— 编造的 id 会让模板永远选不中。"""
        known: set[str] = set()
        for path in KNOWLEDGE_DIR.rglob("*.md"):
            text = path.read_text(encoding="utf-8")
            for line in text.splitlines():
                if line.startswith("kp_id:"):
                    known.add(line.split(":", 1)[1].strip())
        self.assertTrue(known, f"没从 {KNOWLEDGE_DIR} 里读到任何 kp_id（教材结构变了？）")

        unknown: list[str] = []
        for template in self.templates:
            for kp_id in template.kp_ids:
                if kp_id not in known:
                    unknown.append(f"{template.id} → {kp_id}")
        self.assertEqual(unknown, [], f"模板声明了教材里不存在的知识点：{unknown}")

    def test_模板占位符与参数声明一致(self) -> None:
        """模板里 `{{name}}` 用到的参数必须声明过，声明的也必须用到（否则渲染出来是半成品）。"""
        for template in self.templates:
            with self.subTest(template=template.id):
                import re

                used = set(
                    re.findall(
                        r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}",
                        template.body + template.script,
                    )
                )
                self.assertEqual(used - set(template.params), set(), f"{template.id} 用了未声明的参数")
                self.assertEqual(set(template.params) - used, set(), f"{template.id} 声明了没用上的参数")


class TestNoExternalReferences(unittest.TestCase):
    """★ 陷阱 §6 第 3 条：模板内联 CDN → 沙箱断网白屏。"""

    def test_template_files_have_no_external_reference(self) -> None:
        import re

        pattern = re.compile(EXTERNAL_RE, re.IGNORECASE)
        offenders: list[str] = []
        for path in sorted(TEMPLATES_DIR.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in {".json", ".js", ".css"}:
                continue
            match = pattern.search(path.read_text(encoding="utf-8"))
            if match:
                offenders.append(f"{path.name} → 「{match.group(0)}」")
        self.assertEqual(
            offenders,
            [],
            f"模板文件里出现外部引用：{offenders}（沙箱断网会白屏，动画库必须本地读取后内联）",
        )

    def test_rendered_html_has_no_external_reference(self) -> None:
        import re

        pattern = re.compile(EXTERNAL_RE, re.IGNORECASE)
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                payload = R.render_animation(template, payload_id="unit")
                match = pattern.search(payload.html)
                self.assertIsNone(match, f"{template.id} 的产物里出现外部引用：{match and match.group(0)}")

    def test_共享运行时里没有_http_字面量_除了拼出来的命名空间(self) -> None:
        """运行时是唯一可能引入 `http://` 的地方（SVG 命名空间），且它是**拼出来**的。"""
        runtime = R.read_shared(TEMPLATES_DIR, R.RUNTIME_FILENAME)
        self.assertNotRegex(
            runtime,
            r"https?://",
            "运行时的源码里出现了完整的 http 字面量（命名空间必须拆成两段拼）",
        )
        # 拼出来的那个值必须真的是标准命名空间
        self.assertIn("'http' + ':' + '//www.w3.org/2000/svg'", runtime)

    def test_动画库确实是_v3(self) -> None:
        """陷阱 §6 第 2 条：必须锁 v3（v4 API 不兼容）。"""
        library = R.read_shared(TEMPLATES_DIR, R.ANIME_LIB_FILENAME)
        self.assertIn("anime.js v3", library, "内联的动画库不是 v3")
        self.assertRegex(library, r"v3\.\d", "动画库版本号里没有 v3.x")


class TestRenderedHtmlSafety(unittest.TestCase):
    """★ 产物本身的结构安全（票 17 第 4、5 项 + 凭据不进 HTML）。"""

    def test_产物里库与运行时都内联_且有_ready_与payload_id(self) -> None:
        template = R.load_templates(TEMPLATES_DIR)[0]
        payload = R.render_animation(template, payload_id="unit-pid")
        html = payload.html
        self.assertIn(R.INLINE_LIBRARY_MARKER, html, "动画库没有内联")
        self.assertIn(R.INLINE_RUNTIME_MARKER, html, "沙箱运行时不在了")
        self.assertIn(R.READY_MARKER, html, "没有 ready 上报（宿主会等到超时）")
        self.assertIn(R.PAYLOAD_ID_MARKER, html, "没有 payload_id（多卡片会串台）")
        self.assertIn('"unit-pid"', html, "payload_id 要真的注入进去")
        self.assertLess(html.index(R.INLINE_LIBRARY_MARKER), html.index("Sandbox.play"), "库必须在模板脚本之前")

    def test_模板的页面片段真的进了产物(self) -> None:
        """★ 回归用例：`{body}` 一旦在拼接时漏掉，模板脚本就会在**空 DOM** 上跑。

        实测踩到（症状极具误导性）：脚本第一句 `document.getElementById('caption')` 拿到 `null`，
        于是 `Sandbox.ready()` 那一行永远执行不到 → 宿主 5 秒后判超时 → 卡片降级。
        单测全绿（HTML 结构完全合法），只有真在浏览器里跑才暴露。
        """
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                payload = R.render_animation(template, payload_id="unit")
                # 模板 body 里的标题必须在产物里（它是每个模板都有的第一个元素）
                self.assertIn("<h1", payload.html, "模板的页面片段没进产物（body 占位符漏了？）")
                stage = payload.html.index('<div id="stage">')
                body_position = payload.html.index("<h1", stage)
                script_position = payload.html.index(R.READY_MARKER)
                self.assertLess(body_position, script_position, "页面元素必须排在模板脚本之前")

    def test_payload_id_注入必须排在沙箱运行时之前(self) -> None:
        """★★ 回归用例（实测踩到，且**只有真在浏览器里跑才会暴露**）。

        沙箱运行时在 IIFE 求值时就读 `window.__K12_PAYLOAD_ID__`。顺序反了的话它读到
        `undefined`，会自造一个随机 id —— 与卡片手里的 id 对不上，于是**所有消息都被当成串台丢掉**，
        卡片永远等不到 `ready`、5 秒后超时降级。表现极具误导性：动画明明能播，
        卡片却说「加载失败」（单测全绿，因为两边各自都自洽）。
        """
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                html = R.render_animation(template, payload_id="order-check").html
                assignment = html.index('__K12_PAYLOAD_ID__ = "order-check"')
                runtime = html.index(R.INLINE_RUNTIME_MARKER)
                library = html.index(R.INLINE_LIBRARY_MARKER)
                self.assertLess(library, assignment, "动画库应当最先内联")
                self.assertLess(
                    assignment,
                    runtime,
                    "payload_id 的注入必须排在沙箱运行时之前（否则运行时会自造一个随机 id）",
                )

    def test_产物里没有内嵌iframe_没有放开沙箱_不碰宿主存储(self) -> None:
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                html = R.render_animation(template, payload_id="unit").html.lower()
                self.assertNotIn("<iframe", html, "产物里不该再嵌 iframe")
                self.assertNotIn(R.FORBIDDEN_SANDBOX_FLAG, html, "产物里出现了放开沙箱的属性")
                for token in ("localstorage", "document.cookie", "indexeddb"):
                    self.assertNotIn(token, html, f"产物里出现宿主存储访问：{token}")

    def test_产物里没有凭据与宿主路径(self) -> None:
        """★ 票 17 硬要求：API Key / baseURL / 本机绝对路径都不进 HTML。"""
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                html = R.render_animation(template, payload_id="unit").html
                for label, pattern in R.CREDENTIAL_PATTERNS:
                    self.assertIsNone(pattern.search(html), f"产物里出现禁项：{label}")

    def test_降级图是可用_dataURL_且外层没有_http_字面量(self) -> None:
        svg = R.build_fallback_svg(concept="排序", title="排序", text="反复比较相邻的两个数。")
        self.assertTrue(svg.startswith("data:image/svg+xml;base64,"))
        import base64

        decoded = base64.b64decode(svg.split(",", 1)[1]).decode("utf-8")
        self.assertIn("<svg", decoded)
        self.assertIn("排序", decoded)
        # ★ base64 之后外层字符串里不该有 URL 形状（否则「零外部引用」的 grep 出现假命中）
        self.assertNotRegex(svg, r"https?://")


class TestParameterResolution(unittest.TestCase):
    """参数解析：越界裁剪、类型不对报错、缺省用 default。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        _write_template(self.root, _minimal_template())
        self.template = R.load_templates(self.root)[0]

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_缺省用_default(self) -> None:
        self.assertEqual(R.resolve_params(self.template, {}), {"n": 3})
        self.assertEqual(R.resolve_params(self.template, None), {"n": 3})

    def test_越界裁剪而不是报错(self) -> None:
        """★ 越界参数不该让整个动画失败：收敛到合法范围即可（学生要的是动画，不是 422）。"""
        self.assertEqual(R.resolve_params(self.template, {"n": 999}), {"n": 5})
        self.assertEqual(R.resolve_params(self.template, {"n": 0}), {"n": 1})
        self.assertEqual(R.resolve_params(self.template, {"n": 3.7}), {"n": 4})

    def test_类型不对报错(self) -> None:
        with self.assertRaises(R.TemplateError):
            R.resolve_params(self.template, {"n": "三个"})
        with self.assertRaises(R.TemplateError):
            R.resolve_params(self.template, {"n": True})  # 布尔不当数字用

    def test_未知参数报错(self) -> None:
        with self.assertRaises(R.TemplateError):
            R.resolve_params(self.template, {"unknown": 1})

    def test_占位符替换成JSON字面量(self) -> None:
        self.assertEqual(R.substitute_placeholders("n = {{n}}", {"n": 3}), "n = 3")
        self.assertEqual(R.substitute_placeholders("s = {{s}}", {"s": "a'b"}).count('"'), 2)


class TestTemplateValidation(unittest.TestCase):
    """★ 坏模板必须**当场被点名**，而不是拖到演示现场（票 17 的「模板写了但跑不起来」）。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_坏模板被拒绝并给出可读原因(self) -> None:
        cases = [
            ({}, "缺字段"),
            (_minimal_template(id="BadId"), "id 非法"),
            (_minimal_template(kp_ids=[]), "没有知识点"),
            (_minimal_template(grade_levels=["college"]), "非法学段"),
            (_minimal_template(duration_ms=0), "时长非法"),
            # body + script 都不再用 {{n}} → 声明的参数没用上（渲染出来是半成品）
            (_minimal_template(body="<p>没有占位符</p>", script="Sandbox.ready({})"), "声明的参数没用上"),
            (_minimal_template(body="<p>{{missing}}</p>", script="Sandbox.ready({})"), "用了未声明的参数"),
            (_minimal_template(fallback_text=""), "降级文案为空"),
            (_minimal_template(oops=1), "未知字段"),
            (_minimal_template(params={"n": {"type": "magic", "default": 1}}), "参数类型非法"),
            (_minimal_template(params={"n": {"type": "int"}}), "参数缺 default"),
        ]
        for payload, label in cases:
            with self.subTest(case=label):
                path = _write_template(self.root, payload)
                with self.assertRaises(R.TemplateError, msg=f"这份坏模板应当被拒（{label}）"):
                    R.load_template(path)

    def test_坏模板只跳过不抛_好模板照常可用(self) -> None:
        """★ 一条手滑的记录不该让动画能力整体消失（与题库加载同一口径）。"""
        _write_template(self.root, _minimal_template(id="good-one"))
        (self.root / "broken.json").write_text("{ not json", encoding="utf-8")
        loaded = R.load_templates(self.root)
        self.assertEqual([template.id for template in loaded], ["good-one"])

    def test_id_重复时保留先出现的那份(self) -> None:
        _write_template(self.root, _minimal_template(id="dup"))
        (self.root / "zzz-dup.json").write_text(
            json.dumps(_minimal_template(id="dup"), ensure_ascii=False), encoding="utf-8"
        )
        loaded = R.load_templates(self.root)
        self.assertEqual(len(loaded), 1)


class TestHtmlValidation(unittest.TestCase):
    """★ 校验器的正反用例 —— 它是「重试 vs 降级」的唯一判据来源。"""

    def setUp(self) -> None:
        self.template = R.load_templates(TEMPLATES_DIR)[0]
        self.good = R.render_animation(self.template, payload_id="unit").html

    def test_好产物通过(self) -> None:
        verdict = R.validate_animation_html(self.good)
        self.assertTrue(verdict.ok, f"正常产物被判不合格：{verdict.problems}")
        self.assertEqual(verdict.problems, ())

    def test_空与残缺产物被拒(self) -> None:
        for html, label in [
            ("", "空"),
            ("   ", "全空白"),
            ("<html><body>没有脚本</body></html>", "没有脚本"),
            ("<script>Sandbox.ready({})</script>", "不是完整文档"),
        ]:
            with self.subTest(case=label):
                self.assertFalse(R.validate_animation_html(html).ok, f"应当被拒：{label}")

    def test_外部引用被拒(self) -> None:
        for snippet in (
            '<script src="https://cdn.example/anime.js"></script>',
            '<script src="//cdn.unpkg.com/x.js"></script>',
            '<link href="https://fonts.gstatic.com/x.css" />',
        ):
            with self.subTest(snippet=snippet):
                verdict = R.validate_animation_html(self.good.replace("</head>", f"{snippet}</head>"))
                self.assertFalse(verdict.ok)
                self.assertTrue(any("外部引用" in problem for problem in verdict.problems))

    def test_缺库或缺运行时被拒(self) -> None:
        without_library = self.good.replace(R.INLINE_LIBRARY_MARKER, "gone")
        self.assertFalse(R.validate_animation_html(without_library).ok)

        without_runtime = self.good.replace(R.INLINE_RUNTIME_MARKER, "gone")
        self.assertFalse(R.validate_animation_html(without_runtime).ok)

        without_ready = self.good.replace(R.READY_MARKER, "Sandbox.nothing(")
        self.assertFalse(R.validate_animation_html(without_ready).ok)

        without_id = self.good.replace(R.PAYLOAD_ID_MARKER, "nothing")
        self.assertFalse(R.validate_animation_html(without_id).ok)

    def test_模板路径同样要求脚本注册播放实现(self) -> None:
        """★★ 回归用例（审计发现，修复前**必红**）：模板路径的校验器只认四个**标记串**。

        ``Sandbox.ready(`` 在**内联的 runtime.js 里本来就存在**，所以它证明不了
        「模板脚本自己调过 ``Sandbox.play()``」。抹掉模板脚本里的 ``Sandbox.play(`` 之后，
        四个旧标记一个不少 → 修复前整份产物 ``ok = True``（实测），
        于是模型/模板漏写播放实现时会产出**永远静止**的卡片，而不是降级成文字 + 静态图。

        修法：校验器（经 :func:`app.routes.resources.template_script_problems`）在**脚本段**里
        断言出现 ``Sandbox.play(``。8 个内置模板 + runtime.js 都含该标记，所以收紧不误伤。
        """
        self.assertIn(R.PLAY_MARKER, self.good, "前提：正常产物里本就有 Sandbox.play")
        bad = self.good.replace(R.PLAY_MARKER, "Sandbox.nothing(")
        self.assertNotEqual(bad, self.good, "替换失败：产物里没有 Sandbox.play")

        # 四个旧标记一个都没少 —— 这就是「只查标记」抓不住坏片段的原因
        for marker in (
            R.INLINE_LIBRARY_MARKER,
            R.INLINE_RUNTIME_MARKER,
            R.READY_MARKER,
            R.PAYLOAD_ID_MARKER,
        ):
            self.assertIn(marker, bad, f"构造坏产物时误删了旧标记「{marker}」")

        verdict = R.validate_animation_html(bad)
        self.assertFalse(verdict.ok, "抹掉 Sandbox.play 的产物竟然通过了校验")
        self.assertTrue(
            any("播放实现" in problem for problem in verdict.problems),
            f"拒因必须是可读中文且点名播放实现：{verdict.problems}",
        )

    def test_每个内置模板的脚本都注册了播放实现(self) -> None:
        """★ 收紧后的**正向**证据：8 个模板都含 `Sandbox.play(`（否则上面那条会误伤它们）。"""
        for template in R.load_templates(TEMPLATES_DIR):
            with self.subTest(template=template.id):
                self.assertIn(
                    R.PLAY_MARKER,
                    template.script,
                    f"模板 {template.id} 的脚本里没有注册播放实现",
                )
                payload = R.render_animation(template, payload_id="unit")
                self.assertIn(R.PLAY_MARKER, R.extract_template_script(payload.html))

    def test_运行时里的定义不算脚本段自己的调用(self) -> None:
        """★ 边界：runtime.js 里的 ``Sandbox.play`` 是**定义**，位于脚本段之外，不参与判定。"""
        runtime = R.read_shared(TEMPLATES_DIR, R.RUNTIME_FILENAME)
        self.assertIn("Sandbox.play", runtime, "前提：运行时里有该名字（否则这条边界不存在）")
        segment = R.extract_template_script(self.good)
        self.assertNotIn(
            "window.Sandbox",
            segment,
            "脚本段不该包含内联运行时（否则运行时的定义会被当成模板自己调的 play）",
        )

    def test_运行时在暂停后不再上报进度(self) -> None:
        """★ 回归用例（实测踩到）：模板的进度多是 `setInterval` 按「过了多少毫秒」算的，
        定时器**不认识「暂停」** —— 点暂停后动画停了、进度条却继续爬，学生会以为按钮坏了。

        修法在**运行时那一层**（拦掉上报），所以 8 个模板一次全好；这条断言盯住它别再退化。
        """
        runtime = R.read_shared(TEMPLATES_DIR, R.RUNTIME_FILENAME)
        self.assertIn("var paused = false", runtime, "运行时缺少暂停标志")
        self.assertIn("if (paused && value !== 1) return", runtime, "暂停态下仍会上报进度")
        # 三条指令都要维护这个标志
        for command in ("'pause'", "'play'", "'replay'"):
            self.assertIn(command, runtime, f"运行时没有处理 {command} 指令")

    def test_模板脚本里的_throw_被拒(self) -> None:
        """★★ 票据的验收演练：模板里插一行 `throw new Error("boom")` 必须被判不合格。

        判定的不是「运行之后崩了」，而是**静态就看不合格** —— 这样调用方能在重试与降级之间
        做选择，而不是等宿主超时 5 秒。
        """
        injected = self.good.replace(
            R.READY_MARKER, 'throw new Error("boom")\n' + R.READY_MARKER, 1
        )
        verdict = R.validate_animation_html(injected)
        self.assertFalse(verdict.ok, "注入 throw 的产物竟然通过了校验")
        self.assertTrue(any("throw" in problem for problem in verdict.problems), verdict.problems)

    def test_模板脚本里的网络调用与宿主文档访问被拒(self) -> None:
        for injected, label in (
            ("fetch('/x').then(function(){})", "fetch"),
            ("var x = parent.document.body", "parent.document"),
        ):
            with self.subTest(case=label):
                html = self.good.replace(R.READY_MARKER, injected + "\n" + R.READY_MARKER, 1)
                self.assertFalse(R.validate_animation_html(html).ok, f"应当被拒：{label}")

    def test_凭据被拒(self) -> None:
        html = self.good.replace(
            "</body>", "<script>var apiKey = 'sk-abcdef123456';</script>\n</body>", 1
        )
        verdict = R.validate_animation_html(html)
        self.assertFalse(verdict.ok)
        self.assertTrue(any("API Key" in problem or "apiKey" in problem for problem in verdict.problems))

    def test_校验器不误伤库代码里的_throw(self) -> None:
        """★ 反向用例：库代码里的 `throw` 不该把好模板判死（那是误报，不是安全）。

        判据只在**模板自己的脚本段**生效 —— 真去扫整份 HTML 的话，任何库里的一处 `throw`
        都会让所有模板不可用。
        """
        html = self.good.replace("<head>", "<head><script>function f() { throw new Error('lib') }</script>", 1)
        verdict = R.validate_animation_html(html)
        self.assertFalse(any("模板脚本里有 throw" in problem for problem in verdict.problems))


class TestRenderPipeline(unittest.TestCase):
    """渲染管线：载荷六字段齐备、source 取值、失败抛 TemplateError。"""

    def setUp(self) -> None:
        self.templates = R.load_templates(TEMPLATES_DIR)

    def test_每个模板都能渲染成完整载荷(self) -> None:
        for template in self.templates:
            with self.subTest(template=template.id):
                payload = R.render_animation(template, payload_id="unit")
                self.assertEqual(payload.source, "template")
                self.assertTrue(payload.concept.strip(), "concept 不能为空")
                self.assertTrue(payload.html.strip(), "html 不能为空")
                self.assertGreater(payload.duration_ms, 0)
                self.assertTrue(payload.fallback_text.strip(), "fallback_text 不能为空")
                self.assertIsNotNone(payload.fallback_image, "fallback_image 必须有（降级后不能只剩文字）")
                self.assertTrue(payload.fallback_image.startswith("data:image/svg+xml"))

    def test_渲染产物是合法契约模型且能序列化成camelCase(self) -> None:
        payload = R.render_animation(self.templates[0], payload_id="unit")
        dumped = payload.model_dump(by_alias=True)
        self.assertEqual(
            set(dumped),
            {"concept", "html", "durationMs", "fallbackText", "fallbackImage", "source"},
            "AnimationPayload 的六个字段一个都不能多、一个都不能少（§6.5 冻结）",
        )

    def test_模型传来的降级文案会覆盖模板自带的(self) -> None:
        payload = R.render_animation(
            self.templates[0], payload_id="unit", fallback_text="看左边的柱子怎么挪到位置。"
        )
        self.assertEqual(payload.fallback_text, "看左边的柱子怎么挪到位置。")

    def test_校验不过时抛_TemplateError_而不是返回半成品(self) -> None:
        """★ 半成品的下场就是白屏：宁可抛（触发重试）也不返回。"""
        original = os.environ.get(R.SIMULATE_ENV)
        try:
            os.environ[R.SIMULATE_ENV] = "throw"
            with self.assertRaises(R.TemplateError) as caught:
                R.render_animation(self.templates[0], payload_id="unit")
            self.assertIn("校验", str(caught.exception))
        finally:
            if original is None:
                os.environ.pop(R.SIMULATE_ENV, None)
            else:
                os.environ[R.SIMULATE_ENV] = original

    def test_演练开关的每种取值都会产出不合格产物(self) -> None:
        """★ 人为注入错误演练：四种坏法都必须被校验器抓住（否则演练就是假的）。"""
        original = os.environ.get(R.SIMULATE_ENV)
        try:
            for mode in ("throw", "external", "nolib", "credential"):
                with self.subTest(mode=mode):
                    os.environ[R.SIMULATE_ENV] = mode
                    # `nolib` 会替换掉库标记，但**不会**动 HTML 结构校验之外的东西
                    with self.assertRaises(R.TemplateError, msg=f"{mode} 演练应当被判不合格"):
                        R.render_animation(self.templates[0], payload_id="unit")
        finally:
            if original is None:
                os.environ.pop(R.SIMULATE_ENV, None)
            else:
                os.environ[R.SIMULATE_ENV] = original

    def test_关闭演练开关后恢复正常(self) -> None:
        """★ 演练后必须能恢复 —— 否则这套开关本身成了故障源。"""
        payload = R.render_animation(self.templates[0], payload_id="unit")
        self.assertTrue(R.validate_animation_html(payload.html).ok)


class TestTemplateMatching(unittest.TestCase):
    """模板选择：知识点精确命中优先，学段方向与检索一致。"""

    def setUp(self) -> None:
        self.templates = R.load_templates(TEMPLATES_DIR)

    def test_知识点精确命中(self) -> None:
        template, reason = R.pick_template(self.templates, kp_id="prog-loop-jr", grade_level="junior")
        self.assertEqual(reason, "kp")
        self.assertIn("prog-loop-jr", template.kp_ids if template else [])

    def test_神经网络在初中命中自己而不是被退到小学模板(self) -> None:
        """★ 回归用例（实测踩到）：跨学段模板（junior+senior）必须能被初中生选中。

        `neural-network-jr` 只被 `neural-forward`（junior+senior）覆盖；
        若学段判据写反，初中生会被退到小学那份 `image-pixels`（它含 `computer-vision-jr`）。
        """
        template, reason = R.pick_template(self.templates, kp_id="neural-network-jr", grade_level="junior")
        self.assertEqual(reason, "kp")
        self.assertEqual(template.id if template else None, "neural-forward")

    def test_知识点没有专门模板时标记为学段兜底(self) -> None:
        template, reason = R.pick_template(self.templates, kp_id="invented-kp-xyz", grade_level="junior")
        self.assertEqual(reason, "grade")
        self.assertIsNotNone(template, "兜底模板应当存在（但要由调用方决定用不用）")

    def test_超出学段的模板不可用(self) -> None:
        """高中生能用初中的模板（巩固），小学生不能看到高中专属的模板。"""
        senior_only = [t for t in self.templates if t.grade_levels == ("senior",)]
        self.assertTrue(senior_only, "应当存在只给高中的模板（如梯度下降），否则这条断言没意义")
        for template in senior_only:
            self.assertTrue(R.template_usable_for(template, "senior"))
            self.assertFalse(
                R.template_usable_for(template, "primary_low"),
                f"{template.id} 不该对小学低年级可用（超纲）",
            )

        # ★ 学段方向在**模板选择**这条路径上同样不放宽：
        # `machine-learning-sr` 由 `gradient-descent`（仅 senior）覆盖，
        # 小学低年级来问时不能靠「知识点命中」把它拿到手。
        template, reason = R.pick_template(
            self.templates, kp_id="machine-learning-sr", grade_level="primary_low"
        )
        self.assertNotEqual(reason, "kp", "小学低年级不该按知识点命中只给高中的梯度下降模板")
        self.assertNotEqual(template.id if template else None, "gradient-descent")

    def test_每个学段都至少有一个可用模板(self) -> None:
        """★ 反向检查：**每个学段**都得有模板可用，否则那个学段的动画只能降级。

        （空 `grade_levels` = 通识模板、任何学段可用；当前 8 个模板都声明了学段，
        所以这里用「至少一个可用」而不是「必须存在通识模板」来断言 —— 后者会绑死内容策略。）
        """
        for level in R.GRADE_LEVELS:
            usable = [t for t in self.templates if R.template_usable_for(t, level)]
            self.assertTrue(usable, f"学段 {level} 一个可用模板都没有")

        # 空 grade_levels 的语义也要钉住（将来真加了通识模板，这条仍成立）
        general = [t for t in self.templates if not t.grade_levels]
        for template in general:
            for level in R.GRADE_LEVELS:
                self.assertTrue(R.template_usable_for(template, level))


class TestGeneratedAnimationQuality(unittest.TestCase):
    """★ A2 的质量守卫：206 份生成模板必须「真的在讲、真的在动」。

    用户口径（原话）：「现在的内置的动画我看了都做的很潦草，不要草草放几个方框、放个
    渐入渐出动效就草草了事，给 K12 的学生根本无法理解」，另外还有一条「动画得有审美，
    而且确保根据学段也能切换」。

    所以判据都是**结构性**的（能不能在 CI 上稳定跑），不掺像素比对：

    1. 走真 anime.js 时间线（``Sandbox.timeline(``），不是 rAF + 线性 t；
    2. 相位数够看：插画系 ≥ 4、工程系 ≥ 5；
    3. 文案零省略号（节点永不截断是本票的产品口径）；
    4. ``duration_ms`` 在（原型 × 皮肤）区间内，且不是全库一个数；
    5. 每份至少两种可动画属性（只动不透明度 = 被投诉的那种）；
    6. 没有裸色值（写死颜色 = 学段皮肤当场失效）；
    7. **端到端**不截断：真渲染一份，节点标签的整句要能在产物里找到。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.templates = R.load_templates(TEMPLATES_DIR)
        cls.generated = _generated_templates()
        assert cls.generated, "一份生成的模板都没认出来（生成标记变了？）"

    def test_生成模板确实在库里且占绝大多数(self) -> None:
        """★ 守卫不许空转：认不出生成的模板时，下面按它遍历的断言会**全绿空跑**。"""
        self.assertGreater(
            len(self.generated), 200, f"只认出 {len(self.generated)} 份生成模板（应当是 206）"
        )
        self.assertGreater(
            len(self.templates) - len(self.generated),
            0,
            "发货目录里应当还有手作高保真模板（它们是本票的质量标尺）",
        )

    def test_每份生成模板都走_anime_时间线(self) -> None:
        """★ 不是 rAF 手搓进度：``Sandbox.timeline(N, builder)`` 才是真时间线（相位 + 停顿）。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                self.assertIn(
                    "Sandbox.timeline(",
                    template.script,
                    f"{template.id} 没用 Sandbox.timeline（退回了手搓进度？）",
                )
                self.assertIn("Sandbox.motion", template.script, f"{template.id} 没取 Sandbox.motion")
                self.assertNotIn(
                    "requestAnimationFrame",
                    template.script,
                    f"{template.id} 里出现 requestAnimationFrame（旧写法回来了）",
                )

    def test_相位数够看(self) -> None:
        """★ 插画系 ≥ 4 相位、工程系 ≥ 5 相位（用户抱怨的正是「两三个方框就完事」）。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                minimum, default = _phases_of(template)
                skin = R.skin_for_grade(template.grade_levels[0])
                # 头注释里的 skin= 必须与学段推出的皮肤一致（小学高年级用工程系原型时也一致）
                header = GENERATED_MARKER_RE.search(template.script).group(2)
                self.assertEqual(
                    header,
                    skin,
                    f"{template.id} 头注释的 skin={header} 与学段 {template.grade_levels[0]} 推出的 {skin} 不符",
                )
                self.assertGreaterEqual(
                    minimum,
                    MIN_PHASES[skin],
                    f"{template.id}（{skin}）最少只有 {minimum} 个相位，低于 {MIN_PHASES[skin]}",
                )
                self.assertGreaterEqual(
                    default, minimum, f"{template.id} 的默认相位数 {default} 小于最少相位 {minimum}"
                )

    def test_文案里零省略号(self) -> None:
        """★ 「永不截断」的第一道：可见文案与脚本里一个 `…` / `...` 都不许有。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                for field in ("body", "script", "title", "concept", "fallback_text", "label"):
                    text = getattr(template, field)
                    for mark in ("…", "..."):
                        self.assertNotIn(
                            mark,
                            text,
                            f"{template.id}.{field} 出现省略号「{mark}」（文案被截断了？）",
                        )

    def test_步骤条只数位置_且说该动画自己的量词(self) -> None:
        """★★ 坐标不变量（D-087）：一份动画只有**一套**位置坐标。

        缺陷现场（实测）：步骤条原来数的是**相位**（`共 COUNT + 2 步`，含布景与收尾两拍），
        而节点徽标与字幕数的是**位置**（「第 1…4 段」）——
        于是同一段收尾里字幕写着「一共 4 段」、步骤条写着「共 6 步」：
        学生在同一时刻读到三个数（段 / 步 / 百分比），建立不起「讲到哪了」。
        另一处真缺陷：`counter` 原型的相位数声明是 `TIMES + 2`，步骤条却按 `COUNT + 2` 算，
        `times > 行数` 时两者必然对不上 —— 根因是「步骤条在数相位」，这一条断言把它钉死。

        四条判据（都在发货产物上静态可查）：
          ① 一份模板里所有步骤条调用的**总数**只有一个表达式；
          ② 那个表达式**不带 `+ N`**（带的就是把布景/收尾两拍算进去了）；
          ③ **量词只有一个**（一份动画一套说法）；
          ④ 量词必须是内容自己在用的词 —— 正文里出现过「第 N <量词>」；
             若这份动画正文里**没有任何**位置编号（如 `network` 的八拍），量词只许用中性的「步」。
        """
        # ★★ 必须匹配**所有**步骤条调用（含参数个数不对的）：上一版正则只认「三参且带引号量词」
        #    的调用，于是 `h.step(2, STEPS + 3)` 这种漏了量词的调用整条被跳过 —— 守卫是绿的，
        #    运行时的步骤条却在说另一个词（D-087 的第二层缺陷就是这么漏过去的）。
        call_re = re.compile(r"(?:h|Sandbox)\.step\(([^)]*)\)")
        step_re = re.compile(r"(?:h|Sandbox)\.step\(([^,)]+), ([^,)]+), '([^']+)'\)")
        units_re = "|".join(
            re.escape(word) for word in sorted(STEP_UNIT_WORDS, key=len, reverse=True)
        )
        # 内容在用的位置量词，三个来源取并集：
        #   ① 字面量编号「第 N 站」；② 读数清单里的单位（`"unit": "圈"`）；
        #   ③ 拼接式字幕（`'第 ' + round + ' 圈：…'`）。
        ordinal_re = re.compile(r"第\s*\d+\s*(" + units_re + ")")
        concat_re = re.compile(r"第 '\s*\+\s*[\w.]+\s*\+\s*'(" + units_re + ")")
        readout_re = re.compile(r'"unit"\s*:\s*"([^"]{1,4})"')
        for template in self.generated:
            with self.subTest(template=template.id):
                raw_calls = call_re.findall(template.script)
                self.assertTrue(raw_calls, f"{template.id} 没有任何步骤条调用（生成器契约变了？）")
                for args in raw_calls:
                    parts = [part.strip() for part in args.split(",")]
                    self.assertEqual(
                        len(parts),
                        3,
                        f"{template.id} 步骤条调用必须是（序号, 总数, 量词）：step({args})",
                    )
                    # 允许两种：原型里写死的字面量（`'段'`），以及公共透传那一行的变量
                    # （`Sandbox.step(at, total, word)` —— 它把量词原样交给 runtime）。
                    self.assertRegex(
                        parts[2],
                        r"^(?:'[^']+'|word|unit)$",
                        f"{template.id} 步骤条的量词只该是引号里的字面量或透传变量：{parts[2]!r}",
                    )
                calls = step_re.findall(template.script)
                totals = {total.strip() for _, total, _ in calls}
                units = {unit for _, _, unit in calls}
                self.assertEqual(len(totals), 1, f"{template.id} 步骤条总数不唯一：{sorted(totals)}")
                self.assertEqual(len(units), 1, f"{template.id} 步骤条量词不唯一：{sorted(units)}")
                total, unit = totals.pop(), units.pop()
                self.assertNotRegex(
                    total,
                    r"\+\s*\d",
                    f"{template.id} 步骤条总数带相位偏移（只该数位置）：{total}",
                )
                self.assertIn(unit, STEP_UNIT_WORDS, f"{template.id} 步骤条量词不在词表里：{unit!r}")
                used = set(ordinal_re.findall(template.script + template.body))
                used |= set(readout_re.findall(template.script))
                used |= set(concat_re.findall(template.script))
                self.assertTrue(
                    unit in used or unit == "步",
                    f"{template.id} 步骤条说「{unit}」，而这份动画用过的位置量词是 {sorted(used)}"
                    "（没有位置量词时才允许用中性的「步」）",
                )
                if total.isdigit():
                    indexes = [int(m) for m in re.findall(r"\.step\((\d+),", template.script)]
                    self.assertTrue(indexes, f"{template.id} 步骤条序号全是表达式，无法核对上限")
                    self.assertLessEqual(
                        max(indexes), int(total), f"{template.id} 步骤条序号超过总数"
                    )

    def test_时长按原型与皮肤分档_不是全库一个数(self) -> None:
        """★ 每份的 duration_ms 落在（原型 × 皮肤）的区间里，且**不是所有模板都一样**。"""
        durations = [template.duration_ms for template in self.generated]
        for template in self.generated:
            with self.subTest(template=template.id):
                match = GENERATED_MARKER_RE.search(template.script)
                archetype = match.group(1)
                skin = match.group(2)
                self.assertIn(
                    (archetype, skin),
                    DURATION_RANGES,
                    f"{template.id} 的原型组合 {(archetype, skin)} 不在区间表里（生成器加了新原型？）",
                )
                low, high = DURATION_RANGES[(archetype, skin)]
                self.assertGreaterEqual(template.duration_ms, low, f"{template.id} 时长低于区间下界")
                self.assertLessEqual(template.duration_ms, high, f"{template.id} 时长高于区间上界")

        # 旧版是「一律 4800」；本票要求一概念一节奏（同原型同皮肤内也要有散布）
        self.assertGreater(
            len(set(durations)),
            20,
            f"206 份模板只有 {len(set(durations))} 种时长（退回了「全库一个数」？）",
        )
        # 同（原型 × 皮肤）组内也不许只有一个值 —— 组内一致 = 参数化程度退化了
        for archetype, skin in sorted({(m.group(1), m.group(2)) for t in self.generated for m in [GENERATED_MARKER_RE.search(t.script)]}):
            group = [
                template.duration_ms
                for template in self.generated
                if GENERATED_MARKER_RE.search(template.script).groups() == (archetype, skin)
            ]
            if len(group) < 3:
                continue
            with self.subTest(group=f"{archetype}/{skin}"):
                self.assertGreater(
                    len(set(group)),
                    1,
                    f"{archetype}/{skin} 这一组 {len(group)} 份的时长全都一样（参数化退化了）",
                )

    def test_每份至少两种可动画属性(self) -> None:
        """★ 只动不透明度（渐入渐出）正是被投诉的「潦草」；至少要有两种属性一起动。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                seen = {
                    name
                    for name in ANIMATABLE_PROPS
                    if re.search(r"\b" + name + r"\s*:", template.script)
                }
                if re.search(r"\b\w+\.set\(", template.script):
                    seen.add("readout().set(")  # 数值读数变化也算一种（真算的证据）
                self.assertGreaterEqual(
                    len(seen),
                    2,
                    f"{template.id} 只动了 {sorted(seen)}（至少两种属性，别只做渐入渐出）",
                )

    def test_没有裸色值(self) -> None:
        """★ 写死 `#rrggbb` = 那份模板永远只属于一个学段（皮肤切换当场失效）。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                match = re.search(RAW_COLOUR_RE, template.body + template.script)
                self.assertIsNone(
                    match,
                    f"{template.id} 出现裸色值「{match and match.group(0)}」（颜色只许走 CSS 类与变量）",
                )

    def test_时长与缓动取自_motion_而不是写死(self) -> None:
        """★ 模板不许写死 `duration: 800` 这类绝对值（皮肤要能改掉节奏）。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                literal = re.findall(r"duration:\s*(\d+)\s*[,}]", template.script)
                offending = [value for value in literal if int(value) > 4]
                self.assertEqual(
                    offending,
                    [],
                    f"{template.id} 写死了 duration: {offending}（应当走 Sandbox.motion 或用 d() 换算）",
                )

    def test_渲染后完整文案真的上屏_不截断(self) -> None:
        """★★ 端到端的不截断证据：真渲染，节点标签的**整句**要能在产物里找到。

        这条是「结构断言」之外的兜底：`body` / `script` 里没有省略号 ≠ 学生看得到整句话。
        所以取数据里最长的那个节点标签，渲染后断言它整句出现在 HTML 里（节点标签是**一次
        性写进 tspan** 的，不会因为折行/缩字号而分片，所以整句一定在源码里出现）。
        """
        checked = 0
        for template in self.generated:
            match = re.search(r"var DATA = (\{.*?\});\n", template.script, re.S)
            if not match:
                continue
            data = json.loads(match.group(1))
            labels = []

            def _collect(value: object) -> None:
                if isinstance(value, dict):
                    for key, item in value.items():
                        if key in ("label", "station", "sub", "title", "ask", "layer", "right", "left") and isinstance(item, str):
                            labels.append(item)
                        else:
                            _collect(item)
                elif isinstance(value, list):
                    for item in value:
                        _collect(item)

            _collect(data)
            labels = [label for label in labels if len(label) >= 4]
            if not labels:
                continue
            longest = max(labels, key=len)
            with self.subTest(template=template.id):
                html = R.render_animation(template, params=None, payload_id="unit").html
                self.assertIn(
                    longest,
                    html,
                    f"{template.id} 的节点标签「{longest}」没有整句出现在产物里（被截断了？）",
                )
                # ★ 省略号只在**模板自己那两段**里查：内联的库 / 共享 CSS 是别人的资产
                #   （anime.min.js 与 base.css 的注释里本来就有），查整份产物等于查错了对象。
                segment = R.extract_template_script(html)
                self.assertNotIn("…", segment, f"{template.id} 的脚本段里出现省略号")
                body_start = html.index('<div id="stage">')
                body_end = html.index(R.READY_MARKER)
                self.assertNotIn("…", html[body_start:body_end], f"{template.id} 的页面片段里出现省略号")
                # 全文另有 <title> 兜底（悬停可见）—— 这条保证「缩字号到底」时还有退路
                self.assertIn("<title", html, f"{template.id} 的节点没有 <title> 全文")
            checked += 1
            if checked >= 12:  # 抽样即可：渲染 200+ 份会让本文件跑成分钟级
                break
        self.assertGreaterEqual(checked, 12, f"只核了 {checked} 份模板的文案上屏（样本太少）")


# --------------------------------------------------------------------------- #
# 布局守卫（票 A3：用户投诉「文字、图标、小人位置都是错位重叠的」）
#
# ★ 为什么能在**不开浏览器**的前提下守住「不重叠」：生成器把每个盒子的坐标与尺寸
#   算成一份**布局清单**内联进脚本（`Sandbox.layout({...})` 的第一个参数），
#   运行时照单画。清单就是几何本身 —— 于是「盒盒重叠 / 出舞台 / 标签等于副标题 /
#   人物压盒子」这几类缺陷都能在 CI 上用纯算术验出来（毫秒级、无像素比对）。
#
# ★ 清单里的坐标是生成器按**真几何**算的（文本折行 + 缩字号 + 内边距都与运行时同一套
#   算式），但它仍然是「声明」；「实际画出来是不是这样」由运行时的对账兜住
#   （`Sandbox.layout()` 会把「实际比清单大」记进 `window.__K12_LAYOUT__` 的 overflow
#   条目，截图流水线会读它）。本文件只管**声明自洽**这一半。
# --------------------------------------------------------------------------- #

#: 舞台与安全边距（与 `runtime.js` 的 STAGE_WIDTH / SAFE_MARGIN 同源）。
STAGE_WIDTH = 720
STAGE_HEIGHT = 420
SAFE_MARGIN = 34
SAFE_BOTTOM = STAGE_HEIGHT - 30

#: 布局清单的入口（生成器 `script_for` 写进脚本的那一行）。
PLAN_RE = re.compile(r"Sandbox\.layout\((\{.*?\})\);", re.S)

#: 盒子类清单项的类型（`text` 是裸注释、`blank` 是空档，都不算「有底板的盒子」）。
SOLID_KINDS = ("node", "readout", "bubble")


def _plan_of(template) -> dict:
    """从模板脚本里取出布局清单（`Sandbox.layout({...})` 的第一个参数）。"""
    match = PLAN_RE.search(template.script)
    assert match, f"{template.id} 的脚本里没有布局清单（生成器契约变了？）"
    return json.loads(match.group(1))


def _cells(plan: dict) -> list[dict]:
    return [cell for cell in plan.get("cells") or [] if cell.get("kind") != "blank"]


def _hidden_by_spread(cell: dict, plan: dict) -> bool:
    """这一格会不会被参数调到最小时**隐藏**（隐藏的格子不参与碰撞判定）。

    `spread` 是生成器声明的「这一组格子随参数增减」：参数取最小值时，编号 >= min 的
    那些格子不显示（`display:none`），所以它们与别人的重叠是看不见的 —— 判它们等于
    给守卫制造假红。参数取**最大值**时反而全部都在，所以这里只放行「必然隐藏」的那些。
    """
    cell_id = str(cell.get("id") or "")
    for spread in plan.get("spread") or []:
        prefix = str(spread.get("prefix") or "")
        if not cell_id.startswith(prefix):
            continue
        tail = cell_id[len(prefix) :].lstrip("-_")
        if tail.isdigit() and int(tail) >= int(spread.get("min") or 0):
            return True
    return False


def _overlap(a: dict, b: dict) -> tuple[float, float]:
    over_x = min(float(a["x"]) + float(a["w"]), float(b["x"]) + float(b["w"])) - max(
        float(a["x"]), float(b["x"])
    )
    over_y = min(float(a["y"]) + float(a["h"]), float(b["y"]) + float(b["h"])) - max(
        float(a["y"]), float(b["y"])
    )
    return over_x, over_y


def _actor_rect(actor: dict) -> tuple[float, float, float, float]:
    """人物的占位矩形（与运行时同源：含脚下那行名字）。"""
    scale = float(actor.get("scale") or 1)
    label = str(actor.get("label") or "")
    label_width = max(40.0, min(160.0, len(label) * 13.0)) if label else 40.0
    room = 30.0 if label else 0.0
    return (
        float(actor["x"]) - label_width / 2 * scale,
        float(actor["y"]) - 96 * scale,
        label_width * scale,
        (96 + room) * scale,
    )


class TestGeneratedLayoutGeometry(unittest.TestCase):
    """★ 布局清单的几何守卫：盒盒不重叠、不出舞台、标签≠副标题、人物站得住。

    用户口径（原话）：「有的文字 图标 还有你自己画的小人位置都是错位重叠的 记得修复」。
    这一组盯的就是它，而且**不需要开浏览器**：清单里的每个盒子都带坐标与尺寸。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.generated = _generated_templates()
        assert cls.generated, "一份生成的模板都没认出来（生成标记变了？）"
        cls.plans = {template.id: _plan_of(template) for template in cls.generated}

    def test_每份生成模板都带布局清单(self) -> None:
        """★ 守卫不许空转：清单缺失时下面按它遍历的断言会**全绿空跑**。"""
        self.assertGreaterEqual(len(self.plans), 200, "带布局清单的模板太少（生成器回退了？）")
        for template_id, plan in self.plans.items():
            with self.subTest(template=template_id):
                self.assertTrue(plan.get("bands"), f"{template_id} 的清单里没有带（纵向定位手段没了）")
                self.assertTrue(plan.get("cells"), f"{template_id} 的清单里没有格子")

    def test_没有空白盒子(self) -> None:
        """★★ 每个画出来的盒子都得有字。

        ★ 实测缺陷（用户在截图里看到的「空白方框」）：`blank` 只该**占位**
          （把同一行其他格子推到想要的位置），`_plan_need` 会跳过它算高度，
          但发格子那一步漏了它 —— 运行时按 `node` 画，画布上就多一个空框。
          19 份模板中招，而且全都停在同一个坐标上。
          读数也一样：标签取空串就成了「只有数字、没有说明」的框。
        """
        checked = 0
        for template_id, plan in self.plans.items():
            for cell in _cells(plan):
                if cell.get("kind") == "blank":
                    self.fail(f"{template_id}:{cell.get('id')} 把占位格也画出来了（会变成空白方框）")
                text = str(cell.get("label") or cell.get("text") or "").strip()
                with self.subTest(template=template_id, cell=cell.get("id")):
                    self.assertTrue(
                        text,
                        f"{template_id}:{cell.get('id')} 是个没有文字的 {cell.get('kind')} 盒子",
                    )
                checked += 1
        self.assertGreaterEqual(checked, 200, f"只核了 {checked} 个盒子（样本太少）")

    def test_盒子两两不重叠(self) -> None:
        """★★ 核心断言：同一屏上任何两个**有底板的盒子**都不许相交。

        同槽位的轮换成员（`alt`）例外 —— 它们占同一个矩形，同一时刻只显示一个
        （`dialogue` 的问答气泡、`counter` 的话术轮播都是这个用法）。
        """
        checked = 0
        for template_id, plan in self.plans.items():
            cells = [cell for cell in _cells(plan) if not _hidden_by_spread(cell, plan)]
            for index, cell in enumerate(cells):
                self.assertIn("x", cell, f"{template_id}:{cell.get('id')} 缺 x")
                for other in cells[index + 1 :]:
                    if cell.get("alt") and cell.get("alt") == other.get("alt"):
                        continue
                    over_x, over_y = _overlap(cell, other)
                    with self.subTest(template=template_id, pair=(cell.get("id"), other.get("id"))):
                        self.assertFalse(
                            over_x > 1 and over_y > 1,
                            f"{template_id}：「{cell.get('id')}」与「{other.get('id')}」重叠 "
                            f"{over_x:.1f}×{over_y:.1f}（盒子必须各占一块，不许压在一起）",
                        )
            checked += 1
        self.assertGreaterEqual(checked, 200, f"只核了 {checked} 份模板的布局（样本太少）")

    def test_盒子都在安全区里(self) -> None:
        """★ 出舞台 = 学生看不到半截；安全边距是给步骤条与卡片圆角留的。"""
        for template_id, plan in self.plans.items():
            cells = [cell for cell in _cells(plan) if not _hidden_by_spread(cell, plan)]
            for cell in cells:
                with self.subTest(template=template_id, cell=cell.get("id")):
                    x, y = float(cell["x"]), float(cell["y"])
                    right, bottom = x + float(cell["w"]), y + float(cell["h"])
                    self.assertGreaterEqual(x, SAFE_MARGIN - 0.5, f"{template_id}:{cell['id']} 越出左边")
                    self.assertGreaterEqual(y, SAFE_MARGIN - 0.5, f"{template_id}:{cell['id']} 越出上边")
                    self.assertLessEqual(right, STAGE_WIDTH - SAFE_MARGIN + 0.5, f"{template_id}:{cell['id']} 越出右边")
                    self.assertLessEqual(bottom, SAFE_BOTTOM + 0.5, f"{template_id}:{cell['id']} 越出下边（会被步骤条吃掉）")

    def test_带与带之间不重叠(self) -> None:
        """★ 带是纵向定位的唯一手段：后一条带必须排在前一条的下沿之下。"""
        for template_id, plan in self.plans.items():
            bands = plan.get("bands") or []
            for index, band in enumerate(bands):
                for other in bands[index + 1 :]:
                    bottom = float(band["y"]) + float(band["h"])
                    with self.subTest(template=template_id, pair=(band["id"], other["id"])):
                        self.assertLessEqual(
                            bottom,
                            float(other["y"]) + 0.5,
                            f"{template_id}：带「{band['id']}」压到了「{other['id']}」",
                        )

    def test_标签与副标题不是同一句(self) -> None:
        """★★ 用户看到的「同一句话在一个框里印了两遍」：数据构造的缺陷，不是排版。

        根因是旧版让**同一段文字**既当主标题又当副标题（短标签与副标题取了同一个
        budget）。现在标题与副标题是两个角色：取不到更长的句子时**副标题留空**。
        """
        for template_id, plan in self.plans.items():
            cells = _cells(plan)
            for cell in cells:
                label = cell.get("label")
                sub = cell.get("sub")
                if not sub:
                    continue
                with self.subTest(template=template_id, cell=cell.get("id")):
                    self.assertNotEqual(
                        label,
                        sub,
                        f"{template_id}：{cell['id']} 的主标题与副标题是同一句「{label}」",
                    )

    def test_清单里没有重复的盒子_id(self) -> None:
        """id 撞车 = `L.one()` 取错件（动画会去动错误的盒子）。"""
        for template_id, plan in self.plans.items():
            ids = [str(cell.get("id")) for cell in _cells(plan)] + [
                str(actor.get("id")) for actor in plan.get("actors") or []
            ]
            duplicates = {value for value in ids if ids.count(value) > 1}
            with self.subTest(template=template_id):
                self.assertEqual(duplicates, set(), f"{template_id} 里有重复 id：{sorted(duplicates)}")

    def test_人物都在舞台里且不压在盒子上(self) -> None:
        """★★ 用户投诉的「小人站在莫名其妙的地方」：人物必须站在讲得通的位置上。

        「讲得通」在这份清单里有三档判据：
          ① 人物整体在安全区里（没被截掉）；
          ② 不压任何盒子（压住盒子 = 「错位重叠」的另一种形态）；
          ③ 若声明了 `on`（站在哪条线 / 哪个路上），脚底必须**正好落在那条线上** ——
             这是「站在路边」「站在底座上」这类语义的机械表达。
        """
        actors_seen = 0
        for template_id, plan in self.plans.items():
            actors = plan.get("actors") or []
            cells = [cell for cell in _cells(plan) if not _hidden_by_spread(cell, plan)]
            rails = {str(rail["id"]): rail for rail in plan.get("rails") or []}
            for actor in actors:
                actors_seen += 1
                ax, ay, aw, ah = _actor_rect(actor)
                with self.subTest(template=template_id, actor=actor.get("id")):
                    self.assertGreaterEqual(ax, SAFE_MARGIN - 0.5, f"{template_id}:{actor['id']} 越出左边")
                    self.assertGreaterEqual(ay, SAFE_MARGIN - 0.5, f"{template_id}:{actor['id']} 越出上边")
                    self.assertLessEqual(ax + aw, STAGE_WIDTH - SAFE_MARGIN + 0.5, f"{template_id}:{actor['id']} 越出右边")
                    self.assertLessEqual(ay + ah, SAFE_BOTTOM + 0.5, f"{template_id}:{actor['id']} 越出下边")
                for cell in cells:
                    over_x, over_y = _overlap(
                        {"x": ax, "y": ay, "w": aw, "h": ah}, cell
                    )
                    with self.subTest(template=template_id, actor=actor.get("id"), cell=cell.get("id")):
                        self.assertFalse(
                            over_x > 1 and over_y > 1,
                            f"{template_id}：人物「{actor['id']}」压在盒子「{cell.get('id')}」上 "
                            f"（{over_x:.1f}×{over_y:.1f}）",
                        )
                line = rails.get(str(actor.get("on") or ""))
                if line is None:
                    continue
                start, end = line.get("from"), line.get("to")
                if isinstance(start, list) and isinstance(end, list) and abs(float(start[1]) - float(end[1])) < 0.5:
                    with self.subTest(template=template_id, actor=actor.get("id"), rail=line.get("id")):
                        self.assertAlmostEqual(
                            float(actor["y"]),
                            float(start[1]),
                            delta=1.0,
                            msg=f"{template_id}：人物「{actor['id']}」的脚底不在他声明的那条线上",
                        )
        self.assertGreaterEqual(actors_seen, 50, f"只核了 {actors_seen} 个人物（样本太少，守卫可能空跑）")

    def test_每个原型都至少有一份模板走新的布局清单(self) -> None:
        """★ 覆盖度自检：十四原型一个都不能漏（漏了的原型就是没被这组守卫覆盖到）。"""
        archetypes = set()
        for template in self.generated:
            match = GENERATED_MARKER_RE.search(template.script)
            if match:
                archetypes.add(match.group(1))
        expected = {
            "scene", "dialogue", "contrast_kid", "accumulate_kid", "checklist_kid",
            "flow", "compare", "layers", "loop", "tree", "network", "matrix", "trace", "counter",
        }
        self.assertEqual(expected - archetypes, set(), f"这些原型一份模板都没有：{sorted(expected - archetypes)}")

    def test_运行时确实按清单建盒子(self) -> None:
        """★ 正向证据：清单不是摆设 —— 脚本里真的调了 `Sandbox.layout(`。"""
        for template in self.generated:
            with self.subTest(template=template.id):
                self.assertIn("Sandbox.layout(", template.script, f"{template.id} 没有用布局清单")
                self.assertNotRegex(
                    template.script,
                    r"var GAP = \(\d+ - \d+ \* COUNT\)",
                    f"{template.id} 里还有手算的负 gap 公式（旧写法回来了？）",
                )

    def test_人物的位置与动画分成两层(self) -> None:
        """★★ 实测缺陷：对话原型的小人被切在画布上沿、脚底跑到 y=33（应该在 228）。

        根因不在清单，而在**运行时**：anime 的 `scale` / `translateX` 写的是
        style.transform，而 style 会**整个盖掉**元素自己的 `transform` 属性 ——
        把位置留在人物本体上、却去动它，位置就被抹掉了（人物弹回舞台原点）。

        判据是结构性的，不看像素：运行时必须给每个人物建**两层**
          ① 外层只写 transform 属性（摆位置），且不进任何动画；
          ② 内层不带 transform（动画从空开始写），并把 `k12Pivot` 指给它。
        这样「摆位置」与「做动画」在结构上就不可能互相覆盖。
        """
        runtime = self.runtime_source()
        with self.subTest(check="外层只摆位置"):
            self.assertIn(
                "translate(' + actorX + ' ' + actorY + ')",
                runtime,
                "人物外层没有按 x/y 摆位置（位置又回到会被动画覆盖的那一层了）",
            )
        with self.subTest(check="内层不带 transform"):
            match = re.search(r"var pivot = Sandbox\.svgEl\('g'\)([\s\S]{0,400}?)pivot\.appendChild", runtime)
            self.assertIsNotNone(match, "没找到人物的内层 pivot 建法（结构变了？）")
            self.assertNotIn(
                "setAttribute('transform'",
                match.group(1),
                "内层 pivot 自己带 transform 属性；动画一写 style.transform 就会把它盖掉",
            )
        with self.subTest(check="动画用内层"):
            self.assertIn("actorGroup.k12Pivot = pivot", runtime, "k12Pivot 没指向内层（模板会动错元素）")

    def runtime_source(self) -> str:
        """公共运行时 `runtime.js` 的源码（人物分层那条守卫要读它）。"""
        path = TEMPLATES_DIR / "_shared" / "runtime.js"
        return path.read_text(encoding="utf-8")


def _iter_routes(app_or_router: object) -> list[object]:
    """递归展开 FastAPI 的路由树。

    ⚠️ 本机的 FastAPI 把 `include_router` 的结果包成 `_IncludedRouter`（它自己的 `path` 是 None，
    真正的路由在 `original_router.routes` 里）。直接看 `app.routes` 的 `path` 会**以为路由没挂上**
    —— 实测踩到过：断言报「缺少路由 /api/animation/templates」，而接口其实是通的。
    所以逐层展开：`app.routes` → 每个条目自己的 `routes` / `original_router.routes` / `router.routes`。
    """
    found: list[object] = []
    stack = list(getattr(app_or_router, "routes", []) or [])
    while stack:
        route = stack.pop()
        found.append(route)
        nested = list(getattr(route, "routes", []) or [])
        for attribute in ("original_router", "router"):
            inner = getattr(route, attribute, None)
            if inner is not None:
                nested = list(nested) + list(getattr(inner, "routes", []) or [])
        stack.extend(nested)
    return found


def _route_paths(app_or_router: object) -> set[str]:
    """路由树里出现过的全部 `path_format`（带 `{param}` 的那种）。"""
    paths: set[str] = set()
    for route in _iter_routes(app_or_router):
        for attribute in ("path_format", "path"):
            value = getattr(route, attribute, None)
            if isinstance(value, str) and value:
                paths.add(value)
    return paths


def _router_paths(router: object) -> set[str]:
    """一个 router 自己声明的全部路径（把 `prefix` 拼回去）。"""
    prefix = str(getattr(router, "prefix", "") or "")
    return {f"{prefix}{path}" for path in _route_paths(router)}


class TestInternalRoutes(unittest.TestCase):
    """内部路由（主进程调用，走 X-Auth-Token）：模板清单 + 渲染。

    ⚠️ **本测试自己挂路由**（`app.include_router(R.router)`），而不是依赖 `main.py`。
    原因：本票不修改 `app/main.py`（那是另一位同事的接线点），所以路由的挂载在测试里显式完成 ——
    这样「路由实现对不对」与「有没有被挂上」是两件事，前者在本文件验证，后者由一条断言单独盯住
    （见 `test_路由尚未被_main_挂上时本测试自己挂载`）。
    """

    def setUp(self) -> None:
        self.app = create_app(build_runtime_config())
        if not _route_paths(self.app).intersection(_router_paths(R.router)):
            self.app.include_router(R.router)
        if not _route_paths(self.app).intersection(_router_paths(R.public_router)):
            self.app.include_router(R.public_router)
        self.client = TestClient(self.app)

    def test_两个_router_都能被挂载且路径正确(self) -> None:
        """接线自检：内部路由与沙箱路由的前缀与冻结值一致（main.py 照这两行挂即可）。"""
        paths = _route_paths(self.app)
        for expected in (
            "/api/animation/templates",
            "/api/animation/render",
            "/api/animation/host/{student_id}/{kp_id}",
            "/resources/animation/{student_id}/{kp_id}",
        ):
            self.assertIn(expected, paths, f"缺少路由 {expected}")
        self.assertEqual(R.router.prefix, "/api", "内部路由前缀必须是 /api（走 X-Auth-Token）")
        self.assertEqual(R.public_router.prefix, "", "沙箱路由不能有 /api 前缀（它不走 token）")

    def test_列出模板_并按知识点过滤(self) -> None:
        response = self.client.get("/api/animation/templates")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertGreater(body["total"], 0, "一个模板都没有：列表端点的 total 必须为正")
        self.assertEqual(len(body["matched"]), body["total"], "不过滤时应返回全部模板")

        filtered = self.client.get(
            "/api/animation/templates", params={"kpId": "prog-loop-jr", "gradeLevel": "junior"}
        )
        self.assertEqual(filtered.status_code, 200)
        matched = filtered.json()["matched"]
        self.assertTrue(matched, "prog-loop-jr 应当有模板")
        self.assertTrue(all("prog-loop-jr" in item["kpIds"] for item in matched))

    def test_渲染命中模板_返回完整载荷(self) -> None:
        response = self.client.post(
            "/api/animation/render",
            json={"kpId": "prog-loop-jr", "gradeLevel": "junior", "payloadId": "unit-pid"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["source"], "template")
        self.assertEqual(set(payload), {
            "concept", "html", "durationMs", "fallbackText", "fallbackImage", "source"
        })
        self.assertIn("anime", payload["html"])

    def test_渲染时参数越界被裁剪(self) -> None:
        response = self.client.post(
            "/api/animation/render",
            json={
                "templateId": "python-loop",
                "payloadId": "unit-pid",
                "params": {"times": 999, "speed": 1.2},
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("var TIMES = 8", response.json()["html"], "越界参数应被裁到上限 8")

    def test_知识点没有模板_返回404_让调用方去降级(self) -> None:
        response = self.client.post(
            "/api/animation/render",
            json={"kpId": "invented-kp-xyz", "gradeLevel": "junior", "payloadId": "unit-pid"},
        )
        self.assertEqual(response.status_code, 404, "没有专门模板时不该硬塞一个不相关的模板")

    def test_指定不存在的模板_返回404(self) -> None:
        response = self.client.post(
            "/api/animation/render",
            json={"templateId": "no-such-template", "payloadId": "unit-pid"},
        )
        self.assertEqual(response.status_code, 404)

    def test_校验失败_返回422_带可读原因(self) -> None:
        """★ 422 是「内容不合格」而不是「服务故障」：TS 侧据此**重试**。"""
        original = os.environ.get(R.SIMULATE_ENV)
        try:
            os.environ[R.SIMULATE_ENV] = "throw"
            response = self.client.post(
                "/api/animation/render",
                json={"templateId": "sorting-bars", "payloadId": "unit-pid"},
            )
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn("throw", response.json()["detail"], "失败原因要可读（重试才知道该改什么）")
        finally:
            if original is None:
                os.environ.pop(R.SIMULATE_ENV, None)
            else:
                os.environ[R.SIMULATE_ENV] = original

    def test_非法_payloadId_返回422(self) -> None:
        response = self.client.post(
            "/api/animation/render",
            json={"templateId": "sorting-bars", "payloadId": "../../etc/passwd"},
        )
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
