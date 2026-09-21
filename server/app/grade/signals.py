# -*- coding: utf-8 -*-
"""学段信号的提取（执行文档 §10.2 / §10.3，票 21）—— **第一层，不调 LLM**。

本模块是**信号提取的唯一实现**：桌面端只上交「本轮证据」（学生原话 +
第二层的 LLM 提议），提取与判定都在 Python 侧发生一次。**不要在 TS 里再写一份轻量版** ——
两份实现必然漂移，而漂移的表现是「学段莫名乱动」，现场演示时最难解释。

★★ **三路信号（2026-09-21 起；原先四路，去掉了「答题表现」）**：
:data:`SIGNAL_TYPES` = ``vocab`` / ``depth`` / ``meta_cognition``。

去掉 ``quiz_perf`` 的理由（两条，都是实测出来的）：

1. **概念错位**：答错两道题说明「这个知识点没掌握」，不等于「学段更低」——
   那本来就是 ``mastery`` 该管的事（``MASTERY_GAIN_CORRECT`` / ``MASTERY_LOSS_WRONG``
   已有一套独立机制）。让答题表现去改学段，等于把「掌握度」和「学段」两个量混在一起。
2. **重复计数**：``TOO_HARD_TERMS``（太难了 / 太难 / 好难 / 不会做）与 ``META_STRUGGLE``
   是同一批词，而 ``extract_quiz_perf_signal`` 还会**读学生原话**去找它们 ——
   学生说一句「太难了」既产生一条元认知 ``-0.5``，又产生一条答题 ``-0.5``，
   该轮合并值直接顶到 ``-1.0``（强度封顶）。一句话的挫败被当成两条独立证据。
   它还绕过了「答题表现只从 ``learning.db`` 读」的设计意图，偷偷读了对话。

⚠️ 契约里仍保留 ``quiz_perf`` 这个取值：历史库里已经有这类行，
   把字面量删掉会让读旧库的接口 500（``GradeSignal.signal_type`` 会校验失败）。

契约（每个提取器都必须满足）
----------------------------
- **纯函数**：不读文件、不发网络、不碰数据库。术语表由调用方注入，默认取模块级缓存词表；
- 返回 :class:`SignalReading`，其中

  - ``value`` 的**符号 = 方向**（正 = 学生比当前学段高，负 = 低 / 受挫），
    ``绝对值 = 强度``（``0.0`` = 该路没有证据）；
  - ``level_hint`` = 「这条证据若被采纳，学段应当落在哪」（``None`` = 给不出方向）；
  - ``raw`` = **自有词表的命中项**（如 ``术语=梯度下降(min_grade=senior)``），
    **绝不放学生原话** —— SQLite 不存对话正文（AGENTS §5.9、执行文档 §8.1）。

- 强度口径**唯一**在 :data:`SIGNAL_STRENGTH_PER_LEVEL` 与
  :func:`strength_for` 里定义：差一个学段 = ``0.5``，差两级及以上封顶 ``1.0``。

> ★ 「连续 3 个同方向信号」的计数单位是**轮**，不是「信号条数」（见
> :class:`TurnSignals` / :func:`turn_direction`）：一轮里同时出现词汇、深度、元认知
> 两条同向信号，仍然只算**一轮**。否则学生一口气多说两句就能把学段推走一级。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Protocol, Sequence

from app.contracts import GradeLevel, GradeSignal, GradeSignalType
from app.knowledge.library import GRADE_LEVELS, load_terminology

logger = logging.getLogger(__name__)

#: **本模块真正提取的**三路信号（2026-09-21 起）。
#:
#: ⚠️ 它与 ``contracts.GradeSignalType`` **不是**同一个集合：契约那个联合类型里还留着
#: ``quiz_perf`` —— 不是给提取器用的，而是**为了能读历史库**（升级前写入的行仍存着那个取值，
#: ``recent_signals()`` 会把库里的值原样灌进 ``GradeSignal``，删掉取值就会 500）。
#: 所以新增一路时改三处：契约 / 本元组 / 提取器；**移除**一路时契约那一处**不要删**。
SIGNAL_TYPES: tuple[GradeSignalType, ...] = ("vocab", "depth", "meta_cognition")

#: 学段由低到高（复用教材轨的冻结顺序，**不要**再抄一份字面量）。
GRADE_ORDER: tuple[GradeLevel, ...] = GRADE_LEVELS  # type: ignore[assignment]

#: ★ 差**一个学段**记 0.5 强度：`0.5 × 1.5(增益) = 0.75 ≥ 0.6 阈值`，
#: 即「三路单级证据」刚好够调整，而「三路都是弱证据」不够（见 rules.py 的置信度公式）。
SIGNAL_STRENGTH_PER_LEVEL = 0.5

#: 单条信号的强度上限（差 ≥2 个学段不再变强：证据再足也只按 1.0 计）。
MAX_SIGNAL_STRENGTH = 1.0

#: ``raw`` 的字符上限（它是一条**证据摘要**，不是正文的容器）。
RAW_MAX_CHARS = 160

# --------------------------------------------------------------------------- #
# 词表（自有，随手改这里 —— 不要在提取器里内联字面量）
# --------------------------------------------------------------------------- #
#: 日常口语（「电脑 / 图片 / 好玩」这类）：与 terminology.json 的专业术语**互为反向证据**。
DAILY_TERMS: tuple[str, ...] = (
    "电脑",
    "手机",
    "平板",
    "玩具",
    "机器人",
    "动画片",
    "动画",
    "照片",
    "图片",
    "好玩",
    "神奇",
    "小猫",
    "小狗",
    "画画",
    "唱歌",
    "打游戏",
    "小助手",
    "说一说",
)

#: 问题深度四档（§10.2：概念 / 原理 / 推导；工程实践是高中档，同样按「深度」计）。
#: 判据是**提问用词**，不是问题本身的价值 —— 同一件事问得越靠内部机制，学段越高。
#:
#: ★★ 词表**分两类**（D3 修复的关键，别把两类合回一张表）：
#:
#: - :data:`DEPTH_FRAME_LEVELS` —— **提问框架**词（「怎么问的」）：什么是 / 原理 / 怎么推导 …。
#:   档位由它决定，且**具体的那一档赢**（原理 > 概念：``神经网络的工作原理是什么``
#:   命中 junior 的「原理」与 primary_high 的「是什么」，取 junior）；
#: - :data:`DEPTH_TOPIC_LEVELS` —— **主题术语**词（「问的是啥」）：公式 / 矩阵 / 概率分布 …。
#:   它**只在没有任何框架词命中时**才兜底。
#:
#: 为什么要分：``什么是公式`` 命中了概念框架（什么是）+ 高中术语（公式）。
#: 合并成一张表 + 「最高档优先」会让它落 senior —— 学生只是问「公式是什么」，
#: 却拿到一条 ``0.5 × 1.5 = 0.75 ≥ 0.6`` 的**上调**证据；同样是问概念，
#: ``什么是循环``（词表里没有「循环」）却落 primary_high。**同一句式不该有两种档位。**
DEPTH_FRAME_LEVELS: tuple[tuple[GradeLevel, tuple[str, ...]], ...] = (
    (
        "senior",
        (
            r"推导",
            r"证明",
            r"求导",
            r"误差(?:怎么|如何)?(?:计算|估计)",
        ),
    ),
    (
        "junior",
        (
            r"原理",
            r"机制",
            r"底层",
            r"内部(?:怎么|如何|是)",
            r"为什么(?:能|会|可以|行)",
            r"怎么(?:样)?(?:工作|运行|学习|实现|训练|判断)",
            r"如何(?:工作|运行|实现|训练)",
            r"是(?:怎么|如何)(?:工作|学习|实现|做到)的",
        ),
    ),
    (
        "primary_high",
        (
            r"什么是",
            r"是什么",
            r"是啥",
            r"啥是",
            r"什么意?思",
            r"能干什么",
            r"能做什么",
            r"有什么用",
            r"会什么",
            r"怎么用",
            r"怎么(?:才)?会",
        ),
    ),
)

#: 主题术语（只兜底：没有框架词时才按「问到的词有多难」定档）。
#: 方向仍是**从高到低取第一个命中**（难点的话题确实更像高学段在问）。
DEPTH_TOPIC_LEVELS: tuple[tuple[GradeLevel, tuple[str, ...]], ...] = (
    (
        "senior",
        (
            r"导数",
            r"链式法则",
            r"梯度",
            r"公式",
            r"矩阵",
            r"概率分布",
            r"极限",
            r"收敛",
        ),
    ),
)

#: 全部深度词表（框架 + 主题）：``raw`` 证据按它遍历命中项，文档/测试也认这个名字。
DEPTH_LEVELS: tuple[tuple[GradeLevel, tuple[str, ...]], ...] = (
    DEPTH_FRAME_LEVELS + DEPTH_TOPIC_LEVELS
)

#: 提问但没有任何「深度词」时按**概念问题**处理（学段 = 小学高年级）：
#: 「电脑怎么认图片呀」这种口语提问不该被当成初中原理问题。
DEFAULT_QUESTION_LEVEL: GradeLevel = "primary_high"

#: 疑问句尾巴（配合上面的默认档：只有真在提问才落默认档，陈述句不猜）。
#: ⚠️ **只收真正的疑问语气**。「吧 / 嘛」是**祈使 / 商量**语气（「我们开始吧」「做一道题吧」），
#: 把它们当疑问句尾，等于把每句课堂用语都读成一次「小学档提问」→ 每轮累积一条下调信号（D2）。
QUESTION_MARKERS: tuple[str, ...] = ("?", "？", "吗", "呢", "呀")

#: ★ 落默认档的**最小信息量**：剥掉标点、语气词与课堂用语后，剩下的 CJK 实词至少这么多字，
#: 才认它是「一个真正的问题」。否则「好呀」「继续吧」「那我们做一道题吧」这类课堂用语
#: 每轮都会产生一条「小学档」读数（对初中/高中学生 = 下调），三五轮就能把学段推走一级，
#: 而 D-020 之后**没有人工纠正出口** —— 代价不对称，所以门槛取保守值。
MIN_QUESTION_CONTENT_CHARS = 4

#: 落默认档时要剥掉的**非实词**（不承载任何知识点信息）：语气词、寒暄、课堂元话语。
#: 只用于 :func:`question_content` 的信息量判定，**不参与任何证据计算**。
FILLER_WORDS: tuple[str, ...] = (
    # 语气词 / 叹词（单字）
    "吧", "呀", "啊", "呢", "吗", "嘛", "哦", "嗯", "哈", "哟", "啦", "咦", "唉", "哇", "诶",
    # 寒暄 / 礼貌语
    "你好", "您好", "谢谢", "老师好", "老师", "请问", "请",
    # 课堂元话语：「开始 / 继续 / 做题」这类，句子再长也没有知识点信息
    "我们", "咱们", "同学", "一起", "现在", "接下来", "然后", "接着", "继续", "开始",
    "再来", "上课", "下课", "休息", "可以", "能不能", "好不好", "行不行", "好吗", "好吧",
    "好呀", "好啊", "好的", "一道", "做题目", "做题", "题目", "题", "练习", "学习",
    "讲讲", "讲", "说说", "说", "看看", "看", "做", "来", "那", "再",
    "这个", "那个", "这里", "那里", "一下", "一点", "有点", "那么", "这么", "这道", "那道",
    "我会了", "会了", "懂了", "知道了",
)

#: 标点 / 空白 / 下划线（信息量判定前的清洗；``\\w`` 在 Python 里包含 CJK）。
_NON_WORD_RE = re.compile(r"[\W_]+", re.UNICODE)

#: CJK 汉字（信息量只数实词，英文数字不算「字」——中文提问里它们通常只是名字）。
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")

#: 剥词顺序：**长的先剥**（否则「继续」被「来」拆散、「那里」被「那」拆散）。
_FILLER_ORDERED: tuple[str, ...] = tuple(sorted(FILLER_WORDS, key=len, reverse=True))

#: 元认知表达（§10.2 第四行）：**受挫 / 需要重复讲解** → 一律按「讲得太深了」处理。
META_STRUGGLE: tuple[str, ...] = (
    "听不懂",
    "没听懂",
    "听不明白",
    "不明白",
    "不理解",
    "看不懂",
    "搞不懂",
    "不懂",
    "跟不上",
    "不会做",
    "太难了",
    "太难",
    "好难",
    "有点难",
    "说简单点",
    "简单一点",
    "讲慢",
    "慢一点",
)
META_REPHRASE: tuple[str, ...] = (
    "再讲一遍",
    "再说一遍",
    "再讲一次",
    "重新讲",
    "换个说法",
    "换种说法",
    "换一个说法",
)

#: ★ 刻意**不**收录「举个例子」「详细一点」「讲详细」（2026-09-21 移除）：
#:   它们是**好奇心与求知欲**的表达 ——「能举个例子吗」是听懂了、想更深一层，
#:   不是「刚才那段讲深了」。把它们当成受挫信号，会让积极提问的学生被**降级**，
#:   而且这类话在低学段尤其常见，方向恰好是反的。
#:   真正要表达「听不懂」的人会用 :data:`META_STRUGGLE` 里的词（听不懂 / 太难了 / 慢一点）。

#: 「太难了」这类受挫表达**已经并入** :data:`META_STRUGGLE`（那边本来就有
#: 太难了 / 太难 / 好难 / 不会做）。原先这里另有一份 ``TOO_HARD_TERMS`` 是给
#: 「答题表现」那一路用的 —— 它从**对话原文**里找这些词，于是与元认知重复计数
#: （一句「太难了」产生两条 ``-0.5``、该轮强度封顶）。那一路已整体移除，
#: 这份常量随之删除，避免留一个「改词表要记得改两处」的坑。


# --------------------------------------------------------------------------- #
# 结构
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SignalReading:
    """一条信号的读数（第一层的唯一产物）。

    ``value`` 的符号是方向、绝对值是强度；``level_hint`` 是「采纳后应落在哪」。
    ``raw`` 为空表示**没有证据**（该路本轮不参与判定，也不会写库）。
    """

    signal_type: GradeSignalType
    value: float
    level_hint: GradeLevel | None = None
    raw: str = ""

    @property
    def direction(self) -> int:
        """``-1`` / ``0`` / ``+1``。"""
        return direction_of(self.value)

    @property
    def strength(self) -> float:
        return abs(self.value)

    @property
    def has_evidence(self) -> bool:
        return bool(self.raw)

    def to_contract(self, ts: int | None = None) -> GradeSignal:
        """转成契约模型（路由出参用；``raw`` 已限长）。"""
        return GradeSignal(
            signal_type=self.signal_type,
            value=float(self.value),
            raw=self.raw[:RAW_MAX_CHARS] or None,
            ts=ts,
        )


class Directional(Protocol):
    """「有方向、有强度」的最小结构面。

    :class:`TurnSignals`（本轮的各路读数）与 ``rules.TurnVerdict``（从库里还原出来的轮次读数）
    都满足它 —— 连续同方向的统计只写一份，两处共用。
    """

    @property
    def direction(self) -> int: ...

    @property
    def strength(self) -> float: ...


@dataclass(frozen=True)
class TurnSignals:
    """**一轮**的全部读数（判定的计数单位）。"""

    turn: int
    session_id: str
    readings: tuple[SignalReading, ...]

    @property
    def evidence(self) -> tuple[SignalReading, ...]:
        """本轮真正有证据的读数。"""
        return tuple(reading for reading in self.readings if reading.has_evidence)

    @property
    def total_value(self) -> float:
        """本轮合并值 = 各条 ``value`` 之和（同向叠加变强，反向相互抵消）。"""
        return sum(reading.value for reading in self.readings)

    @property
    def direction(self) -> int:
        return direction_of(self.total_value)

    @property
    def strength(self) -> float:
        """本轮强度 ∈ [0, 1]（多路证据同向时很快到顶；单路差一级 = 0.5）。"""
        return min(MAX_SIGNAL_STRENGTH, abs(self.total_value))

    @property
    def dominant(self) -> SignalReading | None:
        """本轮最强的那条读数（写库/报告的「代表信号」；无证据返回 ``None``）。"""
        candidates = [reading for reading in self.evidence if reading.value != 0.0]
        if not candidates:
            return self.evidence[0] if self.evidence else None
        return max(candidates, key=lambda reading: abs(reading.value))


# --------------------------------------------------------------------------- #
# 通用小工具（全部纯函数）
# --------------------------------------------------------------------------- #
def direction_of(value: float) -> int:
    """数值 → 方向（``-1`` / ``0`` / ``+1``）。"""
    if value > 0:
        return 1
    if value < 0:
        return -1
    return 0


def rank_of(level: str | None) -> int | None:
    """学段序号（越小越低）；**非法值返回 ``None`` 而不是抛**。

    库里的学段可能是旧版本写的脏值。聊天路径上抛异常 = 一轮对话直接挂，
    而学段脏值最多让本轮没有信号（由 ``routes.students.as_grade_level`` 在读取处兜底）。
    """
    try:
        return GRADE_ORDER.index(level)  # type: ignore[arg-type]
    except ValueError:
        return None


def level_at(rank: int) -> GradeLevel | None:
    """序号 → 学段（越界返回 ``None``：到顶/到底就是**没得调**）。"""
    if rank < 0 or rank >= len(GRADE_ORDER):
        return None
    return GRADE_ORDER[rank]


def strength_for(current_level: str, target_level: str | None) -> tuple[int, float]:
    """比较两个学段 → ``(方向, 强度)``。

    ★ 强度公式的唯一落点：``min(1.0, 级差 × 0.5)``。改这里等于改全局灵敏度。
    """
    current_rank = rank_of(current_level)
    target_rank = rank_of(target_level)
    if current_rank is None or target_rank is None or current_rank == target_rank:
        return 0, 0.0
    delta = target_rank - current_rank
    direction = 1 if delta > 0 else -1
    strength = min(MAX_SIGNAL_STRENGTH, abs(delta) * SIGNAL_STRENGTH_PER_LEVEL)
    return direction, strength


def _reading(
    signal_type: GradeSignalType,
    current_level: str,
    target_level: str | None,
    raw: str,
    *,
    only_up: bool = False,
) -> SignalReading:
    """按「当前学段 + 证据指向的学段」组装读数（无证据 → 值 0）。

    ``only_up=True``（深度信号用）：档位**低于**当前学段时方向取 0 ——
    **证据照记**（``level_hint`` / ``raw`` 都留着，仍然落库、仍然可审计、
    仍然是一条会打断「连续同向」的中性轮），但**不产生下调**。

    ★ 为什么需要它：``classify_depth`` 返回的是**绝对档位**（``什么是X`` → ``primary_high``、
    普通疑问句兜底 → ``primary_high``），再对当前学段求差 —— 初中生问「什么是矩阵」
    就得到一条 ``-0.5``。连问三句这样的问题（``0.5 × 3`` → 置信度 0.75 ≥ 0.6）
    就会把学段**自动降级**。实测日志里 ``第 [8] 轮 → primary_high
    （changed=True reason=changed 置信度=0.75 连续=4）`` 正是这种单路下调。

    这与「问得浅 = 学段低」的推论并不成立：**任何学段的学生都会用「什么是…」的句式
    问一个自己刚接触的概念** —— 那是好奇心的常态，不是学段证据。
    真正的「听不懂 / 太难了」由元认知那一路负责下调（它说的是「刚才讲深了」，
    而不是「你年级低」），两者分工由此清晰。
    """
    evidence = raw[:RAW_MAX_CHARS]
    if target_level is None or not evidence:
        return SignalReading(signal_type=signal_type, value=0.0, level_hint=None, raw=evidence)
    direction, strength = strength_for(current_level, target_level)
    if only_up and direction < 0:
        # 记为中性：证据保留，但不作为下调依据。
        return SignalReading(
            signal_type=signal_type,
            value=0.0,
            level_hint=target_level,  # type: ignore[arg-type]
            raw=evidence,
        )
    return SignalReading(
        signal_type=signal_type,
        value=direction * strength,
        level_hint=target_level,  # type: ignore[arg-type]
        raw=evidence,
    )


def matches_any(text: str, patterns: Sequence[str]) -> list[str]:
    """返回命中的模式**原文**（去重、保序）—— 证据里只写我们自己的词表项。"""
    hits: list[str] = []
    for pattern in patterns:
        if re.search(pattern, text) and pattern not in hits:
            hits.append(pattern)
    return hits


def find_terms(text: str, words: Sequence[str]) -> list[str]:
    """子串命中的词表项（中文没有词边界，用子串匹配；词表本身足够长，误命中可接受）。"""
    return [word for word in words if word in text]


# --------------------------------------------------------------------------- #
# ① 词汇复杂度
# --------------------------------------------------------------------------- #
_terminology_cache: dict | None = None


def default_terminology() -> dict:
    """模块级缓存的术语文表（``server/knowledge/terminology.json``，票 10 的那一份）。

    读失败时返回空表并**告警一次**：第一层必须照常工作（缺词表只是少一路证据，
    不该让「对话答疑」这条主线挂掉）。这也是打包态最可能的失败形态
    （``knowledge/`` 没跟着 ``resources/`` 进产物）。
    """
    global _terminology_cache
    if _terminology_cache is None:
        try:
            _terminology_cache = load_terminology(_terminology_path())
        except Exception as exc:  # noqa: BLE001 - 词表不可用不该让聊天路径失败
            logger.warning("术语文表不可用，第一层词汇信号退化为「仅日常用语」判定：%s", exc)
            _terminology_cache = {"terms": [], "tone_markers": []}
    return _terminology_cache


def _terminology_path() -> str:
    from app.config import KNOWLEDGE_DIR  # noqa: PLC0415 - 与 config 的循环 import 无关，但延迟取值便于测试替换

    return str(KNOWLEDGE_DIR)


def reset_terminology_cache() -> None:
    """清缓存（测试与「换了教材目录」的脚本用）。"""
    global _terminology_cache
    _terminology_cache = None


def highest_terminology_level(
    text: str, terminology: dict | None = None
) -> tuple[GradeLevel | None, list[tuple[str, GradeLevel]]]:
    """文本里出现的**最高档**术语及其 ``min_grade``（``min_grade`` = 该术语最早可出现的学段）。

    判据与 ``app.knowledge.checker`` / ``routes.quiz.out_of_scope_terms`` 完全一致
    （同一个表、同一个字段），不另立一套。
    """
    table = terminology if terminology is not None else default_terminology()
    found: list[tuple[str, GradeLevel]] = []
    for entry in table.get("terms") or []:
        if not isinstance(entry, dict):
            continue
        term = str(entry.get("term") or "")
        if not term or term not in text:
            continue
        min_grade = entry.get("min_grade")
        if rank_of(min_grade) is None:
            continue  # 表里写错的 min_grade：跳过（不是我们这次要修的东西）
        found.append((term, min_grade))  # type: ignore[arg-type]
    if not found:
        return None, []
    highest = max(found, key=lambda item: rank_of(item[1]) or 0)[1]
    return highest, found


def extract_vocab_signal(
    text: str, current_level: str, *, terminology: dict | None = None
) -> SignalReading:
    """① 词汇复杂度：命中专业术语 → 往上；日常口语 → **中性**（不再往下）。

    - 命中术语表 → ``level_hint`` = 命中的**最高** ``min_grade``（「梯度下降」→ senior）；
    - 只命中日常用语 → ``level_hint`` = ``primary_low``，但**方向恒为 0**（``only_up=True``）；
    - 两者都没有 → 没有证据（``value = 0``）。

    ★★ **日常口语为什么不再下调**（2026-09-21）：``DAILY_TERMS`` 里的词
    （电脑 / 动画 / 图片 / 机器人 / 手机 / 小猫…）在**四个学段**的教材里都到处都是 ——
    初、高中生聊「机器人」是很自然的事，却会各得一条 ``-0.5``；连提三轮就凑够
    「连续 3 轮同向 + 置信度 0.75」，把学段**自动降级**。
    这与深度信号「问得浅 ≠ 学段低」是同一类错误：**用词日常**只说明他在用生活语言，
    不说明他年级低。下调只留给元认知（「听不懂」）—— 那才是真的信号。
    """
    highest, terms = highest_terminology_level(text, terminology)
    if highest is not None:
        raw = "术语=" + ",".join(f"{term}(min_grade={grade})" for term, grade in terms[:4])
        return _reading("vocab", current_level, highest, raw)
    daily = find_terms(text, DAILY_TERMS)
    if daily:
        return _reading(
            "vocab", current_level, "primary_low", "口语=" + ",".join(daily[:6]), only_up=True
        )
    return SignalReading(signal_type="vocab", value=0.0, level_hint=None, raw="")


# --------------------------------------------------------------------------- #
# ② 问题深度
# --------------------------------------------------------------------------- #
def question_content(text: str) -> str:
    """剥掉标点、语气词与课堂用语后剩下的**实词**文本（判「这句话有没有信息量」）。

    只为 :func:`has_question_content` 服务，**不参与任何证据计算**：
    返回的是过滤后的中间产物，不写库、不回传。
    """
    stripped = _NON_WORD_RE.sub("", text or "")
    for word in _FILLER_ORDERED:
        if word in stripped:
            stripped = stripped.replace(word, "")
    return stripped


def has_question_content(text: str) -> bool:
    """这句话剥掉课堂用语后**还剩多少实词** —— 够 :data:`MIN_QUESTION_CONTENT_CHARS` 才算提问。

    「好呀」「继续吧」「那我们做一道题吧」剥完是空的；「电脑怎么认图片呀」剥完还剩 8 个字。
    """
    return len(_CJK_RE.findall(question_content(text))) >= MIN_QUESTION_CONTENT_CHARS


def classify_depth(text: str) -> GradeLevel | None:
    """提问深度 → 学段档位。

    判定顺序（★ D3 修复后）：

    1. **框架优先**：命中提问框架词（:data:`DEPTH_FRAME_LEVELS`，顺序即「具体优先」：
       推导 → 原理 → 概念）就按框架定档 —— ``什么是公式`` 是**概念**问题，
       不会因为话题里出现「公式」这个高中词而被判成推导档；
    2. **主题兜底**：没有任何框架词时，才按 :data:`DEPTH_TOPIC_LEVELS` 里的术语定档
       （陈述句也走这条：「梯度和矩阵的关系」仍算 senior 深度的表述）；
    3. **普通提问兜底**：既没有框架词也没有术语，但有疑问语气 **且**剥掉课堂用语后
       还剩实词（:func:`has_question_content`），才落 :data:`DEFAULT_QUESTION_LEVEL`。
       ★ 门槛是必需的：「我们开始吧」「好呀」这类课堂用语每轮都冒出来，
       没有门槛就会给每个初中/高中学生每轮加一条**下调**信号（D2）。

    陈述句（没有疑问语气）且不含任何深度词 → ``None``（**不猜**）。
    """
    for level, patterns in DEPTH_FRAME_LEVELS:
        if matches_any(text, patterns):
            return level
    for level, patterns in DEPTH_TOPIC_LEVELS:
        if matches_any(text, patterns):
            return level
    if any(marker in text for marker in QUESTION_MARKERS) and has_question_content(text):
        return DEFAULT_QUESTION_LEVEL
    return None


def extract_depth_signal(text: str, current_level: str) -> SignalReading:
    """② 问题深度（规则 + 关键词，**不调 LLM**；第二层的轻量 LLM 只做复核）。

    ★★ **只上不下**（``only_up=True``，2026-09-21 起）：判出的档位低于当前学段时方向取 0。
    问得浅**不是**学段低的证据 —— 任何学段的学生都会用「什么是…」问一个刚接触的概念。
    原先它会累计成一条真正的下调（实测：初中生连问三句「什么是矩阵」→ 0.75 ≥ 0.6 → 降级）。
    下调由元认知那一路负责，它说的是「刚才讲深了」，与「你是几年级」是两回事。
    """
    level = classify_depth(text)
    if level is None:
        return SignalReading(signal_type="depth", value=0.0, level_hint=None, raw="")
    hit_patterns = [pattern for _, patterns in DEPTH_LEVELS for pattern in matches_any(text, patterns)]
    raw = f"深度={level}" + (f";命中={'/'.join(hit_patterns[:3])}" if hit_patterns else ";命中=疑问语气")
    return _reading("depth", current_level, level, raw, only_up=True)


# --------------------------------------------------------------------------- #
# ③ 元认知表达
# --------------------------------------------------------------------------- #
def extract_meta_cognition_signal(text: str, current_level: str) -> SignalReading:
    """③ 元认知表达：「听不懂 / 再讲一遍 / 换个说法」→ **下调**信号（§10.2 第四行）。

    这类表达不告诉你学生是几年级，只告诉你**刚才那一段讲深了** ——
    所以 ``level_hint`` 取「当前学段往下调一级」，而不是硬说他是小学低年级。

    ★ 它是「受挫」这条路**唯一**的来源：原先「答题表现」那一路也会读
    ``TOO_HARD_TERMS``（与 ``META_STRUGGLE`` 是同一批词），导致一句「太难了」
    同时产生两条 ``-0.5``、该轮强度直接封顶。那一路已整体移除（见模块 docstring）。
    """
    struggle = find_terms(text, META_STRUGGLE)
    rephrase = find_terms(text, META_REPHRASE)
    if not struggle and not rephrase:
        return SignalReading(signal_type="meta_cognition", value=0.0, level_hint=None, raw="")

    parts = []
    if struggle:
        parts.append("受挫=" + ",".join(struggle[:3]))
    if rephrase:
        parts.append("求复述=" + ",".join(rephrase[:3]))
    raw = f"元认知={';'.join(parts)}"[:RAW_MAX_CHARS]

    current_rank = rank_of(current_level)
    target = level_at(current_rank - 1) if current_rank is not None else None
    if target is None:
        # 已是最低学段：**没有可下调的空间**。证据照记（它是「学生受挫」的事实），
        # 但方向为 0 —— 不改学段不等于不记录。
        return SignalReading(signal_type="meta_cognition", value=0.0, level_hint=None, raw=raw)
    return _reading("meta_cognition", current_level, target, raw)


# --------------------------------------------------------------------------- #
# 组合：一轮 → 各路读数
# --------------------------------------------------------------------------- #
def extract_turn_signals(
    *,
    text: str,
    turn: int,
    current_level: str,
    session_id: str = "",
    terminology: dict | None = None,
) -> TurnSignals:
    """一轮对话 → 各路读数（**第一层的唯一入口**，每轮同步执行、不调 LLM）。

    ★ **只从学生这一轮的原文里取证据**（词汇 / 深度 / 元认知三路）。
    原先还有第四路「答题表现」（从 ``learning.db`` 连对连错读出来）——
    2026-09-21 整体移除：它把「知识点没掌握」误当成「学段更低」，
    而且会从**对话原文**里捡「太难了」，与元认知那一路重复计数。
    详见模块 docstring。
    """
    readings = (
        extract_vocab_signal(text, current_level, terminology=terminology),
        extract_depth_signal(text, current_level),
        extract_meta_cognition_signal(text, current_level),
    )
    return TurnSignals(turn=int(turn), session_id=session_id, readings=readings)


def turn_direction(turns: Sequence[Directional]) -> int:
    """一轮的方向（= 该轮合并值的符号）。"""
    if not turns:
        return 0
    return turns[-1].direction


def consecutive_same_direction(turns: Sequence[Directional]) -> tuple[int, int]:
    """末尾连续同方向 → ``(方向, 轮数)``。

    ``方向 = 0`` 的轮次**打断**连续（一条中性轮就说明证据断了，不跨过去累加）。
    """
    if not turns:
        return 0, 0
    direction = turns[-1].direction
    if direction == 0:
        return 0, 0
    count = 0
    for turn in reversed(turns):
        if turn.direction != direction:
            break
        count += 1
    return direction, count


def mean_strength(turns: Sequence[Directional]) -> float:
    """连续同方向那几轮的平均强度（置信度的原料；空序列 → 0）。"""
    relevant = [turn.strength for turn in turns if turn.direction != 0]
    if not relevant:
        return 0.0
    return sum(relevant) / len(relevant)


# --------------------------------------------------------------------------- #
# ``raw`` 里的轮次锚点
# --------------------------------------------------------------------------- #
#: ★ 为什么轮次要塞进 ``raw``：``grade_signals`` 的 DDL 里**没有 turn 列**
#: （那份 DDL 归 ``app/store/**``），而「连续 3 轮同方向」必须知道每条信号属于哪一轮。
#: 这里用 ``t<turn>|`` 前缀把它锚在证据串里（可解析、可读、不新增表）。
#: ⚠️ **已向 store 轨报备**：建议 v2 迁移给 ``grade_signals`` 加一列 ``turn INTEGER``，
#: 届时本前缀可以退化成纯证据串。
TURN_RAW_RE = re.compile(r"^t(\d+)\|")


def encode_turn_raw(turn: int, evidence: str) -> str:
    """``(第几轮, 证据)`` → 入库的 ``raw``。"""
    return f"t{int(turn)}|{evidence}"[:RAW_MAX_CHARS]


def decode_turn_raw(raw: str | None) -> tuple[int | None, str]:
    """入库的 ``raw`` → ``(第几轮, 证据)``；没有锚点返回 ``(None, 原文)``。"""
    text = raw or ""
    matched = TURN_RAW_RE.match(text)
    if not matched:
        return None, text
    return int(matched.group(1)), text[matched.end() :]


__all__ = [
    "DAILY_TERMS",
    "DEFAULT_QUESTION_LEVEL",
    "DEPTH_FRAME_LEVELS",
    "DEPTH_LEVELS",
    "DEPTH_TOPIC_LEVELS",
    "Directional",
    "FILLER_WORDS",
    "GRADE_ORDER",
    "MAX_SIGNAL_STRENGTH",
    "META_REPHRASE",
    "META_STRUGGLE",
    "MIN_QUESTION_CONTENT_CHARS",
    "QUESTION_MARKERS",
    "RAW_MAX_CHARS",
    "SIGNAL_STRENGTH_PER_LEVEL",
    "SIGNAL_TYPES",
    "SignalReading",
    "TurnSignals",
    "classify_depth",
    "consecutive_same_direction",
    "decode_turn_raw",
    "default_terminology",
    "direction_of",
    "encode_turn_raw",
    "extract_depth_signal",
    "extract_meta_cognition_signal",
    "extract_turn_signals",
    "extract_vocab_signal",
    "find_terms",
    "has_question_content",
    "highest_terminology_level",
    "level_at",
    "matches_any",
    "mean_strength",
    "question_content",
    "rank_of",
    "reset_terminology_cache",
    "strength_for",
    "turn_direction",
]
