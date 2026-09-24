# -*- coding: utf-8 -*-
"""沙箱皮肤的**漂移守卫**：``_shared/skins.css`` 必须与设计令牌逐字节一致。

══════════════════════════════════════════════════════════════════════════
为什么要有这一份（以及它盯的是什么）
══════════════════════════════════════════════════════════════════════════

动画沙箱此前**只有一套配色**：``_shared/base.css`` 里写死 ``--accent: #2f6fd0``，
于是四个学段的动画长得一模一样 —— 小学低年级和高中生的卡片是同一张脸。而项目本来就有
一套分学段调色板（``desktop/scripts/design/tokens.source.json``，渲染进程的
``tokens.generated.css`` 也从它生成），沙箱只是从没用过它。

修法是同一套纪律再来一次：**一处来源 → 生成 → 比对**。
- 来源：``desktop/scripts/design/tokens.source.json``（soft 饱和度 · 学段轴）
- 生成：``server/scripts/build_animation_skins.py`` → ``_shared/skins.css``
- 比对：本文件（``skins.css`` 与「现算出来的结果」必须一个字不差）

★ 为什么这一条必须自动化：手抄一份色板到 CSS 里，第一次改令牌就漂了，而**漂了没人知道**
（动画照样渲染，只是配色不再跟着设计走 —— 这种缺陷不会红任何测试，只会让产品慢慢变得
不一致）。所以本文件**重新推导**一遍期望值（不读生成器的输出、不缓存），再逐条断言。

══════════════════════════════════════════════════════════════════════════
三类断言（缺一条就会退化成假守卫）
══════════════════════════════════════════════════════════════════════════

1. **生成物 = 现算结果**（整文件字节比对）：有人手改了 ``skins.css`` 或忘了重新生成 → 当场红；
2. **调色板真进了产物**：``render_animation()`` 出来的 HTML 里注入的 ``<html data-grade>``
   与 ``skins.css`` 里那块的取值一致 —— 只比对文件可能「文件对、没人用」（P-116 的教训）；
3. **皮肤与基元的结构**：``data-skin`` 只有两个取值、学段→皮肤只有一处映射、
   运行时的基元名一个不少、**没有截断**（``…``）与外部引用。

令牌文件缺失时**跳过**而不是失败：``desktop/`` 是另一端的产物，跨端 CI 里可能没 checkout
（跳过会打印原因，免得有人以为「验过了」）。
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # …/server
REPO_ROOT = ROOT.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.routes import resources as R  # noqa: E402

#: 设计令牌（唯一来源；另一端 ``desktop/``）
TOKENS_PATH = REPO_ROOT / "desktop" / "scripts" / "design" / "tokens.source.json"
#: 生成器脚本（期望值由它现算 —— 本文件**不**依赖磁盘上的 skins.css 反推）
BUILDER_PATH = ROOT / "scripts" / "build_animation_skins.py"
#: 生成物
SKINS_CSS_PATH = R.templates_dir() / R.SHARED_DIRNAME / R.SKINS_CSS_FILENAME

#: 外部引用判据（与 ``resources.py::EXTERNAL_REFERENCE_RE`` 同源）—— 断网演示的底线。
EXTERNAL_RE = re.compile(r"https?://|//cdn|unpkg|jsdelivr|cdnjs|googleapis|fonts\.gstatic", re.I)

#: 冻结的舞台基元名（``preset-content/_meta/STAGE-API.md`` 与下一批模板照着它写）。
STAGE_API_NAMES: tuple[str, ...] = (
    "stage",
    "grid",
    "timeline",
    "node",
    "actor",
    "bubble",
    "link",
    "readout",
    "axis",
    "caption",
    "step",
)


def load_builder():
    """import 生成器脚本（它 import 时只读令牌，不写盘）。"""
    spec = importlib.util.spec_from_file_location("build_animation_skins", BUILDER_PATH)
    if spec is None or spec.loader is None:  # pragma: no cover - 环境坏了才走到
        raise RuntimeError(f"无法加载生成器：{BUILDER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


#: 去注释用：块注释 / 行注释（行注释只看「行首或空白之后的 //」——
#: 运行时里 `'http' + ':' + '//www.w3.org/2000/svg'` 这种拼出来的串不能被误伤）。
_JS_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.S)
_JS_LINE_COMMENT_RE = re.compile(r"(^|\s)//[^\n]*")


def _strip_js_comments(source: str) -> str:
    """去掉 JS 注释（只为扫「代码里有没有省略号」，不追求完整词法分析）。"""
    return _JS_LINE_COMMENT_RE.sub(" ", _JS_BLOCK_COMMENT_RE.sub(" ", source))


TOKENS_AVAILABLE = TOKENS_PATH.is_file()


@unittest.skipUnless(
    TOKENS_AVAILABLE, f"缺少设计令牌 {TOKENS_PATH}（跳过；不代表皮肤是对的）"
)
class TestSkinsCssMatchesTokens(unittest.TestCase):
    """① 生成物 = 令牌现算结果（与 ``tokens.generated.css`` 同一条纪律）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.builder = load_builder()
        cls.source = json.loads(TOKENS_PATH.read_text(encoding="utf-8"))
        cls.expected = cls.builder.render_css(cls.source)
        cls.actual = SKINS_CSS_PATH.read_text(encoding="utf-8") if SKINS_CSS_PATH.is_file() else ""

    def test_skins_css_exists(self) -> None:
        self.assertTrue(SKINS_CSS_PATH.is_file(), f"皮肤样式不存在：{SKINS_CSS_PATH}")

    def test_文件与现算结果逐字节一致(self) -> None:
        """★ 有人手改了 skins.css、或改了令牌忘了重新生成 → 这条会红。"""
        self.assertEqual(
            self.actual,
            self.expected,
            "skins.css 与设计令牌不一致：跑 `cd server && uv run python scripts/build_animation_skins.py` "
            "重新生成（手改生成物一定会漂，改设计令牌或生成器才对）",
        )

    def test_每个学段都有调色板块(self) -> None:
        """五个学段（四个真学段 + default 兜底）一个都不能少 —— 少一个就有学段的动画没颜色。"""
        for grade in ("primary_low", "primary_high", "junior", "senior", "default"):
            with self.subTest(grade=grade):
                self.assertIn(f':root[data-grade="{grade}"]', self.actual)

    def test_学段块里的取值就是令牌里的_soft_取值(self) -> None:
        """★ 独立复算一遍索引（``gradeIndex * 3 + satIndex``），别只信生成器自己。"""
        source = self.source
        grades = list(source["grades"])
        sats = list(source["sats"])
        sat_index = sats.index(self.builder.SATURATION)
        themed = source["themed"]

        for grade, family in self.builder.GRADE_FAMILIES:
            index = grades.index(family) * len(sats) + sat_index
            with self.subTest(grade=grade):
                for name in self.builder.THEMED_VARS:
                    expected = themed[name][index]
                    self.assertIn(f"--{name}: {expected};", self.actual)
                for token_name, var_name in self.builder.SINGLE_VARS:
                    self.assertIn(f"--{var_name}: {source['single'][token_name]};", self.actual)

    def test_学段之间真的不同色(self) -> None:
        """★ 这条是本票的病根：四个学段的主色必须互不相同（曾经四个学段共用 #2f6fd0）。"""
        palette = self.builder.derive_palette(self.source)
        accents = {grade: palette[grade]["accent"] for grade in R.GRADE_LEVELS}
        self.assertEqual(
            len(set(accents.values())),
            len(R.GRADE_LEVELS),
            f"有两个学段的主色是一样的（等于没分学段）：{accents}",
        )

    def test_生成区之外没有裸色值(self) -> None:
        """手写区（皮肤与基元）只许引用变量 —— 裸色值 = 第二份调色板 = 必然漂移。"""
        start = self.actual.index(self.builder.PALETTE_END)
        handwritten = self.actual[start:]
        offenders = re.findall(r"#[0-9a-fA-F]{3,8}\b", handwritten)
        self.assertEqual(offenders, [], f"手写区出现了裸色值：{offenders[:8]}")

    def test_手写区引用的每个变量都有兜底(self) -> None:
        """★ 没有 ``data-grade`` 的产物（自由生成路径 / 单独打开调试）也要渲染得出来。

        所以 ``skins.css`` 里引用的每个变量，都必须在 ``base.css`` 的 ``:root`` 里有取值。
        """
        base_css = R.read_shared(R.templates_dir(), R.BASE_CSS_FILENAME)
        start = self.actual.index(self.builder.PALETTE_END)
        used = set(re.findall(r"var\((--[a-z0-9-]+)\)", self.actual[start:]))
        self.assertTrue(used, "手写区一个变量都没引用？扫描面坏了")
        missing = sorted(name for name in used if f"{name}:" not in base_css)
        self.assertEqual(missing, [], f"这些变量在 base.css 里没有兜底取值：{missing}")

    def test_皮肤样式里没有外部引用(self) -> None:
        """断网演示的底线：一份内联进每张卡片的 CSS 不许有 url() / CDN。"""
        self.assertNotRegex(self.actual, EXTERNAL_RE)
        self.assertNotIn("url(", self.actual)

    def test_基元在_base_css_里有地板(self) -> None:
        """★★ 没有 ``skins.css`` 时基元也不能变成「黑底黑框」。

        ``skins.css`` 缺席不是假想：**自由生成路径**（``app/animation/compose.py``，
        与模板路径共用 ``compose_animation_html``）只拼 ``base.css`` + 库 + 运行时 ——
        那里内联不到 ``skins.css``。而基元是冻结接口，模型在自由生成里也会调：
        SVG 的默认 ``fill`` 是**黑**、``stroke`` 是 ``none``，没有地板就是一片黑块。

        所以 ``base.css`` 必须为每个基元部件提供「填充 / 描边 / 字号」这层地板
        （形状细节留给 skins.css）。这条断言盯住它别再退回去。
        """
        base_css = R.read_shared(R.templates_dir(), R.BASE_CSS_FILENAME)
        #: 缺了就会渲染成垃圾的关键部件（每个都要在 base.css 里有 fill 或 stroke）
        essentials = (
            ".k12-stage-bg",
            ".k12-node-body",
            ".k12-node-label",
            ".k12-node-sub",
            ".k12-actor-head",
            ".k12-actor-limb",
            ".k12-bubble-body",
            ".k12-bubble-text",
            ".k12-link-line",
            ".k12-link-arrow",
            ".k12-readout-bg",
            ".k12-readout-value",
            ".k12-axis-line",
            ".k12-grid-line",
        )
        for selector in essentials:
            with self.subTest(selector=selector):
                self.assertIn(selector, base_css, f"base.css 里没有基元地板：{selector}")
        self.assertGreaterEqual(
            base_css.count("fill: var(") + base_css.count("stroke: var("),
            20,
            "base.css 的基元地板太少（像是被删过）",
        )
        # 地板同样不许写死颜色（学段色板只由令牌生成）
        offenders = re.findall(r"#[0-9a-fA-F]{3,8}\b", base_css.split("舞台基元")[-1])
        self.assertEqual(offenders, [], f"base.css 的基元地板里出现裸色值：{offenders[:6]}")


@unittest.skipUnless(
    TOKENS_AVAILABLE, f"缺少设计令牌 {TOKENS_PATH}（跳过；不代表皮肤是对的）"
)
class TestGradeToSkinWiring(unittest.TestCase):
    """② 学段 → 皮肤 → 产物：映射只有一处，且真的进了渲染结果。"""

    def test_映射表是唯一落点_且覆盖四个学段(self) -> None:
        self.assertEqual(set(R.GRADE_TO_SKIN), set(R.GRADE_LEVELS))
        self.assertEqual(R.skin_for_grade("primary_low"), "illustrated")
        self.assertEqual(R.skin_for_grade("primary_high"), "illustrated")
        self.assertEqual(R.skin_for_grade("junior"), "technical")
        self.assertEqual(R.skin_for_grade("senior"), "technical")
        # 未知学段回退而不是抛（皮肤不该拖累动画能不能播）
        self.assertEqual(R.skin_for_grade("college"), R.DEFAULT_SKIN)
        self.assertEqual(R.skin_for_grade(""), R.DEFAULT_SKIN)

    def test_皮肤只有两个取值(self) -> None:
        self.assertEqual(set(R.GRADE_TO_SKIN.values()), {"illustrated", "technical"})
        skins_css = SKINS_CSS_PATH.read_text(encoding="utf-8")
        declared = set(re.findall(r':root\[data-skin="([a-z]+)"\]', skins_css))
        self.assertEqual(declared, {"illustrated", "technical"}, f"skins.css 里的皮肤：{declared}")

    def test_渲染产物里注入了学段与皮肤(self) -> None:
        """★ 文件对还不够：产物里必须真的有这两个属性（它是运行时的唯一真相来源）。"""
        templates = R.load_templates(R.templates_dir())
        self.assertTrue(templates, "一个模板都没有，这条断言会空转")
        for template in templates[:12]:
            with self.subTest(template=template.id):
                html = R.render_animation(template, payload_id="unit").html
                grade = R.default_grade_for(template)
                self.assertIn(f'data-grade="{grade}"', html)
                self.assertIn(f'data-skin="{R.skin_for_grade(grade)}"', html)

    def test_显式学段覆盖模板自带的猜测(self) -> None:
        template = [t for t in R.load_templates(R.templates_dir()) if t.id == "python-loop"]
        self.assertTrue(template, "找不到 python-loop（模板被人挪走了？）")
        html = R.render_animation(template[0], payload_id="unit", grade_level="primary_low").html
        self.assertIn('data-grade="primary_low"', html)
        self.assertIn('data-skin="illustrated"', html, "小学低年级必须是插画皮肤")

    def test_非法学段回退而不是渲染失败(self) -> None:
        template = R.load_templates(R.templates_dir())[0]
        html = R.render_animation(template, payload_id="unit", grade_level="college").html
        self.assertIn(f'data-grade="{R.DEFAULT_GRADE}"', html)

    def test_产物的背景色跟着学段变(self) -> None:
        """★ 视觉证据的最小化版本：同模板换学段 → 学生看到的是**不同的配色**。

        断言分两半，缺一半都可能「看起来改了其实没生效」：
        ① 根元素上的 ``data-grade`` 不同（选择器会命中不同的块）；
        ② 两个学段块里的**取值真的不同**（主色 / 页面底色）—— 只比 ``data-grade`` 的话，
           两份 skins.css 各写一遍同样的颜色也能过。
        """
        template = [t for t in R.load_templates(R.templates_dir()) if t.id == "python-loop"]
        self.assertTrue(template, "找不到 python-loop（模板被人挪走了？）")
        low = R.render_animation(template[0], payload_id="unit", grade_level="primary_low").html
        senior = R.render_animation(template[0], payload_id="unit", grade_level="senior").html
        self.assertIn('data-grade="primary_low"', low)
        self.assertIn('data-grade="senior"', senior)

        def block_for(html: str, grade: str) -> str:
            style = html.split("<style>", 1)[1].split("</style>", 1)[0]
            index = style.index(f'[data-grade="{grade}"]')
            return style[index : style.index("}", index)]

        low_block = block_for(low, "primary_low")
        senior_block = block_for(senior, "senior")
        for block in (low_block, senior_block):
            self.assertIn("--accent:", block, "学段块里没有主色")
            self.assertIn("--page:", block, "学段块里没有页面底色")
        self.assertNotEqual(
            low_block, senior_block, "两个学段的调色板一模一样 —— 学段隔离没生效（本票的病根）"
        )

    def test_产物仍然过全套校验(self) -> None:
        """★ 注入了属性、加了一份 CSS —— 产物必须仍然过 ``validate_animation_html``。"""
        for template in R.load_templates(R.templates_dir())[:12]:
            with self.subTest(template=template.id):
                payload = R.render_animation(
                    template, payload_id="unit", grade_level="primary_high"
                )
                verdict = R.validate_animation_html(payload.html)
                self.assertTrue(verdict.ok, f"{template.id} 的产物没过校验：{verdict.reason}")


@unittest.skipUnless(
    TOKENS_AVAILABLE, f"缺少设计令牌 {TOKENS_PATH}（跳过；不代表皮肤是对的）"
)
class TestStageApiIsFrozen(unittest.TestCase):
    """③ 冻结的舞台基元：名字一个不少、**永不截断**、零外部引用。

    这一组不依赖令牌（没有 ``desktop/`` 也要能跑）：它守的是**契约**而不是配色 ——
    下一批 206 份模板是照着 ``preset-content/_meta/STAGE-API.md`` 生成的，
    运行时少一个基元、或把文字截断成「……」，那一批模板就整体出问题。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.runtime = R.read_shared(R.templates_dir(), R.RUNTIME_FILENAME)

    def test_基元名一个都不少(self) -> None:
        """导出对象里必须逐个出现 ``name: name``（最后一项没有逗号，所以按行匹配）。"""
        for name in STAGE_API_NAMES:
            with self.subTest(primitive=name):
                pattern = r"(?m)^\s*" + name + r": " + name + r",?\s*$"
                self.assertRegex(
                    self.runtime,
                    pattern,
                    f"Sandbox.{name} 不在运行时的导出里",
                )

    def test_学段与皮肤与动效预设可读(self) -> None:
        for token in ("grade: GRADE", "skin: SKIN", "motion: MOTION"):
            with self.subTest(token=token):
                self.assertIn(token, self.runtime)
        self.assertIn("data-grade", self.runtime, "运行时没读 <html data-grade>")
        self.assertIn("data-skin", self.runtime, "运行时没读 <html data-skin>")
        # 两套动效预设（插画慢+回弹 / 工程快+克制）都要在
        self.assertIn("easeOutBack", self.runtime)
        self.assertIn("easeInOutQuad", self.runtime)

    def test_运行时从不截断文字(self) -> None:
        """★ 产品要求：节点 / 气泡的文字**永远不截断**（折行或缩字号），省略号一个都不许有。

        ★ 扫的是**去掉注释之后的代码**：注释里写「不是「……」」是说明，代码里出现省略号
        才是缺陷 —— 判据不看注释（否则解释这条纪律的那句话本身会把断言判红）。
        """
        code = _strip_js_comments(self.runtime)
        self.assertNotIn("…", code, "运行时的代码里出现了省略号（基元不许截断文字）")
        self.assertNotIn("...", code, "运行时的代码里出现了省略号（基元不许截断文字）")
        # 折行 / 缩字号 / 悬停全文这三条路径必须在
        self.assertIn("function wrapText(", self.runtime)
        self.assertIn("function fitText(", self.runtime)
        self.assertIn("function attachTooltip(", self.runtime)
        self.assertIn("'title'", self.runtime, "缺少 <title> 全文（悬停看不到整句话）")
        # 节点装不下时长高（而不是切掉副标题）
        self.assertIn("height = needed", self.runtime)

    def test_运行时里没有外部引用与命名空间字面量(self) -> None:
        self.assertNotRegex(self.runtime, r"https?://")
        self.assertIn("'http' + ':' + '//www.w3.org/2000/svg'", self.runtime)
        # 舞台坐标与 720×420 的契约
        self.assertIn("STAGE_WIDTH = 720", self.runtime)
        self.assertIn("STAGE_HEIGHT = 420", self.runtime)
        self.assertIn("preserveAspectRatio", self.runtime)
        self.assertIn("xMidYMid meet", self.runtime)

    def test_暂停引脚一个都没丢(self) -> None:
        """既有的三行硬约束（票 16 的验收口径）—— 别在加基元时顺手改掉。"""
        self.assertIn("var paused = false", self.runtime)
        self.assertIn("if (paused && value !== 1) return", self.runtime)
        for command in ("'pause'", "'play'", "'replay'"):
            self.assertIn(command, self.runtime)

    def test_阶段文档在位且列出全部基元(self) -> None:
        """★ 下一批模板读的就是它：文档缺了或少了基元，那一批会凭记忆瞎写。"""
        doc = REPO_ROOT / "preset-content" / "_meta" / "STAGE-API.md"
        self.assertTrue(doc.is_file(), f"缺少舞台接口文档：{doc}")
        text = doc.read_text(encoding="utf-8")
        for name in STAGE_API_NAMES:
            with self.subTest(primitive=name):
                self.assertIn(f"Sandbox.{name}(", text)


if __name__ == "__main__":
    unittest.main()
