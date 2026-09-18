"""内容安全：**输入侧轻量检查 + 生成结束后的整段终审 + 日志/provider 边界脱敏**（票 22）。

链路（执行文档 §12）::

    学生输入 ──▶ [1] 输入检查（词表 + 越狱意图正则）      ← 命中：直接 blocked，不发请求
                   │ 通过
                   ▼
              [2] 流式生成（首 token 不被审核拖慢）
                   │ 生成结束
                   ▼
              [3] 整段终审：词表再扫一遍 + LLM 自审（双重过滤）
                   │ 命中
                   ▼
              发 blocked {requestId, reason, safeText}，前端撤回该条消息并替换为安全文本

**为什么终审放在「生成结束之后」**：审核放生成前会拖慢首 token，放每一段流式增量前会让
句子被切得七零八落。生成结束后整段判一次，既准又不动流式体验（票 22 的实测要求）。

**为什么判定与安全文本都留在这里**：主进程只负责「投递事件 + 协调撤回」，不出现第二套判定口径
（`desktop/src/main/safety/review.ts` 只做 LLM 自审调用与事件投递）。LLM 调用本身在 TS 侧
（Python 侧不装 LLM 客户端），所以这里提供：自审 prompt 模板 + 自审响应的容错解析 + 两者合并规则。

**脱敏**：``redact_text`` / :class:`RedactionFilter` / ``redact_provider_headers`` /
``summarize_provider_payload``。三条纪律：

1. **API Key 与模型 I/O 明文绝不入日志**（Key 用 :func:`register_secret` 注册后全局抹掉）；
2. ★ **脱敏必须保留 ``%s`` / ``%(name)s`` 占位符** —— 无脑把 ``record.msg`` 擦成 ``***``
   会让 ``record.getMessage()`` 抛 ``TypeError: not all arguments converted during string
   formatting``（见 :class:`RedactionFilter` 的实现说明）；
3. **模型请求体只留脱敏摘要**（:func:`summarize_provider_payload` 一个正文字符都不输出）。

**K12 合规**（§12）：采集最小化、**不采集生物特征**、不索取个人信息。字段清单与禁用词在
:data:`COLLECTED_FIELDS` / :data:`FORBIDDEN_FIELD_TOKENS`，用 :func:`audit_collected_fields` 自检。

> 归口说明：``server/app/security.py`` 是**鉴权与 CORS**（token/中间件），里面**没有**脱敏实现 ——
> 所以全仓的脱敏唯一实现就是本文件的 :func:`redact_text` 一族，不要另起第二套。
"""

from __future__ import annotations

import json
import logging
import re
import threading
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import RESOURCES_DIR

logger = logging.getLogger(__name__)

#: 敏感词表路径（可扩展的 JSON 数据文件）
SENSITIVE_WORDS_FILENAME = "sensitive-words.json"
#: 环境变量覆盖（演示时指向「故意收紧」的那一份）
WORDS_PATH_ENV = "K12_SENSITIVE_WORDS"

#: 命中这些 severity 的条目 = 拦截；``flag`` 只记日志（观察用，不打断对话）
BLOCK_SEVERITY = "block"
FLAG_SEVERITY = "flag"

#: 多类同时命中时按这个顺序取「最该说的话」（越靠前越优先）
CATEGORY_PRIORITY: tuple[str, ...] = (
    "self_harm",
    "violence",
    "adult",
    "illegal",
    "personal_info",
    "jailbreak",
    "abuse",
    "llm_unclassified",
)

#: 词表缺失或某类没写 safeText 时的兜底安全文本（**永远有话可说**，不能空手撤回消息）
DEFAULT_SAFE_TEXT = (
    "这个话题我不能接着讲。我们正在上人工智能通识课，换个问题我一定能帮上忙。"
)

STAGE_INPUT = "input"
STAGE_FINAL = "final_review"


# --------------------------------------------------------------------------- #
# 词表
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class WordHit:
    """一次命中（词或正则）。"""

    token: str
    category: str
    severity: str = BLOCK_SEVERITY
    note: str = ""


@dataclass(frozen=True)
class WordList:
    """加载后的词表（不可变；运行期只读）。"""

    categories: Mapping[str, Mapping[str, str]] = field(default_factory=dict)
    words: tuple[Mapping[str, Any], ...] = ()
    patterns: tuple[Mapping[str, Any], ...] = ()
    source: str = ""

    def safe_text(self, category: str) -> str:
        """取某一类的安全文本（没有就兜底）。"""
        entry = self.categories.get(category) or {}
        text = str(entry.get("safeText") or "").strip()
        return text or DEFAULT_SAFE_TEXT

    def label(self, category: str) -> str:
        entry = self.categories.get(category) or {}
        return str(entry.get("label") or category)


EMPTY_WORDLIST = WordList()


def default_words_path() -> Path:
    """词表默认路径（``K12_SENSITIVE_WORDS`` 可覆盖）。"""
    import os

    override = os.environ.get(WORDS_PATH_ENV)
    if override:
        return Path(override)
    return RESOURCES_DIR / SENSITIVE_WORDS_FILENAME


def load_wordlist(path: str | Path | None = None) -> WordList:
    """读词表。**读不到不算错误**（返回空表 = 不拦），但要留下警告日志。

    现场演示时宁可「少拦一点」也不能因为一个 JSON 坏了整条对话链挂掉；
    而「词表没加载」这件事必须能在日志里看到，不能静默失效。
    """
    target = Path(path) if path else default_words_path()
    try:
        raw = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("敏感词表不可用（本次不拦输入）：%s（%s）", target, exc)
        return EMPTY_WORDLIST

    categories = raw.get("categories") or {}
    words = tuple(w for w in (raw.get("words") or []) if isinstance(w, dict) and w.get("word"))
    patterns = tuple(
        p for p in (raw.get("patterns") or []) if isinstance(p, dict) and p.get("pattern")
    )
    return WordList(
        categories={str(k): dict(v) for k, v in categories.items() if isinstance(v, dict)},
        words=words,
        patterns=patterns,
        source=str(target),
    )


_WORDLIST_CACHE: WordList | None = None
_WORDLIST_LOCK = threading.Lock()


def get_wordlist(*, force_reload: bool = False) -> WordList:
    """进程内缓存的默认词表（每次启动读一次；``force_reload`` 供测试/演示用）。"""
    global _WORDLIST_CACHE
    with _WORDLIST_LOCK:
        if _WORDLIST_CACHE is None or force_reload:
            _WORDLIST_CACHE = load_wordlist()
        return _WORDLIST_CACHE


# --------------------------------------------------------------------------- #
# 判定
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SafetyVerdict:
    """一次安全检查的结论（``blocked`` 事件的两个字段就来自这里）。"""

    allowed: bool
    category: str = "ok"
    reason: str = ""
    safe_text: str = ""
    matched: tuple[str, ...] = ()
    #: ``wordlist`` = 词表命中；``pattern`` = 越狱意图正则命中；``llm`` = 自审判违规；``none`` = 通过
    source: str = "none"
    #: 只记日志、不拦截的命中（severity=flag）
    flagged: tuple[str, ...] = ()
    stage: str = STAGE_INPUT

    def to_payload(self) -> dict[str, str]:
        """``blocked`` 事件的载荷（**不含 ``requestId``** —— 它由主进程的轮次句柄注入）。"""
        return {"reason": self.reason, "safeText": self.safe_text}

    def as_log_fields(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "category": self.category,
            "source": self.source,
            "stage": self.stage,
            "matched": list(self.matched),
            "flagged": list(self.flagged),
        }


ALLOWED_VERDICT = SafetyVerdict(allowed=True)


def _compile_patterns(wordlist: WordList) -> list[tuple[re.Pattern[str], Mapping[str, Any]]]:
    compiled: list[tuple[re.Pattern[str], Mapping[str, Any]]] = []
    for entry in wordlist.patterns:
        try:
            compiled.append((re.compile(str(entry["pattern"]), re.IGNORECASE), entry))
        except re.error as exc:  # 词表里写错一条正则，不该让整个安全检查崩
            logger.warning("敏感词正则非法，已跳过：%s（%s）", entry.get("id"), exc)
    return compiled


# --------------------------------------------------------------------------- #
# 匹配前的**归一化**（防「最普通的打字方式」绕过）
# --------------------------------------------------------------------------- #
#: 零宽 / 不可见 / 双向控制字符：把词切开就能绕过朴素子串匹配
#: （``自\u200b杀`` 在屏幕上与「自杀」一模一样，但 ``in`` 判不出）。
#: 范围覆盖：零宽空格/连接符/方向标记（200b–200f）、行/段分隔符（2028–2029）、
#: 双向嵌入与覆盖（202a–202e）、词连接符（2060–2064）、BOM（feff）。
_INVISIBLE_CHARS_RE = re.compile("[\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]")

#: 词内部的分隔符（``自 杀`` / ``自　杀`` / ``自-杀``）：全部当「没写」处理。
#: 含换行 —— 「买\n枪」这类跨行拆分同样是绕过手法（词表里的词都是 2–6 字的整词，
#: 被换行劈开的概率极低，所以不会带来实质误伤）。
_CJK_SEPARATORS = (
    " \t\r\n\u3000\u00a0\u2007\u2008\u2009\u200a·・.,，、;；:：-—_~～/\\|+*'\"“”‘’()（）[]【】<>《》?!！？"
)
#: 只在**两个 CJK 字符之间**吃掉分隔符 —— 英文单词里的空格必须保留
#: （否则「a b」会粘成「ab」，把无关文本焊成命中）。
_CJK_CHAR = r"[\u3400-\u4dbf\u4e00-\u9fff]"
_CJK_GAP_RE = re.compile(f"({_CJK_CHAR})[{re.escape(_CJK_SEPARATORS)}]+(?={_CJK_CHAR})")


def normalize_for_matching(text: str) -> str:
    """把文本归一化成**用于匹配**的形态（**只用于匹配，不用于回显/存库**）。

    三步（业务陷阱清单 §5：朴素子串匹配下「最普通的打字方式」就能绕过第一道防线）：

    1. ``NFKC`` —— 全角标点/字母向内折叠（``ＡＢＣ`` → ``ABC``），
       同时把大部分兼容字符收敛成标准形态；
    2. **删掉零宽/不可见/双向控制字符** —— ``自\\u200b杀``、``自\\ufeff杀`` 屏幕上就是「自杀」；
    3. **吃掉两个 CJK 字符之间的空白与标点** —— ``自 杀`` / ``自　杀``（全角空格）/``自-杀``。

    ⚠️ 归一化只影响**匹配用的那份副本**：返回的 ``SafetyVerdict.matched`` 里只有
    **命中的词**（词表原文），不回显位移，因此不存在「命中的 span 映射不回原文」的问题
    （这是有意的取舍：回显位移需要一张偏移映射表，而本项目从不回显学生原话）。

    ⚠️ **已知残留风险（需产品确认后补词表，本期不做自动转写）**：
    繁体（``自殺``）、拼音（``zisha``）、同音替代（``自沙``）、英文（``self-harm``）
    **不在本次修复范围内** —— 它们不是「打字习惯」问题，而是词表覆盖面问题；
    自动繁→简转写要引第三方表，且会把教材里的正常繁体内容（如引用港台资料）
    卷进误伤。已在 ``docs/report-material/pitfalls.md`` 记一条。
    """
    if not text:
        return text
    folded = unicodedata.normalize("NFKC", str(text))
    stripped = _INVISIBLE_CHARS_RE.sub("", folded)
    return _CJK_GAP_RE.sub(r"\1", stripped)


def _match_all(text: str, wordlist: WordList) -> list[WordHit]:
    """词表 + 越狱正则匹配。**先归一化再匹配**（否则零宽/空格变体全放行）。

    正则同样跑在归一化文本上：越狱话术里塞零宽字符是常见绕过手法
    （``Ignore all previous instructions`` 的空格变体也一样）。
    """
    normalized = normalize_for_matching(text)
    hits: list[WordHit] = []
    for entry in wordlist.words:
        token = str(entry["word"])
        if token and (token in normalized or token in text):
            hits.append(
                WordHit(
                    token=token,
                    category=str(entry.get("category") or "unclassified"),
                    severity=str(entry.get("severity") or BLOCK_SEVERITY),
                    note=str(entry.get("note") or ""),
                )
            )
    for pattern, entry in _compile_patterns(wordlist):
        found = pattern.search(normalized) or pattern.search(text)
        if found:
            hits.append(
                WordHit(
                    token=f"regex:{entry.get('id') or found.group(0)}",
                    category=str(entry.get("category") or "jailbreak"),
                    severity=str(entry.get("severity") or BLOCK_SEVERITY),
                    note=str(entry.get("note") or ""),
                )
            )
    return hits


def _pick_category(hits: Sequence[WordHit]) -> str:
    for category in CATEGORY_PRIORITY:
        if any(hit.category == category for hit in hits):
            return category
    return hits[0].category if hits else "ok"


def _blocked(
    hits: Sequence[WordHit], wordlist: WordList, *, stage: str, reason: str = ""
) -> SafetyVerdict:
    category = _pick_category(hits)
    tokens = tuple(dict.fromkeys(hit.token for hit in hits if hit.severity == BLOCK_SEVERITY))
    flagged = tuple(dict.fromkeys(hit.token for hit in hits if hit.severity != BLOCK_SEVERITY))
    label = wordlist.label(category)
    return SafetyVerdict(
        allowed=False,
        category=category,
        reason=reason or f"命中内容安全规则：{label}（{'、'.join(tokens) or '自审'}）",
        safe_text=wordlist.safe_text(category),
        matched=tokens,
        source="pattern" if tokens and tokens[0].startswith("regex:") else "wordlist",
        flagged=flagged,
        stage=stage,
    )


def check_input(
    text: str,
    *,
    wordlist: WordList | None = None,
    grade_level: str | None = None,
) -> SafetyVerdict:
    """**输入侧轻量检查**：敏感词 + 越狱意图正则。命中即拦截，不发起模型调用。

    ``grade_level`` 只用于日志（安全口径不因学段放宽 —— 这是刻意的不对称：
    高年级可以聊更复杂的话题，但不能聊违规内容）。

    日志里**只记命中的词与类别，不记学生原话**（最小化采集）。
    """
    if not text or not text.strip():
        return ALLOWED_VERDICT
    words = wordlist or get_wordlist()
    hits = _match_all(text, words)
    blocking = [hit for hit in hits if hit.severity == BLOCK_SEVERITY]
    if blocking:
        verdict = _blocked(blocking, words, stage=STAGE_INPUT)
        logger.warning(
            "内容安全拦截（输入侧）：%s 学段=%s 命中=%s 正文长度=%d（不回显正文）",
            json.dumps(verdict.as_log_fields(), ensure_ascii=False),
            grade_level or "unknown",
            list(verdict.matched),
            len(text),
        )
        return verdict

    flagged = tuple(dict.fromkeys(hit.token for hit in hits))
    if flagged:
        logger.info("内容安全观察项（输入侧，不拦截）：%s", list(flagged))
    return SafetyVerdict(allowed=True, flagged=flagged, stage=STAGE_INPUT)


# --------------------------------------------------------------------------- #
# 生成侧终审（流结束后整段判定）
# --------------------------------------------------------------------------- #
def build_self_review_prompt(text: str, *, grade_level: str | None = None) -> str:
    """LLM 自审 prompt（双重过滤的第二道，票 22）。

    在 TS 侧调用（Python 不装 LLM 客户端），响应交回 :func:`parse_self_review` 解析。
    刻意写成「只回 JSON」，避免模型多写一段解释导致解析失败。
    """
    level = grade_level or "未指定"
    return (
        "你是 K12 人工智能通识课的内容安全审核员。请判断下面这段「教学助手回复」是否违反安全规则。\n"
        "违反的情形只有这些：\n"
        "1. 涉及自伤、轻生、暴力伤害的具体方法或鼓励；\n"
        "2. 涉及色情/成人内容；\n"
        "3. 涉及违法犯罪的具体操作（制毒、制爆、买卖枪械等）；\n"
        "4. 向学生索要或诱导其提供个人信息（姓名、住址、电话、密码、照片、生物特征）；\n"
        "5. 辱骂、人身攻击学生；\n"
        "6. 与「人工智能通识课」无关且不适合未成年人讨论的内容。\n"
        "注意：正常讲解教材中的技术概念（如神经网络、决策树、数据与隐私保护）、"
        "提醒学生保护个人信息、讨论 AI 伦理与安全，**都不算违规**，不要误判。\n"
        f"目标学段：{level}。\n\n"
        "只输出一个 JSON 对象，不要任何其它文字、不要 Markdown 代码块：\n"
        '{"violation": true 或 false, "category": "self_harm|violence|adult|illegal|personal_info|abuse|off_topic|none", '
        '"reason": "一句话中文理由"}\n\n'
        "待审核的回复：\n"
        "<<<REPLY\n"
        f"{text}\n"
        "REPLY>>>\n"
    )


@dataclass(frozen=True)
class SelfReview:
    """LLM 自审结果（容错解析后的形态）。"""

    violation: bool
    category: str = "llm_unclassified"
    reason: str = ""
    raw: str = ""


_BOOL_TRUE = {"true", "1", "yes", "y", "是", "违规", "unsafe", "不通过"}
_BOOL_FALSE = {"false", "0", "no", "n", "否", "安全", "safe", "通过"}
_VIOLATION_KEYS = ("violation", "is_violation", "isviolation", "unsafe", "violates", "blocked")
_SAFE_KEYS = ("safe", "ok", "allowed", "pass")


def _coerce_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        text = value.strip().lower()
        if text in _BOOL_TRUE:
            return True
        if text in _BOOL_FALSE:
            return False
    return None


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    """从模型输出里抠出第一个 JSON 对象（允许 ```json 围栏与前后废话）。

    ★ **单次线性扫描**（``O(n)``，每个字符只看一遍）。曾经的实现是「每个 ``{`` 起点都做一次
    到底扫描，失败后 ``find("{", start+1)`` 再来一遍」——最坏 ``O(n²)``：
    实测全 ``{`` 的 8000 字符输入要 **2.04 秒**（``{"`` 交替 0.86 秒），
    而 ``MAX_SELF_REVIEW_CHARS`` 正好是 8000。调用链是**同步**端点 ``/api/safety/check``，
    一次畸形响应就能占住一个线程池 worker（并发几个就把池子占满）。

    现行算法：从左到右扫**一遍**，遇到 ``{`` 压栈、遇到 ``}`` 弹栈，
    字符串与转义状态在同一次扫描里维护（所以 ``{"reason": "写 { 号"}`` 里的花括号不会被误配对）。
    **只在「栈空了」的那个右括号处尝试解析** —— 它对应的正是**最外层**对象：

    - 顶层对象合法 → 立刻返回（这一条覆盖了 ``{"violation": true, "detail": {"a": 1}}``
      这类嵌套输入：内层右括号不触发解析，外层那一次直接拿到整个对象）；
    - 顶层对象非法 → 继续扫下一个顶层对象（``{乱写} {"violation": true}`` 能找到后者）；
    - 全程没有合法顶层对象 → 返回 ``None``（**坏 JSON 返回 None，绝不抛**）。

    每个顶层候选互不重叠，所以总解析代价是 ``O(n)``。
    已知取舍：外层非法而**恰好内层合法**的畸形输入（``{"x": y {"violation": true}}``）
    现在返回 ``None``（旧实现会退到内层对象）。这条代价是有意接受的：
    「解析不出来」在调用链上的语义是「审核不可用 → 不据此拦截」，
    不会把内容误判成违规；而为了它去逐层重扫，就等于把 ``O(n²)`` 请回来。
    """
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    starts: list[int] = []  # 未闭合的 `{` 位置（栈）
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            starts.append(index)
        elif char == "}":
            if not starts:
                continue  # 多余的右括号（前面废话里的）：跳过，继续找后面的对象
            start = starts.pop()
            if starts:
                continue  # 嵌套内的右括号：它的外层的右括号会负责解析整个顶层对象
            try:
                parsed = json.loads(text[start : index + 1])
            except json.JSONDecodeError:
                continue  # 这个顶层对象不合法 → 继续找下一个
            return parsed if isinstance(parsed, dict) else None
    return None


def parse_self_review(raw: str) -> SelfReview | None:
    """解析 LLM 自审响应。**解析不了就返回 ``None``**（调用方按「审核不可用」处理，不据此拦截）。"""
    if not raw or not raw.strip():
        return None
    payload = _extract_json_object(raw)
    if payload is None:
        logger.warning("自审响应无法解析为 JSON（按「审核不可用」处理，不据此拦截）")
        return None

    violation: bool | None = None
    for key in _VIOLATION_KEYS:
        if key in payload:
            violation = _coerce_bool(payload[key])
            if violation is not None:
                break
    if violation is None:
        for key in _SAFE_KEYS:
            if key in payload:
                value = _coerce_bool(payload[key])
                if value is not None:
                    violation = not value
                    break
    if violation is None:
        return None

    category = str(payload.get("category") or "").strip() or "llm_unclassified"
    reason = str(payload.get("reason") or "").strip()
    return SelfReview(violation=violation, category=category, reason=reason, raw=raw)


def final_review(
    text: str,
    *,
    self_review_raw: str | None = None,
    self_review: SelfReview | None = None,
    grade_level: str | None = None,
    wordlist: WordList | None = None,
) -> SafetyVerdict:
    """**生成结束后的整段终审**（双重过滤的唯一合流点）。

    顺序刻意如此：词表先（确定、便宜、可复现），自审后（覆盖词表漏网）。
    任一道判违规都走同一条 ``blocked`` 路径，前端只处理一种失败形态。
    """
    words = wordlist or get_wordlist()
    verdict = check_input(text, wordlist=words, grade_level=grade_level)
    if not verdict.allowed:
        return SafetyVerdict(
            allowed=False,
            category=verdict.category,
            reason=verdict.reason,
            safe_text=verdict.safe_text,
            matched=verdict.matched,
            source=verdict.source,
            flagged=verdict.flagged,
            stage=STAGE_FINAL,
        )

    review = self_review if self_review is not None else parse_self_review(self_review_raw or "")
    if review is None or not review.violation:
        return SafetyVerdict(
            allowed=True, flagged=verdict.flagged, stage=STAGE_FINAL
        )

    category = review.category if review.category in words.categories else "llm_unclassified"
    result = SafetyVerdict(
        allowed=False,
        category=category,
        reason=review.reason or f"LLM 自审判定违规（{review.category}）",
        safe_text=words.safe_text(category),
        matched=(f"llm:{review.category}",),
        source="llm",
        flagged=verdict.flagged,
        stage=STAGE_FINAL,
    )
    logger.warning(
        "内容安全拦截（生成侧终审）：%s 学段=%s 正文长度=%d（不回显正文）",
        json.dumps(result.as_log_fields(), ensure_ascii=False),
        grade_level or "unknown",
        len(text),
    )
    return result


# --------------------------------------------------------------------------- #
# 脱敏（凭据、模型 I/O、日志）
# --------------------------------------------------------------------------- #
_SECRETS: set[str] = set()
_SECRETS_LOCK = threading.Lock()

#: 明确的凭据形态（``sk-...`` / ``Bearer ...`` / ``"apiKey": "..."``）
_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}"), "sk-***"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{8,}"), "Bearer ***"),
    (
        re.compile(
            r"(?i)([\"']?(?:api[_-]?key|apikey|authorization|access[_-]?token|secret|password)[\"']?"
            r"\s*[:=]\s*[\"']?)([^\"',\s}]{4,})"
        ),
        r"\1***",
    ),
)
#: 邮箱：K12 场景不入日志（最小化采集）
_EMAIL_PATTERN = re.compile(r"\b[A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b")

#: ``%``-格式占位符（``%s`` / ``%(name)s`` / ``%d`` / ``%%``）——脱敏时**必须原样保留**
_FORMAT_SPECIFIER = re.compile(r"%(?:\([^)]*\))?[#0\- +]?\d*(?:\.\d+)?[diouxXeEfFgGcrsa%]")

#: 需要脱敏的请求头（provider 边界审计）
SENSITIVE_HEADERS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "x-api-key",
        "api-key",
        "apikey",
        "cookie",
        "set-cookie",
        "x-auth-token",
        "token",
    }
)

REDACTED = "***"


def register_secret(value: str | None) -> None:
    """把一个明文凭据登记进「全局抹掉」名单（**只用于让日志/审计里不再出现它**）。"""
    if not value:
        return
    secret = str(value).strip()
    if len(secret) < 6:  # 太短的串（如 "none"）抹掉会造成大量误伤
        return
    with _SECRETS_LOCK:
        _SECRETS.add(secret)


def clear_secrets() -> None:
    """清空登记表（单测用）。"""
    with _SECRETS_LOCK:
        _SECRETS.clear()


def redact_text(text: str, extra_secrets: Iterable[str] = ()) -> str:
    """把凭据与邮箱抹成 ``***``。返回新串，不改入参。"""
    if not text:
        return text
    result = str(text)
    with _SECRETS_LOCK:
        secrets = sorted(set(_SECRETS) | {str(s) for s in extra_secrets if s}, key=len, reverse=True)
    for secret in secrets:
        if secret:
            result = result.replace(secret, REDACTED)
    for pattern, replacement in _SECRET_PATTERNS:
        result = pattern.sub(replacement, result)
    result = _EMAIL_PATTERN.sub(lambda m: f"{REDACTED}@{m.group(1)}", result)
    return result


def _redact_value(value: Any) -> Any:
    """脱敏一个日志参数。**类型能不动就不动** —— 改了类型会让 ``%d`` 直接抛异常。"""
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, (int, float, bool, bytes)) or value is None:
        return value
    if isinstance(value, (BaseException, Path, dict, list, tuple, set)):
        # 这些类型在 %s 下都安全；用它们自己的文本形态脱敏后再放回去
        return redact_text(str(value))
    return value


def _redact_format_string(fmt: str) -> str:
    """脱敏 ``record.msg``，**逐段跳过 %-占位符**。

    这就是「擦 record.msg 导致格式化炸」的正解：
    占位符周围的字面量可以随便改，占位符本身一个字符都不能动。
    """
    pieces: list[str] = []
    cursor = 0
    for match in _FORMAT_SPECIFIER.finditer(fmt):
        pieces.append(redact_text(fmt[cursor : match.start()]))
        pieces.append(match.group(0))
        cursor = match.end()
    pieces.append(redact_text(fmt[cursor:]))
    return "".join(pieces)


def _redact_args(args: Any) -> Any:
    if args is None:
        return None
    if isinstance(args, Mapping):
        return {key: _redact_value(value) for key, value in args.items()}
    if isinstance(args, tuple):
        return tuple(_redact_value(item) for item in args)
    return _redact_value(args)


class RedactionFilter(logging.Filter):
    """日志脱敏过滤器（**保留 ``%s`` / ``%(name)s`` 占位符**）。

    为什么不能图省事把 ``record.msg`` 整个擦掉：``record.getMessage()`` 会做
    ``msg % args``，占位符没了、参数还在 → ``TypeError: not all arguments converted
    during string formatting``。格式化一炸，日志 handler 会把异常打到自己头上，
    真正的日志内容反而全丢，排查时只能看到一片 TypeError。

    所以这里：① 格式串**逐段**脱敏、跳过占位符；② 参数值各自脱敏后**保持原类型与个数**。
    两处都保住，``getMessage()`` 就永远和原来一样能跑。
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 - logging 的接口名
        try:
            if isinstance(record.msg, str):
                record.msg = _redact_format_string(record.msg)
            elif record.msg is not None:
                record.msg = redact_text(str(record.msg))
            record.args = _redact_args(record.args)
        except Exception:  # noqa: BLE001 - 脱敏绝不允许把日志打挂
            record.msg = "（日志脱敏失败，原始记录已丢弃）"
            record.args = ()
        return True


def _attach_filter_once(target: Any, redaction: RedactionFilter) -> None:
    """把过滤器挂到 logger / handler 上（**幂等**：已有 RedactionFilter 实例就不再加）。"""
    for existing in list(getattr(target, "filters", ())):
        if isinstance(existing, RedactionFilter):
            return
    target.addFilter(redaction)


def install_log_redaction(logger_: logging.Logger | None = None) -> RedactionFilter:
    """把脱敏过滤器挂到根 logger **以及它现有的 handler** 上（幂等）。

    ★★ **为什么必须同时挂 handler（生产路径上漏掉这一半 = 脱敏完全不生效）**：
    ``Logger.filter()`` 只对「**直接在该 logger 上调用**」的记录生效；
    子 logger（``app.rag.retriever`` 等）通过 ``propagate`` 把记录交给 root 的 **handler** 时,
    **不会再跑 root logger 的 filter**。而 ``configure_logging()`` 用 ``logging.basicConfig``
    建的是 root 的 handler —— 于是「只 addFilter 到 root logger」的实现里，
    真实业务日志（子 logger 打的）一条都没被脱敏。

    实测（修复前）::

        install_log_redaction(); register_secret('sk-supersecret123456')
        logging.getLogger('app.rag.retriever').info('调用失败 key=%s', 'sk-supersecret123456')
        # 实际输出：INFO:app.rag.retriever:调用失败 key=sk-supersecret123456   ← 明文

    挂到 handler 上之后，记录在 ``emit`` 之前一定会过一遍脱敏，传播路径漏不掉。

    ⚠️ **必须在写任何日志之前、且在 handler 建好之后调用**（``app/main.py`` 里紧挨
    ``configure_logging()``）。若之后又有新 handler（例如 uvicorn 自建），**再调一次本函数**
    即可补齐 —— 它是幂等的，重复调用不会叠加第二个过滤器。

    本函数不在 import 时自动生效 —— 模块级副作用会让单测互相污染。
    """
    target = logger_ if logger_ is not None else logging.getLogger()
    existing = next((f for f in target.filters if isinstance(f, RedactionFilter)), None)
    redaction = existing if existing is not None else RedactionFilter()
    _attach_filter_once(target, redaction)

    # handler 侧：root 的 handler 承接所有 propagate 上来的记录（子 logger 的日志就是这条路）。
    # 同一个 filter 实例挂到多个 handler 上没有问题（它是无状态纯函数式改写）。
    root = logging.getLogger()
    for handler in [*root.handlers, *target.handlers]:
        _attach_filter_once(handler, redaction)
    return redaction


def redact_provider_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """provider 边界（``before_provider_headers``）的脱敏副本：敏感头一律 ``***``。

    返回**新 dict**，不改入参 —— 审计只读，绝不能顺手改掉真正要发出去的请求头。
    """
    out: dict[str, str] = {}
    for key, value in headers.items():
        if str(key).lower() in SENSITIVE_HEADERS:
            out[str(key)] = REDACTED
        else:
            out[str(key)] = redact_text(str(value))
    return out


def summarize_provider_payload(payload: Any, *, max_tools: int = 8) -> dict[str, Any]:
    """把「即将发给模型的请求体」压成**不含正文**的摘要（日志只允许写这个）。

    输出里没有任何 prompt / 消息正文，只有规模与模型名 —— 出了事故也查不出学生说了什么，
    这正是「最小化采集」在日志上的落实。
    """
    if not isinstance(payload, Mapping):
        return {"redacted": True, "shape": type(payload).__name__}

    messages = payload.get("messages")
    message_count = 0
    chars = 0
    system_chars = 0
    roles: dict[str, int] = {}
    if isinstance(messages, Sequence) and not isinstance(messages, (str, bytes)):
        for message in messages:
            if not isinstance(message, Mapping):
                continue
            message_count += 1
            role = str(message.get("role") or "unknown")
            roles[role] = roles.get(role, 0) + 1
            content = message.get("content")
            length = len(content) if isinstance(content, str) else len(str(content or ""))
            chars += length
            if role == "system":
                system_chars += length

    tools = payload.get("tools")
    summary: dict[str, Any] = {
        "redacted": True,
        "model": str(payload.get("model") or ""),
        "messageCount": message_count,
        "roles": roles,
        "chars": chars,
        "systemChars": system_chars,
        "hasTools": bool(tools),
    }
    if isinstance(tools, Sequence) and not isinstance(tools, (str, bytes)):
        summary["toolCount"] = len(tools)
        names = [
            str(tool.get("name"))
            for tool in tools[:max_tools]
            if isinstance(tool, Mapping) and tool.get("name")
        ]
        summary["toolNames"] = names
    return summary


# --------------------------------------------------------------------------- #
# K12 合规核对
# --------------------------------------------------------------------------- #
#: 本应用**实际采集**的字段（最小化：只有昵称、学段、学习过程数据；**不采集生物特征**）
COLLECTED_FIELDS: tuple[str, ...] = (
    "student_id",
    "nickname",
    "grade_level",
    "created_at",
    "last_active_at",
    "kp_id",
    "score",
    "attempts",
    "correct",
    "last_seen_at",
    "activity",
    "is_correct",
    "session_id",
)

#: 采集或索要这些字段一律判违规（未成年人数据最小化 + 不采集生物特征，§12）
FORBIDDEN_FIELD_TOKENS: tuple[str, ...] = (
    "biometric",
    "faceprint",
    "face_feature",
    "voiceprint",
    "fingerprint",
    "iris",
    "人脸",
    "面纹",
    "指纹",
    "声纹",
    "虹膜",
    "步态",
    "dna",
    "real_name",
    "真实姓名",
    "id_card",
    "身份证",
    "家庭住址",
    "home_address",
    "phone",
    "手机号",
    "地理位置",
    "gps",
)


def audit_collected_fields(fields: Iterable[str] = COLLECTED_FIELDS) -> list[str]:
    """自检字段清单：命中禁用词即判违规（生物特征 / 真实身份 / 精确位置）。

    返回违规字段名列表（空 = 合格）。票 20 增字段时把清单传进来跑一次即可 ——
    这就是「最小化采集」的可执行版本，而不是文档里的一句口号。
    """
    violations: list[str] = []
    for name in fields:
        lowered = str(name).lower()
        for token in FORBIDDEN_FIELD_TOKENS:
            if token.lower() in lowered:
                violations.append(f"{name} ← {token}")
                break
    return violations


__all__ = [
    "ALLOWED_VERDICT",
    "BLOCK_SEVERITY",
    "CATEGORY_PRIORITY",
    "COLLECTED_FIELDS",
    "DEFAULT_SAFE_TEXT",
    "EMPTY_WORDLIST",
    "FLAG_SEVERITY",
    "FORBIDDEN_FIELD_TOKENS",
    "REDACTED",
    "SENSITIVE_HEADERS",
    "SENSITIVE_WORDS_FILENAME",
    "STAGE_FINAL",
    "STAGE_INPUT",
    "SafetyVerdict",
    "SelfReview",
    "WordHit",
    "WordList",
    "audit_collected_fields",
    "build_self_review_prompt",
    "check_input",
    "clear_secrets",
    "default_words_path",
    "final_review",
    "get_wordlist",
    "install_log_redaction",
    "load_wordlist",
    "parse_self_review",
    "redact_provider_headers",
    "redact_text",
    "register_secret",
    "summarize_provider_payload",
    "RedactionFilter",
]
