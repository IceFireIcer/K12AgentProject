# -*- coding: utf-8 -*-
"""动画模板与渲染校验（票 17）：模板内容质量 + 「校验 → 重试 → 降级」链的**服务端一半**。

本文件盯住六条（每条对应票据里的一条验收口径）：

1. ★ **模板落位与覆盖**：6–8 个模板，至少覆盖「排序 / 神经网络 / 决策树 / 梯度下降 / 循环 / 变量」，
   且每个都声明了参数 schema 与**非空降级文案**；
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

    def test_directory_exists_and_has_six_to_eight_templates(self) -> None:
        self.assertTrue(TEMPLATES_DIR.is_dir(), f"模板目录不存在：{TEMPLATES_DIR}")
        count = len(list(TEMPLATES_DIR.glob("*.json")))
        self.assertGreaterEqual(count, 6, f"模板太少（{count} 个）：票据要求 6–8 个")
        self.assertLessEqual(count, 8, f"模板太多（{count} 个）：票据要求 6–8 个")
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
        self.assertGreaterEqual(body["total"], 6)
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
