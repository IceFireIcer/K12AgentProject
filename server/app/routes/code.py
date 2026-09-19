# -*- coding: utf-8 -*-
"""``GET /api/code/templates/{kp_id}`` + ``POST /api/code/run-hint``（票 19：编程 Extension 的服务端）。

两条端点各管一件事，分工与代码执行的**安全边界**严格一致：

| 端点 | 做什么 | 边界 |
| --- | --- | --- |
| ``GET /api/code/templates/{kp_id}`` | 按知识点返回预置代码模板（``CodeTemplate``） | **本地文件读取，不经 LLM** —— 断网仍可用（票 19 验收项） |
| ``POST /api/code/run-hint`` | 收到「学生代码 + Pyodide 的运行结果」→ 归一化报错 → 生成中文反馈 + 下一级提示 | ★ **本端点不执行任何 Python 代码**（见下） |

★★ **本文件绝不执行学生代码。** 执行发生在渲染进程的 Pyodide Worker 里
（执行文档 §11.3 / §12 的沙箱三重隔离）。本模块只做**纯文本处理**：
把 Pyodide 回传的 traceback 解析成结构化错误、翻译成面向学生的中文，
再挑一条分级提示。它连 ``exec`` / ``eval`` / ``subprocess`` 都不 import ——
这不是纪律声明，是**可被测试断言的事实**（``tests/test_code_templates.py`` 里有一条
「本模块不出现任何执行原语」的守卫）。

**为什么不在这里跑代码**（哪怕 sidecar 就是个 Python 进程）：
① 学生代码绝不在主进程执行，也**不该**从主进程绕道 sidecar 执行 —— 那等于给编排层
开了一条「把任意代码送进一个真 Python 进程」的通道，与 §12 的硬约束精神相悖；
② Pyodide 里的 Python 与 sidecar 的 Python 是**两个独立运行时**（业务陷阱清单 §7 第 2 条），
学生代码碰不到学习数据，这是要写进报告的隔离设计；
③ 真正执行的地方只有一个：浏览器沙箱里的 Worker。

**错误归一化**：Pyodide 抛出的 ``PythonError`` 会把整段 traceback 塞进 ``message``，
格式还随版本浮动。所以 :func:`parse_python_error` 用**保守的逐行扫描**（找最后一个
``XxxError: ...`` 与最后一个 ``line N``），拿不准就退回 ``PythonError`` 原文 ——
宁可少认一类错误，也不要张冠李戴（把 ``TypeError`` 说成 ``IndexError`` 比不翻译更糟）。
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Sequence

from fastapi import APIRouter, HTTPException, Query, Request

from app.config import RESOURCES_DIR
from app.contracts import CodeError, CodeEvaluation, CodeRunRequest, CodeTemplate, CodingHint
from app.knowledge.library import GRADE_LEVELS, compatible_grades, grade_index

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["code"])

# ---------------------------------------------------------------- 常量 --
#: 模板目录名（``server/resources/code-templates/``）。
#:
#: ⚠️ 为什么叫 ``code-templates`` 而不是票面写的 ``templates``：
#: ``server/resources/templates/`` **已被动画模板占用**（票 17，见 ``resources/README.md``），
#: 两者共用一个目录会让 ``load_template`` 读到动画模板的 JSON。目录名以本文件为准。
CODE_TEMPLATES_DIRNAME = "code-templates"

#: ``app.state`` 上的模板目录注入点（测试与演示用临时模板目录）。
TEMPLATES_DIR_STATE_ATTR = "code_templates_dir"
#: 环境变量覆盖（演示时指向「故意少模板」的那一份）。
TEMPLATES_DIR_ENV = "K12_CODE_TEMPLATES_DIR"

#: 分级提示的级数上限（契约 ``CodingHint.level`` 是 ``Literal[1, 2, 3]``）。
MAX_HINT_LEVEL = 3
#: 提示起始级别（**永远从 1 开始**，level 1 只指方向，票 19 的「不许跳级」）。
MIN_HINT_LEVEL = 1

#: 代码运行的学生侧超时（毫秒）。**前端 Worker 里是真中断（``setInterruptBuffer``）**，
#: 这个值只用于文案与「这次算不算超时」的判定；不要拿它当保护 —— 保护在 Worker 里。
#:
#: 5s 是「够跑完教学代码」与「死循环不冻住 UI」的折中（票 18 的验收数字）。
CODE_RUN_TIMEOUT_MS = 5000

#: 学生代码长度上限。K12 练习不会有两万字符的代码，超了多半是粘贴事故；
#: 卡住长度也顺带卡住了 traceback 的规模（错误翻译是正则扫描，规模要可控）。
MAX_CODE_CHARS = 20_000
#: 回传的 stdout / stderr 截断长度（超长输出不该把 IPC 与 DOM 撑爆）。
MAX_OUTPUT_CHARS = 8_000
#: ``raw_traceback`` 的保留长度（供家长/教师排查，但不无限膨胀）。
MAX_TRACEBACK_CHARS = 6_000

#: 面向学生的一句话鼓励（失败时给，避免只报错不安慰）。
ENCOURAGEMENT = "别急，这个错误大多数同学都遇到过，我们一起看看。"
#: 成功时的肯定（**不夸大**：跑通 ≠ 学会了）。
SUCCESS_FEEDBACK = "运行成功，输出和你预期的一样吗？对照上面的「预期效果」检查一下。"

#: ``PythonError`` 里能找到的「错误类名: 说明」形态。
#:
#: ⚠️ **冒号与说明是可选的** —— 这不是为了宽松，而是实测：
#: Pyodide 抛的 ``KeyboardInterrupt`` 在 traceback 里**只有类名、没有冒号也没有说明**
#: （实测原文末行就是 ``KeyboardInterrupt``）。如果正则强制要求 ``:``，
#: 「死循环被中断」这个头号演示场景会被误判成认不出的 ``PythonError``，
#: 于是文案退回通用兜底 —— 学生看到的是"运行时出错"，而不是"程序停不下来"。
#:
#: 只认 ``XxxError`` / ``XxxException`` / ``KeyboardInterrupt`` / ``SystemExit`` 这类后缀，
#: 且**首字母必须大写**（Python 的异常类名一律大写开头）—— 这样 traceback 里的普通标识符行
#: （``coroutine = eval(...)``、``my_error``）不会被误认成错误类名。
_ERROR_LINE_RE = re.compile(
    r"^(?P<type>[A-Z][A-Za-z0-9_]*(?:Error|Exception|Interrupt|Exit|Warning|Iteration))"
    r"(?:\s*:\s*(?P<msg>.*))?$"
)
#: traceback 里最后一处 ``File "xxx", line N``（最内层帧，就是出错的那一行）。
_LINE_RE = re.compile(r'File\s+"[^"]*"\s*,\s*line\s+(?P<line>\d+)')

# ---------------------------------------------------------------- 内部模型 --
#: 模板的内部形态：比对外契约多一个 **``solution``**。
#:
#: ★★ ``solution`` **绝不外发** —— 与题库的 ``answer`` 是同一条纪律（执行文档 §6.3）。
#: 它只用于两件事：测试里断言「填完 TODO 即可通过」，以及将来做自动判分时的参照。
#: 对外一律经 :func:`to_code_template` **投影**（白名单挑字段），
#: **不要**用 pydantic 的 ``exclude`` 临时裁剪 —— 那是最容易漏掉一处的地方。
#:
#: 这也是本模型**刻意不放进 `contracts.py`** 的原因：契约模块里的模型会被
#: ``tests/test_contracts.py`` 要求登记进 ``CONTRACT_MODELS`` 并导出到 OpenAPI，
#: 而 ``solution`` 一旦进了 OpenAPI/TS 就等于把答案发给了前端。
@dataclass(frozen=True)
class CodeTemplateRecord:
    kp_id: str
    grade_level: str
    title: str
    scaffold: str
    expected_behavior: str
    expected_output: str
    hints: tuple[dict, ...] = ()
    #: ★ 内部字段：正确完成的参照实现。**绝不出现在任何响应里。**
    solution: str = ""
    #: 来自哪个文件（日志与排错用）。
    source_file: str = ""

    def hint_at(self, level: int) -> "CodingHint | None":
        """取 ``level`` 级提示（缺该级返回 ``None``，由调用方兜底）。"""
        for item in self.hints:
            if int(item.get("level", 0)) == level:
                text = str(item.get("hint") or "").strip()
                if text:
                    return CodingHint(level=level, hint=text)  # type: ignore[arg-type]
        return None

    @property
    def max_hint_level(self) -> int:
        """本模板**实际**有几级提示（模板可能只写到 2 级，不许凭空跳到 3）。"""
        levels = [int(item.get("level", 0)) for item in self.hints if str(item.get("hint") or "").strip()]
        return max(levels) if levels else 0


@dataclass
class TemplateLoadReport:
    """加载报告（供日志与测试断言「模板本身是干净的」）。"""

    records: list[CodeTemplateRecord] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)


# ---------------------------------------------------------------- 报错翻译 --#: ★★ **原始报错 → 面向学生的中文** 的翻译表（票 19 的核心产出）。
#:
#: 设计口径（**这三条决定了文案能不能用，不是随便写的**）：
#:
#: 1. **不吐原始 traceback**：学生看到 ``Traceback (most recent call last)`` 只会放弃。
#:    所以 ``message`` 用日常话讲「哪里错了、为什么错」，raw 原文只留在
#:    ``CodeError.raw_traceback`` 里（供家长/教师导出与排查）。
#: 2. **说「怎么改」，不说「改成什么」**：这里是**报错感知**，不是求助 ——
#:    所以只给方向和定位（第几行、这类错误通常是怎么来的），
#:    **绝不给出可直接抄的修复代码**。要更具体的引导走 ``get_coding_hint`` 的分级提示。
#: 3. **每一条都点到「为什么」**：K12 的 AI 通识课，报错是最自然的"计算机很死板"的教材。
#:
#: ``key`` 是归一化后的错误类名；``.message`` 里 ``{line}`` 会被替换成行号（没有行号时用「这几行」）。
_ERROR_PLAYBOOK: dict[str, dict[str, str]] = {
    "IndentationError": {
        "label": "缩进错误",
        "message": (
            "{line}附近的缩进不对。Python 靠**缩进**判断哪些代码属于同一个块"
            "（比如循环体、if 里面），多一个空格或少一个空格都会改变程序的意思。"
            "检查这一行和它上下两行：该对齐的是不是没对齐？是不是把空格和 Tab 混用了？"
        ),
    },
    "TabError": {
        "label": "缩进错误（空格与 Tab 混用）",
        "message": (
            "{line}附近把 **Tab 和空格混用**了。它们看起来一样宽，但 Python 认为是两种不同的字符。"
            "把这一行前面的空白全部删掉，用空格重新对齐（每层缩进统一 4 个空格）。"
        ),
    },
    "NameError": {
        "label": "变量名没有定义",
        "message": (
            "{line}用到了一个**还没被创建过**的名字。常见原因有三个："
            "① 名字拼错了（大小写也算不同）；② 这个变量在别的位置才赋值，你用在了它之前；"
            "③ 忘了先给它一个初值（比如累加用的 ``total = 0``）。"
            "顺着这个名字往上找，看它到底在哪里被创建。"
        ),
    },
    "UnboundLocalError": {
        "label": "变量在赋值之前被使用",
        "message": (
            "{line}用到的变量，在**这个函数内部**还没有被赋值。"
            "常见情形是：函数里既要用外面那个变量、又给它赋了值。"
            "检查函数内部：这个变量第一次出现时，是不是在「赋值」的右边？"
        ),
    },
    "TypeError": {
        "label": "类型不匹配",
        "message": (
            "{line}对**两种不匹配的东西**做了运算。最常踩的是"
            "「数字」和「字符串」混在一起：``\"3\" + 5`` 是不行的，"
            "要么先把字符串转成数字（``int(...)`` 或 ``float(...)``），要么按字符串拼接处理。"
            "也可能是在调用函数时参数个数/顺序不对 —— 对照一下定义再数一遍。"
        ),
    },
    "ValueError": {
        "label": "值的类型对、但内容不合法",
        "message": (
            "{line}拿到了一个**类型没错、内容却不能用**的值。"
            "最常见的是 ``int()`` 碰到不是数字的字符串（比如空字符串或带字母的文本）。"
            "先把这个值打印出来看看（``print(repr(值))``），确认它到底是什么。"
        ),
    },
    "IndexError": {
        "label": "索引越界",
        "message": (
            "{line}取了**列表里不存在的位置**。Python 的下标从 0 开始，"
            "长度为 n 的列表，合法下标是 0 到 n-1 —— ``range()`` 少写或多写 1 是这里最常见的坑。"
            "先把长度打印出来（``print(len(列表))``），再核对你的下标范围。"
        ),
    },
    "KeyError": {
        "label": "字典里没有这个键",
        "message": (
            "{line}从字典里取一个**不存在的键**。先 ``print(字典)`` 看清里面到底有哪些键，"
            "注意键的大小写、以及键是字符串（带引号）还是数字。"
            "不确定有没有时，可以想一想用 ``.get(键, 默认值)`` 会不会更稳。"
        ),
    },
    "AttributeError": {
        "label": "对象没有这个属性/方法",
        "message": (
            "{line}对一个对象用了**它并不具备**的方法或属性。"
            "常见原因是类型认错了（比如把列表当字符串用），或者方法名拼错/大小写不对。"
            "先用 ``type(变量)`` 确认它到底是什么类型，再查这个类型支持什么操作。"
        ),
    },
    "ZeroDivisionError": {
        "label": "除以零",
        "message": (
            "{line}做了**除以 0** 的运算。如果除数是算出来的（比如 ``len(列表)``），"
            "那说明它是空的时候你没先判断。想清楚「除数为 0 时该怎么办」，再补上这个判断。"
        ),
    },
    "ModuleNotFoundError": {
        "label": "找不到这个模块",
        "message": (
            "{line} ``import`` 的模块**在这个运行环境里没有**。"
            "浏览器里的 Python（Pyodide）预装了 numpy，但**不是所有**库都有 —— "
            "确认一下这个练习是不是真的需要它，能不能只用内置功能完成。"
        ),
    },
    "SyntaxError": {
        "label": "语法错误",
        "message": (
            "{line}写得不合 Python 的语法。最常见的是：**少了冒号**（``if`` / ``for`` / ``def`` 行末）、"
            "**括号没配平**（多一个或少一个）、**用了中文标点**（``（）``、``，``、``：`` 看着和英文一样但不合法）。"
            "对着这一行逐个字符检查一遍，尤其是标点。"
        ),
    },
    # ★★ 超时中断（票 18 的头号演示）：这**不是一个错误**，是程序被停下了。
    #    文案必须让学生明白「是我的程序停不下来」，而不是「我写错了」。
    "KeyboardInterrupt": {
        "label": "程序运行太久，已被中断",
        "message": (
            "你的代码**一直在重复做同一件事，停不下来**，为了保护界面我已经把它停住了。"
            "先找找那个「永远为真」的条件：循环体里有没有让条件最终变成假的那一步？"
            "（在纸上跑两轮循环，看看判断条件什么时候会变 —— 死循环几乎都出在这里。）"
        ),
    },
    "TimeoutError": {
        "label": "程序运行超时",
        "message": (
            "代码**运行超过了时间上限**，我已经把它停住了。"
            "先看有没有停不下来的循环；如果代码本来就该跑很久，想想能不能把要处理的量减少再试。"
        ),
    },
}

#: 认不出类名时的兜底（**绝不假装认出来了**：如实说明 + 给最通用的排查建议）。
_FALLBACK_PLAYBOOK = {
    "label": "运行时出错",
    "message": (
        "{line}运行时出错了。这类错误通常和「数据的样子和你想的不一样」有关："
        "先把这一行用到的变量打印出来看看（``print(变量)``），确认它真的是你以为的那个值。"
    ),
}


def error_label(error_type: str) -> str:
    """错误类名 → 中文标签（界面上显示的那几个字）。"""
    entry = _ERROR_PLAYBOOK.get(error_type) or _FALLBACK_PLAYBOOK
    return entry["label"]


def _line_phrase(line: int | None) -> str:
    """行号 → **完整可读短语**：``第 3 行`` / ``出错的那一行``（认不出行号时的说法）。

    ⚠️ 因此文案模板里写的是 ``{line}附近的缩进不对``，**不要**再包一层「第…行」：
    两处都拼会得到「第 第 3 行 行附近…」—— 这是**实测 HTTP 回执里抓到的真实 bug**
    （`…/api/code/run-hint` 的 `feedback`），不是假想。
    """
    return f"第 {line} 行" if isinstance(line, int) and line > 0 else "出错的那一行"


def translate_python_error(error_type: str, message: str, line: int | None) -> str:
    """**原始报错 → 面向学生的中文反馈**（票 19 的核心函数，纯函数、可单测）。

    查表命中就用表里的文案（模板里的 ``{line}`` 换成真实行号）；
    查不到就退到 :data:`_FALLBACK_PLAYBOOK` —— **认不出类名不等于没有建议**。

    无论走哪条路，都**不会**把原始 traceback 拼进来（那是 ``CodeError.raw_traceback`` 的职责）。
    """
    entry = _ERROR_PLAYBOOK.get(error_type)
    if entry is None:
        # 认不清类名时，把原文里**最关键的一句**附在通用建议后面：
        # 一句「TypeError: unsupported operand type(s)」对学生没帮助，
        # 但「你写的是：...」能让家长/老师一眼定位（截断，不整段贴）。
        detail = (message or "").strip()
        detail = detail.splitlines()[-1].strip() if detail else ""
        tail = f"\n（程序报的原话是：{_clip(detail, 160)}）" if detail and detail != error_type else ""
        return _FALLBACK_PLAYBOOK["message"].format(line=_line_phrase(line)) + tail
    return entry["message"].format(line=_line_phrase(line))


def parse_python_error(raw: str) -> tuple[str, str, int | None]:
    """从 Pyodide 的原始报错里抽出 ``(错误类名, 说明, 行号)``。

    保守扫描（见模块头「错误归一化」）：
      - 错误类名 = **最后一个**形如 ``XxxError: 说明`` 的行；
      - 行号 = **最后一个** ``File "...", line N`` 里的 N（即最内层出错帧）；
      - 认不出类名时返回 ``("PythonError", 原文首行, None)``。

    ``KeyboardInterrupt`` 也走这条路（Pyodide 的中断就是抛它），
    因此「死循环被中断」与「语法写错」在数据结构上是同一类，靠类名区分文案。
    """
    text = (raw or "").strip()
    if not text:
        return "PythonError", "", None

    error_type = ""
    error_message = ""
    for line_text in text.splitlines():
        matched = _ERROR_LINE_RE.match(line_text.strip())
        if matched:
            error_type = matched.group("type")
            # ⚠️ `msg` 组是可选的（`KeyboardInterrupt` 后面什么都没有）——
            #    必须防 None，否则中断这个头号场景会在这里抛 AttributeError。
            error_message = (matched.group("msg") or "").strip()

    line: int | None = None
    for matched in _LINE_RE.finditer(text):
        try:
            line = int(matched.group("line"))
        except ValueError:  # pragma: no cover - 正则已限定为数字
            continue

    if not error_type:
        return "PythonError", text.splitlines()[-1].strip(), line
    return error_type, error_message, line


# ---------------------------------------------------------------- 分级提示 --
def resolve_hint_level(
    consecutive_failures: int,
    *,
    current_level: int | None = None,
    max_level: int = MAX_HINT_LEVEL,
) -> int:
    """算出这次该给**第几级**提示（★ **同一知识点内绝不跳级**）。

    ``consecutive_failures`` = **该知识点上连续失败了几次**（1 = 第一次失败），
    由主进程的失败计数器给出（见 ``coding.ts`` 的 ``MAX_CONSECUTIVE_FAILURES``）。

    ``current_level``：
      - ``None``（默认）= **调用方不知道已经给到第几级**（本路由是无状态的，
        只拿到契约里的 ``attempt``）→ 完全按失败次数定级；
      - 传一个整数 = 调用方**已知**该知识点上给过的最高级（例如 ``coding.ts`` 的
        ``hintLevel`` 映射）→ 施加「最多 +1」的硬护栏。

    三条规则（缺一不可，票 19 的验收口径）：

    1. **按失败次数递进**：第 1 次失败给 level 1（只指方向），第 2 次 level 2（结构性提示），
       第 3 次及以后才 level 3（贴近骨架）—— 也就是 ``level = 失败次数``（封顶）。
    2. ★ **不跳级**（仅在传入 ``current_level`` 时生效）：永远不超过 ``current_level + 1``。
       学生上一次拿到 level 1，这一次**不可能**直接看到 level 3 的答案骨架 ——
       即使 ``consecutive_failures`` 很大（比如计数被改、或前端换了重试策略）。
    3. **封顶**：不超过 ``max_level``。它由模板**实际写了几级**决定
       （``CodeTemplateRecord.max_hint_level``）：模板只写到 2 级时不许凭空造一个 3 级出来，
       那会返回一条空提示。

    >>> resolve_hint_level(1)                     # 第一次失败：只指方向
    1
    >>> resolve_hint_level(3)                     # 第三次失败：贴近骨架
    3
    >>> resolve_hint_level(9, current_level=1)    # 已知只给过 1 级 → 最多 2（不跳级）
    2
    >>> resolve_hint_level(3, max_level=2)        # 模板只有两级 → 停在 2
    2
    """
    ceiling = max(0, min(int(max_level), MAX_HINT_LEVEL))
    if ceiling == 0:
        return 0  # 该模板没有提示（调用方据此返回 next_hint=None）
    by_failures = max(MIN_HINT_LEVEL, min(ceiling, int(consecutive_failures)))
    if current_level is None:
        return by_failures
    stepwise = max(MIN_HINT_LEVEL, min(ceiling, int(current_level) + 1))
    return min(by_failures, stepwise)


def next_hint_level(level: int, *, max_level: int = MAX_HINT_LEVEL) -> int:
    """手动点「求助」时的下一级（已是最高级则**停在最高级**，不越界、不报错）。"""
    ceiling = max(0, min(int(max_level), MAX_HINT_LEVEL))
    if ceiling == 0:
        return 0
    return min(ceiling, max(MIN_HINT_LEVEL, int(level) + 1))


# ---------------------------------------------------------------- 模板加载 --
def default_templates_dir() -> Path:
    """模板目录（``K12_CODE_TEMPLATES_DIR`` 可覆盖，便于演示与排障）。"""
    override = os.environ.get(TEMPLATES_DIR_ENV)
    if override:
        return Path(override)
    return RESOURCES_DIR / CODE_TEMPLATES_DIRNAME


def templates_dir_for(request: Request) -> Path:
    """路由取模板目录：``app.state`` 注入优先（测试），否则用默认目录。"""
    injected = getattr(request.app.state, TEMPLATES_DIR_STATE_ATTR, None)
    return Path(injected) if injected else default_templates_dir()


def load_template(path: str | Path) -> CodeTemplateRecord | None:
    """读一个模板文件。**坏模板返回 ``None`` 并记日志，绝不抛异常**。

    「坏模板只跳过」与题库同一条纪律：现场演示时一个手滑的 JSON 不该让整条
    「取模板」链路挂掉。缺关键字段（``scaffold`` / ``expected_behavior``）一律判坏 ——
    没有 scaffold 的模板卡片是空的，没有 expected_behavior 就无从判断「做对了没有」。
    """
    file_path = Path(path)
    try:
        raw = json.loads(file_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("代码模板无法解析，已跳过：%s（%s）", file_path, exc)
        return None
    if not isinstance(raw, dict):
        logger.warning("代码模板不是对象，已跳过：%s", file_path)
        return None

    kp_id = str(raw.get("kp_id") or "").strip()
    scaffold = str(raw.get("scaffold") or "")
    expected_behavior = str(raw.get("expected_behavior") or "").strip()
    grade_level = str(raw.get("grade_level") or "").strip()
    if not kp_id or not scaffold.strip() or not expected_behavior:
        logger.warning("代码模板缺 kp_id/scaffold/expected_behavior，已跳过：%s", file_path)
        return None
    if grade_level not in GRADE_LEVELS:
        logger.warning("代码模板学段非法（%r），已跳过：%s", grade_level, file_path)
        return None

    hints = raw.get("hints")
    hints_tuple: tuple[dict, ...] = ()
    if isinstance(hints, list):
        hints_tuple = tuple(item for item in hints if isinstance(item, dict))

    return CodeTemplateRecord(
        kp_id=kp_id,
        grade_level=grade_level,
        title=str(raw.get("title") or kp_id).strip(),
        scaffold=scaffold,
        expected_behavior=expected_behavior,
        expected_output=str(raw.get("expected_output") or ""),
        hints=hints_tuple,
        solution=str(raw.get("solution") or ""),
        source_file=file_path.name,
    )


def load_templates(templates_dir: str | Path) -> TemplateLoadReport:
    """读整个模板目录（一个知识点一个文件）。"""
    report = TemplateLoadReport()
    root = Path(templates_dir)
    if not root.is_dir():
        logger.warning("代码模板目录不存在：%s（取模板将全部落空）", root)
        return report
    for path in sorted(root.glob("*.json")):
        report.files.append(path.name)
        record = load_template(path)
        if record is None:
            report.skipped.append(path.name)
            continue
        report.records.append(record)
    return report


def find_template(records: Sequence[CodeTemplateRecord], kp_id: str) -> CodeTemplateRecord | None:
    """按知识点查模板（同 kp 多文件时取**文件名排序最前**的那个，行为确定、可测）。"""
    for record in records:
        if record.kp_id == kp_id:
            return record
    return None


def template_grade_ok(record: CodeTemplateRecord, grade_level: str | None) -> bool:
    """模板学段是否可用（``grade_level`` 为 ``None`` = 不做学段过滤）。

    ★ **学段过滤是「显式开关」而不是默认门槛**，这是一个需要说清的设计取舍：

    - 「只允许不高于学生学段」这条口径（§8.5）管的是**检索与教材投放** ——
      学生没有被教过决策树，就不该在检索里撞见它。那一条在 ``rag`` 里强制，不在这里。
    - 代码模板是**按 ``kp_id`` 显式取用**的材料：模型已经点名了「学生正在做 prog-loop-jr 这道题」
      （kp 来自当前教学上下文，不是服务端自由挑选），此时再用学段把模板挡掉，
      结果是学生面对一张空卡片 —— 教学价值为负。
    - 因此：**调用方传了 ``gradeLevel`` 就按兼容链严格卡**（外部集成方想卡就卡得住），
      **不传就不卡**（Tool 的默认行为见 ``coding.ts`` 的注释）。
      两种行为都有测试覆盖：这是「有意的取舍」，不是「忘了加过滤」。
    """
    if grade_level is None:
        return True
    if grade_level not in GRADE_LEVELS:
        return False
    try:
        return record.grade_level in compatible_grades(grade_level)
    except (KeyError, ValueError):  # pragma: no cover - 学段已先校验，留作保险
        return False


def to_code_template(record: CodeTemplateRecord) -> CodeTemplate:
    """★★ 内部记录 → 对外契约（**白名单投影**，``solution`` 在这里被丢掉）。

    这是「参照实现不出后端」的唯一边界（与题库 ``QuizQuestionOut.from_internal`` 同构）：
    逐个字段挑出来，而不是 ``model_copy`` 之后再删 —— 将来给 ``CodeTemplateRecord``
    加任何内部字段（参考答案、判分用例…）都**不会**自动泄漏出去。
    """
    return CodeTemplate(
        kp_id=record.kp_id,
        language="python",
        scaffold=record.scaffold,
        expected_behavior=record.expected_behavior,
    )


# ---------------------------------------------------------------- 结果整形 --
def _clip(text: str, limit: int) -> str:
    """截断（并显式标出「被截断了」，否则学生会以为输出就到这里为止）。"""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（输出过长，已截断）"


def looks_interrupted(stderr: str) -> bool:
    """判定「这次是不是被超时中断的」（决定文案是"停不下来"还是"写错了"）。"""
    text = stderr or ""
    return "KeyboardInterrupt" in text or "TimeoutError" in text


def build_code_error(raw_stderr: str) -> CodeError | None:
    """原始报错 → 结构化 :class:`CodeError`（**面向学生**，原文留档）。

    ``raw_traceback`` 保留原文（§6.5 明确要求，供家长/教师导出与排查），
    但**只做截断、不做清洗** —— 它要能原样复现问题。
    """
    raw = (raw_stderr or "").strip()
    if not raw:
        return None
    error_type, message, line = parse_python_error(raw)
    return CodeError(
        type=error_type,
        message=translate_python_error(error_type, message, line),
        raw_traceback=_clip(raw, MAX_TRACEBACK_CHARS),
        line=line,
    )


def build_feedback(*, ok: bool, code_error: CodeError | None, attempt: int) -> str:
    """面向学生的中文反馈（**不含提示**：提示是独立的 ``next_hint`` 字段）。"""
    if ok:
        return SUCCESS_FEEDBACK
    if code_error is None:
        return "这次没有拿到运行结果，稍后再试一次。"

    entry = _ERROR_PLAYBOOK.get(code_error.type) or _FALLBACK_PLAYBOOK
    head = f"运行没有通过（{error_label(code_error.type)}）。"
    body = code_error.message
    # 中断不是「写错了」：这时再安慰「大多数同学都遇到过」是错的语气。
    if looks_interrupted(code_error.type if code_error.type else ""):
        return f"{head}\n{body}"
    tail = ENCOURAGEMENT
    if attempt >= MAX_HINT_LEVEL:
        tail += "已经试了好几次了 —— 看看下面的提示，或者直接问老师吧。"
    return f"{head}\n{body}\n{tail}"


# ---------------------------------------------------------------- 路由 --
def _pick_grade_level(grade_level: str | None, camel: str | None) -> str | None:
    """取学段参数（两种写法都认；**都没传 = 不过滤**，见 :func:`template_grade_ok`）。"""
    value = camel or grade_level
    if value is None or value == "":
        return None
    if value not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422,
            detail=f"gradeLevel 非法：{value!r}（只允许 {'、'.join(GRADE_LEVELS)}）",
        )
    return value


@router.get(
    "/code/templates/{kp_id}",
    response_model=CodeTemplate,
    summary="按知识点取代码模板（含 TODO 脚手架，剔除 solution）",
)
def get_code_template(
    request: Request,
    kp_id: str,
    grade_level: str | None = Query(None, description="学生学段（可选；传了就按兼容链卡，不传不过滤）"),
    gradeLevel: str | None = Query(None, include_in_schema=False),
) -> CodeTemplate:
    """取模板（供 ``get_code_template`` Tool 调用）。

    - **纯本地文件读取**，不经 LLM、不联网 —— 断网可用（票 19 验收项）；
    - 返回体是 :class:`CodeTemplate`，**结构上没有 ``solution``**（投影而非裁剪）；
    - 取不到 → **404 + 可读中文**（空对象会让前端渲染一张没有脚手架的卡片）；
    - 坏模板只跳过、不抛异常（与题库同口径）。
    """
    level = _pick_grade_level(grade_level, gradeLevel)
    report = load_templates(templates_dir_for(request))
    record = find_template(report.records, kp_id)
    if record is None:
        known = "、".join(sorted({item.kp_id for item in report.records})) or "（无）"
        raise HTTPException(
            status_code=404,
            detail=(
                f"知识点 {kp_id!r} 还没有预置代码模板。"
                f"现有模板：{known}（模板文件：server/resources/code-templates/）。"
            ),
        )
    if not template_grade_ok(record, level):
        raise HTTPException(
            status_code=404,
            detail=(
                f"模板 {record.kp_id!r} 属 {record.grade_level} 学段，"
                f"高于当前学段 {level}（只允许取不高于本学段的内容）。"
            ),
        )

    logger.info(
        "取代码模板：kp=%s 学段=%s 命中=%s（模板文件：%s；坏模板 %d）",
        kp_id,
        level or "未过滤",
        record.source_file,
        "、".join(report.files) or "无",
        len(report.skipped),
    )
    return to_code_template(record)


@router.get(
    "/code/hint/{kp_id}",
    response_model=CodingHint,
    summary="取某知识点的一条分级提示（手动求助按钮用）",
)
def get_coding_hint(
    request: Request,
    kp_id: str,
    level: int = Query(1, ge=MIN_HINT_LEVEL, le=MAX_HINT_LEVEL, description="要第几级提示（1 指方向 / 2 结构 / 3 骨架）"),
) -> CodingHint:
    """取一条提示（供 ``get_coding_hint`` Tool 调用：学生点「求助」时）。

    ★ **级别由调用方决定、由本端点封顶**：
      - 调用方（``coding.ts``）维护「该 kp 上已经给过第几级」，据此要**下一级** ——
        它在有状态的那一侧强制「一次只升一级」，这是「不跳级」的落点；
      - 本端点只保证**不越界**：``level`` 超过模板实际写了几级时，退到模板的最高级
        （宁可给最高级的提示，也不要因为越界而让学生的「求助」按钮点了没反应）。

    没有该 kp 的模板（= 没有提示素材）→ **404 + 可读中文**，
    由编排层退回「用对话引导」（这是能力受限，不是崩溃）。
    """
    report = load_templates(templates_dir_for(request))
    record = find_template(report.records, kp_id)
    if record is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"知识点 {kp_id!r} 还没有分级提示（模板文件：server/resources/code-templates/）。"
                "请改用对话引导：先问学生卡在哪一步，再给一句方向性的提示。"
            ),
        )

    ceiling = record.max_hint_level
    if ceiling <= 0:  # pragma: no cover - load_template 已要求 hints 非空时才有值
        raise HTTPException(status_code=404, detail=f"知识点 {kp_id!r} 的模板里没有提示内容。")

    # 越界 → 退到该模板的最高级（不是报错：学生的「求助」应该总能得到点什么）
    wanted = max(MIN_HINT_LEVEL, min(int(level), MAX_HINT_LEVEL))
    hint = record.hint_at(min(wanted, ceiling)) or record.hint_at(ceiling)
    if hint is None:  # pragma: no cover - 上面的 ceiling 已保证至少有一级
        raise HTTPException(status_code=404, detail=f"知识点 {kp_id!r} 的提示内容为空。")

    logger.info(
        "取分级提示：kp=%s 请求级=%s 实给级=%s（模板最高级=%s）",
        kp_id,
        level,
        hint.level,
        ceiling,
    )
    return hint


@router.post(
    "/code/run-hint",
    response_model=CodeEvaluation,
    summary="提交「代码 + 运行结果」，返回中文反馈与下一级提示（不执行代码）",
)
def run_hint(request: Request, body: CodeRunRequest) -> CodeEvaluation:
    """★ **本端点不执行代码**：它收到的是渲染进程 Pyodide Worker 已经跑完的结果。

    入参 :class:`CodeRunRequest` 里的 ``stdout`` / ``stderr`` 就是 Worker 回传的原文
    （``stderr`` 非空 = 运行失败）。本函数只做三件事：

    1. **归一化报错** → :class:`CodeError`（中文解释 + 原始 traceback 留档）；
    2. **生成反馈** → ``feedback``（面向学生，不说「改成什么」）；
    3. **挑下一级提示** → ``next_hint``（按 ``attempt`` 递进，**不跳级**，见 :func:`resolve_hint_level`）。

    ``attempt`` 是「同一知识点下的第几次尝试」（契约里 ``ge=1``），
    由主进程的 ``evaluate_code`` Tool 按学生维度计数后传入 ——
    **服务端不保存这个计数**（它是单轮临时态，放 Extension 内存 Map 里，执行文档 §6.6）。

    取不到模板不算失败：没有模板就没有分级提示，此时 ``next_hint=None``，
    反馈本身照给（报错翻译与模板无关）。
    """
    code = body.code or ""
    if len(code) > MAX_CODE_CHARS:
        raise HTTPException(
            status_code=422,
            detail=f"代码过长（{len(code)} 字符，上限 {MAX_CODE_CHARS}）——请确认没有误粘贴整份文件。",
        )

    stdout = _clip(body.stdout or "", MAX_OUTPUT_CHARS)
    stderr = _clip(body.stderr or "", MAX_OUTPUT_CHARS)

    # ★ 「成功」的判据只看 stderr 是否为空 —— **不猜、不重跑**。
    #   注意 stdout 为空也可能成功（程序没打印），所以不能用 stdout 判成败。
    ok = stderr.strip() == ""
    code_error = None if ok else build_code_error(stderr)
    feedback = build_feedback(ok=ok, code_error=code_error, attempt=body.attempt)

    # 下一级提示：**失败才给**（跑通了还要提示是打扰；且提示会给学生「我还没做对」的错觉）。
    hint: CodingHint | None = None
    if not ok:
        report = load_templates(templates_dir_for(request))
        record = find_template(report.records, body.kp_id)
        if record is not None:
            level = resolve_hint_level(body.attempt, max_level=record.max_hint_level)
            if level > 0:
                hint = record.hint_at(level)

    logger.info(
        "代码评估：kp=%s 学段=%s 第 %d 次 成功=%s 错误=%s 行=%s 提示级=%s",
        body.kp_id,
        body.language,
        body.attempt,
        ok,
        code_error.type if code_error else "无",
        code_error.line if code_error else "-",
        hint.level if hint else "-",
    )

    return CodeEvaluation(
        ok=ok,
        stdout=stdout,
        error=code_error,
        feedback=feedback,
        next_hint=hint,
    )


#: 供测试只读访问的出口（**不导出到 HTTP**：它们只是文案表与短语函数的引用）。
#: 为什么允许测试直接看它们：文案表是"四类错误都要翻成人话"这条验收口径的唯一实现处，
#: 测试要能全量扫一遍（防某一条模板漏改），而不是只测手写的那几条样例。
ERROR_PLAYBOOK = _ERROR_PLAYBOOK
line_phrase = _line_phrase

__all__ = [
    "CODE_RUN_TIMEOUT_MS",
    "CODE_TEMPLATES_DIRNAME",
    "CodeTemplateRecord",
    "MAX_CODE_CHARS",
    "MAX_HINT_LEVEL",
    "MAX_OUTPUT_CHARS",
    "SUCCESS_FEEDBACK",
    "TEMPLATES_DIR_ENV",
    "TEMPLATES_DIR_STATE_ATTR",
    "TemplateLoadReport",
    "build_code_error",
    "build_feedback",
    "default_templates_dir",
    "ERROR_PLAYBOOK",
    "error_label",
    "line_phrase",
    "find_template",
    "get_code_template",
    "load_template",
    "load_templates",
    "looks_interrupted",
    "next_hint_level",
    "parse_python_error",
    "resolve_hint_level",
    "router",
    "run_hint",
    "template_grade_ok",
    "templates_dir_for",
    "to_code_template",
    "translate_python_error",
]
