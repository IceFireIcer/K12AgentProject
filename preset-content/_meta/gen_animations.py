# -*- coding: utf-8 -*-
"""从 _meta/generation-input.json 生成 57 份概念动画模板 + 228 份 by-kp 分学段动画数据。

══════════════════════════════════════════════════════════════════════════
这一版为什么重写（用户口径：内置动画「草草地放几个方框、放个渐入渐出」）
══════════════════════════════════════════════════════════════════════════

旧版只有 6 个「布局原型」（steps / flow / compare / layers / loop / checklist）：
每份都是 `requestAnimationFrame + 线性 t` 手搓进度、相位固定 3~4 个、
`duration_ms` 一律 4800、参数只有一个 `speed`、节点文案被 `short()` 硬截成
「四个字加省略号」，206 份里有 36 份连 SVG 都没有（纯 div 透明度开关）。
它「动」得起来，但没把概念讲明白。

新版照 ``preset-content/_meta/STAGE-API.md``（冻结契约）重写，十四条原型：

  ① 全部走 ``Sandbox.timeline(N, builder)`` 的**真 anime.js 时间线**（相位 + 停顿），
     不再有 rAF 手搓进度；
  ② 时长与缓动一律取自 ``Sandbox.motion``（按皮肤：小学慢而回弹 / 中学快而克制），
     模板里没有一处写死 `duration: 800`；
  ③ 每个相位至少两种属性一起动（位移 / 缩放 / 透明度 / 描边宽度 / 数值读数）；
  ④ 文案**一个省略号都没有**：整句进 caption 与气泡，节点上是**完整的小句**；
  ⑤ 每份两个**有含义**的参数（跑几轮 / 多快 / 几个单元 / 网格多宽 / 下降几步），
     且它们真的改变动画；
  ⑥ 学段 → 皮肤由服务端决定（``GRADE_TO_SKIN``），本文件只按学段挑**内容原型**：
     小学用插画系（scene / dialogue / contrast_kid / accumulate_kid / checklist_kid），
     中学用工程系（flow / compare / layers / loop / tree / network / matrix / trace / counter）。

★ 有几条原型是**真算**，不是幻灯片：
  · ``trace``   真的按学习率迭代梯度下降（参数与损失读数每步都变，步长大时会震荡）；
  · ``counter`` 真的数字数并累加（每次读数 = 这一句的字数，合计 = 前缀和）；
  · ``network`` 真的做加权求和（每个隐层单元 = Σ 输入 × 权重，输出层再算一遍）；
  · ``matrix``  真的逐行求均值、再求整张表的均值，最亮那一格是真的最大值；
  · ``loop``    真的按 TIMES 绕圈并累计次数。

★ 一个实测踩到的渲染坑（写在这里，免得下一个人重踩）：**SVG 的 <g> 上做 scale
  是按 SVG 原点缩放的** —— 不设 ``transform-box: fill-box`` 的话，节点会「飞」到
  1.5 倍坐标处（实测 scale(1.5) 把 (300,60) 的盒子挪到 (450,300)）。
  所以本文件里凡是要缩放的组，都过一遍 ``anchor()``（就是设这两个内联样式）。

★ 产物形态（与 expand_templates.py 的注入完全同源，两处不许各写一套）：

    script = SCRIPT_CORE.replace("__DATA__", json.dumps(data))        # 相位数据（整句）
                       .replace("__PHASES__", phases_expr)             # 相位数（字面量或表达式）
                       .replace("@@PACE@@", "{{" + pace_param + "}}")  # 参数占位符
    body   = body_html(title, hint, aria, chip)

★ 与守卫的约定（``server/tests/test_animation_templates.py``）：

  · 脚本第一行是 ``/* K12-ARCHETYPE <原型> | skin=<皮肤> */``（守卫据此认出「这一批是生成的」）；
  · 紧随其后是 ``/* k12:phases min=<最少> default=<默认> */`` —— 相位数是字面量时守卫按字面量查，
    否则按这里的声明查（两个数都由下面的原型表算出，不是手写的）。

运行（仓库根）：

    uv run python preset-content/_meta/gen_animations.py
    uv run python preset-content/_meta/expand_templates.py
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path

# ★ 路径相对本文件（不写死盘符）：本脚本住在 preset-content/_meta/，仓库根 = 往上两层。
META = Path(__file__).resolve().parent
ROOT = Path(__file__).resolve().parents[2]
INPUT = META / "generation-input.json"
OUT_T = ROOT / "preset-content" / "animations" / "templates"
OUT_K = ROOT / "preset-content" / "animations" / "by-kp"

GRADE_LEVELS = ["primary_low", "primary_high", "junior", "senior"]
GRADE_LABEL = {
    "primary_low": "小学低年级",
    "primary_high": "小学高年级",
    "junior": "初中",
    "senior": "高中",
}
GRADE_SHORT = {"primary_low": "pl", "primary_high": "ph", "junior": "jr", "senior": "sr"}

#: 学段 → 皮肤（**只读**：真源在 ``server/app/routes/resources.py::GRADE_TO_SKIN``）。
GRADE_SKIN = {
    "primary_low": "illustrated",
    "primary_high": "illustrated",
    "junior": "technical",
    "senior": "technical",
}

#: 两种皮肤的动效预设（与 ``_shared/runtime.js`` 的 MOTION_PRESETS 逐字一致）。
#: 只用来**估**一份模板播完要多久（算 duration_ms），模板脚本本身不许写死时长。
#: ★ holdMs 是「相位演完之后、下一相位开始之前」的空档（学生读这一屏正文的时间）。
#: 2026-09-25 与运行时同步上调（620→880 / 380→740）：原来工程档只有 0.84 秒，
#: 中学相位正文（常带数字与标签）读不完，看着像一闪而过。duration 两档一个字没动。
MOTION = {
    "illustrated": {"duration": 720, "holdMs": 880},
    "technical": {"duration": 460, "holdMs": 740},
}

#: 每（原型 × 皮肤）的 duration_ms 允许区间 —— **有意的窄区间**：
#: 它要贴近「相位数 × 每相位动效时长 + 相位停顿」的真实播放长度，而不是随便取一个数。
#: 上界按**该原型最慢的相位**留出余量（loop 每圈绕一整圈、trace 每步要读两个数），
#: 所以 loop / trace / network 的上界明显高于同皮肤的 others —— 那是真会更久，不是随手写的。
#: ⚠️ ``server/tests/test_animation_templates.py::DURATION_RANGES`` 是同一张表的副本
#: （守卫要独立算一遍，不许读生成器的输出）—— 改这里必须同步改那边，否则守卫当场红。
DURATION_RANGES: dict[tuple[str, str], tuple[int, int]] = {
    # 插画系（小学）：慢 + 相位之间停得久
    ("scene", "illustrated"): (6800, 9200),
    ("dialogue", "illustrated"): (6800, 9200),
    ("contrast_kid", "illustrated"): (6600, 9000),
    ("accumulate_kid", "illustrated"): (6600, 9000),
    ("checklist_kid", "illustrated"): (6600, 9000),
    # 工程系（中学）：快 + 停顿短
    ("flow", "technical"): (4000, 6400),
    ("compare", "technical"): (3800, 6200),
    ("layers", "technical"): (4000, 6400),
    ("loop", "technical"): (4400, 12000),
    ("tree", "technical"): (4400, 7200),
    ("network", "technical"): (4800, 7600),
    ("matrix", "technical"): (4200, 7000),
    ("trace", "technical"): (5400, 9600),
    ("counter", "technical"): (4000, 7200),
    # 学段向上兼容时可能出现的「原型 × 皮肤」交叉组合（小学看到中学原型 / 反之）。
    # 今天真正会出现的只有 layers / counter 各 1 例（primary_high），其余键是兜底：
    # 将来有人把它们映到小学时，守卫在这里就会红，而不是产出一个 18 秒的动画。
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


# --------------------------------------------------------------------------- #
# 文本：从教材原句里**整句 / 整小句**取材（一个字符都不切）
# --------------------------------------------------------------------------- #
#: 教材里指向源文档的交叉引用 —— 印给学生看是噪音（「参见 4.5.1」）。
#: 另有一类**元语言**同样不能上屏：学生看的是知识本身，不是「课本里说」这件事
#: （「课本上把它叫做」「教材原文」这类句子一出现，动画就变成了朗读器）。
JUNK_MARKERS = (
    "参见", "见第", "如上表", "如下表", "本节", "上一节", "下一节",
    "课本", "教材", "原话", "书里", "文中",
)
#: 学生可见文案禁用的三种排版标记（D-076 / P-123）。
MARKS = ("——", "**", "`")

#: 标签/短语**不得**以这些虚词收尾：说明后面那一截被切掉了，读起来就是半句话
#: （「它的输出形 式有」「在整个流程中」这类碎片正是学生看不懂的根源）。
TAIL_BAN = ("是", "有", "的", "在", "中", "里", "和", "与", "把", "被", "为", "成", "了",
            "从", "而", "就", "会", "对", "等", "把", "让", "给", "跟")
#: 孤立泛名词：单独出现等于没说（学生读到「底面」「流程」不知道该看什么）。
VAGUE = {"底面", "流程", "内容", "部分", "方面", "情况", "环节", "过程", "东西", "问题",
         "基础", "辨析", "易错点", "要点", "做法", "方式", "方法", "概念", "知识", "作用"}
#: 标签里不许出现引号（嵌套引号把一句话切得七零八落）。
QUOTES = "「」『』“”\"'‘’"
#: **分句**（副标题 / 卡片里那句讲解）**不可能**以这些字收尾：它们是**连接 / 判断 / 存在**
#: 功能词，句子以它们收尾就说明被切了一半（「它的输出形式有」「它的特点是」）。
#: ★ 为什么另立一套而不复用 `TAIL_BAN`（2026-09-25 用户截图「动画里面有的文字是空的」）：
#:   分句是一句完整的话 —— 以「的 / 了」收尾天经地义（「这些画不是拍出来的」
#:   「它马上就画出来了」）；拿名词标签那套禁尾去卡，整池小学教材句会被全部毙掉，
#:   卡片上就只剩一个光标题。
CLAUSE_TAIL_BAN = ("和", "与", "把", "被", "为", "从", "而", "就", "会", "对", "等",
                   "让", "给", "跟", "是", "有")
#: 汉字：卡片上那句是给学生**读**的，至少要有一处汉字（否则「2022」这种纯编号会占掉一格）。
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
#: 方位收尾：与 ``PREP_START``（介词/动词）合起来判「这是个状语，不是一句话」。
CLAUSE_LOC_TAIL = ("中", "里", "上", "下", "内", "外", "在")
#: 卡片讲解取不到时**放宽**几个字（卡片会折行，高度按真实文字算；越界由 `assert_clean` 拦）。
WIDE_EXTRA = 6
#: 教材的小标题前缀：它是章节结构，不是句子 —— 印进盒子里就成了「辨析：……」这种半截话。
HEADINGS = ("辨析", "易错点", "想一想", "小结", "提示", "注意", "要点", "概念", "定义",
            "举例", "说明", "拓展", "应用", "做法", "作用")
#: 抽**名词短句**时用的切分点（「人工智能包含机器学习」到「人工智能」）：
#: 层级/组成类的句子几乎都长这样，不切就抽不出对象名，盒子上只剩「第 4 件」。
NOUN_SPLIT = ("包含", "包括", "由", "就是", "指", "叫做", "称为", "分为", "分成", "属于",
              "里", "内", "上", "下", "中", "是")
#: 单字动词：文案以「…看小球滑。」这种收尾读着就是断句（缺宾语）。
#: ★ 只收**只可能当动词**的字（「数」「照」这类既可能是名词/介词，收了会误报）。
VERB_TAIL = set("滑跑走看做搭垒堆流落进传摆收画翻压调取读改停接给加减乘除")


def _label_head(text: str, budget: int) -> str:
    """从「A 包含 B」这类句子里抽出**对象名** A（抽不出返回空串，由调用方兜底）。"""
    value = clean_text(text)
    if len(value) <= budget:
        return value
    for separator in NOUN_SPLIT:
        head = value.split(separator)[0].strip("，、。：； ")
        if 2 <= len(head) <= budget:
            return head
    return ""


def check_lines(name: str, data: object) -> None:
    """内容自检：**生成侧自己写的**字幕不许以「单字动词 + 。」收尾（那是断句，不是句子）。

    ★ 只盯这几个键（open / close / caption / stopLine / hold）—— 教材原句进了
      `rows[i].sub` / `answer` 这些键，它们天然完整，不在检查范围内。
    """
    wanted = ("open", "close", "caption", "stopLine", "hold", "note")
    texts: list[str] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item, str) and str(key) in wanted:
                    texts.append(item)
                else:
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(data)
    for text in texts:
        if text.endswith("。") and len(text) >= 2 and text[-2] in VERB_TAIL:
            raise AssertionError(
                "{0}: 字幕以单字动词收尾（读着是断句）：{1}".format(name, text[-16:])
            )


STEP_CALL_RE = re.compile(r"h\.step\(([^,]+), ([^,)]+), '([^']+)'\)")

#: 步骤条允许用的位置量词（与 `server/tests/test_animation_templates.py` 同一张表）：
#: 步骤条是运行时元素，必须说内容已经在用的那个词，一个动画才只有一套说法（D-087）。
STEP_UNIT_WORDS = ("站", "轮", "组", "件", "条", "段", "行", "层", "圈", "次", "个问题", "步")


def check_step_coordinate(name: str, script: str) -> None:
    """步骤条的**坐标不变量**（D-087）：只数位置、一套量词、不带相位偏移。

    背景（真缺陷，实测）：步骤条原来数的是**相位**（`共 COUNT+2 步`），
    而节点徽标与字幕数的是**位置**（「第 1…4 段」）——
    同一段收尾里字幕写着「一共 4 段」、步骤条写着「共 6 步」，两个数对不上。

    三条断言：
      ① 一份模板里所有 `h.step` 的**总数**必须是同一个表达式；
      ② 那个表达式**不许带 `+ N`**（`+2`/`+3` 正是「布景 + 收尾」两拍，它们不是位置）；
      ③ **量词**只能有一个，且必须是内容自己在用的那个词（`段 / 站 / 层 / 条 / 件 / 行 / 组 / 轮 / 圈 / 次 / 个问题 / 步`）——
        步骤条是运行时元素，让它说内容已经说过的话，一个动画才只有一套说法。
    """
    calls = STEP_CALL_RE.findall(script)
    if not calls:
        return  # 手作模板（8 份）没有步骤条调用，不在本检查范围
    totals = {total.strip() for _, total, _ in calls}
    units = {unit for _, _, unit in calls}
    assert len(totals) == 1, "{0}: 步骤条总数不唯一 {1}".format(name, sorted(totals))
    assert len(units) == 1, "{0}: 步骤条量词不唯一 {1}".format(name, sorted(units))
    total = totals.pop()
    assert not re.search(r"\+\s*\d", total), (
        "{0}: 步骤条总数带相位偏移（只该数位置，不该加布景/收尾两拍）：{1}".format(name, total)
    )
    unit = units.pop()
    assert 1 <= len(unit) <= 4, "{0}: 步骤条量词长度不合理：{1!r}".format(name, unit)
    # 量词必须是**内容自己在用的词**（三个来源取并集：字面量编号 / 读数单位 / 拼接式字幕）；
    # 正文里根本没有位置编号时才允许用中性的「步」（network 的八拍就是这种）。
    units_re = "|".join(re.escape(w) for w in sorted(STEP_UNIT_WORDS, key=len, reverse=True))
    used = set(re.findall(r"第\s*\d+\s*(" + units_re + ")", script))
    used |= set(re.findall(r'"unit"\s*:\s*"([^"]{1,4})"', script))
    used |= set(re.findall(r"第 '\s*\+\s*[\w.]+\s*\+\s*'(" + units_re + ")", script))
    assert unit in used or unit == "步", "{0}: 步骤条说「{1}」，用过的量词是 {2}".format(
        name, unit, sorted(used)
    )
    # 字面量总数时，最大的字面量序号不许超过它（network 的 1..8）
    literal = re.fullmatch(r"\d+", total)
    if literal:
        limit = int(literal.group(0))
        indexes = [int(m) for m in re.findall(r"h\.step\((\d+),", script)]
        assert indexes and max(indexes) <= limit, (
            "{0}: 步骤条序号 {1} 超过总数 {2}".format(name, max(indexes), limit)
        )


def _drop_heading(text: str) -> str:
    """去掉教材的小标题前缀（「辨析：X」到「X」）。"""
    value = text or ""
    for head in HEADINGS:
        for separator in ("：", ":", "，", ",", "。"):
            prefix = head + separator
            if value.startswith(prefix):
                return value[len(prefix) :].strip()
    return value


def _unquote(text: str) -> str:
    """剥掉引号：教材句里的「会动脑筋」这种强调不该带进盒子。"""
    value = text or ""
    for mark in QUOTES:
        value = value.replace(mark, "")
    return value


def _accept(text: str) -> bool:
    """候选标签/短语能不能上屏：不以虚词收尾、不是孤立泛名词、不带引号、至少 2 字。"""
    value = (text or "").strip()
    if len(value) < 2:
        return False
    if value[-1] in TAIL_BAN:
        return False
    if value in VAGUE:
        return False
    if any(mark in value for mark in QUOTES):
        return False
    return True


#: 代词 / 介词开头的片段不是名词（「它最大」「对不确定」印在盒子上等于没说）。
PRONOUN_START = ("它", "他", "她", "这", "那", "我", "你", "咱", "其", "此")
PREP_START = ("对", "在", "把", "被", "从", "向", "给", "跟", "与", "和", "为", "由", "以", "像", "如", "比", "是")
#: 方位词单独当标签也没有信息量。
LOCAL_WORDS = {"里面", "上面", "下面", "中间", "其中", "外部", "内部", "旁边", "这里", "那里", "内部"}




def _noun_ok(text: str) -> bool:
    """**名词标签**的额外要求（比 `_accept` 严）：≥3 字、不以代词/介词开头、不是方位词。"""
    value = (text or "").strip()
    if len(value) < 3 or not _accept(value):
        return False
    if value.startswith(PRONOUN_START) or value.startswith(PREP_START):
        return False
    if value in LOCAL_WORDS:
        return False
    return True


#: 类比标记：含这些词的句子是在**打比方**（「…像水果、苹果、红富士，一层套一层」）。
#: 比方里的词（红富士 / 水果）不属于概念本身，拿来当标签会让学生把比喻当成术语。
#: ★ 单字「像」只认**从句首开始**的那种（「像水果」）—— 否则会把「图像识别」误伤。
ANALOGY_MARKERS = ("比如", "例如", "好比", "如同", "打个比方", "相当于", "好像", "就像", "类似于")


def _has_analogy(text: str) -> bool:
    """这句话/这个小句是不是在打比方。"""
    value = (text or "").strip()
    if any(mark in value for mark in ANALOGY_MARKERS):
        return True
    return value.startswith("像") or value.startswith("如同") or value.startswith("好比")


def _prefer_plain(pool: list[str]) -> list[str]:
    """把打比方的句子**排到后面**：标签优先用不打比方的句子（比方句仍可当兜底）。

    ★ 第五轮：比方句里的词混进标签池，塔上就会冒出「红富士」这种与技术层级无关的层。
    """
    return [text for text in pool if not _has_analogy(text)] + [
        text for text in pool if _has_analogy(text)
    ]


#: 只可能当动词/虚词的字（用在 accumulate 抽名词时排除「找出规律」「再里面」这类片段）。
NARROW_VERB = set("不找答回说想看用做管保存输认理自把被让给跟与和")
#: 切出来的名词前缀里同样不许出现的字（这是 NARROW_VERB 的加强版，但**不含「能 / 会 / 有」**
#: ——「人工智能」里就有个「能」，把它们一起禁掉会把最该出现的名词也挡在门外）。
SPLIT_BAN = NARROW_VERB | set("再又还也很更就都要得到来去里内上下中面")





def _trim_tail(text: str, budget: int) -> str:
    """把结尾的虚词削掉（「它的输出形式有」到「它的输出形式」）。

    ★ 这不是「切字」：被削掉的是**悬空的虚词**，留下的仍然是原句里连续的片段。
    """
    value = (text or "").strip()
    while len(value) > 2 and value[-1] in TAIL_BAN and len(value) > budget:
        value = value[:-1]
    while value and value[-1] in ("，", ",", "、", "；", ";", "：", ":"):
        value = value[:-1]
    return value


#: 教材原文里偶尔自带省略号（「第一个、第二个…」）—— 学生面文案一个都不许有，
#: 所以选句时直接跳过这种句子；兜底再抹一遍（摘要 / 名称走不到选句那一步）。
ELLIPSIS = ("…", "...")


def strip_ellipsis(text: str) -> str:
    for mark in ELLIPSIS:
        text = text.replace(mark, "")
    return text


def clean_text(text: str) -> str:
    """去排版标记与多余空白。**不做任何长度截断**（只抹省略号，不切句子）。"""
    value = strip_ellipsis(text or "").replace("**", "").replace("`", "").strip()
    value = value.replace("——", "，")
    value = re.sub(r"\s+", " ", value)
    return value.strip(" ，、；：")


def has_ellipsis(text: str) -> bool:
    return any(mark in (text or "") for mark in ELLIPSIS)


def _sentences(item: dict) -> list[str]:
    """该学段的教材原句（整句、去重、按源顺序）。"""
    out: list[str] = []
    for chunk in item.get("chunks") or []:
        for raw in re.split(r"[。\n！？]", chunk.get("text") or ""):
            if has_ellipsis(raw):
                continue
            text = clean_text(raw)
            if not 6 <= len(text) <= 60:
                continue
            if any(mark in text for mark in JUNK_MARKERS):
                continue
            if any(mark in text for mark in MARKS):
                continue
            if text not in out:
                out.append(text)
    return out


def _lines_matching(item: dict, prefix: str) -> list[str]:
    """取以某小标题开头的整句（`想一想` / `易错点` / `辨析`…），冒号后的内容原样保留。"""
    found: list[str] = []
    for chunk in item.get("chunks") or []:
        for raw in re.split(r"[。\n！？]", chunk.get("text") or []):
            if has_ellipsis(raw):
                continue
            text = clean_text(raw)
            if text.startswith(prefix) and len(text) > len(prefix) + 3:
                body = clean_text(text[len(prefix) :].lstrip("：: "))
                if body and body not in found:
                    found.append(body)
    return found


def _phrases(text: str) -> list[str]:
    """一句拆成**完整小句**（只是切分，不是截断）。"""
    value = clean_text(text)
    if not value:
        return []
    return [part for part in re.split(r"[，,、；;：:]", value) if part]


def _phrase(text: str, budget: int) -> str:
    """把一个整句收成短标签：能装下的**完整小句**（可能是几个连着），否则最短的那个小句。

    ★ 永不切字：返回的永远是原句里真实存在的连续片段（或整句），不会出现半截词。
    """
    value = clean_text(text)
    if not value:
        return ""
    if len(value) <= budget:
        return value
    parts = _phrases(value)
    if not parts:
        return value
    acc = ""
    for part in parts:
        candidate = (acc + "，" + part) if acc else part
        if len(candidate) > budget:
            break
        acc = candidate
    if acc:
        return acc
    return min(parts, key=len)


def _select(pool: list[str], count: int, budget: int, backup: list[str]) -> list[str]:
    """按「整句」挑 ``count`` 条，优先短句（不超过 ``budget`` 字）；不够就放宽，最后才用兜底句。

    ★ 绝不切句：宁可换一句更短的，也不把一句话砍成半截。
    """
    picks: list[str] = []
    for limit in (budget, budget + 12, 10**6):
        # ★ 第五轮：打比方的句子排到最后（标签优先用不打比方的句子）。
        for text in _prefer_plain(pool):
            if text in picks or len(text) > limit:
                continue
            picks.append(text)
            if len(picks) >= count:
                return picks
    for text in backup:
        if len(picks) >= count:
            break
        if text and text not in picks:
            picks.append(text)
    # ★★ **绝不靠复制凑数**（实测缺陷：`compare` 的左栏只有一句可挑时，
    #   后两格复制了第一格 —— 画布上出现两块一模一样的板子，学生以为系统出错了）。
    #   挑不满就**少给几格**：`ROWS.length` 决定 N，`COUNT = min(参数, N)` 自动跟着变小，
    #   参数滑到更大值时也不会越界。
    return picks


def _head(text: str, budget: int) -> str:
    """概念的**完整**名字头：优先取冒号 / 括号前的主名（「硬件载体：GPU / CPU / TPU」→「硬件载体」）。

    ★ 绝不按字符切：拆不出更短的**完整**片段时**返回整名**，交给基元折行 + 缩字号。
    旧版这里写的是 ``name[:8]``，会把「硬件载体：GPU / CPU / TPU」切成「硬件载体：GPU 」——
    正是用户抱怨的那种「学生看不懂」的文案。
    """
    value = clean_text(text)
    if len(value) <= budget:
        return value
    # ★ 分隔符表里带上了「的 / 和 / 与 / 在 / 把」这类虚词：教材句常常整句没有标点
    #   （「模型在大量数据上训练出来」），只按标点切会一路退到「第 2 站」这种角色名。
    #   按虚词切出来的仍然是**句子里真实存在的连续片段**（如「模型」），不是切字。
    for separator in ("：", ":", "（", "(", "、", "，", ",", " ", "的", "和", "与", "在", "把", "是"):
        head = value.split(separator)[0].strip()
        if 2 <= len(head) <= budget:
            return head
    return value


def _question_from(text: str, fallback: str) -> str:
    """把教材的辨析句变成**学生视角的疑问句**（问句不长，答案才是原句）。"""
    value = clean_text(text)
    patterns = (
        (r"^(.{2,12}?)(?:不等于|不是|并非)(.{2,16})$", r"真的能说成「{2}」吗"),
        (r"^(.{2,14}?)是(.{2,16}?)$", r"「{1}」到底是什么"),
        (r"^(.{2,14}?)(?:需要|要|得)(.{2,16})$", r"为什么非得{2}"),
    )
    for pattern, shape in patterns:
        match = re.match(pattern, value)
        if match:
            question = clean_text(shape.format(*([""] + list(match.groups()))))
            if 4 <= len(question) <= 24:
                return question
    return fallback


def _clause_ok(text: str) -> bool:
    """**分句**（副标题 / 卡片讲解）能不能上屏：够长、说人话（有汉字）、不是孤立泛名词、
    不带引号、不以功能词收尾（``CLAUSE_TAIL_BAN``）、不以半截「的」收尾。

    ★ 与 `_accept` 的分工：`_accept` 服务**名词标签**（禁尾表很严，连「的 / 了」都禁），
      本条服务**完整分句**。两者的判据不能混用 —— 混用的后果就是卡片上的空白。
    """
    value = (text or "").strip()
    if len(value) < 4:
        return False
    # ★ 卡片上那句是给学生**读的**：整格只有一个年份 / 编号（实测「2022」上过屏）等于没说。
    if not CJK_RE.search(value):
        return False
    if value in VAGUE:
        return False
    if any(mark in value for mark in QUOTES):
        return False
    if value[-1] in CLAUSE_TAIL_BAN:
        return False
    # ★ 介词开头的**方位短语**不是一句讲解（实测「在闭环中」「在流程中」上过屏）：
    #   它是状语，缺谓语 —— 学生读到它不知道该看什么。
    if value[0] in PREP_START and value[-1] in CLAUSE_LOC_TAIL:
        return False
    # ★ 括号必须**成对**（实测两头都会踩）：
    #   「有几个）」= 「（有几个）」被标点切掉了左括号；「…设计特征（如边缘，角点」= 贪心前缀
    #   停在了括号里。两者印在卡片上都是半截话，一律不要。
    for open_mark, close_mark in (("（", "）"), ("(", ")"), ("「", "」"), ("《", "》")):
        if value.count(open_mark) != value.count(close_mark):
            return False
    # ★ 以「的」收尾要分两种（实测踩到「把重复的」这种半截话）：
    #   「这些画不是拍出来的」是完整的「是…的」句，可以；「把重复的」是被逗号/顿号
    #   切了一半的并列项（后面那个名词还在下一小句里），不行。
    #   判据取**最后一个小句**里有没有「是」—— 前面小句里的「是」不算数。
    if value.endswith("的"):
        last = re.split(r"[，,、；;：:]", value)[-1]
        if "是" not in last:
            return False
    return True


def _sub_line(text: str, label: str, budget: int, allow_analogy: bool = False) -> str:
    """副标题：**预算内的完整小句**（标签已经用 ``_badge`` 单独取过时的入口）。

    ★ 为什么单独一个函数：这几条原型的标签走 ``_badge``（自带预算与兜底名），
      副标题只需要「比标签更完整的那一句」；旧写法拿两个 budget 去切同一段文字，
      而没有标点可切的长句切出来与整句相同，于是被判成「重复」清成空串，
      盒子里就只剩一个标题（学生看不到完整那句）。

    ★★ 2026-09-25（用户截图里的「文字是空的」）——这里**不再用 ``_noun_ok``**。
      ``_noun_ok`` 是给**名词标签**定的（禁代词/介词开头、禁方位词、≥3 字），
      而副标题是**一个分句**：「你对机器说一句话」「这些画不是拍出来的」
      「它马上就画出来了」在小学教材里是再正常不过的讲解句，却全被
      「代词开头」「以『的』收尾」两条毙掉 —— 一整池句子全灭，卡片上就是空白。
      分句的完整性由 ``_phrase`` 保证（只按标点拼**完整小句**，永不切字），
      所以这里只守「不以悬空连接词收尾」这一条（``CLAUSE_TAIL_BAN``，比 ``TAIL_BAN`` 宽）。

    ★ 预算仍然要守（实测踩到）：副标题一长，整条带就跟着长高，把下面的带顶出安全区
      （``scene`` 原型当场被 ``assert_clean`` 拦下）。**整句一个字都不少** ——
      它在 caption 与 ``<title>``（悬停全文）里，这正是那两处的职责。

    ★ ``allow_analogy``：只给 ``scene`` 的**最后一招**用 —— 句池里剩下的句子全在打比方时，
      「讲个比方」也比画布上一个**空框**强（小学讲法本来就爱打比方）。默认仍然禁。
    """
    value = _drop_heading(_unquote(clean_text(text)))
    # ★ 第五轮：副标题同样不打比方（比方句留给 caption，盒子上一律是概念本身的话）。
    if not value or value == label:
        return ""
    if not allow_analogy and _has_analogy(value):
        return ""
    for candidate in _sub_candidates(value, budget):
        if candidate == label or len(candidate) > budget:
            continue
        if _clause_ok(candidate):
            return candidate
    return ""


def _card_line(text: str, label: str, budget: int = 14) -> str:
    """**卡片里那句讲解**：四步退让 —— 预算内不打比方 → 允许打比方 → 放宽 ``WIDE_EXTRA`` 字
    （同样两种）→ 空串（由调用方**换一句**）。

    ★★ 空框比一句比方更糟（2026-09-25 用户口径「动画里面有的文字是空的」）：
      这批原型（flow / layers / checklist / contrast 两栏…）的卡片都是「编号 + 一句讲解」，
      ``detail`` 一旦是空串，画布上就出现一个**只有编号的框** —— 学生不知道这一格在讲什么。

    ★ 为什么还要「放宽几字」：卡片**会折行**，高度由基元按真实文字算（`Sandbox.measure`），
      所以多几个字不会压到别人；而整句 15~20 字又没有标点可切时（「Transformer 是大语言
      模型的底层骨架」），卡在 14 字上就只能整格空着 —— 那是最差的结果。
      真的放不下（带子顶出安全区）由生成期的 ``assert_clean`` 当场拦下，不会带病写盘。
    """
    return (
        _sub_line(text, label, budget)
        or _sub_line(text, label, budget, allow_analogy=True)
        or _sub_line(text, label, budget + WIDE_EXTRA)
        or _sub_line(text, label, budget + WIDE_EXTRA, allow_analogy=True)
    )


def _whole_line(text: str, label: str) -> str:
    """最后一步：**整句端上去**（只剥小标题与引号，一个字都不切）。

    ★ 用在句池已经被别处用光、退让到这一步还取不到讲解的那**一格**上：卡片会折行、
      高度由基元按真实文字算，所以「多两行」是可接受的代价；而**空框**不是
      （2026-09-25 用户口径「动画里面有的文字是空的」）。真放不下由 `assert_clean` 拦。
    ★ 仍然守内容卫生：带排版标记（`——` / `**` / 反引号）的整句不上屏。
    """
    value = _drop_heading(_unquote(clean_text(text)))
    if not value or value == label or not CJK_RE.search(value):
        return ""
    if any(mark in value for mark in MARKS):
        return ""
    return value


def _lines_with_detail(
    item: dict, count: int, pick_budget: int, card_budget: int, backup: list[str], label_of
) -> list[tuple[str, str]]:
    """挑 ``count`` 条教材句，并保证**每一条都配得上一句能上屏的卡片讲解**。

    ★★ 2026-09-25 用户截图「动画里面有的文字是空的」的根治办法。
      这批原型（scene 站牌 / flow 分段 / layers 分层 / checklist 逐条）的卡片都是
      「编号 + 一句讲解」：讲解取不到时旧版写空串，画布上就出现一个**只有编号的框**，
      学生不知道这一格在讲什么。而现在有些句子天生取不出讲解（整句 20+ 字又没有标点、
      或者整句在打比方）—— 所以**换一句**：从同一个句池里取一条能给出讲解的
      （短的优先，卡片带的高度按最费的那一项算）。

    ★ 三级退让，**顺序不能改**：① 这句的常规讲解 → ② 换一句（免得把 30 字整句塞进小卡片）
      → ③ 整句端上去（`_whole_line`，句池真的被别处用光时才走到这一步）。
      若把 ③ 提前到 ①，第 ② 级就永远轮不到，「换一句」等于失效
      （实测：`机器学习（ML）` 的第 1 站因此顶着一条 30 字的整句，而池子里另有 15 字的短句）。

    ⚠️ 返回的 ``line`` 是**换过之后的**那句：caption / 悬停全文用的也是它，
      否则会出现「卡片讲 A、字幕讲 B」的错配。
    """
    pool = _sentences(item)
    lines = _select(pool, count, pick_budget, backup)
    used = set(lines)
    spares = sorted((text for text in _prefer_plain(pool) if text not in used), key=len)
    out: list[tuple[str, str]] = []
    for index, line in enumerate(lines):
        label = label_of(index)
        detail = _card_line(line, label, card_budget)
        if not detail:
            for position, alt in enumerate(spares):
                alt_detail = _card_line(alt, label, card_budget)
                if alt_detail:
                    line = spares.pop(position)
                    detail = alt_detail
                    break
        if not detail:
            detail = _whole_line(line, label)
        out.append((line, detail))
    return out


def _sub_candidates(value: str, budget: int) -> list[str]:
    """副标题候选（按「读起来最像一句讲解」排序），逐个试到能用为止。

    ★★ 为什么不能只试「贪心前缀」（2026-09-25 空文字的第二层根因）：
       ``_phrase`` 只拼**开头**那几个小句，于是「算法，就是机器做题的方法和步骤」
       → 「算法」（2 字，太短）、「加权，每个数字乘上自己的重要程度」→「加权」——
       **真正的讲解句在后面那一小句**，却从来没被拿到过。所以先试贪心前缀，
       再**逐个小句**试（长的优先）：正常情况一步到位，前缀太短时由后面的小句顶上。

    ★★ 候选**只来自完整小句**，不许用 `_head` 那种「句中的切片」：
       ``_head`` 是按「的 / 在 / 和」这类虚词切的，切出来的是**修饰语**而不是句子 ——
       实测踩到「就像给机器装了一双会认东西」（后面那个名词被切掉了）、
       「就像有小朋友把没看过的书」，印在卡片上就是半截话。
       没有标点可切的长句一律**取不到**，改由 `_lines_with_detail` **换一句**。
    """
    out: list[str] = []
    seen: set[str] = set()

    def push(text: str) -> None:
        trimmed = _trim_tail(text, budget)
        if trimmed and trimmed not in seen:
            seen.add(trimmed)
            out.append(trimmed)

    push(_phrase(value, budget))
    for part in sorted(_phrases(value), key=len, reverse=True):
        push(part)
    return out


def _badge(text: str, budget: int, fallback: str) -> str:
    """盒内的**短标签**：先剥引号，再取预算内的完整小句 / 名头 / 名词短句，过 `_noun_ok`。

    ★ 拒绝的形态（见 TAIL_BAN / VAGUE / QUOTES / PRONOUN_START）：结尾是悬空虚词、
      孤立泛名词、带引号、代词或介词开头的碎片。全被拒就用机制词兜底（「第 2 站」）。
    """
    value = _drop_heading(_unquote(clean_text(text)))
    # ★ 第五轮：**打比方的句子整句不参与标签**（「就像你学做菜」里的词不是概念本身）。
    if value and not _has_analogy(value):
        for candidate in (_phrase(value, budget), _head(value, budget), _label_head(value, budget)):
            trimmed = _trim_tail(candidate, budget)
            if trimmed and len(trimmed) <= budget and _noun_ok(trimmed):
                return trimmed
    return fallback


def _fit(text: str, budget: int, fallback: str) -> str:
    """预算内的**完整片段**：整句 → 完整小句 → 名头 → 兜底句（永不切字，且过 `_accept`）。"""
    value = _drop_heading(_unquote(clean_text(text)))
    if value and len(value) <= budget and _accept(value):
        return value
    if value:
        for candidate in (_phrase(value, budget), _head(value, budget)):
            trimmed = _trim_tail(candidate, budget)
            if trimmed and len(trimmed) <= budget and _accept(trimmed):
                return trimmed
    return _unquote(clean_text(fallback))


def _open_line(text: str, fallback: str, budget: int = 22) -> str:
    """开场字幕：带概念名的那一句若超预算，就用不说名字的那一句（守 22 字）。"""
    value = clean_text(text)
    return value if 0 < len(value) <= budget else fallback


# --------------------------------------------------------------------------- #
# 文本度量（Python 侧）—— 与 ``runtime.js`` 的 characterWidth / wrapText / fitText
# **逐字同一套算式**（含 0.92 的收缩步长与 12 次上限）。
#
# ★ 为什么要在这里再写一遍：模板在**离线**就要把「每个格子放哪、多高多宽」算出来，
#   这样守卫不用开浏览器就能验「盒子不重叠 / 不出舞台 / 标签≠副标题」（spec 的硬要求）。
#   两套实现必然有漂移风险，所以：
#     · 运行时对每个盒子做**对账**（实际比清单大就记进 `window.__K12_LAYOUT__` 的
#       `overflow` 条目）；
#     · 本仓库的截图流水线会在真浏览器里跑一遍 `__K12_LAYOUT__` 对账（见报告里的实测数字）；
#     · 同一份算式在两边都用「最保守」的取值方向（见下面 SKIN_METRICS 的说明）。
# --------------------------------------------------------------------------- #
#: 皮肤刻度 —— 逐字取自 ``_shared/skins.css`` 的 ``--k12-*``（illustrated / technical）。
#: ⚠️ 改 skins.css 的刻度必须同步这里（`:root[data-skin=...]` 两段）。
#: ★★ 第六轮实测踩到：刻度漂了 1~4%（node 19→20、node_sub 14→14.5、bubble 16.5→17、
#:   readout_value 27→28…）而这里没跟 —— 于是**规划高度系统性偏低**，运行时按真实文字
#:   把盒子排高一点就压住了下一层（layers 塔两层重叠 375×12px，Python 侧一句都拦不住）。
SKIN_METRICS: dict[str, dict[str, float]] = {
    "illustrated": {
        "pad": 18.0,
        "node": 20.0,
        "node_sub": 14.5,
        "bubble": 17.0,
        "readout_label": 12.5,
        "readout_value": 28.0,
        "actor": 13.0,
    },
    "technical": {
        "pad": 13.0,
        "node": 16.0,
        "node_sub": 12.5,
        "bubble": 15.0,
        "readout_label": 11.5,
        "readout_value": 25.0,
        "actor": 12.0,
    },
}

#: 中文避头 / 避尾标点（与运行时的两张表逐字一致）。
NO_LINE_START = "，。、；：！？）】》」』〕｝ヽヾゝゞ々ー・%—～"
NO_LINE_END = "（【《「『〔｛"


def _is_wide(character: str) -> bool:
    return ord(character) >= 0x2E80


def _character_width(character: str) -> float:
    if character == " ":
        return 0.3
    if _is_wide(character):
        return 1.0
    if "0" <= character <= "9":
        return 0.56
    if "A" <= character <= "Z":
        return 0.66
    return 0.54


def estimated_width(text: str, font_size: float) -> float:
    return sum(_character_width(ch) for ch in text) * font_size


def _text_units(text: str) -> list[str]:
    units: list[str] = []
    buffer = ""
    for character in text:
        if _is_wide(character) or character == " ":
            if buffer:
                units.append(buffer)
                buffer = ""
            units.append(character)
        else:
            buffer += character
    if buffer:
        units.append(buffer)
    return units


def wrap_text(text: str, max_width: float, font_size: float) -> list[str]:
    """按最大宽度折行（与运行时同源：中文逐字、西文按词、避头标点拉回上一行）。"""
    units = _text_units(text)
    lines: list[str] = []
    current = ""
    index = 0
    while index < len(units):
        unit = units[index]
        if unit == " " and not current:
            index += 1
            continue
        too_wide = current != "" and estimated_width(current + unit, font_size) > max_width
        break_before = current != "" and (
            (unit in NO_LINE_END and len(unit) == 1)
            or (too_wide and not (unit in NO_LINE_START and len(unit) == 1))
        )
        if break_before:
            lines.append(current.rstrip())
            current = ""
            continue
        current += unit
        index += 1
    if current:
        lines.append(current.rstrip())
    return lines or [""]


def fit_text(
    text: str, max_width: float, font_size: float, min_font_size: float, max_lines: int
) -> tuple[list[str], float]:
    """折行 + 按「行数上限 / 宽度上限」收缩字号（下限 min_font_size）—— 运行时的同一套。"""
    size = font_size
    lines = wrap_text(text, max_width, size)
    guard = 0
    while guard < 12 and size > min_font_size:
        widest = max((estimated_width(line, size) for line in lines), default=0.0)
        if len(lines) <= max_lines and widest <= max_width:
            break
        size = max(min_font_size, round(size * 0.92 * 10) / 10)
        lines = wrap_text(text, max_width, size)
        guard += 1
    return lines, size


def node_needed(label: str, sub: str, width: float, skin: str) -> float:
    """``node()`` 需要的高度（不够它会自动长高 —— 这里必须**提前**算准）。"""
    scale = SKIN_METRICS[skin]
    pad = scale["pad"]
    inner = max(24.0, width - pad * 2)
    label = label or ""
    sub = sub or ""
    label_height = 0.0
    if label:
        lines, size = fit_text(label, inner, scale["node"], 11.0, 4)
        label_height = len(lines) * size * 1.34
    sub_height = 0.0
    if sub:
        lines, size = fit_text(sub, inner, scale["node_sub"], 10.0, 3)
        sub_height = len(lines) * size * 1.34
    mid_gap = max(2.0, pad * 0.3) if sub else 0.0
    return label_height + mid_gap + sub_height + pad * 2


def readout_needed(label: str, width: float, skin: str) -> float:
    """``readout()`` 需要的高度（标签一行 + 数值一行 + 上下内边距）。"""
    scale = SKIN_METRICS[skin]
    pad = scale["pad"]
    inner = max(40.0, width - pad * 2)
    label_height = 0.0
    if label:
        lines, size = fit_text(label, inner, scale["readout_label"], 9.5, 2)
        label_height = len(lines) * size * 1.34
    value_height = scale["readout_value"] * 1.34
    mid_gap = 6.0 if label_height else 0.0
    return pad + label_height + mid_gap + value_height + pad


def bubble_size(text: str, max_width: float, tail: str, skin: str) -> tuple[float, float]:
    """``bubble()`` 真实的 (宽, 高含尾巴) —— 框会按内容收敛，所以宽度不是给定值。"""
    scale = SKIN_METRICS[skin]
    pad = scale["pad"]
    width = max(120.0, max_width)
    inner = max(60.0, width - pad * 2)
    lines, size = fit_text(text or "", inner, scale["bubble"], 10.5, 6)
    widest = max((estimated_width(line, size) for line in lines), default=0.0)
    box_width = max(96.0, min(width, float(int(widest + 0.999) + pad * 2)))
    line_height = size * 1.34
    box_height = max(pad * 2 + line_height, len(lines) * line_height + pad * 2)
    return box_width, box_height + (0.0 if tail == "none" else 14.0)


def actor_rect(x: float, y: float, scale: float, label: str, skin: str) -> tuple[float, float, float, float]:
    """人物的占位矩形（与 ``actor()`` 里的 k12Box 同源：含脚下那行名字）。"""
    label_width = 40.0
    if label:
        label_width = max(40.0, min(160.0, estimated_width(label, SKIN_METRICS[skin]["actor"])))
    room = 30.0 if label else 0.0
    return (x - label_width / 2 * scale, y - 96 * scale, label_width * scale, (96 + room) * scale)


#: 舞台与安全区（与运行时 ``SAFE_MARGIN`` / ``SAFE_BOTTOM_MARGIN`` 同一个契约）。
STAGE_W = 720.0
STAGE_H = 420.0
SAFE_X = 34.0
SAFE_TOP = 34.0
SAFE_RIGHT = 686.0
SAFE_BOTTOM = 390.0

#: 布局里一条带的总宽（= 安全区宽度）。子文案的预算按格子宽度推，不能各原型拍脑袋。
BAND_WIDTH = SAFE_RIGHT - SAFE_X


def cell_width(count: int, gap: float, total: float = BAND_WIDTH) -> float:
    """一行 ``count`` 个格子时，每格的实际宽度（与运行时均分同一式）。"""
    if count <= 0:
        return total
    return (total - gap * (count - 1)) / count


def sub_budget(width: float, lines: int = 2, font: float = 14.0, pad: float = 36.0) -> int:
    """按格子宽度算出「副标题最多几个字」，让它正好排成 ``lines`` 行。

    ★★ 实测踩到：``scene`` 一行 4 格、每格只有 154px，副标题给到 20 字就折成 3 行 ——
      盒子长高约 50px，几个带叠起来把最下面的读数顶出安全区（``assert_clean`` 当场拦下）。
      根因是**预算没跟着宽度走**：同一句文案放进 470px 宽的格子只要 2 行。
      所以预算必须由宽度推出来，而不是各原型各写一个常数。
    """
    inner = max(40.0, float(width) - pad)
    per_line = max(4, int(inner / font))
    return per_line * lines


# 脚本公共前奏（所有原型共用；颜色一律走类名，一个色值都不写）
# --------------------------------------------------------------------------- #
COMMON_JS = r'''
var M = Sandbox.motion;
var PACE = @@PACE@@;
var DATA = __DATA__;
var ROWS = DATA.rows;
var N = ROWS.length;
var SAFE = Sandbox.safe;

function d(f) { return M.duration * f / PACE; }
function fg() {
  var host = Sandbox.stage().svg.querySelector('.k12-layer-fg');
  var g = Sandbox.svgEl('g');
  host.appendChild(g);
  return g;
}
function at(g, x, y) { g.setAttribute('transform', 'translate(' + x + ' ' + y + ')'); return g; }
function anchor(el) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; return el; }
/*
 * 把布局清单建出来的每一件都设成「按自己的盒子缩放」（fill-box + 中心原点）。
 *
 * ★★ 实测踩到（用户看到的「错位」）：SVG 的 <g> 默认按 view-box 缩放，scale 的参考点
 *   是整块画布的中心，于是 bump(某一个盒子) 会把它整体挪走（1.5 倍时 (300,60) 跑到 (450,300)）。
 *   模板里凡是要缩放的东西都得先 anchor()；清单建出来的盒子也一样，所以这里统一过一遍。
 */
function anchorCells(L) {
  var ids = L.ids || [], k, one;
  for (k = 0; k < ids.length; k += 1) {
    one = L.pick(ids[k]);
    if (one) anchor(one);
  }
}
/*
 * 两层：外层（seat）只负责摆位置，它用 transform 属性，任何动画都不许碰它；
 * 内层（返回的 pivot）不带 transform 属性，交给 anime 写 style.transform。
 *
 * ★★ 实测踩到（P-133 同类，最严重的一类）：把位置留在被动画的那个元素上，
 *   anime 的 translateX / scale 会写 style.transform，而 style 整个盖掉 transform 属性，
 *   于是第 2 帧那个元素就跳到画布原点附近（trace 的小球被裁在左上角就是这么来的）。
 */
function pivot(x, y) { var inner = Sandbox.svgEl('g'); at(fg(), x, y).appendChild(inner); return anchor(inner); }
/* 只移动外层（换位置用；被动画的内层依旧不动）。 */
function moveSeat(inner, x, y) { at(inner.parentNode, x, y); return inner; }
function off(el) { el.setAttribute('opacity', '0'); return el; }
function nd(o) { return anchor(Sandbox.node(o)); }
function rd(o) { return anchor(Sandbox.readout(o)); }
function bub(o) { return anchor(Sandbox.bubble(o)); }
function person(o) { return anchor(Sandbox.actor(o)); }
/*
 * ★★ 布局（本版新增，替掉旧版每个原型手算的 x / y / w / h）。
 *
 * 旧写法把每个站点的坐标手算成「可用宽度减去固定卡宽再除以站点数加一」：站点一多，分子变负，
 * 盒子互相压；文案一长，node() 为「永不截断」自己长高，又压住下一行；读数框钉死在右下角，
 * 与步骤条挤在一起。根因是没有任何一处知道别人占多大地方。
 *
 * 现在一律走 Sandbox.zone / row / stack：宽度均分、整行同一高度（按最费的那项给）、
 * 带与带之间有纵向游标 ， 重叠在构造上不可能。下面的 zone() 就是「新开一条带」的简写。
 */
function zone(o) { return Sandbox.zone(o || {}); }
function safeWidth() { return SAFE.width; }
/* 人物站在 x、脚底落在 y 上（y 必须是「一条线」：路面 / 站的基线 / 天平横梁）。 */
function walker(x, y, pose, name, scale) {
  return person({ x: x, y: y, pose: pose || 'walk', label: name || '', scale: scale || 1 });
}
/* 盒子中线（连接线、人物走位都以它为准，不再手算 center）。 */
function midOf(box) { return box ? box.x + box.w / 2 : 0; }
/*
 * 一段文字要多大（与基元同一套算式）。
 *
 * ★ 用途：同一格里要轮播好几段文案时（对照两栏、读数框），先按最大的一段预留尺寸，
 *   轮播过程中盒子一次都不会长大 ， 也就不会去压邻居。旧写法正是在这里出的错：
 *   盒子按第一段文案的尺寸建好，后面长的一句让它临时长高，压住下面那一行。
 */
function fitOf(o) { return Sandbox.measure(o || {}); }
function needH(cells, width) {
  var i, need = 40;
  for (i = 0; i < cells.length; i += 1) {
    var cell = cells[i] || {};
    need = Math.max(need, fitOf({
      kind: cell.kind || 'node', w: width,
      label: cell.label, sub: cell.sub, text: cell.text, tail: cell.tail
    }).height);
  }
  return need;
}
function riseIn(el, dy) { return { targets: el, opacity: [0, 1], translateY: [dy, 0], duration: d(1), easing: M.easing }; }
function popIn(el) { return { targets: el, opacity: [0, 1], scale: [0.94, 1], duration: d(1), easing: M.easing }; }
function slideIn(el, dx) { return { targets: el, opacity: [0, 1], translateX: [dx, 0], duration: d(1), easing: M.easing }; }
function later(anim, factor) { anim.delay = d(factor); return anim; }
/*
 * 同位轮换的「接力棒」（第七轮实测缺陷：交叉淡化 = 文字重影）。
 *
 * 旧的那个淡出（swapOut）与新的那个淡入（slideIn / riseIn / fadeTo）落在同一个格位上：
 * 时间窗一交叠，屏幕同一处就有两段文字同时可见。实测旧气泡 [0, 0.35] 与新气泡
 * （delay 0.10~0.12）叠了约 150ms，学生看到的是糊成一片的两段字，对话、计数、对照三处都中。
 * 所以转速在这里卡死：旧淡出 [0, HANDOFF_OUT]，新淡入最早从 HANDOFF_OUT + HANDOFF_GAP 起。
 * 不用硬切 off()（那会看到闪断）：仍是平滑接力，只是两段永远不重叠。
 */
var HANDOFF_OUT = 0.25;
var HANDOFF_GAP = 0.02;
var HANDOFF_IN = HANDOFF_OUT + HANDOFF_GAP;
function swapOut(el) { return { targets: el, opacity: [1, 0], duration: d(HANDOFF_OUT), easing: 'linear' }; }
function dim(el) { return { targets: el, opacity: [1, 0.55], duration: d(0.5), easing: 'linear' }; }
function lit(el) { return { targets: el, opacity: [0.55, 1], duration: d(0.5), easing: 'linear' }; }
function mark(el) { return { targets: el, strokeWidth: [1.1, 3.6, 1.1], duration: d(1.1), easing: M.easing }; }
function bump(el) { return { targets: el, scale: [1, 1.07, 1], duration: d(0.8), easing: M.easing }; }
function wipe(el) { return { targets: el, strokeWidth: [0.4, 2.6], duration: d(0.9), easing: M.easing }; }
function push(meter, value) {
  return { targets: meter, scale: [1.03, 1], duration: d(0.5), easing: M.easing, begin: function () { meter.set(value); } };
}
/*
 * 动小人一律动他那层 pivot（实测缺陷：对话原型的小人被切在画布上沿）。
 *
 * anime 的 scale / translateX 写的是 style.transform，而 style 会整个盖掉元素自己的
 * transform 属性（translate + scale 那一串）；直接动人物本体，他就会弹回舞台原点，
 * 位置丢了、缩放也没了，看起来就是「小人跑到画布外面」。
 * 运行时给每个人物套了两层：外层只负责摆位置（动画永不碰），
 * 内层 pivot 不带 transform 属性、专供动画。所以这里统一取 pivot。
 */
function actorOf(el) { return (el && el.k12Pivot) || el; }
function bumpActor(el) { return bump(actorOf(el)); }
function popActor(el) { return popIn(actorOf(el)); }
function hideActor(el) { return off(actorOf(el)); }
/*
 * ★★ 相位开始时才更新字幕 / 步骤条（本票最隐蔽的一处，实测踩到）。
 *
 * Sandbox.timeline(steps, builder) 的 builder 是在建时间线时被一次性跑完的
 * （runtime.js 里那个 for 循环），不是每个相位开始时。所以在 builder 里直接调
 * h.caption / h.step，所有相位的字幕会在开播前全部写完，最后一句永远胜出：
 * 学生从第 0 秒起看到的就是收尾文案，而动画才刚开始播（截图里一眼看穿：
 * 人物还在路上，字幕已经是结论）。
 *
 * 修法：所有原型都不直接调 h.caption / h.step，而是把 builder 交给 defer() 包一层：
 * defer 收下这两个调用，改成一条 1ms 的「只会调 begin」的动画塞进该相位的最前面，
 * 由 anime 在相位边界上触发。相位正文因此可以照常写 h.caption 与 h.step，读起来还是直白。
 *
 * ★ defer 只改这一件事：它把 caption / step 变成「相位开始时」的事件，其余成员原样透传，
 *   所以原型里照旧写 h.caption，读起来与 STAGE-API 的样例一致。
 */
function defer(build) {
  return function (tl, index, h) {
    var shim = {}, key, text = null, at = 0, total = 0, word = '';
    for (key in h) { if (Object.prototype.hasOwnProperty.call(h, key)) shim[key] = h[key]; }
    shim.caption = function (value) { text = value; return shim; };
    shim.step = function (value, count, unit) { at = value; total = count; word = unit; return shim; };
    var made = build(tl, index, shim);
    var list = made == null ? [] : (Object.prototype.toString.call(made) === '[object Array]' ? made.slice() : [made]);
    // step 先加、caption 后加 → 两者都在该相位的第一个 tick 触发（顺序只影响同一帧内谁后写）
    if (total) list.unshift({ targets: { t: 0 }, t: [0, 1], duration: 1, easing: 'linear', begin: function () { Sandbox.step(at, total, word); } });
    if (text != null) list.unshift({ targets: { t: 0 }, t: [0, 1], duration: 1, easing: 'linear', begin: function () { Sandbox.caption(text); } });
    return list;
  };
}
function say(text, at, total, unit) {
  return {
    targets: { t: 0 },
    t: [0, 1],
    duration: 1,
    easing: 'linear',
    begin: function () { Sandbox.caption(text); Sandbox.step(at, total, unit); }
  };
}
function label(x, y, text, cls) {
  var t = Sandbox.svgEl('text');
  t.setAttribute('class', cls || 'k12-node-sub');
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.textContent = String(text);
  fg().appendChild(t);
  return t;
}
/*
 * ★★ 背景装饰（插画皮肤的场景感：地面 / 小丘 / 太阳 / 云）。
 *
 * 只挂类名与几何：颜色（以及「工程皮肤把它们收隐」）由 base.css 与 skins.css 决定，
 * 这里一个色值都不写。几何全在 viewBox 内且四周留 >=24 的边距（太阳不再贴角被圆角裁掉）。
 *
 * ★ 第二版（用户口径「人物浮在半空中」「太阳被圆角裁掉」）：地面带与两座小丘〔贴着
 *   人物脚下那条线〕画（groundY 就是那条线的 y），人物于是站在地面上而不是飘着；
 *   没有人物时传舞台底线。太阳 / 云挪进顶部那条空带里（在读数角带左边，不再被压住）。
 */
function bgLayer() { return Sandbox.stage().svg.querySelector('.k12-layer-bg'); }
function bgShape(tag, cls, attrs) {
  var el = Sandbox.svgEl(tag);
  el.setAttribute('class', cls);
  var keys = attrs || {}, name;
  for (name in keys) {
    if (Object.prototype.hasOwnProperty.call(keys, name)) el.setAttribute(name, String(keys[name]));
  }
  return el;
}
function decorScene(groundY) {
  var host = bgLayer();
  if (!host) return;
  var line = typeof groundY === 'number' ? groundY : 392;
  var shapes = [
    bgShape('rect', 'k12-decor-ground', { x: 8, y: line, width: 704, height: Math.max(24, 418 - line), rx: 12 }),
    bgShape('path', 'k12-decor-hill', { d: 'M 40 ' + line + ' Q 96 ' + (line - 30) + ' 152 ' + line + ' Z' }),
    bgShape('path', 'k12-decor-hill', { d: 'M 568 ' + line + ' Q 624 ' + (line - 30) + ' 680 ' + line + ' Z' }),
    bgShape('circle', 'k12-decor-sun', { cx: 318, cy: 72, r: 16 }),
    bgShape('ellipse', 'k12-decor-cloud', { cx: 108, cy: 66, rx: 32, ry: 11 }),
    bgShape('ellipse', 'k12-decor-cloud', { cx: 146, cy: 56, rx: 20, ry: 9 }),
    bgShape('ellipse', 'k12-decor-cloud', { cx: 234, cy: 62, rx: 24, ry: 9 })
  ];
  var i;
  for (i = 0; i < shapes.length; i += 1) host.appendChild(shapes[i]);
}
/*
 * 把一行里〔可见的那几格〕整体居中（参数调小、格数变少时，右边不该留一条空）。
 *
 * 做法：给每一格套一层只负责平移的 <g>（外层摆位置），格子自己的坐标与被动画的
 * transform 都留在它自己身上，于是「居中偏移」与「bump / 缩放」于是互不覆盖。
 * 返回偏移量 dx（人物走位、数据包滑行都要加上它）。
 */
function centerRow(cells, count) {
  var n = Math.min(count, cells.length);
  if (n >= cells.length || cells.length < 2) return 0;
  var step = cells[1].k12Box.x - cells[0].k12Box.x;
  var dx = (cells.length - n) * step / 2;
  var i, wrap;
  for (i = 0; i < n; i += 1) {
    wrap = Sandbox.svgEl('g');
    at(wrap, dx, 0);
    fg().appendChild(wrap);
    wrap.appendChild(cells[i]);
  }
  return dx;
}
/*
 * 焦点纪律：当前讲到的那一件加粗描边（k12-node--focus），别的退回常态。
 * 一个相位只留一个焦点，学生才知道该看哪里。
 */
function focusOn(el) { if (el && el.classList) el.classList.add('k12-node--focus'); return el; }
function focusOff(el) { if (el && el.classList) el.classList.remove('k12-node--focus'); return el; }
/* 传一件或一串（数组）都行：一行的左右两格算同一个焦点。 */
function toggleFocus(target, on) {
  var list = target ? (target.length ? target : [target]) : [];
  var k;
  for (k = 0; k < list.length; k += 1) {
    if (on) focusOn(list[k]);
    else focusOff(list[k]);
  }
}
/*
 * 一次不占时间的「副动作」（改读数 / 换焦点 / 记账）：1ms 的动画，只在 begin 里调一次。
 *
 * ★★ 为什么不能直接调：builder 是「一次性跑完」的（见 defer 的说明），直接在这里改
 *   class 或读数，等于在开播前把所有相位的结果一次性写完，最后一个永远胜出。
 *   once(fn) 把它推迟到相位边界上，与 caption / step 同一套机制。
 */
function once(fn) {
  return { targets: { t: 0 }, t: [0, 1], duration: 1, easing: 'linear', begin: fn };
}
/* 换焦点：当前这一件加粗，上一件退回（旧的可以给 null 或数组）。 */
function focusStep(el, before) {
  return once(function () { toggleFocus(el, true); toggleFocus(before, false); });
}
/* 收尾时把焦点全部撤掉（一屏的焦点只能有一个，结尾不该还留着一个）。 */
function focusClear(list) {
  return once(function () { toggleFocus(list, false); });
}
/* 扫描进度 + 换焦点，同一个 begin 里做完（matrix 用：读数与高亮必须同步）。 */
function scanStep(meter, text, cell, before) {
  return once(function () { meter.set(text); focusOn(cell); focusOff(before); });
}
/* 还没到的地方（0.42 半透明）、走到就点亮（1）。 */
function wake(el) { return { targets: el, opacity: [0.42, 1], duration: d(0.7), easing: M.easing }; }
function asleep(el) { return { targets: el, opacity: [0, 0.42], duration: d(0.5), easing: 'linear' }; }
function ahead(el) { return { targets: el, opacity: [1, 0.42], duration: d(0.5), easing: 'linear' }; }
/*
 * 把一件东西淡到某个亮度（从它当前的值出发，不是写死起点）。
 *
 * ★★ 为什么需要它：dim / lit 用的是「起点到终点」的数组，对一件已经在半途的东西
 *   用错了起点就会先跳一下（0.55 的元素被 dim 成 [1, 0.55] 会闪一次白）。
 *   凡是「已就位 / 已完成 / 未到」这类状态切换，都用 fadeTo(el, 目标值)。
 */
function fadeTo(el, value) { return { targets: el, opacity: value, duration: d(0.55), easing: 'linear' }; }
/*
 * 打钩：先在格子下面画一段弧线，再让它从左边「画出来」（scaleX 0 到 1）。
 * 弧线挂 k12-actor-limb（描边色由 CSS 给），位置落在行距里，不压任何盒子。
 */
function arcUnder(cell) {
  var box = cell.k12Box;
  var path = Sandbox.svgEl('path');
  path.setAttribute('class', 'k12-actor-limb');
  var left = box.x + box.w * 0.26;
  var right = box.x + box.w * 0.74;
  var top = box.y + box.h + 3;
  path.setAttribute('d', 'M ' + left + ' ' + top + ' Q ' + (box.x + box.w * 0.5) + ' ' + (top + 5) + ' ' + right + ' ' + top);
  path.style.transformBox = 'fill-box';
  path.style.transformOrigin = 'left center';
  off(path);
  fg().appendChild(path);
  return path;
}
function drawArc(path) {
  return { targets: path, opacity: [0, 1], scaleX: [0, 1], duration: d(0.8), easing: M.easing };
}
/*
 * 连接线的「线元素本身」（粗细 / 划线动画必须动它，不能动父级 <g>）。
 *
 * ★★ 实测踩到：CSS 给 .k12-link-line 与 .k12-link-pipe 各自定过 stroke-width，
 *   子元素一旦有自己的一档值，父级 <g> 上的 strokeWidth 就不会继承下去，
 *   对 <g> 做划线动画等于什么都没发生（而且不报错）。
 *   pipe 样式的线挂的是 k12-link-pipe，所以两种都要试。
 */
function railLine(rail) {
  if (!rail || !rail.querySelector) return rail;
  return rail.querySelector('.k12-link-line') || rail.querySelector('.k12-link-pipe') || rail;
}
/* 一枚小圆点：数据包 / 游标 / 跑动的小人共用（圆身挂 k12-node-body，颜色由 CSS 给）。 */
function dotAt(radius) {
  var dot = Sandbox.svgEl('circle');
  dot.setAttribute('class', 'k12-node-body');
  dot.setAttribute('cx', '0');
  dot.setAttribute('cy', '0');
  dot.setAttribute('r', String(radius || 11));
  return dot;
}
/* 跑道上的小人：圆脑袋 + 一条腿（脸由运行时的 actor 负责，这里只给身形）。 */
function runnerGlyph(radius) {
  var g = Sandbox.svgEl('g');
  var head = Sandbox.svgEl('circle');
  head.setAttribute('class', 'k12-node-body');
  head.setAttribute('cx', '0');
  head.setAttribute('cy', String(-(radius + 5)));
  head.setAttribute('r', '7');
  var leg = Sandbox.svgEl('line');
  leg.setAttribute('class', 'k12-actor-limb');
  leg.setAttribute('x1', '0');
  leg.setAttribute('y1', String(-radius + 3));
  leg.setAttribute('x2', '0');
  leg.setAttribute('y2', String(radius));
  g.appendChild(leg);
  g.appendChild(head);
  return g;
}
/* 最低点的小旗：一根杆 + 一面三角旗 + 一行小字（挂现成的类名，不写色值）。 */
function flagAt(x, y, text) {
  /* 两层：外层只摆位置（transform 属性，动画永不碰）、内层交给 anime（见 pivot 的说明）。 */
  var inner = pivot(x, y);
  var pole = Sandbox.svgEl('line');
  pole.setAttribute('class', 'k12-link-line');
  pole.setAttribute('x1', '0');
  pole.setAttribute('y1', '0');
  pole.setAttribute('x2', '0');
  pole.setAttribute('y2', '-26');
  var cloth = Sandbox.svgEl('path');
  cloth.setAttribute('class', 'k12-link-arrow');
  cloth.setAttribute('d', 'M 1 -26 L 21 -19 L 1 -12 Z');
  inner.appendChild(pole);
  inner.appendChild(cloth);
  if (text) {
    var t = Sandbox.svgEl('text');
    t.setAttribute('class', 'k12-node-sub');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('x', '12');
    t.setAttribute('y', '-33');
    t.textContent = String(text);
    inner.appendChild(t);
  }
  return inner;
}
'''.lstrip("\n")


def script_for(
    archetype: str, pace_param: str, phases_expr: str, skin: str | None = None, data: dict | None = None
) -> str:
    """拼一份完整模板脚本（头注释 + 公共前奏 + **布局清单** + 原型正文 + ready 上报）。

    ★ ``Sandbox.ready(`` 一条都不能少：宿主 5 秒收不到它就判超时、卡片降级
      （STAGE-API §5 第 ③ 条，也是 ``validate_animation_html`` 的第 3 类断言）。
    ★ ``skin`` 取**本份模板实际会拿到的皮肤**（学段决定），不是原型的天然皮肤 ——
      交叉的两例（小学高年级拿到工程系原型）在头注释里也必须说实话，
      否则截图复盘时会被自己的注释带偏。
    ★★ ``__PLAN__`` 是**布局清单**（每个盒子的坐标与尺寸；Python 侧按真几何算好，
      见 PLANNERS）：运行时 ``Sandbox.layout()`` 照单画，位置一个字都不在 JS 里手算 ——
      旧版那套 ``GAP = (668 - 150 * COUNT) / (COUNT + 1)`` 正是重叠的来源。
      清单同时是守卫的输入：CI 上不用开浏览器就能验盒盒不重叠。
    """
    head = "/* K12-ARCHETYPE {0} | skin={1} */\n{2}\n".format(
        archetype, skin or ARCHETYPES[archetype]["skin"], phases_marker(archetype)
    )
    actual_skin = skin or ARCHETYPES[archetype]["skin"]
    body = COMMON_JS.replace("@@PACE@@", "{{" + pace_param + "}}")
    plan = plan_for(archetype, actual_skin, data or {}, where="script")
    # 清单直接**内联进脚本**（不从别处取）：产物自足，沙箱断网也照常渲染。
    core = (
        ARCHETYPES[archetype]["core"]
        .replace("__PHASES__", phases_expr)
        .replace("__PLAN__", json.dumps(plan, ensure_ascii=False, separators=(",", ":")))
    )
    ready = "\nSandbox.ready({{ archetype: '{0}' }});\n".format(archetype)
    return head + body + core.lstrip("\n") + ready


def phases_marker(archetype: str) -> str:
    """相位数声明：字面量原型两个数一样，表达式原型给「参数取最小 / 取默认」两个数。"""
    kind = ARCHETYPES[archetype]["phases"]
    if kind[0] == "literal":
        return "/* k12:phases min={0} default={0} */".format(kind[1])
    return "/* k12:phases min={0} default={1} */".format(kind[2], kind[3])


def phases_expr(archetype: str) -> str:
    return str(ARCHETYPES[archetype]["phases"][1])


def body_html(title: str, hint: str, aria: str, chip: str) -> str:
    """页面片段：标题 + 字幕行 + 舞台落点 + 步骤条（STAGE-API §2 的四件套）。"""
    return (
        '<h1 class="anim-title">{0}</h1>\n'
        '<p class="anim-caption" id="caption">{1}</p>\n'
        '<div class="anim-canvas" role="img" aria-label="{2}"></div>\n'
        '<p class="anim-caption"><span class="chip">{3}</span></p>\n'
    ).format(title, hint, aria, chip)


TITLE_SHAPE = {
    # ★ 标题是**学生视角的钩子**：说清「看这个动画会看到什么、有什么用」，
    #   不是机制套话（旧版「跟着走一遍，一站一句」等于没说）。
    "scene": "{0}：沿途走一遍，一站一件事",
    "dialogue": "{0}：一问一答，就讲明白了",
    "contrast_kid": "{0}：左右两栏，比出差别",
    "accumulate_kid": "{0}：一件一件堆起来",
    "checklist_kid": "{0}：逐条打钩，一条条核",
    "flow": "{0}：跟着数据走一趟",
    "compare": "{0}：两条路并排看差别",
    "layers": "{0}：从底往上，一层层搭",
    "loop": "{0}：同一件事跑很多遍，每跑一遍数一次",
    "tree": "{0}：从第一个问题出发，一路问到底",
    "network": "{0}：信号一层层往前传",
    "matrix": "{0}：一格一格扫过去",
    "trace": "{0}：看着小球滑到最低点",
    "counter": "{0}：数一遍，加一次",
}

#: 相位数据构造器（每个原型一个）—— 全部只产出**整句 / 完整小句**。
PAYLOADS: dict[str, object] = {}


def payload(archetype: str):
    def register(fn):
        PAYLOADS[archetype] = fn
        return fn

    return register


def _rows(pairs: list[tuple[dict, str]]) -> list[dict]:
    out = []
    for extra, caption in pairs:
        row = dict(extra)
        row["caption"] = caption
        out.append(row)
    return out


@payload("scene")
def payload_scene(entry: dict, grade: str) -> dict:
    """场景推进：小向导沿路走过几站，站牌是**短徽标**，字幕只解说「正在发生什么」。

    ★ 文案三定律在这里最明显：盒子里不再塞课本整句。label 守 8 字（`_badge`）、
      sub 守 14 字（一个短语）、字幕写成「小向导走到第 N 站，这一站讲某件事」；
      课本那一句只在 close 里以一句总结的形式出现。
    """
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    # ★★ 站牌上**不许有空框**（2026-09-25 用户截图「动画里面有的文字是空的」）：
    #   挑中的那句若给不出可上屏的副标题（整句没有标点可切、切出来超过预算、或者整句
    #   都在打比方），旧版就写一个空串 —— 画布上出现一个**只有编号没有内容的框**。
    #   现在统一走 `_lines_with_detail`：取不到就换一句同池的，换不到才退回一句
    #   不指代任何东西的字幕（不写「这一站讲它讲的那件事」这种占位话）。
    rows = []
    for index, (_line, detail) in enumerate(
        _lines_with_detail(
            item, 4, 30, 14, [summary, name], lambda at: "第 {0} 站".format(at + 1)
        )
    ):
        label = "第 {0} 站".format(index + 1)
        rows.append(
            {
                "station": label,
                "sub": detail,
                "caption": (
                    "小向导走到第 {0} 站，这一站讲{1}".format(index + 1, detail)
                    if detail
                    else "小向导走到第 {0} 站，先停一停。".format(index + 1)
                ),
            }
        )
    return {
        "open": _open_line(
            "跟着小向导走几站，{0}就讲完了。".format(name),
            "跟着小向导走几站，一站一件事。",
        ),
        "close": "走完这几站，记住这一句：{0}".format(summary or name),
        "guide": "带路的同学",
        "rows": rows,
    }


@payload("dialogue")
def payload_dialogue(entry: dict, grade: str) -> dict:
    """一问一答：小问提问、小答给关键词，**答句走 accent 气泡**（视觉上「这句是重点」）。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    asks = _lines_matching(item, "想一想")
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    answers = _select(pool, 4, 30, [summary, name])
    frames = ["{0} 是什么".format(_head(name, 12)), "它到底在做什么", "为什么可以这样用", "哪里最容易想错"]
    rows = []
    for index in range(4):
        if index == 0:
            ask = frames[0]
        elif index == 1:
            ask = asks[0] if asks else frames[1]
        elif index == 2:
            ask = frames[2]
        else:
            ask = _question_from(pitfalls[0], frames[3]) if pitfalls else frames[3]
        ask = ask if ask.endswith("？") else ask + "？"
        answer = answers[index] if index < len(answers) else summary
        keyword = _badge(answer, 8, "要点")
        rows.append(
            {
                "ask": ask,
                "answer": _fit(answer, 32, summary),
                "keyword": keyword,
                "caption": "第 {0} 轮：小答接上「{1}」".format(index + 1, keyword),
            }
        )
    return {
        "open": _open_line(
            "{0}和{1}一问一答，把「{2}」说清楚。".format(DATA["ask_who"], DATA["answer_who"], name),
            "两个人一问一答，把它说清楚。",
        ),
        "close": "问答到这里：{0}".format(summary or name),
        "askWho": DATA["ask_who"],
        "answerWho": DATA["answer_who"],
        "rows": rows,
    }


@payload("contrast_kid")
def payload_contrast_kid(entry: dict, grade: str) -> dict:
    """左右对照：两栏中间竖一个 VS，指针在两栏间来回照，被照到的那一格 bump 高亮。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    asks = _lines_matching(item, "想一想")
    lefts = _select(pitfalls + asks, 4, 30, [summary])
    # 右栏排掉左栏已经用掉的句子（左右撞同一句 = 画布上同一段话印两遍）
    rights = _select([text for text in pool if text not in set(lefts)], 4, 32, [summary, name])
    # 两栏按**各自挑到的条数**出格（挑不满就少给几格，既不复制同一句，也不越界）
    count = min(4, len(lefts), len(rights))
    rows = []
    for index in range(count):
        left = "容易想偏"
        right = "正确说法"
        rows.append(
            {
                "left": left,
                "leftMore": _card_line(lefts[index], left, 14),
                "right": right,
                "rightMore": _card_line(rights[index], right, 14),
                "caption": "照到第 {0} 组：{1}".format(index + 1, _badge(rights[index], 10, right)),
            }
        )
    return {
        "open": _open_line(
            "把{0}的两栏并排放在一起，一组组看下来。".format(name),
            "两栏并排放在一起，一组组看下来。",
        ),
        "close": "两栏看完，留下这一句：{0}".format(summary or name),
        "leftHeader": "容易想偏的说法",
        "rightHeader": "正确的说法",
        "versus": "VS",
        "rows": rows,
    }


@payload("accumulate_kid")
def payload_accumulate_kid(entry: dict, grade: str) -> dict:
    """一件件攒：东西从上落进堆里，右侧读数「已经攒了 N 件」每落一件跳一次。

    ★ 第四轮（用户口径「同一件东西印两遍 / 一半名词一半编号」）：堆上的标签只来自
      **教材文本里的名词**，去重后按顺序分给每一层；名词凑不满就**整座塔统一用编号词**
      （绝不混用）；底部那件「底座」不再是一块有名有姓的盒子，塔直接站在地面装饰带上。
    """
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 28, [summary, name])
    # ① 从摘要与各句里收集**互不相同**的名词短句（顺序即教材顺序）。
    #   ★ 只接受**切出来的**前缀（标签严格短于原句）：「好比机器」「一层比一层难」这种
    #     短句本身不是名词，整句端出来只会让学生更糊涂，那种情况整座塔改用编号词。
    ordered: list[str] = []
    ordered.extend(_phrases(summary))
    for text in _sentences(item):
        ordered.extend(_phrases(text))
    # ① **比方链整条出局**：遇到打比方的小句后，紧跟其后的若干条一律不进池。
    #   为什么不能只按「句子含标记」过滤：类比常常跨句展开 —— 标记在「…像水果」这一句，
    #   例子词「红富士」在**下一句**（那句自己不带标记），只查标记必然漏（实测漏过）。
    pool: list[str] = []
    tainted = 0
    for phrase in ordered:
        if _has_analogy(phrase):
            tainted = 6
            continue
        if tainted > 0:
            tainted -= 1
            continue
        pool.append(phrase)
    # ★★ 只认**切出来的名词前缀**（「人工智能包含机器学习」到「人工智能」）：
    #   整句端出来只会放进「找出规律」「好比机器」这类动词短语 —— 那种情况整座塔改用编号词。
    #   （「红富士」这类纯名词整句也不收了：它多半出自比方链，宁可退回编号词。）
    names: list[str] = []
    for phrase in pool:
        value = _drop_heading(phrase)
        candidate = (_label_head(value, 6) or "").strip("。！？!? ，,")
        if not candidate or len(candidate) > 6 or not _noun_ok(candidate):
            continue
        if len(candidate) < len(value) and not (set(candidate) & SPLIT_BAN):
            if candidate not in names:
                names.append(candidate)
    # ② 名词够三层以上 → **有几层名词就搭几层**（层数与名词数对齐，绝不混用）；
    #   名词不够三层 → 整座塔统一用编号词（纪律：要么全名词、要么全编号）。
    use_names = len(names) >= 3
    if use_names:
        lines = lines[: len(names)]
    rows = []
    for index, text in enumerate(lines):
        label = names[index] if use_names else "第 {0} 件".format(index + 1)
        rows.append(
            {
                "label": label,
                "text": "",
                "caption": "第 {0} 件放进去：{1}".format(index + 1, _fit(text, 16, label)),
            }
        )
    return {
        "open": _open_line(
            "{0}是一点点攒出来的。".format(name),
            "这件事是一点一点攒出来的。",
        ),
        "close": "攒到这里：{0}".format(summary or name),
        "unit": "件",
        "rows": rows,
    }


@payload("checklist_kid")
def payload_checklist_kid(entry: dict, grade: str) -> dict:
    """逐条打钩：条目一条条亮起来，钩子（一段弧线）跟着画出来，核对过的条目淡下去。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    rows = []
    for index, (_text, detail) in enumerate(
        _lines_with_detail(
            item, 4, 30, 14, [summary, name], lambda at: "第 {0} 条".format(at + 1)
        )
    ):
        label = "第 {0} 条".format(index + 1)
        rows.append(
            {
                "title": label,
                "detail": detail,
                "caption": "核对第 {0} 条，给它打钩：{1}".format(index + 1, detail or label),
            }
        )
    return {
        "open": _open_line(
            "{0}有几条，一条条对着核对。".format(name),
            "这里有几条，一条条对着核对。",
        ),
        "close": "这几条都对一遍，就能记住：{0}".format(summary or name),
        "tick": "对",
        "rows": rows,
    }


@payload("flow")
def payload_flow(entry: dict, grade: str) -> dict:
    """数据流：一个圆点沿管道从站到站滑行，穿过的站点亮、前方站半透明。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    rows = []
    for index, (_text, detail) in enumerate(
        _lines_with_detail(
            item, 4, 30, 14, [summary, name], lambda at: "第 {0} 段".format(at + 1)
        )
    ):
        label = "第 {0} 段".format(index + 1)
        rows.append(
            {
                "stage": label,
                "detail": detail,
                "caption": "数据流到第 {0} 段：{1}".format(index + 1, detail or label),
            }
        )
    return {
        "open": _open_line(
            "{0}是一条管道，数据从左边进去。".format(name),
            "一条管道，数据从左边进去。",
        ),
        "close": "走完这条管道：{0}".format(summary or name),
        "packet": "数据",
        "rows": rows,
    }


@payload("compare")
def payload_compare(entry: dict, grade: str) -> dict:
    """两条泳道：两个小标记同步往下推进，遇到不一样的那一行，格子闪一下。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    # ★ 4 行而不是 3 行：``pairs`` 参数（3~4）要真的能改变行数，
    #   否则那个参数在界面上是摆设（学生调了没反应 = 假参数）。
    lefts = _select(pitfalls, 4, 26, [summary])
    # 右栏排掉左栏已经用掉的句子（两边撞同一句会印两遍）
    rights = _select(
        [text for text in _sentences(item) if text not in set(lefts)], 4, 26, [summary, name]
    )
    # ★★ 两栏**按各自能挑到的条数**出格（左栏只挑到 1 句时不再给后几格塞占位名）。
    count = min(4, len(lefts), len(rights))
    rows = []
    for index in range(count):
        left = "走法一"
        right = "走法二"
        rows.append(
            {
                "left": left,
                "right": right,
                "caption": "比到第 {0} 行：{1}".format(index + 1, _badge(rights[index], 10, "这一行不一样")),
            }
        )
    return {
        "open": _open_line(
            "{0}有两条路线，并排着看差别。".format(name),
            "两条路线并排放在一起看差别。",
        ),
        "close": "两边对照完，记住：{0}".format(summary or name),
        "leftHeader": "一条路线",
        "rightHeader": "另一条路线",
        "rows": rows,
    }


@payload("layers")
def payload_layers(entry: dict, grade: str) -> dict:
    """一层层垒：积木自下而上落下，当前层 bump、已就位层 dim，读数报「第 N 层」。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    rows = []
    for index, (_text, detail) in enumerate(
        _lines_with_detail(
            item, 4, 30, 14, [summary, name], lambda at: "第 {0} 层".format(at + 1)
        )
    ):
        label = "第 {0} 层".format(index + 1)
        rows.append(
            {
                "layer": label,
                "detail": detail,
                "caption": "第 {0} 层垒上去：{1}".format(index + 1, detail or label),
            }
        )
    return {
        "open": _open_line(
            "{0}是一层层搭起来的。".format(name),
            "它是一层层搭起来的，先看最底下那层。",
        ),
        "close": "整座塔立起来了：{0}".format(summary or name),
        "hold": "每一层都站在下面那层的肩膀上，抽掉任何一层，上面的都不成立。",
        "base": "底面",
        "rows": rows,
    }


@payload("loop")
def payload_loop(entry: dict, grade: str) -> dict:
    """环形跑道：小人绕圈跑，每绕一圈计数器加一，跑到第 N 圈回来说「每圈都一样」。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    # 站点盒只有 110px 宽（每行约 4 字），预算给 8 并兜底角色名：收不进去就退回整句让
    # 基元折行（跑道几何已按「最高那一种盒子」留过空间），但不给占位名。
    rows = [
        {"stop": "第 {0} 站".format(index + 1)}
        for index in range(max(4, len(lines)))
    ]
    return {
        "open": _open_line(
            "{0}会把同一件事反复做很多遍。".format(name),
            "同一件事反复做，每做一遍数一次。",
        ),
        "close": "跑完这么多圈，记住这一句：{0}".format(summary or name),
        "summary": summary or name,
        "loopHead": "每一次重复",
        "rows": rows,
    }


@payload("tree")
def payload_tree(entry: dict, grade: str) -> dict:
    """判定树：从根出发，每个问题两条路，走过的路径亮起来，末端叶子亮出结论。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    asks = _select(pool, 4, 26, [summary, name])
    # ★★ 出口的候选池**排掉左边已经用掉的那些句子**（否则画布上两块板子印着同一句）。
    exits = _select([text for text in (pitfalls + pool[::-1]) if text not in set(asks)], 4, 22, [summary])
    # 行数收到 3 + 根节点：三个条件对「逐条判断」已经够讲清楚，每行给真正的文字。
    count = min(3, len(asks), len(exits))
    rows = []
    for index in range(count):
        ask = _badge(asks[index], 6, "第 {0} 个条件".format(index + 1))
        rows.append(
            {
                "ask": ask,
                "pass": _badge(exits[index], 6, "第 {0} 条出口".format(index + 1)),
                "caption": "问第 {0} 个问题：{1}".format(index + 1, _fit(asks[index], 16, ask)),
            }
        )
    return {
        "open": _open_line(
            "把{0}想成一棵树，一路问下去。".format(name),
            "把它想成一棵树，一路问下去。",
        ),
        "close": "顺着走到底就是：{0}".format(summary or name),
        "root": _phrase(name, 12) or _head(name, 12),
        "yes": "是，继续往下",
        "no": "否，走另一条",
        "flags": [True, False, True, False],
        "rows": rows,
    }


@payload("network")
def payload_network(entry: dict, grade: str) -> dict:
    """分层网络：信号沿连线一层层往前传，当前层的单元依次 bump，读数跟着变。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    # 八个格子要八句**互不相同**的话（输入 3 + 隐层 3 + 输出 2）
    picked = _select(pool, 8, 24, [summary, name])

    def pick_at(index: int, role: str) -> str:
        """盒子只用**角色名**（输入一 / 单元一 / 结果一）：内容那一句在 caption 里讲。

        ★ 实测缺陷：拿教材句当盒子标签，切到 8 字就成了「易错点，如果检索材料质量差」这类碎片。
          盒子上是机制词、字幕里是内容，学生才既知道「这是第几个」又知道「它在做什么」。
        """
        return role

    return {
        "open": _open_line(
            "{0}的输入先变成数字，再一层层算下去。".format(name),
            "输入变成数，再一层层算下去。",
        ),
        "close": "算到最后：{0}".format(summary or name),
        "inputs": [
            {"label": pick_at(0, "输入一"), "value": 1.0},
            {"label": pick_at(1, "输入二"), "value": 0.6},
            {"label": pick_at(2, "输入三"), "value": 0.25},
        ],
        "hidden": [
            {"label": pick_at(3, "单元一")},
            {"label": pick_at(4, "单元二")},
            {"label": pick_at(5, "单元三")},
        ],
        "outputs": [
            {"label": pick_at(6, "结果一")},
            {"label": pick_at(7, "结果二")},
        ],
        "wiresIn": "每根线的粗细就是权重的大小",
        "wiresOut": "第二层的权重有正有负",
        "weights": {
            "ih": [[0.8, -0.4, 0.25], [0.5, 0.6, -0.3], [-0.2, 0.7, 0.45]],
            "ho": [[0.7, -0.5], [0.45, 0.6], [-0.35, 0.3]],
        },
        "rows": [{"caption": text} for text in picked],
    }


#: ``matrix`` 的网格尺寸（算法可复现，所以**生成时就填进 DATA**：
#: 运行时不再自己造数 —— 「最亮的一格」在规划期就定下来，格子大小与内容永远一致）。
#: ★ 行数从 4 收到 3：多出来的竖直空间留给「现在扫到第几格」的读数（见 plan_matrix）。
MATRIX_COLS = 6
MATRIX_ROWS = 3


def matrix_cell(row: int, col: int) -> float:
    """格子的值（与旧版运行时同一条曲线：sin 造的平滑面，最亮的那格是真的最大值）。"""
    return round((math.sin(row * 1.3 + col * 0.8) + 1) / 2 * 0.82 + 0.18, 2)


@payload("matrix")
def payload_matrix(entry: dict, grade: str) -> dict:
    """扫描网格：一格一格亮起来，当前格 --focus，读数报「现在扫到第 R 行第 C 列」。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    values = [[matrix_cell(r, c) for c in range(MATRIX_COLS)] for r in range(MATRIX_ROWS)]
    best = {"r": 0, "c": 0, "v": -1.0}
    for r in range(MATRIX_ROWS):
        for c in range(MATRIX_COLS):
            if values[r][c] > best["v"]:
                best = {"r": r, "c": c, "v": values[r][c]}
    rows = [
        {
            "row": "第 {0} 行".format(index + 1),
            "caption": "扫过第 {0} 行，一格格亮起来".format(index + 1),
        }
        for index in range(MATRIX_ROWS)
    ]
    for index, text in enumerate(lines[:MATRIX_ROWS]):
        rows[index]["detail"] = _badge(text, 8, rows[index]["row"])
    return {
        "open": _open_line(
            "{0}可以摆成一张表，一格一个数。".format(name),
            "可以摆成一张表，一格一个数。",
        ),
        "close": "整张表扫完：{0}".format(summary or name),
        "brightest": "最亮的一格",
        "scanLabel": "现在扫到",
        "values": values,
        "best": best,
        "rows": rows,
    }


@payload("trace")
def payload_trace(entry: dict, grade: str) -> dict:
    """找最低点：小球带尾迹沿曲线一段段下滑，最低点插一面小旗，读数每步都变。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 34, [summary, name])
    rows = [
        {"caption": "第 {0} 步：往低处挪一点，读数变小".format(index + 1)}
        for index in range(max(4, len(lines)))
    ]
    return {
        "open": _open_line(
            "{0}是一条曲线，小球沿着它滑向最低点。".format(name),
            "画成一条曲线，看小球怎么滑向最低点。",
        ),
        "close": "滑到最低点附近，记住这一句：{0}".format(summary or name),
        "summary": summary or name,
        "xLabel": "参数取值",
        "yLabel": "要压小的数",
        "start": 0.4,
        "target": 3.0,
        "curve": 0.5,
        "floor": 0.4,
        "flag": "最低点",
        "stopLine": "滑到最低点就停，这就是在找最小值",
        "rows": rows,
    }


@payload("counter")
def payload_counter(entry: dict, grade: str) -> dict:
    """计数装置：一件件数下去，格子逐格填满，读数「已经数到 N 次 / 合计 M」。"""
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 6, 30, [summary, name])
    rows = [
        {
            "event": _fit(text, 30, summary),
            "label": "第 {0} 件".format(index + 1),
            "caption": "第 {0} 次：数一件，加一次".format(index + 1),
        }
        for index, text in enumerate(lines)
    ]
    return {
        "open": _open_line(
            "{0}要一次一次地数下去。".format(name),
            "一次一次地数，数到最后才知道总数。",
        ),
        "close": "数完了：{0}".format(summary or name),
        "totalLabel": "字数合计",
        "unit": "字",
        "rows": rows,
    }


# 十四原型正文（__DATA__ / __PHASES__ / 参数占位符在此留空）
# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# 十四原型的**布局规划**（Python 侧）
#
# ★★ 为什么布局在 Python 而不是在 JS 里算（这是本次重写的骨架）：
#   · 生成时就能用**真几何**验一遍（盒子重叠 / 出舞台 / 标签等于副标题 / 人物压盒子 /
#     人物不站在他那条线上），不合格的模板当场不许写盘 —— 不用开浏览器；
#   · CI 上的守卫读的就是同一份清单（`var PLAN = {...}` 在脚本里），静态、确定、快；
#   · 模板 JS 只剩「动什么、什么顺序」，位置一个字都不再手算 ——
#     旧写法 `GAP = (668 - 150 * COUNT) / (COUNT + 1)` 那种手算式是重叠的直接来源。
#
# 每个 planner 返回一个 Planner；调用方 `.plan()` 取清单。
# 纵向定位**只有** `band()`：带高 = 带内内容真正用掉的高度，后一条带排在前一条下方。
# --------------------------------------------------------------------------- #

#: 横带内默认行距。
ROW_GAP = 14.0
#: 带间距的上限：把富余高度分给带间距时，单条最多长到这么多（再大就成了一道空谷）。
MAX_BAND_GAP = 42.0
#: 「右上角读数带」的宽度（所有原型共用：读数永远在同一块地方，主内容行因此吃满整行宽）。
CORNER_WIDTH = 236.0


def corner(planner: "Planner", items: list[dict], width: float = CORNER_WIDTH, gap: float = 12.0) -> "Band":
    """右上角**读数带**：一组读数靠右排一行，下面的主内容行于是可以用整行宽度。

    ★ 第二版新增（用户口径：读数与主内容争宽、读数散落在各处）：读数是「仪表」，
      位置固定学生才找得到；它不该插在内容行中间把一行切成两半。
    """
    band = planner.band("corner", gap=gap)
    count = max(1, len(items))
    each = (width - gap * (count - 1)) / count
    band.row([dict(item, w=round(each, 2)) for item in items], x=SAFE_RIGHT - width, w=width)
    return band


#: 人物默认缩放（角色画出来约 96 个单位高，0.85 倍在 420 高的舞台上比例合适）。
ACTOR_SCALE = 0.85


def _cell_ids(rows: list[dict], prefix: str, fields: tuple[str, str]) -> list[dict]:
    """把一批行数据铺成 row() 要的 items，并给每格一个稳定 id（守卫与动画都按它取件）。

    ★★ ``fields`` 是**源数据**里的字段名（如 ``("station", "sub")``），必须映射到布局契约认的
      ``label`` / ``sub`` 两个键上。旧写法是把源字段名**原样拷进去** ——
      布局那层只认 ``label``/``sub``，于是 ``station``、``stage``、``detail`` 全被静默丢掉：
      表现是**盒子里空着**（整格无字）或只剩半句，而且不报错。
      字段名不同就该映射，不能让「名字对不上」变成静默丢内容。
    """
    label_field, sub_field = fields
    items = []
    for index, row in enumerate(rows):
        item: dict = {"id": "{0}-{1}".format(prefix, index)}
        label = row.get(label_field)
        sub = row.get(sub_field)
        if label:
            item["label"] = label
        if sub:
            item["sub"] = sub
        items.append(item)
    return items


def _fit_actor_scale(used: float, gap_total: float, want: float = ACTOR_SCALE) -> float:
    """算出小人能用多大：把「剩下的高度」全给它，但不放大（``want`` 是上限）。

    ★★ 实测缺陷：``road`` 带原先写死 ``(96+30)*ACTOR_SCALE`` = 107.1px。站牌那一条带
      在窄格子里会长到 148.6px（4 站 × 154px，标签折两行 + 副标题两行），
      于是「34 + 148.6 + 12 + 107.1 + 12 + 94.9 = 408.6 > 390」——读数被顶出安全区。
      根因是**各带的高度彼此不知道**：每一条都按自己的需要要高度，加起来才超。
      所以让最软的那一段（小人与它脚下的路）吃掉剩余空间：内容一个字不少，
      学生的观感只是「这次的小人小一点」。
    """
    full = (96 + 30) * want
    left = (SAFE_BOTTOM - SAFE_TOP) - used - gap_total
    if left >= full:
        return want
    return max(0.55, want * (left / full))


def plan_scene(skin: str, data: dict) -> Planner:
    """「一行 N 站 + 小人沿路走过去」—— 站牌统一加高、小人脚下有一条路，读数靠右上角。

    ★ 第二版重排（截图「3 张站点卡挤在左上 1/3，右半 canvas 全空」）：站牌统一高度、
      走满整行宽（`stops.row` 用整行），读数搬去右上角，剩下的高度由带间距平分。
    """
    rows = data["rows"]
    planner = Planner(skin)
    top = corner(planner, [{"id": "meter", "kind": "readout", "label": "走到第", "value": 0, "unit": "站"}])
    stops = planner.band("stops", gap=14.0)
    items = _cell_ids(rows[:4], "stop", ("station", "sub"))
    for item in items:
        item["tone"] = "muted"
    # ★ 站牌给一个**统一的最小高度**（118）：四张卡片立起来，一行就是画布的一条主带，
    #   而不是挤在顶部的一排小盒子。文字比它矮，节点只会把字居中，不会长高。
    stops.row(items, h=118.0)
    stops.spread("stop-", "stations", 3, 4)
    # 读数带先建（它高度固定），才能把剩下的空间算给小人与路 —— 见 _fit_actor_scale
    scale = _fit_actor_scale(top.bottom + stops.bottom, gap_total=14.0 * 2)
    road = planner.band("road", height=(96 + 30) * scale, gap=14.0)
    road.planner.rail("road", [36, 96 * scale], [684, 96 * scale], band="road")
    planner.actor(
        "guide",
        stops.x + 76,
        96 * scale,
        pose="walk",
        scale=scale,
        label=data.get("guide", ""),
        band="road",
        on_rail="road",
    )
    return planner


def plan_dialogue(skin: str, data: dict) -> Planner:
    """「两个人一问一答」—— 气泡走满整行、人物脚下有一条**站台线**，读数靠右上角。

    ★ 第二版重排（截图「小问小答浮在半空中，脚下没有任何地面线」）：floor 带里加一条
      `pipe` 站台线，两个人物都声明 `on_rail` —— 规矩是「没有地面线的人物不放」。
    """
    rows = data["rows"]
    planner = Planner(skin)
    corner(planner, [{"id": "round-meter", "kind": "readout", "label": "问答", "value": 0, "unit": "轮"}])
    qa = planner.band("qa", gap=14.0)
    asks = [{"text": row["ask"], "who": "narrator", "tail": "left"} for row in rows[:4]]
    answers = [{"text": row["answer"], "who": "accent", "tail": "right"} for row in rows[:4]]
    qa.row(
        [
            {"id": "ask", "kind": "bubble", "alts": asks},
            {"id": "answer", "kind": "bubble", "alts": answers},
        ],
        gap=40.0,
    )
    qa.spread("ask-", "rounds", 3, 4)
    feet = 96 * 0.92
    floor = planner.band("floor", height=feet + 30.0, gap=14.0)
    floor.planner.rail("floor-line", [40, feet], [680, feet], band="floor", style="pipe")
    planner.actor(
        "asker", 150, feet, pose="point", scale=0.92, label=data.get("askWho", ""), band="floor", on_rail="floor-line"
    )
    planner.actor(
        "answerer", 570, feet, pose="stand", scale=0.92, label=data.get("answerWho", ""), band="floor", on_rail="floor-line"
    )
    return planner


def plan_contrast_kid(skin: str, data: dict) -> Planner:
    """「两边比一比」—— 表头 + 两栏卡片（统一加高）、读数靠右上角，中间留出 VS 的位置。"""
    rows = data["rows"]
    planner = Planner(skin)
    corner(planner, [{"id": "pair-meter", "kind": "readout", "label": "对照到第", "value": 0, "unit": "组"}])
    heads = planner.band("heads", height=64.0, gap=14.0)
    heads.row(
        [
            {"id": "head-left", "label": data["leftHeader"], "tone": "muted"},
            {"id": "head-right", "label": data["rightHeader"], "tone": "accent"},
        ]
    )
    pairs = planner.band("pairs", gap=14.0)
    left = []
    right = []
    for index, row in enumerate(rows[:4]):
        left.append({"label": row["left"], "sub": row.get("leftMore"), "tone": "muted"})
        right.append({"label": row["right"], "sub": row.get("rightMore"), "tone": "accent"})
    # 卡片统一加高（112）：两栏是一屏的主角，不该是两条薄片。
    pairs.row([{"id": "left", "alts": left}, {"id": "right", "alts": right}], gap=56.0, h=112.0)
    pairs.spread("left-", "pairs", 3, 4)
    return planner


def plan_accumulate_kid(skin: str, data: dict) -> Planner:
    """「一点点攒起来」—— 左边一块块往上摞，右边一块「记分牌」。"""
    rows = data["rows"]
    planner = Planner(skin)
    tower = planner.band("tower", height=356.0, gap=12.0)
    blocks = [
        {"id": "block-{0}".format(index), "label": row["label"], "tone": "base"}
        for index, row in enumerate(rows[:4])
    ]
    # ★ 第四轮：**不再有「底座」那块盒子** —— 它原先是另一块带名字的板子，会和最底下那层
    #   印出同一个名词（截图里「人工智能堆在人工智能上面」）。塔直接站在地面装饰带上。
    # ★ gap=21：四层撑开成 309 高，**塔顶留 47 的内边距**（末相位也不贴住舞台顶框）。
    tower.stack(blocks, anchor="bottom", gap=21.0, w=440.0)
    tower.spread("block-", "items", 3, 4)
    tower.place(
        "meter", kind="readout", w=180, align="right", valign="top", y=8.0, label="已经攒了", value=0, unit=data.get("unit", "")
    )
    return planner


def plan_checklist_kid(skin: str, data: dict) -> Planner:
    """「一条条对着核」—— 左边一列待核条目（每条带一个勾格），右上角记分。"""
    rows = data["rows"]
    planner = Planner(skin)
    board = planner.band("board", height=356.0, gap=12.0)
    tick_w = 58.0
    list_w = 470.0
    lines = []
    for index, row in enumerate(rows[:4]):
        # ★ 条目只写 title 短标签：detail 那一句进 caption 与悬停全文。
        #   四行各带一句副标题要 343px，加上行距就顶穿安全区（步骤条会把最后一行吃掉）。
        lines.append(
            [
                {"id": "item-{0}".format(index), "label": row["title"]},
                {"id": "tick-{0}".format(index), "label": data.get("tick", ""), "tone": "accent", "w": tick_w},
            ]
        )
    board.rows(lines, gap=12.0, spread=True, w=list_w)
    board.spread("item-", "checks", 3, 4)
    board.place(
        "meter", kind="readout", w=150, align="right", valign="top", label="已经核对", value=0, unit="条"
    )
    return planner


def plan_flow(skin: str, data: dict) -> Planner:
    """「数据一段段流过去」—— 站卡走满整行 + **底部一条主管道**（数据包在管道上滑）+ 角读数。

    ★ 第二版重排（截图「管道贴在画布上 1/3，下半 40% 全空，数据节点孤零零浮在上方」）：
      去掉那个孤立的「数据」节点（数据就是管道上滑行的那个圆点），站卡统一加高立起来，
      另外在底部画一条真正的**主管道**（`pipeline`）—— 内容分三条带占满整屏。
    """
    rows = data["rows"]
    planner = Planner(skin)
    corner(planner, [{"id": "flow-meter", "kind": "readout", "label": "流经", "value": 0, "unit": "段"}])
    pipes = planner.band("pipes", gap=14.0)
    items = _cell_ids(rows[:4], "stage", ("stage", "detail"))
    items[0]["tone"] = "accent"
    # 站卡统一加高（132）：一行四张立起来的卡，是这条管道上的四个工位。
    pipes.row(items, gap=44.0, h=132.0)
    pipes.spread("stage-", "stages", 3, 4)
    for index in range(1, 4):
        if index < len(items):
            pipes.planner.rail(
                "pipe-{0}".format(index),
                "stage-{0}".format(index - 1),
                "stage-{0}".format(index),
                band="pipes",
                style="pipe",
                directed=True,
            )
    spine = planner.band("spine", height=52.0, gap=14.0)
    spine.planner.rail("pipeline", [40, 26], [680, 26], band="spine", style="pipe", directed=True)
    return planner


def plan_compare(skin: str, data: dict) -> Planner:
    """「两条路线并排」—— 两个表头 + 四行卡片（拉高铺满）+ 右上角读数。

    ★ 第二版重排（实测这一版原来空着 45% 的高度）：四行卡片统一**拉高到 62**、行距平摊，
      读数搬去右上角；两条泳道（纵向虚线 + 游标）由模板脚本按行的真实坐标画出来。
    """
    rows = data["rows"]
    planner = Planner(skin)
    corner(planner, [{"id": "pair-meter", "kind": "readout", "label": "比到第", "value": 0, "unit": "行"}])
    heads = planner.band("heads", height=56.0, gap=14.0)
    heads.row(
        [
            {"id": "head-left", "label": data["leftHeader"], "tone": "muted"},
            {"id": "head-right", "label": data["rightHeader"], "tone": "accent"},
        ]
    )
    bars = planner.band("bars", gap=14.0)
    lines = [
        [
            {"id": "left-{0}".format(index), "label": row["left"], "tone": "muted"},
            {"id": "right-{0}".format(index), "label": row["right"], "tone": "base"},
        ]
        for index, row in enumerate(rows[:4])
    ]
    bars.rows(lines, gap=14.0, h=62.0, spread=True)
    bars.spread("left-", "pairs", 3, 4)
    return planner


def plan_layers(skin: str, data: dict) -> Planner:
    """「一层层搭起来」—— 自下而上、逐层收窄的塔，右上角读数「已经搭到 N 层」。

    ★★ 第六轮两处实测缺陷与修法：

    ① **高度必须按「该层自己的宽度」算**（金字塔上窄下宽）：`Band.stack` 本来就是按层宽量的
       （`widths[index]` 进 `node_needed`），但刻度没跟 skins.css 时它会整体偏低 ——
       于是运行时把下层盒子排高一点就压住邻居（实测两层重叠 375×12px，Python 侧一句没拦）。
       这里再按层宽**显式算一遍总高**，构造上不允许重叠（`assert_clean` 只作最后一道）。
    ② **整座塔必须落在安全区里**（底边留 ≥8px）：按可用高度挑配置 —— 先试「4 层带副标题」，
       放不下就去掉副标题，仍放不下就减到 3 层；层高由真实文字推出来，不写死。
    ③ 读数标签给**完整词**（「已经搭到」），与「0 / 层」连起来是一句完整的话。
    """
    rows = data["rows"]
    planner = Planner(skin)
    width, inset, gap = 470.0, 30.0, 10.0
    room = (SAFE_BOTTOM - 8.0) - SAFE_TOP

    def stack_height(layers: list[dict]) -> float:
        """这一组层真正要多高（每层按**自己的宽度**量）。"""
        total = 0.0
        for index, layer in enumerate(layers):
            layer_width = max(48.0, width - inset * 2 * index)
            total += max(
                40.0,
                node_needed(str(layer.get("label") or ""), str(layer.get("sub") or ""), layer_width, skin),
            )
        return total + gap * max(0, len(layers) - 1)

    full = [
        {"id": "slab-{0}".format(index), "label": row["layer"], "sub": row.get("detail"), "tone": "muted" if index == 0 else "base"}
        for index, row in enumerate(rows[:4])
    ]
    bare = [dict(item, sub="") for item in full]
    slabs = full
    if stack_height(full) > room:
        slabs = bare if stack_height(bare) <= room else bare[:3]
    # 带高 = 整个安全区（留 8px 底边距）：塔锚在底部，像立在台面上（内容另有上限 room）。
    tower = planner.band("tower", height=room, gap=12.0)
    tower.stack(slabs, anchor="bottom", inset=inset, gap=gap, w=width)
    tower.spread("slab-", "layers", 3, 4)
    tower.place(
        "level-meter", kind="readout", w=170, align="right", valign="top", y=8.0,
        label="已经搭到", value=0, unit="层",
    )
    return planner


def plan_loop(skin: str, data: dict) -> Planner:
    """「同一段反复跑」—— 跑道 + 沿线跑的点 + 右侧两个计数。"""
    rows = data["rows"]
    planner = Planner(skin)
    ring = planner.band("ring", height=356.0, gap=12.0)
    cx, rx = 282.0, 80.0
    node_w, node_h = 110.0, 48.0
    gap_out = 24.0
    # ★★ 实测踩到：站点盒子只有 110px 宽（每行约 4 字），真实短句会折成 3 行 ≈ 114px 高。
    #   原来 cy=176 / ry=78 是按「1 行标签」定的 —— 换成真内容之后，最下面那个站点
    #   被顶出安全区（306+114 = 420 > 390，生成器的自检当场拦下）。
    #   所以这里**先量出最费的那个站点要多高**，再把椭圆压扁、整体居中，
    #   让「最高的那一种盒子」上下都放得下。压扁不影响「转一圈」的意思。
    box_h = max(node_h, max(node_needed(row["stop"], "", node_w, skin) for row in rows))
    # 上站：cy - ry - gap_out - box_h ≥ SAFE_TOP；下站：cy + ry + gap_out + box_h ≤ SAFE_BOTTOM
    span = (SAFE_BOTTOM - SAFE_TOP) - 2 * gap_out - 2 * box_h
    ry = max(22.0, min(78.0, span / 2 - 6.0))
    # ★★ 坐标系是**带内相对**的：`finish()` 会把整条带的内容按带偏移再平移一次
    #   （见 Planner.finish 里给每个 cell 的 y 加 top）。
    #   所以这里必须以 0 为基线算垂直位置 —— 直接用 SAFE_TOP/SAFE_BOTTOM 会**重复计入**
    #   上边距，三条带叠下来正好把最下面那个站点顶出安全区（实测 418 > 390）。
    #   兜底：若带高够不着（内容太高），把椭圆再压扁一档，让上下两站都落在带里。
    band_h = SAFE_BOTTOM - SAFE_TOP
    if 2 * box_h + 2 * gap_out + 2 * ry > band_h:
        ry = max(18.0, (band_h - 2 * box_h - 2 * gap_out) / 2)
    cy = band_h / 2
    ring.planner.plot("track", "ring", cx - rx - 13, cy - ry - 13, (rx + 13) * 2, (ry + 13) * 2)
    ring.planner.plots[-1]["rx"] = rx
    ring.planner.plots[-1]["ry"] = ry
    ring.planner.plots[-1]["cx"] = cx
    ring.planner.plots[-1]["cy"] = cy
    ring.planner.plots[-1]["kind"] = "ellipse"
    stops = [
        {"id": "stop-0", "x": cx - node_w / 2, "y": cy - ry - gap_out - box_h, "w": node_w, "h": box_h, "label": rows[0]["stop"], "tone": "muted"},
        {"id": "stop-1", "x": cx + rx + gap_out, "y": cy - box_h / 2, "w": node_w, "h": box_h, "label": rows[1]["stop"] if len(rows) > 1 else "", "tone": "muted"},
        {"id": "stop-2", "x": cx - node_w / 2, "y": cy + ry + gap_out, "w": node_w, "h": box_h, "label": rows[2]["stop"] if len(rows) > 2 else "", "tone": "muted"},
        {"id": "stop-3", "x": cx - rx - gap_out - node_w, "y": cy - box_h / 2, "w": node_w, "h": box_h, "label": rows[3]["stop"] if len(rows) > 3 else "", "tone": "muted"},
    ]
    for stop in stops:
        ring.planner.cells.append(
            {
                "id": stop["id"],
                "band": "ring",
                "kind": "node",
                "x": round(stop["x"], 2),
                "y": round(stop["y"], 2),
                "w": stop["w"],
                "h": max(node_h, node_needed(stop["label"], "", node_w, skin)),
                "label": stop["label"],
                "tone": stop["tone"],
            }
        )
        ring.bottom = max(ring.bottom, stop["y"] + stop["h"])
    ring.place("round-meter", kind="readout", w=170, align="right", y=60.0, label="已经转了", value=0, unit="圈")
    ring.place("total-meter", kind="readout", w=170, align="right", y=180.0, label="累计次数", value=0, unit="次")
    return planner


def plan_tree(skin: str, data: dict) -> Planner:
    """「逐条判断，走到结论」—— 左边一条判定链，右边每条对应的出口。"""
    rows = data["rows"]
    planner = Planner(skin)
    chain = planner.band("chain", height=356.0, gap=12.0)
    # ★ 判定链 + 出口都是**短标签**（正文那一句在 caption 与悬停全文里）：
    #   5 行各带一句副标题需要 400+，会顶穿安全区（步骤条把最后一行吃掉）。
    #   右侧留出一列给「已判定几层」的读数 —— 那一列不参与行的宽度分配，也就不会重叠。
    chain_w = chain.w - 150.0
    lines = [[{"id": "root", "label": data["root"], "tone": "accent"}, {"id": "root-pad", "kind": "blank"}]]
    for index, row in enumerate(rows[:3]):
        lines.append(
            [
                {"id": "ask-{0}".format(index), "label": row["ask"]},
                {"id": "exit-{0}".format(index), "label": row["pass"], "tone": "muted"},
            ]
        )
    # ★ 行高**不写死**：交给布局按最费的那一行算（真实标签比占位名长，写死 58 会顶穿安全区）。
    #   行数已收到 3 + 根节点 = 4 行，高度自然落在安全区里。
    chain.rows(lines, gap=10.0, h=60.0, spread=True)
    chain.spread("ask-", "rounds", 2, 3)
    for index in range(3):
        chain.planner.rail(
            "step-{0}".format(index),
            "root" if index == 0 else "ask-{0}".format(index - 1),
            "ask-{0}".format(index),
            band="chain",
            directed=True,
        )
        chain.planner.rail(
            "branch-{0}".format(index),
            "ask-{0}".format(index),
            "exit-{0}".format(index),
            band="chain",
            style="dashed",
            directed=True,
        )
    chain.place("depth", kind="readout", w=136, align="right", y=0.0, label="已经判定", value=0, unit="层")
    return planner


def _column(
    planner: Planner,
    band: Band,
    ids: list[str],
    labels: list[str],
    subs: list[str],
    x: float,
    w: float,
    tone: str,
    top: float = 0.0,
    gap: float = 8.0,
) -> list[dict]:
    """在带里竖着摆一列盒子：位置由**量出来的高度**推出来（不是写死的行距）。

    ★ 这是「不重叠」在列方向上的做法：先问 ``node_needed`` 每个盒子要多高，
      再一个接一个往下摞 —— 写死行距（``y: 86 + i * 78``）一旦某个标签折行，
      盒子就会长高并把下一个压住（实测踩到：网络图把两个输入盒子叠在了一起）。
    """
    cells: list[dict] = []
    line = top
    for index, cid in enumerate(ids):
        label = labels[index] if index < len(labels) else ""
        sub = subs[index] if index < len(subs) else ""
        height = max(46.0, node_needed(label, sub, w, planner.skin))
        cells.append(
            band._cell(  # noqa: SLF001 —— 规划器内部工具，直接用带自己的记账
                id=cid,
                kind="node",
                x=round(x, 2),
                y=round(line, 2),
                w=round(w, 2),
                h=round(height, 2),
                label=label,
                sub=sub,
                tone=tone,
            )
        )
        line += height + gap
    return cells


def plan_network(skin: str, data: dict) -> Planner:
    """「信号一层层算下去」—— 输入 / 隐层 / 输出三列 + 带权重的连线 + 三个读数。

    ★ 三列的纵向位置都由 ``_column()`` 按量出来的高度推 —— 不写死行距：
      标签一折行，写死的行距就会让上下两个盒子叠在一起（实测踩到过）。
    """
    planner = Planner(skin)
    # 三个读数先建：**右上角角带**（它们原来挤在左 2/3，网络图被压成一条窄带）。
    top = corner(
        planner,
        [
            {"id": "in-meter", "kind": "readout", "label": "输入", "value": "", "unit": ""},
            {"id": "hidden-meter", "kind": "readout", "label": "隐层算出来", "value": 0, "unit": ""},
            {"id": "out-meter", "kind": "readout", "label": "输出", "value": 0, "unit": ""},
        ],
        width=360.0,
    )
    net = planner.band("net", height=196.0, gap=14.0)
    col_w = 168.0
    col_gap = 24.0
    col_x = [34.0, 34.0 + col_w + col_gap, 34.0 + (col_w + col_gap) * 2]
    inputs = [item["label"] for item in data["inputs"]]
    hidden = [item["label"] for item in data["hidden"][:3]]
    outputs = [item["label"] for item in data["outputs"][:2]]
    in_subs = ["{0}".format(item["value"]) for item in data["inputs"]]
    # 三列各自居中（列内盒子总数不同，居中之后视觉重心齐平）
    def _column_height(labels: list[str], subs: list[str], w: float) -> float:
        total = 0.0
        for index, label in enumerate(labels):
            total += max(46.0, node_needed(label, subs[index] if index < len(subs) else "", w, skin)) + 8.0
        return max(0.0, total - 8.0)

    heights = [
        _column_height(inputs, in_subs, col_w),
        _column_height(hidden, [""] * len(hidden), col_w),
        _column_height(outputs, [""] * len(outputs), col_w),
    ]
    tallest = max(heights)
    _column(planner, net, ["input-{0}".format(i) for i in range(3)], inputs, in_subs, col_x[0], col_w, "base", (tallest - heights[0]) / 2, gap=18.0)
    _column(planner, net, ["hidden-{0}".format(j) for j in range(3)], hidden, [""] * 3, col_x[1], col_w, "accent", (tallest - heights[1]) / 2, gap=18.0)
    _column(planner, net, ["output-{0}".format(k) for k in range(2)], outputs, [""] * 2, col_x[2], col_w, "base", (tallest - heights[2]) / 2, gap=18.0)
    net.spread("hidden-", "units", 2, 3)
    for i in range(3):
        for j in range(3):
            net.planner.rail("wire-in-{0}-{1}".format(i, j), "input-{0}".format(i), "hidden-{0}".format(j), band="net", directed=True)
    for j in range(3):
        for k in range(2):
            net.planner.rail(
                "wire-out-{0}-{1}".format(j, k),
                "hidden-{0}".format(j),
                "output-{0}".format(k),
                band="net",
                style="pipe",
                directed=True,
            )
    net.bottom = max(net.bottom, tallest)
    # ★★ 竖直方向要**先算总账再摆**（实测缺陷：`transformer-sr` 的两个盒子压了 5px）。
    #   旧写法把三个读数放好之后再把 net 的整体高度压一压（等比缩 y 与 h）——
    #   那是**只改清单不改内容**：运行时按真实文字重新量高度，盒子又长回原样，
    #   于是压过界（清单说 77.3，画面上 89，正好压住下面那个）。
    #   正确做法是按**真实高度**保留每个盒子，只压缩**它们之间的空隙**；
    #   空隙压到下限还不放，就说明这一屏内容太多 —— 那种情况要让 payload 少给几行。
    meter_h = top.bottom
    budget = (SAFE_BOTTOM - SAFE_TOP) - meter_h - 14.0
    if net.bottom > budget:
        net_cells = [c for c in planner.cells if c.get("band") == "net"]
        rails = [r for r in planner.rails if r.get("band") == "net"]
        gap = 8.0
        total_h = sum(float(c["h"]) for c in net_cells)
        spare = budget - total_h - gap * max(0, len(net_cells) - 1)
        if spare < 0:
            # 空隙已经压到 8px 还是不够：这不是排布问题，是内容太多，
            # 交给 assert_clean 报出来（宁可生成失败，也不给学生一屏压在一起的盒子）。
            gap = max(2.0, budget - total_h) / max(1, len(net_cells) - 1)
        # 每一格按「它所在列」的序号顺序下摆 —— 列内顺序保留，列间不再互相挤压
        columns = {}
        for cell in net_cells:
            columns.setdefault(str(cell["id"]).split("-")[0], []).append(cell)
        for _name, group in columns.items():
            group.sort(key=lambda c: float(c["y"]))
            cursor = 0.0
            for cell in group:
                cell["y"] = round(cursor, 2)
                cursor += float(cell["h"]) + gap
        # 连线端点跟着各自盒子走（rails 的 from/to 是坐标对）
        for rail in rails:
            for key in ("from", "to"):
                point = rail.get(key)
                if not (isinstance(point, list) and len(point) == 2):
                    continue
                column = None
                for _name, group in columns.items():
                    for cell in group:
                        if abs(float(cell["x"]) - float(point[0])) < 40.0:
                            column = group
                if not column:
                    continue
                # 落在某一列的 x 上：按 y 顺序找最接近的那个盒子，贴到它的边
                best = min(column, key=lambda c: abs(float(c["y"]) + float(c["h"]) / 2 - float(point[1])))
                rail[key] = [point[0], round(float(best["y"]) + float(best["h"]) / 2, 2)]
        net.bottom = max((float(c["y"]) + float(c["h"]) for c in net_cells), default=0.0)
    return planner


def plan_matrix(skin: str, data: dict) -> Planner:
    """「一格一格扫过去」—— 一张表 + 三个读数（行均值 / 最亮的一格 / 现在扫到第几格）。

    ★ 格子上的数字**在生成时就算好**（与运行时同一套算式，见 payload_matrix）：
      这样「最亮的一格」在规划期就定下来（tone=accent），运行时不需要重排文字 ——
      盒子里换文字意味着盒子可能变高，而变高就会压住下一行。
    ★ 行数 3（MATRIX_ROWS）：多出来的竖直空间正好放得下第三个读数（现在扫到第几格）。
    """
    planner = Planner(skin)
    # 三个读数先建（**右上角角带**）：靠右排一行，主网格因此吃满整行宽。
    corner(
        planner,
        [
            {"id": "row-meter", "kind": "readout", "label": "当前行的均值", "value": 0, "unit": ""},
            {"id": "all-meter", "kind": "readout", "label": data.get("brightest", ""), "value": 0, "unit": ""},
            {"id": "scan-meter", "kind": "readout", "label": data.get("scanLabel", ""), "value": "", "unit": ""},
        ],
        width=360.0,
    )
    grid = planner.band("grid", gap=14.0)
    size = int(len(data["values"][0]))
    row_count = len(data["values"])
    cell_w = 100.0
    # ★ 格子加高（62）：三行网格是这一屏的主角，原来 50 高的薄片让画面偏轻。
    cell_h = 68.0
    step_x = cell_w + 10.0
    step_y = cell_h + 10.0
    best = data["best"]
    for r in range(row_count):
        for c in range(size):
            planner.cells.append(
                {
                    "id": "cell-{0}-{1}".format(r, c),
                    "band": "grid",
                    "kind": "node",
                    "x": 34.0 + c * step_x,
                    "y": r * step_y,
                    "w": cell_w,
                    "h": cell_h,
                    "label": "{0:.2f}".format(data["values"][r][c]),
                    "tone": "accent" if (r, c) == (best["r"], best["c"]) else "base",
                }
            )
    grid.bottom = max(grid.bottom, row_count * step_y - 10.0)
    grid.spread("cell-", "size", 4, 6)
    return planner


def plan_trace(skin: str, data: dict) -> Planner:
    """「沿着曲线一步步读数」—— 右上角两个读数 + 一张吃满下面整块画布的坐标图。"""
    planner = Planner(skin)
    corner(
        planner,
        [
            {"id": "w-meter", "kind": "readout", "label": "参数", "value": data.get("start", 0), "unit": ""},
            {"id": "l-meter", "kind": "readout", "label": data.get("yLabel", ""), "value": 0, "unit": ""},
        ],
        width=300.0,
    )
    chart = planner.band("chart", height=240.0, gap=14.0)
    chart.planner.plot("plot", "chart", 62.0, 6.0, 560.0, 200.0)
    return planner


def plan_counter(skin: str, data: dict) -> Planner:
    """「做一次计一次数」—— 上面一句原话、下面一排计数桩、右边两个读数。"""
    rows = data["rows"]
    planner = Planner(skin)
    board = planner.band("board", height=356.0, gap=12.0)
    events = [{"text": row["event"], "who": "narrator", "tail": "left"} for row in rows[:6]]
    board.row([{"id": "say", "kind": "bubble", "alts": events, "w": 430.0}], gap=0.0, w=430.0)
    board.spread("say-", "times", 3, 6)
    pegs = [{"id": "peg-{0}".format(index), "w": 56.0, "h": 52.0, "label": str(index + 1), "tone": "muted"} for index in range(6)]
    board.row(pegs, gap=12.0, x=34.0, w=430.0, y=286.0)
    board.spread("peg-", "times", 3, 6)
    board.place("count-meter", kind="readout", w=180, align="right", y=60.0, label="已经数到", value=0, unit="次")
    # ★ 标签必须有兜底：`trace` 的数据里没有 `totalLabel`/`unit`，原先取空串 →
    #   画布上多一个**只有数字、没有说明**的读数框（学生看不懂那个数字是什么）。
    board.place(
        "sum-meter",
        kind="readout",
        w=180,
        align="right",
        y=180.0,
        label=data.get("totalLabel") or "累计",
        value=0,
        unit=data.get("unit") or "次",
    )
    return planner


#: 原型 → 规划器（与 ARCHETYPES 的表同键）。
PLANNERS = {
    "scene": plan_scene,
    "dialogue": plan_dialogue,
    "contrast_kid": plan_contrast_kid,
    "accumulate_kid": plan_accumulate_kid,
    "checklist_kid": plan_checklist_kid,
    "flow": plan_flow,
    "compare": plan_compare,
    "layers": plan_layers,
    "loop": plan_loop,
    "tree": plan_tree,
    "network": plan_network,
    "matrix": plan_matrix,
    "trace": plan_trace,
    "counter": plan_counter,
}


def plan_for(archetype: str, skin: str, data: dict, where: str = "") -> dict:
    """算一份布局清单；顺手用真几何自检一次（不合格当场抛，不写盘）。"""
    planner = PLANNERS[archetype](skin, data)
    planner.assert_clean("{0}/{1}".format(archetype, where or "?"))
    return planner.plan()


class Band:
    """一条横带：带内放行（row）/ 摞（stack）/ 竖排若干行（rows）/ 自由块（place）。

    ★★ 「带」是这套布局里唯一的纵向定位手段：**带高 = 带内内容真正用掉的高度**，
    后一条带自动排在前一条的下方。于是「盒子长高压住下一行」在构造上不可能 ——
    压住谁就等于把自己算进了带高，下一条带会**整体下移**。

    ★ 两遍走（作者按「带内局部坐标」写，收尾时再堆叠）：写的时候 band 顶 = 0，
    `Planner.finish()` 才知道每条带最终落在哪一行，再把带内所有 cell / 人物 / 连线
    整体平移过去。这样行高就不用**提前**猜（猜错正是旧版重叠的来源）。
    """

    def __init__(self, planner: "Planner", band_id: str, height: float = 0.0, gap: float = 14.0) -> None:
        self.planner = planner
        self.id = band_id
        self.x = SAFE_X
        self.w = SAFE_RIGHT - SAFE_X
        self.h = float(height)
        self.gap = float(gap)
        self.top = 0.0  # 局部坐标：带的顶永远是 0，收尾时再平移
        self.bottom = 0.0

    # ---- 内部 ---------------------------------------------------------- #
    def _cell(self, **kwargs: object) -> dict:
        cell = dict(kwargs)
        cell["band"] = self.id
        self.planner.cells.append(cell)
        self.bottom = max(self.bottom, float(cell["y"]) + float(cell["h"]))  # type: ignore[arg-type]
        return cell

    # ---- 排布 ---------------------------------------------------------- #
    def row(
        self,
        items: list[dict],
        h: float | None = None,
        gap: float | None = None,
        x: float | None = None,
        w: float | None = None,
        y: float | None = None,
    ) -> list[dict]:
        """横着排一行：格子**均分**（带 ``w`` 的项先扣掉，其余按 ``weight``），整行同一高度。

        每项可以是 ``node``（label / sub / tone / focus）、``bubble``（text / who / tail）、
        ``readout``（label / value / unit）、``blank``（只占位的空档）、``text``（裸注释）。
        带 ``alts`` 的项是**同位轮换**：同一块地方按顺序换文案（同一时刻只显示一个），
        格子尺寸按**最长的那一段**预留 —— 轮播过程中盒子一次都不会长大。
        """
        items = [item for item in items if item is not None]
        gap = self.gap if gap is None else gap
        x = self.x if x is None else x
        w = self.w if w is None else w
        y = self.top if y is None else y
        widths = _plan_widths(items, w, gap)
        need = _plan_need(items, widths, self.planner.skin)
        height = max(40.0, need, float(h or 0.0))
        out: list[dict] = []
        cursor_x = x
        for item, cell_w in zip(items, widths):
            variants = item.get("alts") or [item]
            base = str(item.get("id"))
            # ★★ 同位轮换的成员必须占**同一个矩形**（同一块地方换文案，同一时刻只显示一个）：
            #   矩形按**最长的那一段**预留，于是轮播过程中盒子一次都不会长大 ——
            #   这正是旧版「第一段文案定尺寸、后一段更长把盒子撑高压住邻居」的根因。
            slot = _slot_rect(variants, item, cell_w, height, y, cell_w, self.planner.skin)
            for index, variant in enumerate(variants):
                merged = {key: value for key, value in item.items() if key != "alts"}
                merged.update(variant)
                kind = str(merged.get("kind") or "node")
                # ★★ `blank` 只**占位**（用来把同一行的其他格子推到想要的位置），不该画出来。
                #   实测缺陷：`_plan_need` 会跳过它算高度，但这里照样发了一张格子出去 ——
                #   运行时按 node 画，于是画布上多出一个**空白方框**（19 份模板中招，
                #   全都停在同一个坐标上）。占位与「要画的东西」必须分开。
                if kind == "blank":
                    continue
                out.append(
                    self._cell(
                        id=base if len(variants) == 1 else "{0}-{1}".format(base, index),
                        alt=base if len(variants) > 1 else None,
                        kind=kind,
                        x=round(cursor_x, 2),
                        y=round(slot[1], 2),
                        w=round(slot[0], 2),
                        h=round(slot[2], 2),
                        **{
                            key: value
                            for key, value in merged.items()
                            if key
                            in ("label", "sub", "text", "who", "tail", "tone", "focus", "value", "unit")
                            and value not in (None, "")
                        },
                    )
                )
            cursor_x += cell_w + gap
        self.bottom = max(self.bottom, y + height)
        return out

    def stack(
        self,
        items: list[dict],
        anchor: str = "top",
        inset: float = 0.0,
        gap: float = 8.0,
        w: float | None = None,
        x: float | None = None,
        spread: bool = False,
    ) -> list[dict]:
        """竖着叠一摞：``anchor='bottom'`` 自下而上（「一层层往上搭」用）。

        每层高度是**它自己**需要的；``spread=True`` 把带里剩下的竖直空间平摊进层距。
        """
        w = self.w if w is None else w
        x = self.x if x is None else x
        widths = [max(48.0, w - inset * 2 * index) for index in range(len(items))]
        heights = [
            max(
                40.0,
                float(items[index].get("h") or 0.0),
                node_needed(
                    str(items[index].get("label") or ""),
                    str(items[index].get("sub") or ""),
                    widths[index],
                    self.planner.skin,
                ),
            )
            for index in range(len(items))
        ]
        total = sum(heights) + gap * max(0, len(items) - 1)
        if spread and self.h > total and len(items) > 1:
            gap += (self.h - total) / (len(items) - 1)
            total = self.h
        # 自下而上（anchor='bottom'）时**第 0 项落在最底下**，往上叠 ——
        # 「先放底面，再一层层压上去」的阅读顺序，位置从底边倒着算。
        out: list[dict] = []
        edge = self.h
        for index, item in enumerate(items):
            if anchor == "bottom":
                line = edge - heights[index]
                edge = line - gap
            else:
                line = self.top + sum(heights[:index]) + gap * index
            out.append(
                self._cell(
                    id=str(item.get("id") or "tier-{0}".format(index)),
                    kind=str(item.get("kind") or "node"),
                    x=round(x + (w - widths[index]) / 2, 2),
                    y=round(line, 2),
                    w=round(widths[index], 2),
                    h=round(heights[index], 2),
                    **{
                        key: value
                        for key, value in item.items()
                        if key in ("label", "sub", "tone", "focus") and value not in (None, "")
                    },
                )
            )
        return out

    def rows(
        self,
        rows: list[list[dict]],
        gap: float = 10.0,
        h: float | None = None,
        spread: bool = False,
        w: float | None = None,
    ) -> list[list[dict]]:
        """竖排若干**等高**的行（清单 / 判定链：每一行自己又是横着排的）。

        行高按「最费的那一行」统一 —— 行与行不会互相压；``spread=True`` 把剩余空间
        平摊进行距（清单撑满舞台，不留一条空底边）。
        """
        w = self.w if w is None else w
        heights: list[float] = []
        for row in rows:
            widths = _plan_widths(row, w, self.gap)
            heights.append(max(40.0, float(h or 0.0), _plan_need(row, widths, self.planner.skin)))
        total = sum(heights) + gap * max(0, len(rows) - 1)
        if spread and self.h > total and len(rows) > 1:
            gap += (self.h - total) / (len(rows) - 1)
        out: list[list[dict]] = []
        line = self.top
        for index, row in enumerate(rows):
            out.append(self.row(row, h=heights[index], y=line, w=w))
            line += heights[index] + gap
        self.bottom = max(self.bottom, line - gap)
        return out

    def place(
        self,
        cell_id: str,
        kind: str = "readout",
        w: float = 168.0,
        h: float = 0.0,
        align: str = "left",
        valign: str = "top",
        y: float | None = None,
        **fields: object,
    ) -> dict:
        """带里放一个**不参与分行**的块（读数框为主），返回它的清单条目。"""
        width = max(96.0, w)
        height = max(40.0, float(h or 0.0))
        if kind == "readout":
            height = max(
                height, 58.0, readout_needed(str(fields.get("label") or ""), width, self.planner.skin)
            )
        elif kind == "bubble":
            width, height = bubble_size(
                str(fields.get("text") or ""), width, str(fields.get("tail") or "left"), self.planner.skin
            )
        x = self.x
        if align == "right":
            x = self.x + self.w - width
        elif align == "center":
            x = self.x + (self.w - width) / 2
        base = self.top if y is None else y
        cell_y = base
        if valign == "bottom":
            cell_y = base + self.h - height if y is None else base - height
        elif valign == "middle":
            cell_y = base + (self.h - height) / 2
        return self._cell(
            id=cell_id,
            kind=kind,
            x=round(x, 2),
            y=round(cell_y, 2),
            w=round(width, 2),
            h=round(height, 2),
            **{
                key: value
                for key, value in fields.items()
                if key in ("label", "sub", "text", "who", "tail", "tone", "focus", "value", "unit")
                and value not in (None, "")
            },
        )

    def spread(
        self, prefix: str, param: str, minimum: int, maximum: int, axis: str = "x", mode: str = "center"
    ) -> None:
        """声明「这一组格子随参数增减」—— 清单里记一笔，运行时与守卫都照它行动。

        ``mode='center'``：多余的格子隐藏，剩下的**保持列距**在带内居中（列距不变 ⇒
        参数怎么调都不会压到一起）。``mode='keep'`` 只隐藏不挪动（列要对齐、塔要从底往上长）。
        """
        self.planner.spreads.append(
            {
                "band": self.id,
                "prefix": prefix,
                "param": param,
                "min": int(minimum),
                "max": int(maximum),
                "axis": axis,
                "mode": mode,
            }
        )


def _slot_rect(
    variants: list[dict], item: dict, cell_w: float, cell_h: float, y: float, max_w: float, skin: str
) -> tuple[float, float, float]:
    """同位轮换共用的矩形（宽 = 各段需要的最大值，高 = 各段需要的最大值）。"""
    best_w = cell_w if item.get("kind") != "bubble" else 0.0
    best_h = cell_h
    for variant in variants:
        merged = {key: value for key, value in item.items() if key != "alts"}
        merged.update(variant)
        kind = str(merged.get("kind") or "node")
        if kind == "bubble":
            width, height = bubble_size(
                str(merged.get("text") or ""), cell_w, str(merged.get("tail") or "left"), skin
            )
            best_w = max(best_w, min(width, max_w))
            best_h = max(best_h, height)
        elif kind == "readout":
            best_h = max(best_h, 58.0, readout_needed(str(merged.get("label") or ""), cell_w, skin))
        elif kind != "blank":
            best_h = max(best_h, node_needed(str(merged.get("label") or ""), str(merged.get("sub") or ""), cell_w, skin))
    return (best_w, y, best_h)


def _plan_widths(items: list[dict], width: float, gap: float) -> list[float]:
    """把一行的可用宽度分给格子（与运行时 ``planCells`` 同源）。"""
    fixed = sum(max(0.0, float(item.get("w") or 0.0)) for item in items)
    weight = sum(max(0.2, float(item.get("weight") or 1.0)) for item in items if not item.get("w"))
    free = width - gap * max(0, len(items) - 1) - fixed
    unit = free / weight if weight > 0 and free > 0 else 0.0
    widths = [
        max(0.0, float(item.get("w") or 0.0))
        if item.get("w")
        else unit * max(0.2, float(item.get("weight") or 1.0))
        for item in items
    ]
    total = sum(widths) + gap * max(0, len(items) - 1)
    if total > width and total > 0:
        usable = max(0.0, width - gap * max(0, len(items) - 1))
        base = total - gap * max(0, len(items) - 1)
        factor = usable / base if base > 0 else 0.0
        widths = [value * factor for value in widths]
    return widths


def _plan_need(items: list[dict], widths: list[float], skin: str) -> float:
    """一行里最费空间的那一项需要多高（行内所有格子都用这个高度）。"""
    need = 40.0
    for item, cell_w in zip(items, widths):
        variants = item.get("alts") or [item]
        for variant in variants:
            merged = {key: value for key, value in item.items() if key != "alts"}
            merged.update(variant)
            kind = str(merged.get("kind") or "node")
            if kind == "blank":
                continue
            if kind == "readout":
                need = max(need, 58.0, readout_needed(str(merged.get("label") or ""), cell_w, skin))
            elif kind == "bubble":
                need = max(
                    need,
                    bubble_size(str(merged.get("text") or ""), cell_w, str(merged.get("tail") or "left"), skin)[1],
                )
            else:
                need = max(
                    need,
                    node_needed(str(merged.get("label") or ""), str(merged.get("sub") or ""), cell_w, skin),
                )
    return need


class Planner:
    """把「讲什么」翻成「每个盒子放哪、多大」—— 十四原型共用的一套排布器。

    产出的清单（plan）有两个读者：
      · **运行时**：`Sandbox.layout(plan)` 照单画（尺寸照单全收，不再自己算位置）；
      · **守卫**：不用开浏览器就能验「盒盒不重叠 / 不出舞台 / 标签≠副标题 / 人物站得住」。
    """

    def __init__(self, skin: str) -> None:
        self.skin = skin
        self.cells: list[dict] = []
        self.actors: list[dict] = []
        self.rails: list[dict] = []
        self.bands: list[dict] = []
        self.spreads: list[dict] = []
        self.plots: list[dict] = []
        self._order: list[Band] = []
        self._final = False

    def band(self, band_id: str, height: float = 0.0, gap: float = 14.0) -> Band:
        band = Band(self, band_id, height, gap)
        self._order.append(band)
        return band

    def actor(
        self,
        actor_id: str,
        x: float,
        feet_y: float,
        pose: str = "walk",
        scale: float = 1.0,
        label: str = "",
        band: str | None = None,
        on_rail: str | None = None,
    ) -> dict:
        """放一个人物：``x`` 是站位，``feet_y`` 是**脚底那条线**（带内局部坐标）。"""
        entry: dict = {
            "id": actor_id,
            "x": round(x, 2),
            "y": round(feet_y, 2),
            "pose": pose,
            "scale": scale,
            "band": band,
        }
        if label:
            entry["label"] = label
        if on_rail:
            entry["on"] = on_rail
        self.actors.append(entry)
        return entry

    def rail(
        self,
        rail_id: str,
        start: object,
        end: object,
        band: str | None = None,
        style: str = "pipe",
        directed: bool = False,
        label: str = "",
    ) -> dict:
        entry: dict = {
            "id": rail_id,
            "from": start,
            "to": end,
            "band": band,
            "style": style,
            "directed": directed,
        }
        if label:
            entry["label"] = label
        self.rails.append(entry)
        return entry

    def plot(self, plot_id: str, band: str, x: float, y: float, w: float, h: float) -> dict:
        """坐标轴围出来的绘图区（``trace`` 原型用）：也参与「不许重叠」的判定。"""
        entry = {"id": plot_id, "band": band, "x": round(x, 2), "y": round(y, 2), "w": round(w, 2), "h": round(h, 2)}
        self.plots.append(entry)
        return entry

    # ---- 收尾（两遍走：把带内局部坐标平移成舞台坐标）-------------------- #
    def finish(self) -> None:
        """两遍走：① 按**局部坐标**量出每条带真正需要的高度；② 把带内坐标平移到舞台上。

        ★★ 第二版新增（用户口径：截图里「下半 40% 全空」）：**把剩下的竖直空间分给带间距**。
          旧写法每条带只留 ``band.gap``，剩下的高度全堆在画布底部 —— 于是构图永远偏上、
          下面一大片空。现在第一条带贴 ``SAFE_TOP``、最后一条带的底边贴 ``SAFE_BOTTOM``，
          中间的空隙由带间距平分（单条间距封顶 ``MAX_BAND_GAP``，免得撑成一道空谷）。
          只动**间距**、不动任何盒子的尺寸，所以「盒子不重叠」的结论一个字都没变。
        """
        if self._final:
            return
        self._final = True
        heights: list[float] = []
        for band in self._order:
            content = band.bottom
            for actor in self.actors:
                if actor.get("band") != band.id:
                    continue
                rect = actor_rect(
                    float(actor["x"]),
                    float(actor["y"]),
                    float(actor.get("scale") or 1.0),
                    str(actor.get("label") or ""),
                    self.skin,
                )
                content = max(content, rect[1] + rect[3])
            heights.append(round(max(band.h, content), 2))
        gaps = [float(band.gap) for band in self._order]
        if len(self._order) > 1:
            used = sum(heights) + sum(gaps)
            slack = (SAFE_BOTTOM - SAFE_TOP) - used
            room = sum(max(0.0, MAX_BAND_GAP - gap) for gap in gaps)
            if slack > 0 and room > 0:
                share = min(slack, room) / (len(self._order) - 1)
                gaps = [min(MAX_BAND_GAP, round(gap + share, 2)) for gap in gaps]
        cursor = SAFE_TOP
        for index, band in enumerate(self._order):
            top = cursor
            for cell in self.cells:
                if cell.get("band") == band.id:
                    cell["y"] = round(float(cell["y"]) + top, 2)
            for actor in self.actors:
                if actor.get("band") == band.id:
                    actor["y"] = round(float(actor["y"]) + top, 2)
            for rail in self.rails:
                if rail.get("band") == band.id:
                    rail["from"] = _shift(rail["from"], top)
                    rail["to"] = _shift(rail["to"], top)
            for plot in self.plots:
                if plot.get("band") == band.id:
                    plot["y"] = round(float(plot["y"]) + top, 2)
            height = heights[index]
            self.bands.append({"id": band.id, "x": band.x, "y": round(top, 2), "w": band.w, "h": height})
            cursor = top + height + gaps[index]
        self._final_bottom = cursor - (gaps[-1] if self._order else 0.0)

    def plan(self) -> dict:
        """产出一份清单（运行时 `Sandbox.layout()` 照单画，守卫照单验）。"""
        self.finish()
        out: dict = {
            "bands": self.bands,
            "cells": [
                {key: value for key, value in cell.items() if value is not None and value != ""}
                for cell in self.cells
            ],
        }
        if self.actors:
            out["actors"] = [
                {key: value for key, value in actor.items() if value is not None and value != ""}
                for actor in self.actors
            ]
        if self.rails:
            out["rails"] = [
                {key: value for key, value in rail.items() if value is not None and value != ""}
                for rail in self.rails
            ]
        if self.spreads:
            out["spread"] = self.spreads
        if self.plots:
            out["plots"] = self.plots
        out["safe"] = {"x": SAFE_X, "y": SAFE_TOP, "right": SAFE_RIGHT, "bottom": SAFE_BOTTOM}
        return out

    def slack(self) -> float:
        self.finish()
        return SAFE_BOTTOM - self._final_bottom

    # ---- 自检（生成时立刻跑，坏布局不许写盘）---------------------------- #
    def assert_clean(self, where: str) -> None:
        """① 盒子两两不重叠 ② 都在安全区内 ③ 人物不压盒子、脚踩在自己声明的那条线上。

        ★ 还包含「同位轮换的成员必须严格同矩形」—— 同一块地方换文案是允许的（同一时刻
        只显示一个），但一旦矩形不一致，就说明有一个会露出半截压在别人身上。
        """
        self.finish()
        active: list[dict] = []
        for cell in self.cells:
            if cell.get("kind") == "blank":
                continue
            if _hidden_by_spread(cell, self.spreads):
                continue
            active.append(cell)
        for cell in active:
            x, y, w, h = float(cell["x"]), float(cell["y"]), float(cell["w"]), float(cell["h"])
            if x < SAFE_X - 0.5 or y < SAFE_TOP - 0.5 or x + w > SAFE_RIGHT + 0.5 or y + h > SAFE_BOTTOM + 0.5:
                raise AssertionError(
                    "{0}: 盒子 {1} 出了安全区（{2:.1f},{3:.1f} {4:.1f}×{5:.1f}）".format(
                        where, cell["id"], x, y, w, h
                    )
                )
            if cell.get("sub") and cell.get("label") == cell.get("sub"):
                raise AssertionError("{0}: {1} 的主标题与副标题是同一句".format(where, cell["id"]))
        for index, cell in enumerate(active):
            for other in active[index + 1 :]:
                over_x = min(float(cell["x"]) + float(cell["w"]), float(other["x"]) + float(other["w"])) - max(
                    float(cell["x"]), float(other["x"])
                )
                over_y = min(float(cell["y"]) + float(cell["h"]), float(other["y"]) + float(other["h"])) - max(
                    float(cell["y"]), float(other["y"])
                )
                if cell.get("alt") and cell.get("alt") == other.get("alt"):
                    if (
                        abs(float(cell["x"]) - float(other["x"])) > 0.5
                        or abs(float(cell["y"]) - float(other["y"])) > 0.5
                        or abs(float(cell["w"]) - float(other["w"])) > 0.5
                        or abs(float(cell["h"]) - float(other["h"])) > 0.5
                    ):
                        raise AssertionError(
                            "{0}: 同位轮换 {1}/{2} 的矩形不一致".format(where, cell["id"], other["id"])
                        )
                    continue
                if over_x > 1 and over_y > 1:
                    raise AssertionError(
                        "{0}: 盒子 {1} 与 {2} 重叠（{3:.1f}×{4:.1f}）".format(
                            where, cell["id"], other["id"], over_x, over_y
                        )
                    )
        rails = {str(rail["id"]): rail for rail in self.rails}
        for actor in self.actors:
            rect = actor_rect(
                float(actor["x"]),
                float(actor["y"]),
                float(actor.get("scale") or 1.0),
                str(actor.get("label") or ""),
                self.skin,
            )
            ax, ay, aw, ah = rect
            if ax < SAFE_X - 0.5 or ay < SAFE_TOP - 0.5 or ax + aw > SAFE_RIGHT + 0.5 or ay + ah > SAFE_BOTTOM + 0.5:
                raise AssertionError("{0}: 人物 {1} 出了安全区".format(where, actor["id"]))
            for cell in active:
                over_x = min(ax + aw, float(cell["x"]) + float(cell["w"])) - max(ax, float(cell["x"]))
                over_y = min(ay + ah, float(cell["y"]) + float(cell["h"])) - max(ay, float(cell["y"]))
                if over_x > 1 and over_y > 1:
                    raise AssertionError(
                        "{0}: 人物 {1} 压在盒子 {2} 上（{3:.1f}×{4:.1f}）".format(
                            where, actor["id"], cell["id"], over_x, over_y
                        )
                    )
            line = rails.get(str(actor.get("on") or ""))
            if line is not None:
                start, end = line["from"], line["to"]
                if isinstance(start, list) and isinstance(end, list) and abs(float(start[1]) - float(end[1])) < 0.5:
                    if abs(float(actor["y"]) - float(start[1])) > 0.5:
                        raise AssertionError(
                            "{0}: 人物 {1} 的脚底（{2:.1f}）不在他站的那条线（{3:.1f}）上".format(
                                where, actor["id"], float(actor["y"]), float(start[1])
                            )
                        )


def _shift(point: object, delta: float) -> object:
    """把连线端点整体平移（端点要么是 [x, y]，要么是某个盒子的 id）。"""
    if isinstance(point, list) and len(point) == 2:
        return [point[0], round(float(point[1]) + delta, 2)]
    return point


def _hidden_by_spread(cell: dict, spreads: list[dict]) -> bool:
    """这个格子会不会被 `spread` 隐藏（参数调到最小时也还在的格子才算「参与碰撞」）。"""
    for spread in spreads:
        prefix = str(spread["prefix"])
        cid = str(cell.get("id") or "")
        if not cid.startswith(prefix):
            continue
        suffix = cid[len(prefix) :].lstrip("-_")
        if suffix.isdigit() and int(suffix) >= int(spread["min"]):
            return True
    return False

# --------------------------------------------------------------------------- #
# 十四原型的**动效脚本**（只描述「动什么、什么顺序」；位置全部来自清单）
#
# 约定（每个原型都遵守）：
#   · `var L = Sandbox.layout(__PLAN__); anchorCells(L);` 建舞台并让每件都按自己的盒子缩放；
#   · `L.list('<前缀>')` 取一组（按编号排序，同位轮换的成员也在里面）；
#   · `L.one('<id>')` 取单件；`L.center('<id>')` 取盒子中心（连接线、走位都用它）；
#   · `off(...)` 先隐藏，相位里再 `riseIn/popIn/slideIn` 逐个亮 —— 学生看得见过程；
#   · 字幕 / 步骤条一律走 `defer(...)`（相位开始时才写，见 COMMON_JS 的说明）。
# --------------------------------------------------------------------------- #

CORE_SCENE = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{stations}}, N);
var stops = L.list('stop');
var road = L.one('road');
var guide = L.one('guide');
var meter = L.one('meter');
var i, prev = 0, startX = guide.k12Anchor.x;
/* 地面带 / 小丘贴着〔人物脚下那条线〕画：人物踩在地上，不再是浮在半空中。 */
decorScene(guide.k12Anchor.y);
/* 参数调小、站数变少时把这一行居中（右边不留一条空）。 */
var dx = centerRow(stops, COUNT);
for (i = 0; i < stops.length; i += 1) {
  off(stops[i]);
  if (i >= COUNT) stops[i].setAttribute('display', 'none');
}
off(road);
off(guide.k12Pivot);
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [riseIn(road, 10), popIn(guide.k12Pivot), push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) open.push(later(asleep(stops[i]), 0.12 + h.stagger * i / 1000));
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '站');
      var walk = L.center('stop-' + i).x - startX + dx;
      return [
        { targets: guide.k12Pivot, translateX: [prev, walk], scale: [1, 1.05, 1], duration: d(1.5), easing: M.easing },
        later(wake(stops[i]), 0.45),
        later(bump(stops[i]), 0.5),
        later(mark(stops[i].body), 0.5),
        later(focusStep(stops[i], stops[i - 1]), 0.5),
        push(meter, i + 1)
      ];
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 站）');
    h.step(COUNT, COUNT, '站');
    var all = [focusClear(stops), push(meter, COUNT)];
    for (i = 0; i < COUNT; i += 1) {
      all.push(later(bump(stops[i]), h.stagger * i / 1000));
      all.push(later(mark(stops[i].body), 0.1 + h.stagger * i / 1000));
    }
    return all;
  }));
});
'''

CORE_DIALOGUE = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{rounds}}, N);
var asks = L.list('ask');
var answers = L.list('answer');
var asker = L.one('asker');
var answerer = L.one('answerer');
var meter = L.one('round-meter');
var i;
/* 两个人物脚下的那条站台线就是地面线（装饰带贴着它画）。 */
decorScene(asker.k12Anchor.y);
for (i = 0; i < asks.length; i += 1) {
  off(asks[i]);
  off(answers[i]);
  if (i >= COUNT) { asks[i].setAttribute('display', 'none'); answers[i].setAttribute('display', 'none'); }
}
off(actorOf(asker));
off(actorOf(answerer));
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(ROWS[0].caption);
      /* ★ 第一轮问答就在〔第一相位〕里出现：学生不会先盯着两个空人物等两秒。 */
      return [
        popActor(asker),
        later(popActor(answerer), 0.2),
        later(slideIn(asks[0], -18), 0.35),
        later(bumpActor(answerer), 0.7),
        later(slideIn(answers[0], 18), 0.85),
        later(mark(answers[0].body), 1),
        push(meter, 1)
      ];
    }
    if (index < COUNT) {
      i = index;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT, '轮');
      var anims = [
        /*
         * ★★ 旧气泡先退场，而且必须排在这个相位的最前面（第七轮实测缺陷）。
         *
         * anime 时间线的 add() 是顺序追加：同一相位里先加的会整个跑完才轮到后面的，
         * 所以把 swapOut 摆在列表末尾时，它要等新气泡淡入、标记、计数全跑完才执行，
         * 旧气泡一直挂在那，学生看到的是同一格位上两段文字长期并存（文字重影）。
         * 顺序即时间：先退场，再登场，天然没有交叠窗口。
         */
        swapOut(asks[i - 1]),
        swapOut(answers[i - 1]),
        bumpActor(asker),
        later(slideIn(asks[i], -18), HANDOFF_IN),
        later(bumpActor(answerer), HANDOFF_IN + 0.38),
        later(slideIn(answers[i], 18), HANDOFF_IN + 0.5),
        later(mark(answers[i].body), HANDOFF_IN + 0.68),
        push(meter, i + 1)
      ];
      return anims;
    }
    if (index === COUNT) {
      h.caption('看完了这几轮问答，可以把它们连起来读。');
      h.step(COUNT, COUNT, '轮');
      return [
        bump(asks[COUNT - 1]),
        bump(answers[COUNT - 1]),
        mark(answers[COUNT - 1].body),
        push(meter, COUNT)
      ];
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 轮）');
    h.step(COUNT, COUNT, '轮');
    return [bump(answers[COUNT - 1]), mark(answers[COUNT - 1].body), push(meter, COUNT)];
  }));
});
'''

CORE_CONTRAST_KID = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{pairs}}, N);
var leftHead = L.one('head-left');
var rightHead = L.one('head-right');
var leftCards = L.list('left');
var rightCards = L.list('right');
var meter = L.one('pair-meter');
var i;
decorScene();
for (i = 0; i < leftCards.length; i += 1) {
  off(leftCards[i]);
  off(rightCards[i]);
  if (i >= COUNT) { leftCards[i].setAttribute('display', 'none'); rightCards[i].setAttribute('display', 'none'); }
}
/* 两栏中间的分隔线 + 会来回滑的 VS 徽标（它就是那个「指针」）。 */
var qa = L.bands['pairs'];
Sandbox.link({ x: qa.centerX, y: qa.top + 6 }, { x: qa.centerX, y: qa.bottom - 6 }, { style: 'dashed' });
var badge = pivot(qa.centerX, qa.centerY);
badge.appendChild(dotAt(18));
var badgeText = Sandbox.svgEl('text');
badgeText.setAttribute('class', 'k12-node-sub');
badgeText.setAttribute('text-anchor', 'middle');
badgeText.setAttribute('y', '5');
badgeText.textContent = DATA.versus;
badge.appendChild(badgeText);
off(badge);
var SWING = 78, swing = 0, prevSwing = 0;
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      /* 布景 + 第一组的骨架先出（两栏各自暗着），后面几组再逐组点亮。 */
      return [
        slideIn(leftHead, -26),
        slideIn(rightHead, 26),
        popIn(badge),
        later(asleep(leftCards[0]), 0.25),
        later(asleep(rightCards[0]), 0.4),
        push(meter, 0)
      ];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '组');
      swing = i % 2 === 0 ? -SWING : SWING;
      var anims = [];
      /* ★ 同位轮换：上一次那一组先退场（排最前，顺序即时间，见对话原型的说明）。 */
      if (i > 0) {
        anims.push(swapOut(leftCards[i - 1]));
        anims.push(swapOut(rightCards[i - 1]));
      }
      anims.push(later(fadeTo(leftCards[i], 1), HANDOFF_IN));
      anims.push(later(bump(leftCards[i]), HANDOFF_IN + 0.1));
      anims.push(later(fadeTo(rightCards[i], 1), HANDOFF_IN + 0.23));
      anims.push(later(bump(rightCards[i]), HANDOFF_IN + 0.33));
      anims.push(later(mark(rightCards[i].body), HANDOFF_IN + 0.4));
      anims.push(later(focusStep([leftCards[i], rightCards[i]], [leftCards[i - 1], rightCards[i - 1]]), HANDOFF_IN + 0.4));
      anims.push({ targets: badge, translateX: [prevSwing, swing], scale: [1, 1.12, 1], duration: d(0.9), easing: M.easing });
      anims.push(push(meter, i + 1));
      prevSwing = swing;
      return anims;
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 组）');
    h.step(COUNT, COUNT, '组');
    return [
      focusClear([leftCards[COUNT - 1], rightCards[COUNT - 1]]),
      bump(rightCards[COUNT - 1]),
      mark(rightHead.body),
      later(bump(leftCards[COUNT - 1]), 0.3),
      push(meter, COUNT)
    ];
  }));
});
'''

CORE_ACCUMULATE_KID = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{items}}, N);
var blocks = L.list('block');
var meter = L.one('meter');
var i;
decorScene();
for (i = 0; i < blocks.length; i += 1) {
  off(blocks[i]);
  if (i >= COUNT) blocks[i].setAttribute('display', 'none');
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      /* 布景先出：容器骨架（每一层的位置先暗着摆好），然后一件件从上面落进去。 */
      var open = [push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) open.push(later(asleep(blocks[i]), 0.15 + h.stagger * i / 2000));
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '件');
      var anims = [
        /* ★★ 落下位移收敛到 <= 层间距（gap=21）：原来 -52 会在途中压住上面那层。 */
        { targets: blocks[i], opacity: [0.42, 1], translateY: [-20, 0], duration: d(1), easing: M.easing },
        later(bump(blocks[i]), 0.35),
        later(mark(blocks[i].body), 0.35),
        later(focusStep(blocks[i], blocks[i - 1]), 0.35),
        push(meter, i + 1)
      ];
      if (i > 0) anims.push(later({ targets: blocks[i - 1], scale: [1, 1.04, 1], duration: d(0.6), easing: M.easing }, 0.3));
      return anims;
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 件）');
    h.step(COUNT, COUNT, '件');
    var all = [focusClear(blocks), push(meter, COUNT)];
    for (i = 0; i < COUNT; i += 1) all.push(later(bump(blocks[i]), h.stagger * i / 1000));
    return all;
  }));
});
'''

CORE_CHECKLIST_KID = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{checks}}, N);
var meter = L.one('meter');
var items = L.list('item');
var ticks = L.list('tick');
var arcs = [];
var i;
decorScene();
for (i = 0; i < items.length; i += 1) {
  off(items[i]);
  off(ticks[i]);
  if (i >= COUNT) {
    items[i].setAttribute('display', 'none');
    ticks[i].setAttribute('display', 'none');
  } else {
    arcs.push(arcUnder(ticks[i]));
  }
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) {
        open.push(later({ targets: items[i], opacity: [0, 0.72], translateX: [-18, 0], duration: d(1), easing: M.easing }, h.stagger * i / 1000));
        open.push(later(slideIn(ticks[i], 12), h.stagger * i / 1000 + 0.1));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '条');
      var anims = [
        fadeTo(items[i], 1),
        mark(items[i].body),
        bump(ticks[i]),
        focusStep(items[i], items[i - 1]),
        drawArc(arcs[i]),
        push(meter, i + 1)
      ];
      if (i > 0) anims.push(later(fadeTo(items[i - 1], 0.55), 0.5));
      return anims;
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 条）');
    h.step(COUNT, COUNT, '条');
    var all = [focusClear(items), push(meter, COUNT)];
    for (i = 0; i < COUNT; i += 1) {
      all.push(later(fadeTo(items[i], 1), h.stagger * i / 1000));
      all.push(later(bump(ticks[i]), h.stagger * i / 1000));
      all.push(later(mark(items[i].body), 0.1 + h.stagger * i / 1000));
    }
    return all;
  }));
});
'''

CORE_FLOW = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{stages}}, N);
var boxes = L.list('stage');
var pipes = L.list('pipe');
var meter = L.one('flow-meter');
var pipeline = L.one('pipeline');
var spine = L.bands['spine'];
var i, prev = 0;
var dx = centerRow(boxes, COUNT);
var first = boxes[0].k12Box;
/* 数据包就停在〔主管道〕上（y = 管道那一条线），不再是浮在站卡上方的一个孤立节点。 */
var laneY = spine.top + 26;
var dot = pivot(first.x + first.w / 2 + dx, laneY);
dot.appendChild(dotAt(12));
off(dot);
for (i = 0; i < boxes.length; i += 1) {
  off(boxes[i]);
  if (i >= COUNT) boxes[i].setAttribute('display', 'none');
}
for (i = 0; i < pipes.length; i += 1) {
  off(pipes[i]);
  if (i >= COUNT) pipes[i].setAttribute('display', 'none');
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      /* 布景先出：主管道画出来、四张工位卡暗着排在道上、数据包停在第一张卡下面。 */
      var open = [popIn(dot), push(meter, 0), wipe(railLine(pipeline))];
      for (i = 0; i < COUNT; i += 1) open.push(later(asleep(boxes[i]), 0.1 + h.stagger * i / 2000));
      for (i = 0; i < COUNT - 1; i += 1) {
        open.push(later({ targets: pipes[i], opacity: [0, 0.55], duration: d(0.8), easing: M.easing }, 0.3 + h.stagger * i / 2000));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '段');
      var target = L.center('stage-' + i).x - (first.x + first.w / 2);
      return [
        { targets: dot, translateX: [prev, target], scale: [1, 1.2, 1], duration: d(1.2), easing: M.easing },
        wake(boxes[i]),
        mark(boxes[i].body),
        focusStep(boxes[i], boxes[i - 1]),
        push(meter, i + 1)
      ];
    }
    h.caption(DATA.close + '（一共 ' + COUNT + ' 段）');
    h.step(COUNT, COUNT, '段');
    var all = [focusClear(boxes), push(meter, COUNT)];
    for (i = 0; i < COUNT; i += 1) all.push(later(bump(boxes[i]), h.stagger * i / 1000));
    return all;
  }));
});
'''

CORE_COMPARE = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{pairs}}, N);
var leftHead = L.one('head-left');
var rightHead = L.one('head-right');
var leftBars = L.list('left');
var rightBars = L.list('right');
var meter = L.one('pair-meter');
var i, laneY = 0, prevY = 0;
var firstLeft = leftBars[0].k12Box;
var lastLeft = leftBars[COUNT - 1].k12Box;
var bottomY = lastLeft.y + lastLeft.h;
Sandbox.link({ x: 22, y: firstLeft.y }, { x: 22, y: bottomY }, { style: 'dashed' });
Sandbox.link({ x: 698, y: firstLeft.y }, { x: 698, y: bottomY }, { style: 'dashed' });
var markLeft = pivot(22, firstLeft.y + firstLeft.h / 2);
markLeft.appendChild(dotAt(9));
var markRight = pivot(698, firstLeft.y + firstLeft.h / 2);
markRight.appendChild(dotAt(9));
off(markLeft);
off(markRight);
for (i = 0; i < leftBars.length; i += 1) {
  off(leftBars[i]);
  off(rightBars[i]);
  if (i >= COUNT) { leftBars[i].setAttribute('display', 'none'); rightBars[i].setAttribute('display', 'none'); }
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      /* 布景先出：两条泳道 + 游标 + 〔四行卡片骨架〕（暗着），一屏没有三分之一是空的。 */
      var open = [slideIn(leftHead, -24), slideIn(rightHead, 24), mark(rightHead.body), popIn(markLeft), later(popIn(markRight), 0.15), push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) {
        open.push(later(asleep(leftBars[i]), 0.2 + h.stagger * i / 2000));
        open.push(later(asleep(rightBars[i]), 0.25 + h.stagger * i / 2000));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '行');
      laneY = leftBars[i].k12Box.y + leftBars[i].k12Box.h / 2 - (firstLeft.y + firstLeft.h / 2);
      var anims = [
        later(fadeTo(leftBars[i], 1), 0.05),
        later(bump(leftBars[i]), 0.15),
        later(fadeTo(rightBars[i], 1), 0.3),
        later(bump(rightBars[i]), 0.4),
        later(mark(rightBars[i].body), 0.45),
        later(mark(leftBars[i].body), 0.75),
        later(focusStep([leftBars[i], rightBars[i]], [leftBars[i - 1], rightBars[i - 1]]), 0.45),
        { targets: markLeft, translateY: [prevY, laneY], duration: d(0.9), easing: M.easing },
        { targets: markRight, translateY: [prevY, laneY], duration: d(0.9), easing: M.easing },
        push(meter, i + 1)
      ];
      prevY = laneY;
      return anims;
    }
    h.caption(DATA.close + '（一共比了 ' + COUNT + ' 行）');
    h.step(COUNT, COUNT, '行');
    var all = [focusClear(leftBars.concat(rightBars)), push(meter, COUNT)], k;
    for (k = 0; k < COUNT; k += 1) {
      all.push(later(bump(rightBars[k]), h.stagger * k / 1000));
      all.push(later(mark(leftBars[k].body), h.stagger * k / 1000));
    }
    return all;
  }));
});
'''

CORE_LAYERS = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var COUNT = Math.min({{layers}}, N);
var slabs = L.list('slab');
var meter = L.one('level-meter');
var i;
for (i = 0; i < slabs.length; i += 1) {
  off(slabs[i]);
  if (i >= COUNT) slabs[i].setAttribute('display', 'none');
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      /* 布景先出：五层骨架先立起来（暗着），后面逐层点亮垒上去。 */
      var open = [push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) open.push(later(asleep(slabs[i]), 0.15 + h.stagger * i / 2000));
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, COUNT, '层');
      var anims = [
        /* ★★ 滑入位移必须 <= 层间距（gap=10）：原来飞 40px，途中会停在原位下方压住
           已就位的那一层（实测重叠 27~29px，学生大部分时间看到的是歪塔）。
           「一层层垒上去」的语义由逐层点亮 + bump + 计数表达，不靠这一下位移。 */
        { targets: slabs[i], opacity: [0.42, 1], translateY: [10, 0], duration: d(1), easing: M.easing },
        later(bump(slabs[i]), 0.35),
        later(mark(slabs[i].body), 0.35),
        later(focusStep(slabs[i], slabs[i - 1]), 0.35),
        push(meter, i + 1)
      ];
      if (i > 0) anims.push(later(fadeTo(slabs[i - 1], 0.72), 0.5));
      return anims;
    }
    h.caption((COUNT > 1 ? DATA.close : DATA.hold) + '（一共 ' + COUNT + ' 层）');
    h.step(COUNT, COUNT, '层');
    var all = [focusClear(slabs), mark(slabs[0].body), push(meter, COUNT)];
    for (i = 0; i < COUNT; i += 1) {
      all.push(later(fadeTo(slabs[i], 1), h.stagger * i / 1000));
      all.push(later(bump(slabs[i]), h.stagger * i / 1000));
    }
    return all;
  }));
});
'''

CORE_LOOP = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var TIMES = {{times}};
var track = L.list('track')[0] || null;
var stops = L.list('stop');
var rounds = L.one('round-meter');
var totalMeter = L.one('total-meter');
var CX = track.cx, CY = track.cy, RADX = track.rx, RADY = track.ry;
var runner = pivot(CX, CY);
/* ★ 三层：seat（pivot 的外层，摆位置）、pivot（动画层）、spin（小人的身形在它里面）。
   body 自己用 transform 属性贴着跑道动，所以不能再把 bump 打在它身上。 */
var spin = anchor(Sandbox.svgEl('g'));
runner.appendChild(spin);
var body = runnerGlyph(12);
body.setAttribute('transform', 'translate(0 0)');
spin.appendChild(body);
off(runner);
var i;
function placeRunner(progress) {
  var angle = -Math.PI / 2 + progress * 2 * Math.PI;
  body.setAttribute('transform', 'translate(' + RADX * Math.cos(angle) + ' ' + RADY * Math.sin(angle) + ')');
}
placeRunner(0);
var trace = { v: 0 };
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [popIn(runner), push(rounds, 0), push(totalMeter, 0)];
      for (i = 0; i < stops.length; i += 1) open.push(later(popIn(stops[i]), h.stagger * i / 1000));
      return open;
    }
    if (index <= TIMES) {
      var round = index;
      var row = ROWS[(round - 1) % N];
      var stop = stops[(round - 1) % stops.length];
      h.caption('第 ' + round + ' 圈：绕一圈，停在「' + row.stop + '」这一站');
      h.step(index, TIMES, '圈');
      return [
        {
          targets: trace,
          v: [0, 1],
          duration: d(3.2),
          easing: 'linear',
          begin: function () { rounds.set(round); },
          update: function (anim) { placeRunner(anim.progress / 100); },
          complete: function () { placeRunner(1); totalMeter.set(round); }
        },
        mark(stop.body),
        bump(stop),
        focusStep(stop, stops[(round + stops.length - 2) % stops.length])
      ];
    }
    h.caption('跑了 ' + TIMES + ' 圈，每圈做的事一模一样：' + DATA.summary);
    h.step(TIMES, TIMES, '圈');
    return [focusClear(stops), bump(spin), push(rounds, TIMES), push(totalMeter, TIMES)];
  }));
});
'''

CORE_TREE = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var ROUNDS = Math.min({{rounds}}, N);
var root = L.one('root');
var chain = L.list('ask');
var exits = L.list('exit');
var links = L.list('step');
var branches = L.list('branch');
var meter = L.one('depth');
var i, taken = 0;
off(root);
for (i = 0; i < chain.length; i += 1) {
  off(chain[i]);
  off(exits[i]);
  off(links[i]);
  off(branches[i]);
  if (i >= ROUNDS) {
    chain[i].setAttribute('display', 'none');
    exits[i].setAttribute('display', 'none');
    links[i].setAttribute('display', 'none');
    branches[i].setAttribute('display', 'none');
  }
}
var flags = DATA.flags;
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [riseIn(root, 10), focusStep(root, null), push(meter, 0)];
      for (i = 0; i < ROUNDS; i += 1) {
        open.push(later(asleep(chain[i]), 0.15 + h.stagger * i / 2000));
        open.push(later(asleep(exits[i]), 0.2 + h.stagger * i / 2000));
        open.push(later({ targets: links[i], opacity: [0, 0.4], duration: d(0.6), easing: 'linear' }, 0.15 + h.stagger * i / 2000));
      }
      return open;
    }
    if (index <= ROUNDS) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index, ROUNDS, '个问题');
      var anims = [
        wipe(railLine(links[i])),
        later({ targets: links[i], opacity: [0.4, 1], duration: d(0.8), easing: M.easing }, 0),
        later({ targets: branches[i], opacity: [0, 0.42], duration: d(0.8), easing: M.easing }, 0.1),
        later(wake(chain[i]), 0.35),
        later(bump(chain[i]), 0.45),
        later(wake(exits[i]), 0.45),
        later(mark(chain[i].body), 0.5),
        later(focusStep(chain[i], i > 0 ? chain[i - 1] : root), 0.5),
        push(meter, i + 1)
      ];
      if (i > 0) anims.push(later(fadeTo(chain[i - 1], 0.6), 0.6));
      if (flags[i % flags.length]) taken = i;
      return anims;
    }
    if (index === ROUNDS + 1) {
      h.caption('一路都走「是」这条，最后落到「' + ROWS[taken].pass + '」');
      h.step(ROUNDS, ROUNDS, '个问题');
      return [
        focusStep(exits[taken], chain[taken]),
        later({ targets: exits[taken], opacity: [0, 1], duration: d(0.7), easing: M.easing }, 0),
        later(mark(exits[taken].body), 0.15),
        later(bump(exits[taken]), 0.15),
        later(fadeTo(branches[taken], 1), 0.1),
        later(wipe(railLine(branches[taken])), 0.1),
        later(fadeTo(chain[taken], 0.6), 0.2),
        push(meter, taken + 1)
      ];
    }
    h.caption(DATA.close + '（一共问了 ' + ROUNDS + ' 个问题）');
    h.step(ROUNDS, ROUNDS, '个问题');
    var all = [focusClear(exits.concat(chain)), mark(exits[taken].body)];
    for (i = 0; i <= taken; i += 1) all.push(later(mark(chain[i].body), h.stagger * i / 1000));
    return all;
  }));
});
'''

CORE_NETWORK = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var UNITS = Math.max(2, Math.min({{units}}, DATA.hidden.length));
var inNodes = L.list('input');
var hidNodes = L.list('hidden');
var outNodes = L.list('output');
var wiresIn = L.list('wire-in');
var wiresOut = L.list('wire-out');
var inMeter = L.one('in-meter');
var hidMeter = L.one('hidden-meter');
var outMeter = L.one('out-meter');
var i, j, k, sum;
var COL = inNodes.length, OUT = outNodes.length;
if (UNITS < hidNodes.length) hidNodes[hidNodes.length - 1].setAttribute('display', 'none');
for (i = 0; i < inNodes.length; i += 1) off(inNodes[i]);
for (j = 0; j < hidNodes.length; j += 1) off(hidNodes[j]);
for (k = 0; k < outNodes.length; k += 1) off(outNodes[k]);
for (i = 0; i < wiresIn.length; i += 1) off(wiresIn[i]);
for (i = 0; i < wiresOut.length; i += 1) off(wiresOut[i]);
var hid = [], out = [];
for (j = 0; j < UNITS; j += 1) {
  sum = 0;
  for (i = 0; i < COL; i += 1) sum += DATA.inputs[i].value * DATA.weights.ih[i][j];
  hid.push(Math.round(sum * 100) / 100);
}
for (k = 0; k < OUT; k += 1) {
  sum = 0;
  for (j = 0; j < UNITS; j += 1) sum += hid[j] * DATA.weights.ho[j][k];
  out.push(Math.round(sum * 100) / 100);
}
function join(list) { return list.join(' / '); }
function wireIn(i2, j2) { return wiresIn[i2 * UNITS + j2]; }
function wireOut(j2, i2) { return wiresOut[j2 * OUT + i2]; }
/* 三列的列标题（画在每列节点上方）：学生一眼分得清哪一列是输入、哪一列是输出。 */
var netTop = L.bands['net'].top;
label(L.center('input-0').x, netTop - 3, '输入');
label(L.center('hidden-0').x, netTop - 3, '隐层');
label(L.center('output-0').x, netTop - 3, '输出');
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [push(hidMeter, 0), push(outMeter, 0)];
      /* ★ 三列节点全部在第一帧画出（暗着）+ 上方三列列标题：
         否则「输出列整列缺失、箭头射向空白」（截图实测）。 */
      for (i = 0; i < COL; i += 1) open.push(later(asleep(inNodes[i]), 0.05 + h.stagger * i / 2500));
      for (j = 0; j < UNITS; j += 1) open.push(later(asleep(hidNodes[j]), 0.15 + h.stagger * j / 2500));
      for (k = 0; k < OUT; k += 1) open.push(later(asleep(outNodes[k]), 0.25 + h.stagger * k / 2500));
      open.push(push(inMeter, join([DATA.inputs[0].value, DATA.inputs[1].value, DATA.inputs[2].value])));
      return open;
    }
    if (index === 1) {
      h.caption('每根线的粗细就是权重的大小：线越粗，它说话越算数。');
      h.step(2, 8, '步');
      var wide = [focusClear(inNodes)];
      for (i = 0; i < COL; i += 1) {
        for (j = 0; j < UNITS; j += 1) {
          var width = Math.abs(DATA.weights.ih[i][j]) * 4 + 0.6;
          var when = h.stagger * (i + j) / 1000;
          wide.push(later({ targets: wireIn(i, j), opacity: [0, 1], duration: d(0.9), easing: M.easing }, when));
          wide.push(later({ targets: railLine(wireIn(i, j)), strokeWidth: [0.4, width], duration: d(0.9), easing: M.easing }, when));
        }
      }
      return wide;
    }
    if (index === 2) {
      h.caption('三个输入分别乘上权重再加起来，就是隐层每个单元收到的数：' + join(hid.map(String)) + '。');
      h.step(3, 8, '步');
      var calc = [push(hidMeter, join(hid.map(String))), focusStep(hidNodes.slice(0, UNITS), null)];
      for (j = 0; j < UNITS; j += 1) calc.push(later(mark(hidNodes[j].body), h.stagger * j / 1000));
      return calc;
    }
    if (index === 3) {
      h.caption('隐层把这些数记下来，接着往下一层送。');
      h.step(4, 8, '步');
      var up = [];
      for (j = 0; j < UNITS; j += 1) {
        up.push(later(wake(hidNodes[j]), h.stagger * j / 1000));
        up.push(later(bump(hidNodes[j]), h.stagger * j / 1000 + 0.2));
        up.push(later(focusStep(hidNodes[j], hidNodes[j - 1]), h.stagger * j / 1000 + 0.2));
      }
      return up;
    }
    if (index === 4) {
      h.caption('第二层的权重同样有正有负：负的权重要把信号压下去。');
      h.step(5, 8, '步');
      var second = [focusClear(hidNodes)];
      for (j = 0; j < UNITS; j += 1) {
        for (k = 0; k < OUT; k += 1) {
          var weight = Math.abs(DATA.weights.ho[j][k]) * 5 + 0.6;
          var at = h.stagger * (j + k) / 1000;
          second.push(later({ targets: wireOut(j, k), opacity: [0, 1], duration: d(0.9), easing: M.easing }, at));
          second.push(later({ targets: railLine(wireOut(j, k)), strokeWidth: [0.4, weight], duration: d(0.9), easing: M.easing }, at));
        }
      }
      return second;
    }
    if (index === 5) {
      h.caption('输出层的两个数就是这么算出来的，数值大的那个是这次的答案：' + join(out.map(String)) + '。');
      h.step(6, 8, '步');
      var show = [push(outMeter, join(out.map(String))), focusStep(outNodes.slice(0, OUT), null)];
      for (k = 0; k < OUT; k += 1) show.push(later(wake(outNodes[k]), h.stagger * k / 1000));
      show.push(later(bump(outNodes[0]), 0.3));
      return show;
    }
    if (index === 6) {
      h.caption('数值大的那个就是这次的答案：' + join(out.map(String)) + '。');
      h.step(7, 8, '步');
      return [mark(outNodes[0].body), bump(outNodes[0]), push(outMeter, join(out.map(String)))];
    }
    h.caption(DATA.close + '（一共算了 ' + UNITS + ' 个中间单元）');
    h.step(8, 8, '步');
    return [focusClear(outNodes), mark(outNodes[0].body), bump(hidNodes[0]), later(bump(outNodes[0]), 0.3), push(hidMeter, join(hid.map(String)))];
  }));
});
'''

CORE_MATRIX = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var SIZE = Math.max(4, Math.min({{size}}, 6));
var ROW_COUNT = 3;
var values = DATA.values;
var cells = [], r, c, k, i;
for (r = 0; r < ROW_COUNT; r += 1) {
  cells.push([]);
  for (c = 0; c < SIZE; c += 1) {
    var id = 'cell-' + r + '-' + c;
    var cell = L.one(id);
    cells[r].push(cell);
    off(cell);
    if (c >= SIZE) cell.setAttribute('display', 'none');
  }
}
function rowAverage(row) {
  var total = 0, index;
  for (index = 0; index < row.length; index += 1) total += row[index];
  return Math.round(total / row.length * 100) / 100;
}
var flat = [], total = 0;
for (r = 0; r < ROW_COUNT; r += 1) for (c = 0; c < SIZE; c += 1) flat.push(values[r][c]);
for (k = 0; k < flat.length; k += 1) total += flat[k];
var overall = Math.round(total / flat.length * 100) / 100;
var best = DATA.best;
var rowMeter = L.one('row-meter');
var allMeter = L.one('all-meter');
var scanMeter = L.one('scan-meter');
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [once(function () { rowMeter.set('待扫'); allMeter.set('待扫'); scanMeter.set('还没开始'); })];
      for (r = 0; r < ROW_COUNT; r += 1) {
        centerRow(cells[r], SIZE);
        /* ★ 三行 18 格在第一帧就全部画出（暗着）：不能再一格格渐入，否则
           截图里会出现「只有 1 行 6 格」的残缺画面，看起来像坏了。 */
        open.push({ targets: cells[r], opacity: [0, 0.45], scale: [0.86, 1], duration: d(0.7), easing: M.easing });
      }
      return open;
    }
    if (index <= ROW_COUNT) {
      r = index - 1;
      h.caption(ROWS[r].caption);
      h.step(index, ROW_COUNT, '行');
      var row = cells[r];
      var sweep = [push(rowMeter, rowAverage(values[r]))];
      for (c = 0; c < SIZE; c += 1) {
        var slot = h.stagger * c / 1000;
        var here = row[c];
        var before = c > 0 ? row[c - 1] : (r > 0 ? cells[r - 1][SIZE - 1] : null);
        sweep.push(later({ targets: here, opacity: [0.45, 1], translateY: [-8, 0], duration: d(0.7), easing: M.easing }, slot));
        sweep.push(later(scanStep(scanMeter, '第 ' + (r + 1) + ' 行第 ' + (c + 1) + ' 列', here, before), slot));
      }
      return sweep;
    }
    if (index === ROW_COUNT + 1) {
      h.caption('整张表加起来再平均是 ' + overall + '，最亮的那一格就是最大值。');
      h.step(ROW_COUNT, ROW_COUNT, '行');
      return [
        push(allMeter, overall),
        focusStep(cells[best.r][best.c], cells[best.r][SIZE - 1]),
        mark(cells[best.r][best.c].body),
        bump(cells[best.r][best.c]),
        once(function () { scanMeter.set('第 ' + (best.r + 1) + ' 行第 ' + (best.c + 1) + ' 列'); }),
        push(rowMeter, rowAverage(values[best.r]))
      ];
    }
    h.caption(DATA.close + '（一共扫了 ' + (ROW_COUNT * SIZE) + ' 格）');
    h.step(ROW_COUNT, ROW_COUNT, '行');
    var finish = [focusClear([cells[best.r][best.c]])];
    for (c = 0; c < SIZE; c += 1) finish.push(later(bump(cells[best.r][c]), h.stagger * c / 1000));
    finish.push(push(allMeter, overall));
    finish.push(once(function () { scanMeter.set('最亮 ' + best.v); }));
    return finish;
  }));
});
'''

CORE_TRACE = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var STEPS = {{steps}};
var RATE = {{rate}};
var plot = L.one('plot');
var ax = Sandbox.axis({ x: plot.x, y: plot.y, w: plot.w, h: plot.h, xLabel: DATA.xLabel, yLabel: DATA.yLabel });
var area = ax.plot;
var LOW = 0, HIGH = 6;
function lossAt(w) { return DATA.curve * (w - DATA.target) * (w - DATA.target) + DATA.floor; }
var peak = lossAt(LOW) > lossAt(HIGH) ? lossAt(LOW) : lossAt(HIGH);
function pxOf(w) { return area.originX + (w - LOW) / (HIGH - LOW) * area.w; }
function pyOf(l) { return area.originY - (l / peak) * area.h; }
var segments = [], i, w0, w1;
for (i = 0; i < 16; i += 1) {
  w0 = LOW + (HIGH - LOW) * i / 16;
  w1 = LOW + (HIGH - LOW) * (i + 1) / 16;
  segments.push(Sandbox.link({ x: pxOf(w0), y: pyOf(lossAt(w0)) }, { x: pxOf(w1), y: pyOf(lossAt(w1)) }));
  off(segments[i]);
}
var weights = [], losses = [], wi = DATA.start;
for (i = 0; i <= STEPS + 1; i += 1) {
  weights.push(Math.round(wi * 1000) / 1000);
  losses.push(Math.round(lossAt(wi) * 1000) / 1000);
  wi = Math.max(LOW, Math.min(HIGH, wi - RATE * 2 * DATA.curve * (wi - DATA.target)));
}
/* ★ 两层：外层摆位置（transform 属性）、内层被 anime 动，小球不会跳到画布角落。 */
var marker = pivot(pxOf(weights[0]), pyOf(losses[0]));
marker.setAttribute('class', 'k12-node k12-node--accent');
var ball = Sandbox.svgEl('circle');
ball.setAttribute('class', 'k12-node-body');
ball.setAttribute('r', '11');
marker.appendChild(ball);
var targetLine = Sandbox.link({ x: pxOf(DATA.target), y: area.y }, { x: pxOf(DATA.target), y: area.originY }, { style: 'dashed' });
off(targetLine);
function place(step) {
  moveSeat(marker, pxOf(weights[step]), pyOf(losses[step]));
}
place(0);
var flag = flagAt(pxOf(DATA.target), pyOf(lossAt(DATA.target)), DATA.flag);
off(flag);
var litUp = 0;
var wMeter = L.one('w-meter');
var lMeter = L.one('l-meter');
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var draw = [push(wMeter, weights[0]), push(lMeter, losses[0]), riseIn(marker, -16)];
      for (i = 0; i < segments.length; i += 1) {
        draw.push(later({ targets: segments[i], opacity: [0, 0.42], duration: d(0.6), easing: M.easing }, h.stagger * i / 2500));
      }
      return draw;
    }
    if (index === 1) {
      h.caption('先挑一个起点：参数 ' + weights[0] + '，要压小的数是 ' + losses[0] + '。');
      return [bump(marker), push(wMeter, weights[0]), push(lMeter, losses[0])];
    }
    if (index <= STEPS + 1) {
      var step = index - 1;
      h.caption(ROWS[(step - 1) % N].caption + '：参数 ' + weights[step] + '，要压小的数 ' + losses[step]);
      h.step(index - 1, STEPS, '步');
      var trail = [], upto = Math.min(segments.length, Math.round(segments.length * step / STEPS)), k;
      for (k = litUp; k < upto; k += 1) {
        trail.push({ targets: segments[k], opacity: [0.32, 1], duration: d(0.7), easing: M.easing });
        trail.push({ targets: railLine(segments[k]), strokeWidth: [1.2, 2.6], duration: d(0.7), easing: M.easing });
      }
      litUp = upto;
      trail.push({
        targets: marker,
        translateX: [pxOf(weights[step - 1]) - pxOf(weights[0]), pxOf(weights[step]) - pxOf(weights[0])],
        translateY: [pyOf(losses[step - 1]) - pyOf(losses[0]), pyOf(losses[step]) - pyOf(losses[0])],
        scale: [1, 0.88],
        duration: d(1.1),
        easing: M.easing
      });
      trail.push(push(wMeter, weights[step]));
      trail.push(push(lMeter, losses[step]));
      return trail;
    }
    h.caption(DATA.stopLine + '：' + DATA.summary + '（走了 ' + STEPS + ' 步）');
    h.step(STEPS, STEPS, '步');
    var end = [];
    for (i = litUp; i < segments.length; i += 1) {
      end.push({ targets: segments[i], opacity: [0.32, 1], duration: d(0.7), easing: M.easing });
      end.push({ targets: railLine(segments[i]), strokeWidth: [1.2, 2.6], duration: d(0.7), easing: M.easing });
    }
    end.push({ targets: targetLine, opacity: [0, 1], duration: d(1), easing: M.easing });
    end.push({ targets: flag, opacity: [0, 1], scale: [0.7, 1], duration: d(0.9), easing: M.easing });
    end.push(mark(ball));
    end.push(bump(ball));
    end.push(push(wMeter, weights[STEPS]));
    end.push(push(lMeter, losses[STEPS]));
    return end;
  }));
});
'''

CORE_COUNTER = r'''
var L = Sandbox.layout(__PLAN__);
anchorCells(L);
var TIMES = {{times}};
var COUNT = Math.min(TIMES, N);
var cards = L.list('say');
var pegs = L.list('peg');
var countMeter = L.one('count-meter');
var sumMeter = L.one('sum-meter');
var i, running = 0, total = 0;
for (i = 0; i < cards.length; i += 1) {
  off(cards[i]);
  if (i >= COUNT) cards[i].setAttribute('display', 'none');
}
for (i = 0; i < pegs.length; i += 1) {
  off(pegs[i]);
  if (i >= COUNT) pegs[i].setAttribute('display', 'none');
}
for (i = 0; i < COUNT; i += 1) total += ROWS[i].event.length;
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      var open = [push(countMeter, 0), push(sumMeter, 0)];
      for (i = 0; i < COUNT; i += 1) {
        open.push(later({ targets: pegs[i], opacity: [0, 0.45], translateY: [10, 0], duration: d(0.9), easing: M.easing }, h.stagger * i / 2000));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      running += ROWS[i].event.length;
      h.caption(ROWS[i].caption + '：这一句 ' + ROWS[i].event.length + ' 个字，合计 ' + running + ' 字');
      h.step(index, COUNT, '次');
      var anims = [];
      /* ★ 计数卡是同位轮换：上一张先退场（排最前，顺序即时间，见对话原型的说明）。 */
      if (i > 0) {
        anims.push(swapOut(cards[i - 1]));
      }
      anims.push(later(riseIn(cards[i], 20), HANDOFF_IN));
      anims.push(fadeTo(pegs[i], 1));
      anims.push(mark(pegs[i].body));
      anims.push(bump(pegs[i]));
      anims.push(focusStep(pegs[i], pegs[i - 1]));
      anims.push(push(countMeter, i + 1));
      anims.push(push(sumMeter, running));
      if (i > 0) {
        anims.push(later(fadeTo(pegs[i - 1], 0.66), 0.5));
      }
      return anims;
    }
    h.caption(DATA.close + '（数了 ' + COUNT + ' 次，合计 ' + total + ' 字）');
    h.step(COUNT, COUNT, '次');
    var all = [focusClear(pegs)];
    for (i = 0; i < COUNT; i += 1) {
      all.push(later(mark(pegs[i].body), h.stagger * i / 1000));
      all.push(later(fadeTo(pegs[i], 1), h.stagger * i / 1000));
      all.push(later(bump(pegs[i]), h.stagger * i / 1000));
    }
    all.push(push(countMeter, COUNT));
    all.push(push(sumMeter, total));
    return all;
  }));
});
'''


# --------------------------------------------------------------------------- #
# 原型表：skin / phases / params / payload / core
#
# phases = ("literal", N) 或 ("expr", "JS 表达式", 最少相位, 默认相位)
#   · 最少相位 = 参数取最小值时的相位数（守卫按它判「≥4 / ≥5」）
#   · 默认相位 = 参数取默认值时的相位数（用来估 duration_ms）
# --------------------------------------------------------------------------- #
ARCHETYPES: dict[str, dict] = {
    "scene": {
        "skin": "illustrated",
        "hint": "跟着小向导走一遍，一站一件事",
        "chip": "准备出发",
        "aria": "场景推进动画：角色在几个站点之间走动",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "stations": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "走几站（每站一句教材原话）"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_SCENE,
    },
    "dialogue": {
        "skin": "illustrated",
        "hint": "两个人一问一答，把它说清楚",
        "chip": "准备开讲",
        "aria": "角色对话动画：两个人一问一答",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "rounds": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "问答几轮"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_DIALOGUE,
    },
    "contrast_kid": {
        "skin": "illustrated",
        "hint": "左右两栏并排照一照",
        "chip": "准备对照",
        "aria": "对照动画：左右两栏并排比较",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "pairs": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "比几组"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_CONTRAST_KID,
    },
    "accumulate_kid": {
        "skin": "illustrated",
        "hint": "一件一件放进去，看它多起来",
        "chip": "准备攒",
        "aria": "累积动画：方块一层层往上加",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "items": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "往上加几块"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_ACCUMULATE_KID,
    },
    "checklist_kid": {
        "skin": "illustrated",
        "hint": "一条条对，对了就打钩",
        "chip": "准备核对",
        "aria": "要点核对动画：清单逐条打勾",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "checks": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "核对几条"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_CHECKLIST_KID,
    },
    "flow": {
        "skin": "technical",
        "hint": "跟着数据往前走，看它到哪一步",
        "chip": "准备进管道",
        "aria": "流程动画：数据在管道里逐段流动",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "stages": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "经过几段"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_FLOW,
    },
    "compare": {
        "skin": "technical",
        "hint": "两条路线并排，一行行比",
        "chip": "准备对照",
        "aria": "对比动画：两条路线并排逐行比较",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 5),
        "params": {
            "pairs": {"type": "int", "min": 3, "max": 4, "default": 3, "description": "比几行"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_COMPARE,
    },
    "layers": {
        "skin": "technical",
        "hint": "从底往上，一层层垒",
        "chip": "准备搭层",
        "aria": "层级动画：一层层自下而上搭起来",
        "pace": "pace",
        "phases": ("expr", "COUNT + 2", 5, 6),
        "params": {
            "layers": {"type": "int", "min": 3, "max": 4, "default": 4, "description": "搭几层"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_LAYERS,
    },
    "loop": {
        "skin": "technical",
        "hint": "同一件事跑很多遍，每遍数一次",
        "chip": "准备转圈",
        "aria": "循环动画：同一段步骤反复执行并计数",
        "pace": "speed",
        "phases": ("expr", "TIMES + 2", 5, 6),
        "params": {
            "times": {"type": "int", "min": 3, "max": 6, "default": 4, "description": "转几圈（每圈带走一个步骤）"},
            "speed": {"type": "float", "min": 0.6, "max": 2.0, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_LOOP,
    },
    "tree": {
        "skin": "technical",
        "hint": "一路问下去，问到底",
        "chip": "准备判定",
        "aria": "判定树动画：逐个条件分支走到结论",
        "pace": "pace",
        "phases": ("expr", "ROUNDS + 3", 5, 6),
        "params": {
            "rounds": {"type": "int", "min": 2, "max": 3, "default": 3, "description": "判断几个条件"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_TREE,
    },
    "network": {
        "skin": "technical",
        "hint": "信号从左边一层层传到右边",
        "chip": "准备计算",
        "aria": "网络动画：带权重的连线逐层传播信号",
        "pace": "pace",
        "phases": ("literal", 8),
        "params": {
            "units": {"type": "int", "min": 2, "max": 3, "default": 3, "description": "中间层放几个单元"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_NETWORK,
    },
    "matrix": {
        "skin": "technical",
        "hint": "一格一格扫过去，看谁最亮",
        "chip": "准备扫格",
        "aria": "矩阵动画：逐格扫描网格里的数值并报出位置",
        "pace": "pace",
        "phases": ("literal", 6),
        "params": {
            "size": {"type": "int", "min": 4, "max": 6, "default": 6, "description": "网格有几列"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_MATRIX,
    },
    "trace": {
        "skin": "technical",
        "hint": "看着小球滑到最低点",
        "chip": "准备起跑",
        "aria": "轨迹动画：沿曲线逐点下降并读数值",
        "pace": "rate",
        "phases": ("expr", "STEPS + 3", 7, 9),
        "params": {
            "steps": {"type": "int", "min": 4, "max": 8, "default": 6, "description": "往下走几步"},
            "rate": {"type": "float", "min": 0.1, "max": 1.2, "default": 0.4, "description": "每步走多大（步长倍数，太大会来回震荡）"},
        },
        "core": CORE_TRACE,
    },
    "counter": {
        "skin": "technical",
        "hint": "数一遍，加一次",
        "chip": "准备计数",
        "aria": "计数动画：重复的同一件事带真实计数",
        "pace": "speed",
        "phases": ("expr", "TIMES + 2", 5, 6),
        "params": {
            "times": {"type": "int", "min": 3, "max": 6, "default": 4, "description": "数几次"},
            "speed": {"type": "float", "min": 0.6, "max": 2.0, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_COUNTER,
    },
}

#: 相位里「最慢的那条动画」相对 motion.duration 的倍数（估 duration_ms 用）。
PHASE_WORK = {
    "scene": 1.4, "dialogue": 1.2, "contrast_kid": 1.1, "accumulate_kid": 1.1, "checklist_kid": 1.1,
    "flow": 1.3, "compare": 1.1, "layers": 1.1, "loop": 3.4, "tree": 1.1, "network": 1.1,
    "matrix": 1.0, "trace": 1.2, "counter": 1.2,
}


# --------------------------------------------------------------------------- #
# （概念 × 学段）→ 原型
#
# 小学两档挑插画系原型、初中高中挑工程系原型；同一个概念在不同学段拿到不同原型
# （低年级叙事、高年级结构），这是「按学段切换看得出差别」的一半。另一半是皮肤
# 与配色（由服务端注入的 data-grade / data-skin 决定）。
# --------------------------------------------------------------------------- #
#: 概念级覆盖：``base -> {学段短码: 原型}``。没点名的学段走章节默认。
CONCEPT_ARCHETYPE: dict[str, dict[str, str]] = {
    # 第 1 章 基础概念
    "ai-definition": {"pl": "dialogue", "ph": "scene", "jr": "compare", "sr": "compare"},
    "ai-hierarchy": {"pl": "accumulate_kid", "ph": "layers", "jr": "layers", "sr": "layers"},
    "ai-three-values": {"pl": "scene", "ph": "accumulate_kid", "jr": "layers", "sr": "layers"},
    "genai": {"pl": "scene", "ph": "dialogue", "jr": "flow", "sr": "flow"},
    "narrow-ai": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    "strong-ai-agi": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    # 第 2 章 底层支柱
    "data": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "trace", "sr": "trace"},
    "algorithm": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "counter"},
    "computing-power": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "trace", "sr": "trace"},
    "data-processing": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"},
    "hardware-accelerator": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "network"},
    # 第 3 章 核心技术分支
    "machine-learning": {"pl": "scene", "ph": "dialogue", "jr": "trace"},
    "deep-learning": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "layers", "sr": "layers"},
    "neural-network": {"pl": "scene", "ph": "scene"},
    "artificial-neuron": {"pl": "scene", "ph": "scene"},
    "computer-vision": {"pl": "scene", "ph": "dialogue"},
    "nlp": {"pl": "scene", "ph": "dialogue", "jr": "flow", "sr": "flow"},
    "speech-recognition": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "matrix"},
    "speech-synthesis": {"pl": "scene", "ph": "dialogue", "jr": "flow", "sr": "matrix"},
    "transformer": {"pl": "accumulate_kid", "ph": "scene", "jr": "network", "sr": "network"},
    "token": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "counter", "sr": "counter"},
    "supervised-learning": {"pl": "contrast_kid"},
    "unsupervised-learning": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    "reinforcement-learning": {"pl": "scene", "ph": "scene", "jr": "loop", "sr": "trace"},
    "long-term-memory": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "layers", "sr": "layers"},
    "short-term-memory": {"pl": "dialogue", "ph": "dialogue", "jr": "flow", "sr": "flow"},
    # 第 4 章 大模型与智能体
    "llm": {"pl": "dialogue", "ph": "dialogue", "jr": "flow", "sr": "network"},
    "prompt": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "compare"},
    "rag": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"},
    "agent-perception": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"},
    "agent-planning": {"pl": "checklist_kid", "ph": "scene", "jr": "tree", "sr": "tree"},
    "agent-action": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"},
    "agent-reflection": {"pl": "dialogue", "ph": "dialogue", "jr": "loop", "sr": "loop"},
    "agent-tool-use": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"},
    # 第 5 章 应用领域
    "aigc-media": {"pl": "scene", "ph": "dialogue", "jr": "matrix", "sr": "matrix"},
    "autonomous-driving": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "network"},
    "edu-agent": {"pl": "dialogue", "ph": "dialogue", "jr": "flow", "sr": "tree"},
    "edu-mistake-review": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "loop", "sr": "loop"},
    "edu-notes-mindmap": {"pl": "accumulate_kid", "ph": "accumulate_kid", "jr": "tree", "sr": "tree"},
    "edu-preview-review": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "loop", "sr": "loop"},
    "edu-qa": {"pl": "dialogue", "ph": "dialogue", "jr": "flow", "sr": "flow"},
    "industrial-inspection": {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "matrix"},
    "medical-imaging": {"pl": "scene", "ph": "scene", "jr": "matrix", "sr": "matrix"},
    "voice-assistant": {"pl": "dialogue", "ph": "dialogue", "jr": "flow", "sr": "flow"},
    # 第 6 章 局限性
    "limit-hallucination": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    "limit-knowledge-cutoff": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "trace", "sr": "trace"},
    "limit-interaction": {"pl": "dialogue", "ph": "dialogue", "jr": "compare", "sr": "compare"},
    "limit-teaching": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    "limit-understanding": {"pl": "dialogue", "ph": "dialogue", "jr": "compare", "sr": "compare"},
    # 第 7 章 伦理与安全
    "ethics-anti-misuse": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "tree", "sr": "tree"},
    "ethics-fairness": {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"},
    "ethics-information": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "tree", "sr": "tree"},
    "ethics-privacy": {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "tree", "sr": "tree"},
    # 第 8 章 编程实践
    "prog-variable": {"pl": "scene", "ph": "accumulate_kid"},
    "prog-loop": {"pl": "scene", "ph": "counter"},
    "prog-list": {"pl": "accumulate_kid"},
}

#: 章节默认：概念级表没盖到的（学段短码 → 原型）。
CHAPTER_DEFAULT: list[tuple[str, dict[str, str]]] = [
    ("第1章", {"pl": "scene", "ph": "dialogue", "jr": "compare", "sr": "compare"}),
    ("第2章", {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"}),
    ("第3章", {"pl": "scene", "ph": "scene", "jr": "layers", "sr": "layers"}),
    ("第4章", {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"}),
    ("第5章", {"pl": "scene", "ph": "scene", "jr": "flow", "sr": "flow"}),
    ("第6章", {"pl": "contrast_kid", "ph": "contrast_kid", "jr": "compare", "sr": "compare"}),
    ("第7章", {"pl": "checklist_kid", "ph": "checklist_kid", "jr": "tree", "sr": "tree"}),
    ("第8章", {"pl": "scene", "ph": "scene", "jr": "counter", "sr": "counter"}),
]

#: 对话原型里两个角色的名字（写在气泡与人物标签上）。
DATA = {"ask_who": "小问", "answer_who": "小答"}


def pick_archetype(entry: dict, grade: str, item: dict) -> str:
    """（概念 × 学段）→ 原型。概念级表 → 章节默认 → 兜底。"""
    short = GRADE_SHORT[grade]
    chosen = CONCEPT_ARCHETYPE.get(entry["base"], {}).get(short)
    if not chosen:
        chapter = entry.get("chapter_title") or ""
        for prefix, mapping in CHAPTER_DEFAULT:
            if chapter.startswith(prefix):
                chosen = mapping[short]
                break
    if not chosen:
        chosen = "scene" if short in ("pl", "ph") else "flow"
    # 对话原型靠教材的「想一想」撑：那一档没有疑问句时退回场景推进。
    if chosen == "dialogue" and not _lines_matching(item, "想一想"):
        chosen = "scene"
    return chosen


# --------------------------------------------------------------------------- #
# 组装
# --------------------------------------------------------------------------- #
def duration_ms_for(archetype: str, grade: str, kp_id: str) -> int:
    """按「相位数 × 每相位实际动画长度 + 相位停顿」估算播放时长，再在区间内稳定抖动。

    ★ 抖动是**区间内的比例**，不是固定毫秒：估算值被上下界夹住时（loop 这种每圈都很慢的
      原型会被上界夹住），固定 ±300ms 会被夹成同一个数 —— 实测旧写法下 7 份 loop 全是
      7600，等于没有「一概念一节奏」。比例抖动保证即使被夹住，值仍然按 kp 稳定散布。
    """
    skin = GRADE_SKIN[grade]
    kind = ARCHETYPES[archetype]["phases"]
    phases = kind[1] if kind[0] == "literal" else kind[3]
    motion = MOTION[skin]
    estimate = phases * motion["duration"] * PHASE_WORK[archetype] + max(0, phases - 1) * motion["holdMs"]
    low, high = DURATION_RANGES[(archetype, skin)]
    digest = hashlib.sha256((archetype + kp_id).encode("utf-8")).hexdigest()
    # 0.00 ~ 1.00 的稳定伪随机（只依赖原型 + kp，重跑结果一致）
    roll = int(digest[:8], 16) % 1000 / 1000.0
    span = high - low
    if estimate >= high:
        value = high - roll * span * 0.12
    elif estimate <= low:
        value = low + roll * span * 0.12
    else:
        margin = min(estimate - low, high - estimate, span * 0.12)
        value = estimate + (roll * 2 - 1) * margin
    return int(round(max(low, min(high, value)) / 4.0) * 4)  # 收成 4ms 的倍数，读数整洁


def fallback_text(entry: dict, grade: str) -> str:
    """降级文案：整句拼，接近上限就**停**（不切句）。"""
    item = entry["by_grade"][grade]
    name = clean_text(item.get("name") or entry["name"])
    parts = ["（{0}讲法）{1}".format(GRADE_LABEL[grade], name)]
    summary = clean_text(item.get("summary") or "")
    if summary:
        parts.append("：{0}".format(summary))
    for text in _sentences(item)[:3]:
        if sum(len(part) for part in parts) + len(text) > 340:
            break
        parts.append(" {0}。".format(text))
    return "".join(parts).strip()


def build_data(entry: dict, grade: str, archetype: str) -> dict:
    return PAYLOADS[archetype](entry, grade)


def check_placeholders(name: str, body: str, script: str, params: dict) -> None:
    """占位符集合必须**两个方向都相等**（模板加载器与守卫都按这条查）。"""
    used = set(re.findall(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", body + "\n" + script))
    assert used == set(params), "{0}: 占位符 {1} ≠ 参数 {2}".format(name, sorted(used), sorted(params))


def check_text(name: str, text: str) -> None:
    """内容卫生：省略号与三种排版标记一个都不许有（守卫同样盯着）。"""
    assert "…" not in text and "..." not in text, "{0} 出现省略号：{1}".format(name, text[-40:])
    for mark in MARKS:
        assert mark not in text, "{0} 出现排版标记 {1}".format(name, mark)


def build_template(entry: dict, grade: str, archetype: str) -> dict:
    """一份**概念级**模板（57 份）：文案按 ``grade`` 写，``kp_ids`` 盖该概念的四个学段。"""
    item = entry["by_grade"][grade]
    spec = ARCHETYPES[archetype]
    data = build_data(entry, grade, archetype)
    title = TITLE_SHAPE[archetype].format(entry["name"])
    template = {
        "id": re.sub(r"[^a-z0-9-]+", "-", entry["base"].lower())[:60],
        "label": entry["name"],
        "title": title,
        "concept": entry["name"],
        "kp_ids": [entry["by_grade"][g]["kp_id"] for g in GRADE_LEVELS if g in entry["by_grade"]],
        "grade_levels": [g for g in GRADE_LEVELS if g in entry["by_grade"]],
        "duration_ms": duration_ms_for(archetype, grade, item["kp_id"]),
        "params": spec["params"],
        "body": body_html(title, spec["hint"], spec["aria"], spec["chip"]),
        "script": script_for(
            archetype, spec["pace"], phases_expr(archetype), GRADE_SKIN[grade], data
        ).replace("__DATA__", json.dumps(data, ensure_ascii=False)),
        "fallback_text": fallback_text(entry, grade),
        "archetype": archetype,
        "skin": GRADE_SKIN[grade],
    }
    check_placeholders(template["id"], template["body"], template["script"], template["params"])
    check_text(template["id"], template["body"] + template["script"] + template["title"])
    check_lines(template["id"], template["script"])
    assert len(template["fallback_text"]) >= 30, template["id"] + " 降级文案太短"
    check_step_coordinate(template["id"], template["script"])
    return template


def build_by_kp(entry: dict, grade: str, archetype: str, template_id: str) -> dict:
    item = entry["by_grade"][grade]
    spec = ARCHETYPES[archetype]
    data = build_data(entry, grade, archetype)
    title = TITLE_SHAPE[archetype].format(item.get("name") or entry["name"])
    by = {
        "kp_id": item["kp_id"],
        "grade_level": grade,
        "name": item.get("name") or entry["name"],
        "concept": entry["name"],
        "template_id": template_id,
        "archetype": archetype,
        "skin": GRADE_SKIN[grade],
        "title": title,
        "open_caption": data["open"],
        "close_caption": data["close"],
        "steps": data["rows"],
        "data": data,
        "fallback_text": fallback_text(entry, grade),
        "duration_ms": duration_ms_for(archetype, grade, item["kp_id"]),
        "params": spec["params"],
    }
    by["body"] = body_html(title, spec["hint"], spec["aria"], spec["chip"])
    by["script"] = script_for(
        archetype, spec["pace"], phases_expr(archetype), GRADE_SKIN[grade], data
    ).replace("__DATA__", json.dumps(data, ensure_ascii=False))
    check_placeholders(item["kp_id"], by["body"], by["script"], by["params"])
    check_text(item["kp_id"], by["body"] + by["script"] + by["title"] + by["fallback_text"])
    check_lines(item["kp_id"], by["script"])
    check_step_coordinate(item["kp_id"], by["script"])
    assert len(by["fallback_text"]) >= 30, item["kp_id"] + " 降级文案太短"
    return by


def main() -> None:
    payload = json.loads(INPUT.read_text(encoding="utf-8"))
    OUT_T.mkdir(parents=True, exist_ok=True)
    OUT_K.mkdir(parents=True, exist_ok=True)
    for path in list(OUT_T.glob("*.json")) + list(OUT_K.glob("*.json")):
        path.unlink()

    written = 0
    covered = 0
    by_kp = 0
    concept_mix: dict[str, int] = {}
    grade_mix: dict[str, int] = {}
    for entry in payload["concepts"]:
        grades = [g for g in GRADE_LEVELS if g in entry["by_grade"]]
        if not grades:
            continue
        anchor = "junior" if "junior" in grades else grades[-1]
        archetype = pick_archetype(entry, anchor, entry["by_grade"][anchor])
        template = build_template(entry, anchor, archetype)
        public = {key: value for key, value in template.items() if key not in ("archetype", "skin")}
        (OUT_T / "{0}.json".format(template["id"])).write_text(
            json.dumps(public, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        written += 1
        covered += len(template["kp_ids"])
        concept_mix[archetype] = concept_mix.get(archetype, 0) + 1

        for grade in grades:
            item = entry["by_grade"][grade]
            grade_arch = pick_archetype(entry, grade, item)
            by = build_by_kp(entry, grade, grade_arch, template["id"])
            (OUT_K / "{0}.json".format(item["kp_id"])).write_text(
                json.dumps(by, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
            by_kp += 1
            grade_mix[grade_arch] = grade_mix.get(grade_arch, 0) + 1

    print("concept templates: {0}, kp covered: {1}".format(written, covered))
    print("by-kp files: {0}".format(by_kp))
    print("concept archetypes: {0}".format(json.dumps(concept_mix, ensure_ascii=False, sort_keys=True)))
    print("by-kp archetypes:   {0}".format(json.dumps(grade_mix, ensure_ascii=False, sort_keys=True)))


if __name__ == "__main__":
    main()
