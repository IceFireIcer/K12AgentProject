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
MOTION = {
    "illustrated": {"duration": 720, "holdMs": 620},
    "technical": {"duration": 460, "holdMs": 380},
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
JUNK_MARKERS = ("参见", "见第", "如上表", "如下表", "本节", "上一节", "下一节")
#: 学生可见文案禁用的三种排版标记（D-076 / P-123）。
MARKS = ("——", "**", "`")


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


def _tag(text: str, budget: int, fallback: str, widen: int = 4, strict: bool = False) -> str:
    """节点上的**短标签**：先把整句收成完整小句，收不下就取名头，最后才用通用兜底名。

    ★★ 为什么标签要有预算（实测踩到）：节点标签**折成两行会把行高从 61.5 涨到 86.9**，
      判定链 5 行叠起来就顶穿步骤条。所以标签这一层要有长度意识。

    ★ 但**长度不能盖过意思**：旧版直接 ``name[:8]`` 把「硬件载体：GPU / CPU / TPU」切成
      「硬件载体：GPU 」—— 那才是学生看不懂的根源。所以顺序是
        ① 预算内的**完整小句**；② 预算内的名头；③ 放宽 ``widen`` 字的名头
        （宁可行高多一档，也不给学生一个看不懂的标签）；④ 实在没有可用形式才用兜底名。
      整句一个字都不少：它在 caption 与 ``<title>``（悬停全文）里。

    ★★ 兜底名（「第 2 段」「第 3 条」）是**给排版用的序号占位**，不是给学生看的内容 ——
      实测缺陷：strict 分支在「预算内拼不出短句」时直接返回它，于是画布上出现一片
      「第 2 段」「第 3 段」的板子（153 处），学生完全不知道那几段在讲什么。
      现在只有在 ``text`` **本身就是空**（真的没有内容可用）时才用兜底名；
      有内容就一定给出内容（宁可折行、宁可缩字号）。
    """
    value = clean_text(text)
    if not value:
        return fallback
    # ★ `strict=True`：这一层不允许折行（行高必须可预测），收不进去就用 ``fallback``。
    #   所以 **``fallback`` 必须是学生看得懂的角色名**（「输入一」「第 3 层」这类），
    #   而不是排版占位符；整句仍然在 caption 与悬停全文里。
    limits = (budget,) if strict else (budget, budget + widen)
    for limit in limits:
        short = _phrase(value, limit)
        if len(short) <= limit:
            return short
        head = _head(value, limit)
        if len(head) <= limit:
            return head
    if strict:
        return fallback
    # 非 strict 的入口有竖直余量：宁可折行也不给占位名（实测：这里漏出过 153 处
    # 「第 N 段」「第 N 条」那种谁也看不懂的板子，因为调用方把 strict 当默认用了）。
    return _head(value, budget + widen + 8) or value


def _select(pool: list[str], count: int, budget: int, backup: list[str]) -> list[str]:
    """按「整句」挑 ``count`` 条，优先短句（不超过 ``budget`` 字）；不够就放宽，最后才用兜底句。

    ★ 绝不切句：宁可换一句更短的，也不把一句话砍成半截。
    """
    picked: list[str] = []
    for limit in (budget, budget + 12, 10**6):
        for text in pool:
            if text in picked or len(text) > limit:
                continue
            picked.append(text)
            if len(picked) >= count:
                return picked
    for text in backup:
        if len(picked) >= count:
            break
        if text and text not in picked:
            picked.append(text)
    # ★★ **绝不靠复制凑数**（实测缺陷：`compare` 的左栏只有一句可挑时，
    #   后两格复制了第一格 —— 画布上出现两块一模一样的板子，学生以为系统出错了）。
    #   挑不满就**少给几格**：`ROWS.length` 决定 N，`COUNT = min(参数, N)` 自动跟着变小，
    #   参数滑到更大值时也不会越界。
    return picked


def _head(text: str, budget: int) -> str:
    """概念的**完整**名字头：优先取冒号 / 括号前的主名（「硬件载体：GPU / CPU / TPU」→「硬件载体」）。

    ★ 绝不按字符切：拆不出更短的**完整**片段时**返回整名**，交给基元折行 + 缩字号。
    旧版这里写的是 ``name[:8]``，会把「硬件载体：GPU / CPU / TPU」切成「硬件载体：GPU 」——
    正是用户抱怨的那种「学生看不懂」的文案。
    """
    value = clean_text(text)
    if len(value) <= budget:
        return value
    for separator in ("：", ":", "（", "(", "、", "，", ",", " "):
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


def _two_tier(text: str, short_budget: int, long_budget: int, fallback: str = "") -> tuple[str, str]:
    """两级文案：**短标签** + **整句副标题**。两者永远不同（不同就只剩一个）。

    ★★ 实测缺陷一（「同一句话在框里印了两遍」）：旧写法拿两个 budget 去切同一段文字，
      原句只有 10 字时两次切出的是同一串，于是主标题与副标题一模一样。
      根因是**数据构造**：短标签与副标题是两个角色，不该由同一段文字兼任。

    ★★ 实测缺陷二（「盒子里空一片」）：``_phrase`` 对**没有标点可切**的长句会整句返回，
      于是长句（如 16 字的「执行模块就是智能体「会动手的手」」）被当成短标签塞进格子 ——
      标签超预算、副标题又因为「与标签相同」被清空，学生看到的是一个撑破行高、且毫无层次的框。
      所以标签**必须**守住预算：收不进去就用 `fallback`（如「第 2 站」），整句交给副标题。

    ★ 副标题只在**真的更长**时才出现（``long_budget`` 仍用于上限校验）。
    """
    value = clean_text(text)
    if not value:
        return fallback, ""
    short = _phrase(value, short_budget)
    # 收不进预算 → 用兜底名；**再不行就退回整句**。
    # ★ 绝不返回空标签：空标签在画布上就是一个**空白方框**（学生看到一块什么都没有的板子）。
    #   几处调用（contrast 的左右两栏）本来就没给 fallback，于是「切不出短句」直接变成空框。
    if not short or len(short) > short_budget:
        short = fallback or _head(value, short_budget) or value
    # 副标题取**比标签更完整、且在预算内**的那一句。
    # ★ 也必须守预算：副标题一长，整条带跟着长高，会把下面的带顶出安全区
    #   （`scene` 原型当场被 assert_clean 拦下）。整句进 caption 与悬停全文。
    long_ = _phrase(value, long_budget) if value != short else ""
    if not long_ or long_ == short or len(long_) > long_budget:
        return short, ""
    # ★★ 实测缺陷（用户看到的「同一句话在一个框里印了两遍」的另一半）：标签是整句的前缀时，
    #   框里就是「有一对「耳朵」／ 有一对「耳朵」，能听懂你说的话」—— 学生读到的是重复。
    #   把标签那一段从副标题里剪掉，副标题只承担**多出来的信息**。
    if long_.startswith(short):
        long_ = long_[len(short) :].lstrip("，,、；;：: ")
    if not long_:
        return short, ""
    return short, long_


def _sub_line(text: str, label: str, budget: int) -> str:
    """副标题：**预算内的完整小句**（标签已经用 ``_tag`` 单独取过时的入口）。

    ★ 为什么单独一个函数：这几条原型的标签走 ``_tag``（自带预算与兜底名），
      副标题只需要「比标签更完整的那一句」——旧写法却去调 ``_two_tier`` 拿第二个 budget，
      而没有标点可切的长句切出来与整句相同，于是被判成「重复」清成空串，
      盒子里就只剩一个标题（学生看不到完整那句）。

    ★ 预算仍然要守（实测踩到）：副标题一长，整条带就跟着长高，把下面的带顶出安全区
      （``scene`` 原型当场被 ``assert_clean`` 拦下）。**整句一个字都不少** ——
      它在 caption 与 ``<title>``（悬停全文）里，这正是那两处的职责。
    """
    value = clean_text(text)
    if not value or value == label:
        return ""
    candidate = _phrase(value, budget)
    if not candidate or candidate == label or len(candidate) > budget:
        return ""
    return candidate


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
SKIN_METRICS: dict[str, dict[str, float]] = {
    "illustrated": {
        "pad": 18.0,
        "node": 19.0,
        "node_sub": 14.0,
        "bubble": 16.5,
        "readout_label": 12.5,
        "readout_value": 27.0,
        "actor": 13.0,
    },
    "technical": {
        "pad": 13.0,
        "node": 16.0,
        "node_sub": 12.0,
        "bubble": 14.5,
        "readout_label": 11.5,
        "readout_value": 24.0,
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
function pivot(x, y) { var inner = Sandbox.svgEl('g'); at(fg(), x, y).appendChild(inner); return anchor(inner); }
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
function swapOut(el) { return { targets: el, opacity: [1, 0], duration: d(0.35), easing: 'linear' }; }
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
    var shim = {}, key, text = null, at = 0, total = 0;
    for (key in h) { if (Object.prototype.hasOwnProperty.call(h, key)) shim[key] = h[key]; }
    shim.caption = function (value) { text = value; return shim; };
    shim.step = function (value, count) { at = value; total = count; return shim; };
    var made = build(tl, index, shim);
    var list = made == null ? [] : (Object.prototype.toString.call(made) === '[object Array]' ? made.slice() : [made]);
    // step 先加、caption 后加 → 两者都在该相位的第一个 tick 触发（顺序只影响同一帧内谁后写）
    if (total) list.unshift({ targets: { t: 0 }, t: [0, 1], duration: 1, easing: 'linear', begin: function () { Sandbox.step(at, total); } });
    if (text != null) list.unshift({ targets: { t: 0 }, t: [0, 1], duration: 1, easing: 'linear', begin: function () { Sandbox.caption(text); } });
    return list;
  };
}
function say(text, at, total) {
  return {
    targets: { t: 0 },
    t: [0, 1],
    duration: 1,
    easing: 'linear',
    begin: function () { Sandbox.caption(text); Sandbox.step(at, total); }
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
    "scene": "{0}：跟着走一遍，一站一句",
    "dialogue": "{0}：一问一答搞明白",
    "contrast_kid": "{0}：两边比一比",
    "accumulate_kid": "{0}：一点点攒起来",
    "checklist_kid": "{0}：一条条对着核",
    "flow": "{0}：数据流经过的每一步",
    "compare": "{0}：两条路线并排看",
    "layers": "{0}：一层层搭起来",
    "loop": "{0}：同一段反复跑，边跑边计数",
    "tree": "{0}：逐条判断，走到结论",
    "network": "{0}：信号一层层算下去",
    "matrix": "{0}：网格里每个数都在变",
    "trace": "{0}：沿着曲线一步步读数",
    "counter": "{0}：做一次计一次数",
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
    """场景推进：几站，每站一句。站牌是**短标签**，副标题是**原句的完整小句**。

    ★ 两级文案走 ``_two_tier``：短标签与副标题取不到不同长度时**副标题留空** ——
      旧写法让同一段文字既当标题又当副标题，学生看到的是「一句话印两遍」。
    """
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    # 一行最多 4 站 → 每格 ~154px 宽，副标题的预算必须按这个宽度推（见 sub_budget 的说明）
    budget = sub_budget(cell_width(4, 12.0))
    rows = []
    for index, line in enumerate(lines):
        short, long_ = _two_tier(line, 8, budget, "第 {0} 站".format(index + 1))
        rows.append(
            {
                "station": short,
                "sub": long_,
                "line": line,
                "caption": ("先看第一站：" if index == 0 else "再走一站：") + line,
            }
        )
    return {
        # ★ 不写死「4 站」：stations 参数可以是 3 —— 文案里的数字必须与真跑的站点数一致，
        #   否则学生看到「四站走完」而动画只走了三站（参数就变成假的）。
        "open": "{0} 要一站一站走过去，每一站都是课本里的一句原话。".format(name),
        "close": "走完这几站，回到这一句：{0}".format(summary or name),
        "guide": "带路的同学",
        "rows": rows,
    }


@payload("dialogue")
def payload_dialogue(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    asks = _lines_matching(item, "想一想")
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    answers = _select(pool, 4, 34, [summary, name])
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
        rows.append({"ask": ask, "answer": answers[index]})
    return {
        "open": "{0} 和 {1} 一问一答，把 {2} 说明白。".format(DATA["ask_who"], DATA["answer_who"], name),
        "close": "问答到这里：{0}".format(summary or name),
        "askWho": DATA["ask_who"],
        "answerWho": DATA["answer_who"],
        "rows": rows,
    }


@payload("contrast_kid")
def payload_contrast_kid(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    asks = _lines_matching(item, "想一想")
    lefts = _select(pitfalls + asks, 4, 30, [summary])
    # 右栏排掉左栏已经用掉的句子（左右撞同一句 = 画布上同一段话印两遍）
    rights = _select([text for text in pool if text not in set(lefts)], 4, 32, [summary, name])
    # 两栏按**各自挑到的条数**出格（与 compare 同一个道理：挑不满就少给几格，
    # 既不复制同一句，也不越界）
    count = min(4, len(lefts), len(rights))
    rows = []
    for index in range(count):
        left, left_long = _two_tier(lefts[index], 12, 24)
        right, right_long = _two_tier(rights[index], 12, 24)
        rows.append(
            {
                "left": left,
                "leftMore": left_long,
                "right": right,
                "rightMore": right_long,
                "caption": "先放一放左边的想法：{0}".format(rights[index]),
            }
        )
    return {
        "open": "把 {0} 的两栏并排放在一起，一组一组看。".format(name),
        "close": "两栏看完，留下这一句：{0}".format(summary or name),
        "leftHeader": "容易想偏的说法",
        "rightHeader": "课本里的说法",
        "rows": rows,
    }


@payload("accumulate_kid")
def payload_accumulate_kid(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 28, [summary, name])
    rows = []
    for index, text in enumerate(lines):
        label = _tag(text, 12, "第 {0} 块".format(index + 1))
        rows.append(
            {
                "label": label,
                "text": _sub_line(text, label, 22),
                "caption": "第 {0} 块放上去：{1}".format(index + 1, text),
            }
        )
    return {
        "open": "架子是空的。{0} 这件事，是一点点攒出来的。".format(name),
        "close": "攒到这里：{0}".format(summary or name),
        "shelf": "底面",
        "unit": "块",
        "rows": rows,
    }


@payload("checklist_kid")
def payload_checklist_kid(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    rows = []
    for index, text in enumerate(lines):
        label = _tag(text, 12, "第 {0} 条".format(index + 1))
        rows.append(
            {
                "title": label,
                "detail": _sub_line(text, label, 20),
                "caption": "第 {0} 条要核对：{1}".format(index + 1, text),
            }
        )
    return {
        "open": "{0} 有几条是要一条条对着看的。".format(name),
        "close": "这几条都对一遍，就能记住：{0}".format(summary or name),
        "tick": "对",
        "rows": rows,
    }


@payload("flow")
def payload_flow(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    rows = []
    for index, text in enumerate(lines):
        # ★ 预算 6 → 12：4 列的格子只有 130px 宽（每行约 5 字），6 字预算必然放不下真实短句，
        #   于是旧版一路退到「第 2 段」这种占位名。给到 12 字 + 允许折两行，
        #   垂直空间够（包 50 + 段 ~87 + 读数 95 + 间距 = 252 < 356）。
        label = _tag(text, 12, "第 {0} 段".format(index + 1))
        rows.append(
            {
                "stage": label,
                "detail": _sub_line(text, label, 20),
                "caption": "数据流到第 {0} 段：{1}".format(index + 1, text),
            }
        )
    return {
        "open": "{0} 是一条管道，数据从左边进去，一段段走到右边。".format(name),
        "close": "出口这一步：{0}".format(summary or name),
        "packet": "数据",
        "rows": rows,
    }


@payload("compare")
def payload_compare(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    # ★ 4 行而不是 3 行：``pairs`` 参数（3~4）要真的能改变行数，
    #   否则那个参数在界面上是摆设（学生调了没反应 = 假参数）。
    lefts = _select(pitfalls, 4, 26, [summary])
    # 右栏排掉左栏已经用掉的句子（同上：两边撞同一句会印两遍）
    rights = _select(
        [text for text in _sentences(item) if text not in set(lefts)], 4, 26, [summary, name]
    )
    # ★★ 两栏**按各自能挑到的条数**出格（实测缺陷：左栏只挑到 1 句时，
    #   原先会给后三格塞「第 2 行左边」这类占位名 —— 那是给排版看的名字，
    #   印到学生眼前就是「第 1 行左边」这种谁也看不懂的板子）。
    count = min(4, len(lefts), len(rights))
    rows = [
        {
            # 标签守住 14 字预算；收不进去退回**整句**（`_tag` 的 strict 分支会给占位名，
            # 所以这里改用 `_phrase` + 整句兜底：宁可折行，也不印占位名）。
            "left": _phrase(lefts[index], 14) or lefts[index],
            "right": _phrase(rights[index], 14) or rights[index],
            "caption": "第 {0} 行：左边是「{1}」，右边是「{2}」。".format(
                index + 1, lefts[index], rights[index]
            ),
        }
        for index in range(count)
    ]
    return {
        "open": "{0} 有两条路线，并排放在一起看差别。".format(name),
        "close": "两边对照完，记住：{0}".format(summary or name),
        "leftHeader": "一条路线的做法",
        "rightHeader": "另一条路线的做法",
        "rows": rows,
    }


@payload("layers")
def payload_layers(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    rows = []
    for index, text in enumerate(lines):
        label = _tag(text, 12, "第 {0} 层".format(index + 1))
        rows.append(
            {
                "layer": label,
                "detail": _sub_line(text, label, 24),
                "caption": "第 {0} 层搭上去：{1}".format(index + 1, text),
            }
        )
    return {
        "open": "{0} 是一层层搭起来的，先从最底下那层看。".format(name),
        "close": "整座塔立起来了：{0}".format(summary or name),
        "hold": "每一层都站在下面那层的肩膀上，抽掉任何一层，上面的都不成立。",
        "base": "底面",
        "rows": rows,
    }


@payload("loop")
def payload_loop(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 30, [summary, name])
    # ★ 站点盒只有 110px 宽（每行约 4 字，两行 8 字），所以预算给 8 —— 但**不再用
    #   strict 占位名**：收不进去就退回整句让基元折行（盒子会按最长的那行高起来，
    #   跑道几何已按「最高那一种盒子」留过空间了，不会再顶出安全区）。
    rows = [
        {"stop": _tag(text, 8, "第 {0} 步".format(index + 1)), "line": text}
        for index, text in enumerate(lines)
    ]
    return {
        "open": "{0} 是一段被反复执行的代码，转一圈算一轮。".format(name),
        "close": "转完所有轮次：{0}".format(summary or name),
        "loopHead": "每一次重复",
        "rows": rows,
    }


@payload("tree")
def payload_tree(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    pitfalls = _lines_matching(item, "易错点") + _lines_matching(item, "辨析")
    asks = _select(pool, 4, 26, [summary, name])
    # ★★ 出口的候选池**排掉左边已经用掉的那些句子**（实测缺陷：`agent-planning-jr`
    #   的画布上两块板子印着同一句「真正的输出由执行模块完成」）。
    #   左边的池子是 `pool`，右边是 `pitfalls + pool[::-1]` —— 后者把同一批句子倒着再来一遍，
    #   于是左右两栏撞到同一句。同一个概念讲两遍不叫讲清楚，叫看起来没改完。
    exits = _select([text for text in (pitfalls + pool[::-1]) if text not in set(asks)], 4, 22, [summary])
    # ★★ 行数从 4 收到 3（实测缺陷：真实标签比占位名长，5 行 × 58 放不下）。
    #   原来靠「预算内的占位名」把每行压成一行，代价是画布上出现「第 2 个条件」这种
    #   谁也看不懂的板子（153 处）。**内容优先**：行数少一行，每行给真正的文字。
    #   三个条件对「逐条判断」已经够讲清楚，参数上限同步收到 3。
    count = min(3, len(asks), len(exits))
    rows = []
    for index in range(count):
        rows.append(
            {
                # 标签给到 12 字（一行放得下的上限），仍收不进去就退回**整句**让基元折行 ——
                # 占位名（「第 N 个条件」）只在真的没有内容时才用。
                "ask": _tag(asks[index], 12, "第 {0} 个条件".format(index + 1)),
                "pass": _tag(exits[index], 12, "第 {0} 条出口".format(index + 1)),
                "caption": "第 {0} 个条件：{1}（{2}）".format(index + 1, asks[index], exits[index]),
            }
        )
    return {
        "open": "把 {0} 想成一棵树：每个问题只有「是」和「否」两条路。".format(name),
        "close": "顺着走到底就是：{0}".format(summary or name),
        "root": _phrase(name, 12) or _head(name, 12),
        "yes": "是，继续往下",
        "no": "否，走另一条",
        "flags": [True, False, True, False],
        "rows": rows,
    }


@payload("network")
def payload_network(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    pool = _sentences(item)
    # 八个格子要八句**互不相同**的话（输入 3 + 隐层 3 + 输出 2）
    picked = _select(pool, 8, 24, [summary, name])
    # 池子不够时按序回落到角色名 —— 取不到就取不到，绝不复用同一句（那会印两遍）
    def pick_at(index: int, role: str) -> str:
        return _tag(picked[index], 6, role, strict=True) if index < len(picked) else role

    return {
        "open": "{0} 的输入先变成数字，再一层层算下去。".format(name),
        "close": "算到最后：{0}".format(summary or name),
        # ★★ 八格标签**必须互不相同**（实测缺陷：`transformer-sr` 的输入列与输出列
        #   都取了 `picked[0]`，画布上同一句话印在两个盒子里，看起来像复制粘贴没改完）。
        #   `_select` 保证池内不重复，所以这里只按序取不同的句子；池子不够时用角色名
        #   （输入一 / 单元一 / 结果这类），它是**这张图的本来语义**，不是排版占位符。
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
            {"label": pick_at(6, "结果")},
            {"label": pick_at(7, "另一种可能")},
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
MATRIX_COLS = 6
MATRIX_ROWS = 4


def matrix_cell(row: int, col: int) -> float:
    """格子的值（与旧版运行时同一条曲线：sin 造的平滑面，最亮的那格是真的最大值）。"""
    return round((math.sin(row * 1.3 + col * 0.8) + 1) / 2 * 0.82 + 0.18, 2)


@payload("matrix")
def payload_matrix(entry: dict, grade: str) -> dict:
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
            "detail": _phrase(text, 22),
            "caption": "扫过第 {0} 行：{1}".format(index + 1, text),
        }
        for index, text in enumerate(lines)
    ]
    return {
        "open": "{0} 可以摆成一张表格：每一格都是一个数。".format(name),
        "close": "整张表看完：{0}".format(summary or name),
        "brightest": "最亮的一格",
        "values": values,
        "best": best,
        "rows": rows,
    }


@payload("trace")
def payload_trace(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 4, 34, [summary, name])
    return {
        "open": "{0} 可以画成一条曲线：横轴是参数，竖轴是要压下去的那个数。".format(name),
        "close": "走到最低点附近：{0}".format(summary or name),
        "xLabel": "参数取值",
        "yLabel": "要压小的数",
        "start": 0.4,
        "target": 3.0,
        "curve": 0.5,
        "floor": 0.4,
        "rows": [{"caption": text} for text in lines],
    }


@payload("counter")
def payload_counter(entry: dict, grade: str) -> dict:
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = clean_text(item.get("summary") or name)
    lines = _select(_sentences(item), 6, 30, [summary, name])
    return {
        "open": "{0} 要一次一次地数，数到最后才知道总数。".format(name),
        "close": "数完了：{0}".format(summary or name),
        "totalLabel": "字数合计",
        "unit": "字",
        "rows": [{"event": text, "caption": "第 {0} 次：{1}".format(i + 1, text)} for i, text in enumerate(lines)],
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
    """「一行 N 站 + 小人沿路走过去」—— 站的列距固定，小人只沿路平移。"""
    rows = data["rows"]
    planner = Planner(skin)
    stops = planner.band("stops", gap=12.0)
    items = _cell_ids(rows[:4], "stop", ("station", "sub"))
    for index, item in enumerate(items):
        item["tone"] = "accent" if index == 0 else "base"
    stops.row(items)
    stops.spread("stop-", "stations", 3, 4)
    # 读数先建（它高度固定），才能把剩下的空间算给小人与路 —— 见 _fit_actor_scale
    meters = planner.band("meters", gap=12.0)
    meters.place("meter", kind="readout", w=250, label="走到第", value=0, unit="站")
    # ★ 不再要第二个「一共 N 站」读数：顶栏的步骤条已经写着「共 N 步」，
    #   同一个数字印两遍正是用户说的「看着乱」。
    scale = _fit_actor_scale(stops.bottom + meters.bottom, gap_total=12.0 * 2)
    road = planner.band("road", height=(96 + 30) * scale, gap=12.0)
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
    """「两个人一问一答」—— 左右各一栏气泡位，每轮换一次文案（同位轮换）。"""
    rows = data["rows"]
    planner = Planner(skin)
    qa = planner.band("qa", gap=12.0)
    asks = [{"text": row["ask"], "who": "accent", "tail": "left"} for row in rows[:4]]
    answers = [{"text": row["answer"], "who": "narrator", "tail": "right"} for row in rows[:4]]
    qa.row(
        [
            {"id": "ask", "kind": "bubble", "alts": asks},
            {"id": "answer", "kind": "bubble", "alts": answers},
        ],
        gap=40.0,
    )
    qa.spread("ask-", "rounds", 3, 4)
    floor = planner.band("floor", height=(96 + 30) * 0.92, gap=12.0)
    planner.actor("asker", 150, 96 * 0.92, pose="point", scale=0.92, label=data.get("askWho", ""), band="floor")
    planner.actor(
        "answerer", 570, 96 * 0.92, pose="stand", scale=0.92, label=data.get("answerWho", ""), band="floor"
    )
    meter = planner.band("meter", gap=12.0)
    meter.place("round-meter", kind="readout", w=260, label="问答", value=0, unit="轮")
    return planner


def plan_contrast_kid(skin: str, data: dict) -> Planner:
    """「两边比一比」—— 两个表头 + 两栏，每比一组换一次文案（同位轮换）。"""
    rows = data["rows"]
    planner = Planner(skin)
    heads = planner.band("heads", height=64.0, gap=12.0)
    heads.row(
        [
            {"id": "head-left", "label": data["leftHeader"], "tone": "muted"},
            {"id": "head-right", "label": data["rightHeader"], "tone": "accent"},
        ]
    )
    pairs = planner.band("pairs", gap=12.0)
    left = []
    right = []
    for index, row in enumerate(rows[:4]):
        left.append({"label": row["left"], "sub": row.get("leftMore"), "tone": "muted"})
        right.append({"label": row["right"], "sub": row.get("rightMore"), "tone": "accent"})
    pairs.row([{"id": "left", "alts": left}, {"id": "right", "alts": right}])
    pairs.spread("left-", "pairs", 3, 4)
    meter = planner.band("meter", gap=12.0)
    meter.place("pair-meter", kind="readout", w=300, label="已经对照", value=0, unit="组")
    return planner


def plan_accumulate_kid(skin: str, data: dict) -> Planner:
    """「一点点攒起来」—— 左边一块块往上摞，右边一块「记分牌」。"""
    rows = data["rows"]
    planner = Planner(skin)
    tower = planner.band("tower", height=356.0, gap=12.0)
    # ★ 自下而上的摞：**第 0 项在最底下**（见 Band.stack 的说明），所以底面先入列。
    blocks = [{"id": "shelf", "label": data.get("shelf", ""), "tone": "muted"}]
    for index, row in enumerate(rows[:4]):
        blocks.append({"id": "block-{0}".format(index), "label": row["label"], "tone": "base"})
    # ★ 只占左边一列（440 宽）：右边那列留给「已经攒了」的读数 ——
    #   塔身若铺满整幅宽，就会盖在读数框上（这正是旧版右下角读数被压住的那一类）。
    tower.stack(blocks, anchor="bottom", gap=10.0, spread=True, w=440.0)
    tower.spread("block-", "items", 3, 4)
    tower.place(
        "meter", kind="readout", w=180, align="right", valign="top", label="已经攒了", value=0, unit=data.get("unit", "")
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
    """「数据一段段流过去」—— 云朵形的一段段 + 之间的管道 + 走动的数据块。"""
    rows = data["rows"]
    planner = Planner(skin)
    packet = planner.band("packet", height=54.0, gap=10.0)
    packet.place("packet-box", kind="node", w=84, h=50, label=data.get("packet", ""), tone="accent")
    pipes = planner.band("pipes", gap=10.0)
    items = _cell_ids(rows[:4], "stage", ("stage", "detail"))
    items[0]["tone"] = "accent"
    pipes.row(items, gap=44.0)
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
    meter = planner.band("meter", gap=10.0)
    meter.place("flow-meter", kind="readout", w=240, label="流经", value=0, unit="段")
    return planner


def plan_compare(skin: str, data: dict) -> Planner:
    """「两条路线并排」—— 两个表头 + 一行一对，逐行点亮。"""
    rows = data["rows"]
    planner = Planner(skin)
    heads = planner.band("heads", height=60.0, gap=10.0)
    heads.row(
        [
            {"id": "head-left", "label": data["leftHeader"], "tone": "muted"},
            {"id": "head-right", "label": data["rightHeader"], "tone": "accent"},
        ]
    )
    bars = planner.band("bars", gap=10.0)
    lines = [
        [
            {"id": "left-{0}".format(index), "label": row["left"], "tone": "muted"},
            {"id": "right-{0}".format(index), "label": row["right"], "tone": "base"},
        ]
        for index, row in enumerate(rows[:4])
    ]
    bars.rows(lines, gap=10.0, spread=True)
    bars.spread("left-", "pairs", 3, 4)
    return planner


def plan_layers(skin: str, data: dict) -> Planner:
    """「一层层搭起来」—— 自下而上、逐层收窄的塔，右侧计数。

    ★ 塔身只写 ``layer`` 短标签：正文那一句走 caption 与悬停全文（``<title>``）——
      四层各带一段长副标题会把塔撑到 370+，整条带就得跟着长，底部必被步骤条吃掉。
    """
    rows = data["rows"]
    planner = Planner(skin)
    tower = planner.band("tower", height=356.0, gap=12.0)
    slabs = [
        {"id": "slab-{0}".format(index), "label": row["layer"], "sub": row.get("detail"), "tone": "muted" if index == 0 else "base"}
        for index, row in enumerate(rows[:4])
    ]
    tower.stack(slabs, anchor="bottom", inset=30.0, gap=10.0, w=470.0)
    tower.spread("slab-", "layers", 3, 4)
    tower.place("level-meter", kind="readout", w=160, align="right", valign="top", label="第", value=0, unit="层")
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
    chain.rows(lines, gap=10.0, spread=False, w=chain_w)
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
    net = planner.band("net", height=196.0, gap=10.0)
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
    _column(planner, net, ["input-{0}".format(i) for i in range(3)], inputs, in_subs, col_x[0], col_w, "base", (tallest - heights[0]) / 2)
    _column(planner, net, ["hidden-{0}".format(j) for j in range(3)], hidden, [""] * 3, col_x[1], col_w, "accent", (tallest - heights[1]) / 2)
    _column(planner, net, ["output-{0}".format(k) for k in range(2)], outputs, [""] * 2, col_x[2], col_w, "base", (tallest - heights[2]) / 2)
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
    # 连线说明写在图上（一行小字），而不是塞进读数框的标签（那会让读数框长高）
    # ★ 连线的说明不另外占一行（caption 里已经说了），省下的竖直空间留给下面三个读数 ——
    #   网络图本身就是三列 + 三读数，多一行文字就会把读数挤到安全区之外。
    net.bottom = max(net.bottom, tallest)
    meters = planner.band("meters", gap=12.0)
    meters.row(
        [
            {"id": "in-meter", "kind": "readout", "label": "输入", "value": "", "unit": ""},
            {"id": "hidden-meter", "kind": "readout", "label": "隐层算出来", "value": 0, "unit": ""},
            {"id": "out-meter", "kind": "readout", "label": "输出", "value": 0, "unit": ""},
        ]
    )
    # ★★ 竖直方向要**先算总账再摆**（实测缺陷：`transformer-sr` 的两个盒子压了 5px）。
    #   旧写法把三个读数放好之后再把 net 的整体高度压一压（等比缩 y 与 h）——
    #   那是**只改清单不改内容**：运行时按真实文字重新量高度，盒子又长回原样，
    #   于是压过界（清单说 77.3，画面上 89，正好压住下面那个）。
    #   正确做法是按**真实高度**保留每个盒子，只压缩**它们之间的空隙**；
    #   空隙压到下限还不放，就说明这一屏内容太多 —— 那种情况要让 payload 少给几行。
    meter_h = readout_needed("隐层算出来", (net.w - 24.0) / 3, skin)
    budget = (SAFE_BOTTOM - SAFE_TOP) - meter_h - meters.gap
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
    """「网格里每个数都在变」—— 一张表 + 两个均值读数。

    ★ 格子上的数字**在生成时就算好**（与运行时同一套算式，见 payload_matrix）：
      这样「最亮的一格」在规划期就定下来（tone=accent），运行时不需要重排文字 ——
      盒子里换文字意味着盒子可能变高，而变高就会压住下一行。
    """
    rows = data["rows"]
    planner = Planner(skin)
    grid = planner.band("grid", gap=12.0)
    size = int(len(data["values"][0]))
    row_count = len(data["values"])
    cell_w = 100.0
    cell_h = 50.0
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
    meters = planner.band("meters", gap=12.0)
    meters.row(
        [
            {"id": "row-meter", "kind": "readout", "label": rows[0].get("row", ""), "value": 0, "unit": ""},
            {"id": "all-meter", "kind": "readout", "label": data.get("brightest", ""), "value": 0, "unit": ""},
        ]
    )
    return planner


def plan_trace(skin: str, data: dict) -> Planner:
    """「沿着曲线一步步读数」—— 一张坐标图 + 两个读数。"""
    planner = Planner(skin)
    meters = planner.band("meters", gap=12.0)
    meters.row(
        [
            {"id": "w-meter", "kind": "readout", "label": "参数", "value": data.get("start", 0), "unit": ""},
            {"id": "l-meter", "kind": "readout", "label": data.get("yLabel", ""), "value": 0, "unit": ""},
        ],
        gap=24.0,
        x=286.0,
        w=400.0,
    )
    chart = planner.band("chart", height=240.0, gap=12.0)
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
    board.row(pegs, gap=12.0, x=34.0, w=430.0, y=250.0)
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
        if self._final:
            return
        self._final = True
        cursor = SAFE_TOP
        for band in self._order:
            content = band.bottom
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
                content = max(content, rect[1] + rect[3] - top)
            height = max(band.h, content)
            self.bands.append({"id": band.id, "x": band.x, "y": round(top, 2), "w": band.w, "h": round(height, 2)})
            cursor = top + height + band.gap
        self._final_bottom = cursor - (self._order[-1].gap if self._order else 0)

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
#   · `var L = Sandbox.layout(__PLAN__);` —— 建舞台，尺寸照单全收；
#   · `L.list('<前缀>')` 取一组（按编号排序，同位轮换的成员也在里面）；
#   · `L.one('<id>')` 取单件；`L.center('<id>')` 取盒子中心（连接线、走位都用它）；
#   · `off(...)` 先隐藏，相位里再 `riseIn/popIn/slideIn` 逐个亮 —— 学生看得见过程；
#   · 字幕 / 步骤条一律走 `defer(...)`（相位开始时才写，见 COMMON_JS 的说明）。
# --------------------------------------------------------------------------- #

CORE_SCENE = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{stations}}, N);
var stops = L.list('stop');
var road = L.one('road');
var guide = L.one('guide');
var meter = L.one('meter');
var i, prev = 0, startX = guide.k12Anchor.x;
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
      h.step(1, COUNT + 2);
      return [riseIn(road, 10), popIn(guide.k12Pivot), riseIn(stops[0], 24), mark(stops[0].body), push(meter, 1)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      var stop = L.center('stop-' + i).x - startX;
      var anims = [
        { targets: guide.k12Pivot, translateX: [prev, stop], duration: d(1.3), easing: M.easing },
        riseIn(stops[i], 18),
        mark(stops[i].body),
        push(meter, i + 1)
      ];
      prev = stop;
      if (i > 0) anims.push(dim(stops[i - 1]));
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) { all.push(bump(stops[i])); all.push(lit(stops[i])); }
    all.push(push(meter, COUNT));
    return all;
  }));
});
'''

CORE_DIALOGUE = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{rounds}}, N);
var asks = L.list('ask');
var answers = L.list('answer');
var asker = L.one('asker');
var answerer = L.one('answerer');
var meter = L.one('round-meter');
var i;
for (i = 0; i < asks.length; i += 1) {
  off(asks[i]);
  off(answers[i]);
  if (i >= COUNT) { asks[i].setAttribute('display', 'none'); answers[i].setAttribute('display', 'none'); }
}
off(actorOf(asker)); off(actorOf(answerer));
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      return [popActor(asker), popActor(answerer), push(meter, 0)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption('第 ' + (i + 1) + ' 轮：' + ROWS[i].answer);
      h.step(index + 1, COUNT + 2);
      var anims = [bumpActor(asker), bumpActor(answerer), push(meter, i + 1)];
      anims.push(later(slideIn(asks[i], -18), 0.15));
      anims.push(later(slideIn(answers[i], 18), 0.45));
      if (i > 0) {
        anims.push(swapOut(asks[i - 1]));
        anims.push(swapOut(answers[i - 1]));
      }
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    return [bump(asks[COUNT - 1]), bump(answers[COUNT - 1]), push(meter, COUNT)];
  }));
});
'''

CORE_CONTRAST_KID = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{pairs}}, N);
var leftHead = L.one('head-left');
var rightHead = L.one('head-right');
var leftCards = L.list('left');
var rightCards = L.list('right');
var meter = L.one('pair-meter');
var i;
for (i = 0; i < leftCards.length; i += 1) {
  off(leftCards[i]);
  off(rightCards[i]);
  if (i >= COUNT) { leftCards[i].setAttribute('display', 'none'); rightCards[i].setAttribute('display', 'none'); }
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      return [slideIn(leftHead, -26), slideIn(rightHead, 26), push(meter, 0)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      var anims = [
        later(riseIn(leftCards[i], 26), 0.05),
        later(riseIn(rightCards[i], 26), 0.25),
        mark(rightCards[i].body),
        push(meter, i + 1)
      ];
      if (i > 0) {
        anims.push(swapOut(leftCards[i - 1]));
        anims.push(swapOut(rightCards[i - 1]));
      }
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    return [
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
var COUNT = Math.min({{items}}, N);
var blocks = L.list('block');
var shelf = L.one('shelf');
var meter = L.one('meter');
var i;
for (i = 0; i < blocks.length; i += 1) {
  off(blocks[i]);
  if (i >= COUNT) blocks[i].setAttribute('display', 'none');
}
off(shelf);
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      return [riseIn(shelf, 12), push(meter, 0)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      var anims = [riseIn(blocks[i], 34), mark(blocks[i].body), push(meter, i + 1)];
      if (i > 0) anims.push({ targets: blocks[i - 1], scale: [1, 1.03, 1], duration: d(0.7), easing: M.easing });
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) all.push(later(bump(blocks[i]), h.stagger * i / 1000));
    all.push(mark(shelf.body));
    all.push(push(meter, COUNT));
    return all;
  }));
});
'''

CORE_CHECKLIST_KID = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{checks}}, N);
var meter = L.one('meter');
var items = L.list('item');
var ticks = L.list('tick');
var i;
for (i = 0; i < items.length; i += 1) {
  off(items[i]);
  off(ticks[i]);
  if (i >= COUNT) { items[i].setAttribute('display', 'none'); ticks[i].setAttribute('display', 'none'); }
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      var open = [push(meter, 0)];
      for (i = 0; i < COUNT; i += 1) {
        open.push(later(slideIn(items[i], -18), h.stagger * i / 1000));
        open.push(later({ targets: ticks[i], opacity: [0, 0.28], duration: d(0.5), easing: 'linear' }, h.stagger * i / 1000));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      return [mark(items[i].body), riseIn(ticks[i], 12), push(meter, i + 1)];
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) { all.push(later(bump(ticks[i]), h.stagger * i / 1000)); all.push(mark(items[i].body)); }
    all.push(push(meter, COUNT));
    return all;
  }));
});
'''

CORE_FLOW = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{stages}}, N);
var boxes = L.list('stage');
var pipes = L.list('pipe');
var packet = L.one('packet-box');
var meter = L.one('flow-meter');
var i, prev = 0;
var startX = packet.k12Box.x + packet.k12Box.w / 2;
for (i = 0; i < boxes.length; i += 1) {
  off(boxes[i]);
  if (i >= COUNT) boxes[i].setAttribute('display', 'none');
}
for (i = 0; i < pipes.length; i += 1) {
  off(pipes[i]);
  if (i >= COUNT) pipes[i].setAttribute('display', 'none');
}
off(packet);
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      var open = [push(meter, 0), riseIn(packet, -14)];
      for (i = 0; i < COUNT; i += 1) open.push(later(riseIn(boxes[i], 22), h.stagger * i / 1000));
      for (i = 0; i < COUNT - 1; i += 1) open.push(later(wipe(pipes[i].querySelector('.k12-link-line')), h.stagger * (i + 1) / 1000));
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      var target = L.center('stage-' + i).x - startX;
      var anims = [
        { targets: packet, translateX: [prev, target], duration: d(1.2), easing: M.easing },
        mark(boxes[i].body),
        push(meter, i + 1)
      ];
      prev = target;
      if (i > 0) anims.push(dim(boxes[i - 1]));
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) { all.push(bump(boxes[i])); all.push(lit(boxes[i])); }
    all.push(push(meter, COUNT));
    return all;
  }));
});
'''

CORE_COMPARE = r'''
var L = Sandbox.layout(__PLAN__);
var COUNT = Math.min({{pairs}}, N);
var leftHead = L.one('head-left');
var rightHead = L.one('head-right');
var leftBars = L.list('left');
var rightBars = L.list('right');
var i;
for (i = 0; i < leftBars.length; i += 1) {
  off(leftBars[i]);
  off(rightBars[i]);
  if (i >= COUNT) { leftBars[i].setAttribute('display', 'none'); rightBars[i].setAttribute('display', 'none'); }
}
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, COUNT + 2);
      return [slideIn(leftHead, -24), slideIn(rightHead, 24), mark(rightHead.body)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      return [later(riseIn(leftBars[i], 22), 0.05), later(riseIn(rightBars[i], 22), 0.3), mark(rightBars[i].body)];
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [], k;
    for (k = 0; k < COUNT; k += 1) {
      all.push(later({ targets: leftBars[k], opacity: [1, 0.7, 1], duration: d(0.7), easing: M.easing }, h.stagger * k / 1000));
      all.push(later(bump(rightBars[k]), h.stagger * k / 1000));
    }
    return all;
  }));
});
'''

CORE_LAYERS = r'''
var L = Sandbox.layout(__PLAN__);
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
      h.step(1, COUNT + 2);
      return [riseIn(slabs[0], 30), push(meter, 1)];
    }
    if (index <= COUNT) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, COUNT + 2);
      return [riseIn(slabs[i], 36), mark(slabs[i].body), push(meter, i + 1)];
    }
    h.caption(COUNT > 1 ? DATA.close : DATA.hold);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) all.push(later(bump(slabs[i]), h.stagger * i / 1000));
    all.push(mark(slabs[0].body));
    all.push(push(meter, COUNT));
    return all;
  }));
});
'''

CORE_LOOP = r'''
var L = Sandbox.layout(__PLAN__);
var TIMES = {{times}};
var track = L.list('track')[0] || null;
var stops = L.list('stop');
var rounds = L.one('round-meter');
var totalMeter = L.one('total-meter');
var CX = track.cx, CY = track.cy, RADX = track.rx, RADY = track.ry;
var runner = pivot(CX, CY);
var dot = Sandbox.svgEl('circle');
dot.setAttribute('class', 'k12-node-body');
dot.setAttribute('cx', '0');
dot.setAttribute('cy', String(-RADY));
dot.setAttribute('r', '13');
runner.appendChild(dot);
off(runner);
var i;
function placeDot(progress) {
  var angle = -Math.PI / 2 + progress * 2 * Math.PI;
  dot.setAttribute('cx', String(RADX * Math.cos(angle)));
  dot.setAttribute('cy', String(RADY * Math.sin(angle)));
}
var trace = { v: 0 };
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, TIMES + 2);
      var open = [riseIn(runner, -14), push(rounds, 0), push(totalMeter, 0)];
      for (i = 0; i < stops.length; i += 1) open.push(later(popIn(stops[i]), h.stagger * i / 1000));
      return open;
    }
    if (index <= TIMES) {
      var round = index;
      var row = ROWS[(round - 1) % N];
      var stop = stops[(round - 1) % stops.length];
      h.caption('第 ' + round + ' 圈：' + row.line);
      h.step(index + 1, TIMES + 2);
      return [
        {
          targets: trace,
          v: [0, 1],
          duration: d(3.2),
          easing: 'linear',
          begin: function () { rounds.set(round); },
          update: function (anim) { placeDot(anim.progress / 100); },
          complete: function () { placeDot(1); totalMeter.set(round); }
        },
        mark(stop.body),
        { targets: stop, scale: [1, 1.05, 1], duration: d(3.2), easing: 'linear' }
      ];
    }
    h.caption(DATA.close);
    h.step(TIMES + 2, TIMES + 2);
    return [bump(dot), push(rounds, TIMES), push(totalMeter, TIMES)];
  }));
});
'''

CORE_TREE = r'''
var L = Sandbox.layout(__PLAN__);
var ROUNDS = Math.min({{rounds}}, N);
var root = L.one('root');
var chain = L.list('ask');
var exits = L.list('exit');
var links = L.list('step').concat(L.list('branch'));
var meter = L.one('depth');
var i, taken = 0;
off(root);
for (i = 0; i < chain.length; i += 1) {
  off(chain[i]);
  off(exits[i]);
  off(links[i]);
  off(links[chain.length + i]);
  if (i >= ROUNDS) {
    chain[i].setAttribute('display', 'none');
    exits[i].setAttribute('display', 'none');
    links[i].setAttribute('display', 'none');
    links[chain.length + i].setAttribute('display', 'none');
  }
}
var flags = DATA.flags;
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, ROUNDS + 3);
      return [riseIn(root, 22), push(meter, 0)];
    }
    if (index <= ROUNDS) {
      i = index - 1;
      h.caption(ROWS[i].caption);
      h.step(index + 1, ROUNDS + 3);
      var anims = [
        { targets: links[i], opacity: [0, 1], duration: d(0.9), easing: M.easing },
        { targets: links[chain.length + i], opacity: [0, 1], duration: d(0.9), easing: M.easing },
        later(riseIn(chain[i], 22), 0.3),
        later(riseIn(exits[i], 22), 0.3),
        later(mark(exits[i].body), 0.6),
        push(meter, i + 1)
      ];
      if (flags[i % flags.length]) {
        taken = i;
        anims.push(later(bump(chain[i]), 0.5));
      }
      return anims;
    }
    if (index === ROUNDS + 1) {
      h.caption('这次提问让它停在「' + ROWS[taken].ask + '」这一层，没有走右边的出口。');
      h.step(ROUNDS + 2, ROUNDS + 3);
      return [bump(chain[taken]), mark(chain[taken].body), push(meter, taken + 1)];
    }
    h.caption(DATA.close);
    h.step(ROUNDS + 3, ROUNDS + 3);
    var all = [];
    for (i = 0; i <= taken; i += 1) all.push(later(mark(chain[i].body), h.stagger * i / 1000));
    return all;
  }));
});
'''

CORE_NETWORK = r'''
var L = Sandbox.layout(__PLAN__);
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
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.rows[0].caption);
      h.step(1, 8);
      var open = [push(hidMeter, 0), push(outMeter, 0)];
      for (i = 0; i < COL; i += 1) open.push(later(slideIn(inNodes[i], -24), h.stagger * i / 1000));
      open.push(push(inMeter, join([DATA.inputs[0].value, DATA.inputs[1].value, DATA.inputs[2].value])));
      return open;
    }
    if (index === 1) {
      h.caption('每一根线的粗细代表权重的大小，线越粗它说话越算数。');
      h.step(2, 8);
      var wide = [];
      for (i = 0; i < COL; i += 1) {
        for (j = 0; j < UNITS; j += 1) {
          wide.push(later(
            { targets: wireIn(i, j), opacity: [0, 1], strokeWidth: [0.4, Math.abs(DATA.weights.ih[i][j]) * 4 + 0.6], duration: d(0.9), easing: M.easing },
            h.stagger * (i + j) / 1000
          ));
        }
      }
      return wide;
    }
    if (index === 2) {
      h.caption('把三个输入乘上权重再加起来，就是隐层里每个单元收到的数：' + join(hid.map(String)) + '。');
      h.step(3, 8);
      var calc = [push(hidMeter, join(hid.map(String)))];
      for (j = 0; j < UNITS; j += 1) calc.push(mark(hidNodes[j].body));
      return calc;
    }
    if (index === 3) {
      h.caption('隐层把这些数记下来，接着往下一层送。');
      h.step(4, 8);
      var up = [];
      for (j = 0; j < UNITS; j += 1) up.push(later(riseIn(hidNodes[j], 18), h.stagger * j / 1000));
      return up;
    }
    if (index === 4) {
      h.caption('第二层的权重同样有正有负：负的权重要把信号压下去。');
      h.step(5, 8);
      var second = [];
      for (j = 0; j < UNITS; j += 1) {
        for (k = 0; k < OUT; k += 1) {
          second.push(later(
            { targets: wireOut(j, k), opacity: [0, 1], strokeWidth: [0.4, Math.abs(DATA.weights.ho[j][k]) * 5 + 0.6], duration: d(0.9), easing: M.easing },
            h.stagger * (j + k) / 1000
          ));
        }
      }
      return second;
    }
    if (index === 5) {
      h.caption('输出层的两个数就是这么算出来的，数值大的那个是这次的答案：' + join(out.map(String)) + '。');
      h.step(6, 8);
      var show = [push(outMeter, join(out.map(String)))];
      for (k = 0; k < OUT; k += 1) show.push(later(riseIn(outNodes[k], 20), h.stagger * k / 1000));
      return show;
    }
    if (index === 6) {
      h.caption(DATA.rows[Math.min(1, N - 1)].caption);
      h.step(7, 8);
      return [mark(outNodes[0].body), bump(outNodes[0]), push(outMeter, join(out.map(String)))];
    }
    h.caption(DATA.close);
    h.step(8, 8);
    return [bump(hidNodes[0]), later(bump(outNodes[0]), 0.3), push(hidMeter, join(hid.map(String)))];
  }));
});
'''

CORE_MATRIX = r'''
var L = Sandbox.layout(__PLAN__);
var SIZE = Math.max(4, Math.min({{size}}, 6));
var ROW_COUNT = 4;
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
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, ROW_COUNT + 3);
      var open = [push(rowMeter, 0), push(allMeter, 0)];
      for (r = 0; r < ROW_COUNT; r += 1) {
        for (c = 0; c < SIZE; c += 1) {
          open.push(later({ targets: cells[r][c], opacity: [0, 0.3], scale: [0.86, 1], duration: d(0.8), easing: M.easing }, h.stagger * (r + c) / 1000));
        }
      }
      return open;
    }
    if (index <= ROW_COUNT) {
      r = index - 1;
      h.caption(ROWS[r].caption);
      h.step(index + 1, ROW_COUNT + 3);
      var sweep = [push(rowMeter, rowAverage(values[r]))];
      for (c = 0; c < SIZE; c += 1) {
        sweep.push(later({ targets: cells[r][c], opacity: [0.3, values[r][c]], translateY: [-8, 0], duration: d(0.9), easing: M.easing }, h.stagger * c / 1000));
      }
      return sweep;
    }
    if (index === ROW_COUNT + 1) {
      h.caption('整张表每一个格子加起来再平均得到 ' + overall + '；最亮的那一格是这行的最大值。');
      h.step(ROW_COUNT + 2, ROW_COUNT + 3);
      return [push(allMeter, overall), mark(cells[best.r][best.c].body), bump(cells[best.r][best.c]), push(rowMeter, rowAverage(values[best.r]))];
    }
    h.caption(DATA.close);
    h.step(ROW_COUNT + 3, ROW_COUNT + 3);
    var finish = [];
    for (c = 0; c < SIZE; c += 1) finish.push(later(bump(cells[best.r][c]), h.stagger * c / 1000));
    finish.push(push(allMeter, overall));
    return finish;
  }));
});
'''

CORE_TRACE = r'''
var L = Sandbox.layout(__PLAN__);
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
var marker = anchor(Sandbox.svgEl('g'));
marker.setAttribute('class', 'k12-node k12-node--accent');
var ball = Sandbox.svgEl('circle');
ball.setAttribute('class', 'k12-node-body');
ball.setAttribute('r', '11');
marker.appendChild(ball);
fg().appendChild(marker);
var targetLine = Sandbox.link({ x: pxOf(DATA.target), y: area.y }, { x: pxOf(DATA.target), y: area.originY }, { style: 'dashed' });
off(targetLine);
function place(step) {
  marker.setAttribute('transform', 'translate(' + pxOf(weights[step]) + ' ' + pyOf(losses[step]) + ')');
}
place(0);
var wMeter = L.one('w-meter');
var lMeter = L.one('l-meter');
Sandbox.play(function () {
  return Sandbox.timeline(__PHASES__, defer(function (tl, index, h) {
    if (index === 0) {
      h.caption(DATA.open);
      h.step(1, STEPS + 3);
      var draw = [push(wMeter, weights[0]), push(lMeter, losses[0]), riseIn(marker, -16)];
      for (i = 0; i < segments.length; i += 1) {
        draw.push(later({ targets: segments[i], opacity: [0, 1], strokeWidth: [0.5, 2.4], duration: d(0.8), easing: M.easing }, h.stagger * i / 1000));
      }
      return draw;
    }
    if (index === 1) {
      h.caption('先随便挑一个起点：参数 ' + weights[0] + '，这时候要压小的数是 ' + losses[0] + '。');
      h.step(2, STEPS + 3);
      return [bump(marker), push(wMeter, weights[0]), push(lMeter, losses[0])];
    }
    if (index <= STEPS + 1) {
      var step = index - 1;
      h.caption(ROWS[(step - 1) % N].caption + '（第 ' + step + ' 步：参数 ' + weights[step] + '，要压小的数 ' + losses[step] + '）');
      h.step(index + 1, STEPS + 3);
      return [
        {
          targets: marker,
          translateX: [pxOf(weights[step - 1]) - pxOf(weights[0]), pxOf(weights[step]) - pxOf(weights[0])],
          translateY: [pyOf(losses[step - 1]) - pyOf(losses[0]), pyOf(losses[step]) - pyOf(losses[0])],
          scale: [1, step === STEPS ? 1.18 : 0.86],
          duration: d(1.1),
          easing: M.easing
        },
        push(wMeter, weights[step]),
        push(lMeter, losses[step])
      ];
    }
    h.caption(DATA.close);
    h.step(STEPS + 3, STEPS + 3);
    return [{ targets: targetLine, opacity: [0, 1], duration: d(1), easing: M.easing }, bump(ball), push(wMeter, weights[STEPS]), push(lMeter, losses[STEPS])];
  }));
});
'''

CORE_COUNTER = r'''
var L = Sandbox.layout(__PLAN__);
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
      h.step(1, COUNT + 2);
      var open = [push(countMeter, 0), push(sumMeter, 0)];
      for (i = 0; i < COUNT; i += 1) {
        open.push(later(riseIn(pegs[i], 14), h.stagger * i / 1000));
        open.push(later({ targets: pegs[i], opacity: [0, 0.3], duration: d(0.5), easing: 'linear' }, h.stagger * i / 1000));
      }
      return open;
    }
    if (index <= COUNT) {
      i = index - 1;
      running += ROWS[i].event.length;
      h.caption(ROWS[i].caption + '（这一句 ' + ROWS[i].event.length + ' 个字，合计 ' + running + ' 字）');
      h.step(index + 1, COUNT + 2);
      var anims = [
        later(riseIn(cards[i], 20), 0.1),
        mark(pegs[i].body),
        bump(pegs[i]),
        push(countMeter, i + 1),
        push(sumMeter, running)
      ];
      if (i > 0) anims.push(swapOut(cards[i - 1]));
      return anims;
    }
    h.caption(DATA.close);
    h.step(COUNT + 2, COUNT + 2);
    var all = [];
    for (i = 0; i < COUNT; i += 1) all.push(later(mark(pegs[i].body), h.stagger * i / 1000));
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
        "hint": "跟着走这几站，一站一句",
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
        "hint": "一问一答，把话说清楚",
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
        "hint": "左边右边，比一比",
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
        "hint": "一块一块加上去",
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
        "hint": "一条一条对着看",
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
        "hint": "数据从左边进去，一段段走",
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
        "hint": "两条路线，一行一行比",
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
        "hint": "从最底下那层开始搭",
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
        "hint": "转一圈算一轮，看计数器",
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
        "hint": "每个问题只有两条路",
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
        "hint": "信号一层层传下去",
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
        "hint": "一格一格地扫过去",
        "chip": "准备扫格",
        "aria": "矩阵动画：逐行扫描网格里的数值",
        "pace": "pace",
        "phases": ("literal", 7),
        "params": {
            "size": {"type": "int", "min": 4, "max": 6, "default": 6, "description": "网格有几列"},
            "pace": {"type": "float", "min": 0.6, "max": 1.8, "default": 1.0, "description": "播放速度倍数，越大越快"},
        },
        "core": CORE_MATRIX,
    },
    "trace": {
        "skin": "technical",
        "hint": "一边走一边读数值",
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
        "hint": "一次一次地数",
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
    assert len(template["fallback_text"]) >= 30, template["id"] + " 降级文案太短"
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
