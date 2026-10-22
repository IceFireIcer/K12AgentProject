"""``learning.db``（**每人一份**）的建库与仓储。

数据层的三处分离（执行文档 §8.1）：对话正文归 Pi 的 JSONL 会话树，
**SQLite 不存对话内容**，这里只放从对话中提取出来的结构化学习数据。

★ 唯一例外（票 25 的合规口径变更，作用域已缩小）：**冷启动五问的回答**入库，
  落在 :data:`_IDENTITY_PROFILE_V5` 的 `onboarding_qa` 表。例外**只到这 5 条**——
  `learning_history.question` 仍然恒为空串（G-K），quiz/动画/编程判分路径照旧不存正文。

一人一库是合规硬约束：**不同学生的画像/掌握度绝不能共用一个库文件**，
所以本模块只提供「按路径开库」的能力，不持有任何全局连接。

> 归口说明：``app/store/**`` 属数据轨。画像/学段/练习各轨**请复用本模块**，
> 不要另起一套 ``CREATE TABLE`` —— 同一个库两份 DDL 是最难查的那类故障。

票 15/20 新增的两块（都在本文件，**不动 migrations.py**）
--------------------------------------------------------
1. **闯关进度的读写原语**（``progress_rows`` / ``upsert_progress`` / ``mastery_map``）：
   ``progress`` 表在迁移 v1 里就有了（§8.3 的 DDL），此前只是没人写。**状态机不在本文件**
   ——「什么条件才能解锁下一关」是业务规则，属 ``app/routes/quiz.py``；这里只做「存/取」，
   避免出现第二套状态推导。
2. **LLM 生成的变式题仓库**（``generated_question`` 表）：走 ``migrations.py`` 文档里
   明确预留的 ``set_name="quiz"`` 通道（见该文件头部「set_name 是给其他轨道留的并行通道」），
   因此不必改 ``migrations.py``、也不会和 ``kb`` / ``learning`` 的版本号打架。

   ★ 为什么生成题**落在这个学生自己的库**里，而不是回写随包分发的题库文件：
     ① 一人一库是既有边界（生成题是这名学生的练习记录，不该出现在别人的题里）；
     ② ``resources/quizbank/*.json`` 是**随包分发的只读内容资产**（打包态在安装目录里，
        写不进去），往里写会同时污染交付物与演示环境；
     ③ 与掌握度/进度**同一个库同一个事务边界**，不会出现「题存了、掌握度没写」的半截状态。

   ★ 表里存的 ``reference_answer`` 是**标准答案**（用于 ``POST /api/quiz/grade`` 判分），
     它**只在本文件与 Python 侧存在**，绝不出现在任何出参模型里（§6.3 答案泄漏防护：
     对外一律 ``QuizQuestionOut``，结构上没有答案字段）。

3. **学生动画库**（``saved_animation`` 表，票 24 的「生成过的动画存下来复用」）：
   同样走 ``set_name="animation"`` 的并行通道（:data:`ANIMATION_MIGRATION_SET`）。
   ★ 复用键是 ``(kp_id, grade_level, prompt_hash)`` —— 学生身份由**库文件归属**承担
     （一人一份 ``learning.db``），学段是键的一部分：同一个知识点在小学低与初中
     必须是**两份不同的产物**（讲法不同）。
   ★★ **只存请求指纹，不存学生原话**：``prompt_hash`` 是调用方算好的十六进制摘要，
     展示文字（``concept`` / ``title`` / 降级文案）是模型侧的产出 —— 与「SQLite 不存
     对话正文」（§8.1）同一条纪律，原话归 Pi 的 JSONL 会话树。
   ★ 动画 HTML **不进库**：库里只留 ``html_path``，正文落在该学生的
     ``students/<id>/animations/saved/`` 下（路由层负责路径与校验）。

当前教材章节（``student.current_chapter``）
------------------------------------------
学生显式选定的「在学哪一章」是**软偏好**（只进画像 Prompt，不做检索硬过滤），
存在 ``student`` 表的一列里（迁移 v2，见 ``migrations.py`` 的 ``_apply_chapter_v2``；
**不动 v1**，老库靠 v2 补列）。本文件提供这一列唯一的读写对
（:meth:`LearningStore.current_chapter` / :meth:`LearningStore.set_current_chapter`），
与 ``profile_pref`` 的读写对同一口径：**路由层不自己拼 SQL**。

> ⚠️ 章节的**清单**不在这里 —— 它来自 ``kb.sqlite`` 的 ``kp.chapter_title``
> （随包分发的只读内容资产，``store/kb.py:chapters_by_grade``）。
> 学生库里只存「他选了哪一个标题」这一个字符串，别把清单也搬进来
> （那会让教材内容在每个学生的库里各存一份，改教材时到处对不上）。
"""

from __future__ import annotations

import json
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, NamedTuple, Sequence

from app.contracts import MASTERY_DELTA_LIMIT
from app.store.connections import connect
from app.store.migrations import (
    ALLOWED_TAG_KEYS,
    ALLOWED_TAG_KEY_SET,
    IDENTITY_LOCAL_FIELDS,
    JOIN_KEY,
    Migration,
    ensure_learning,
    ensure_migrated,
    execute_script,
)

logger = logging.getLogger(__name__)

# ★ 掌握度单次变更的限幅（业务陷阱清单 §5）**不在本文件定义**，而是从契约
#   ``app/contracts.py`` import：那边用它声明 ``QuizResult.mastery_delta`` 的 ``ge/le``。
#   各写一份 ``= 0.2`` 的话，只改一处就会让「返回给前端的 delta」与「实际写进
#   ``mastery`` 的分数变化」静默不一致 —— 常量只有一个来源（``__all__`` 里的
#   导出保持不变，``from app.store.learning import MASTERY_DELTA_LIMIT`` 照旧可用）。

#: 变式题仓库的迁移组名（``migrations.py`` 预留的并行通道，见模块头）。
QUIZ_MIGRATION_SET = "quiz"

#: 学生动画库的迁移组名（同一个并行通道；**不占 learning 组的版本号**）。
ANIMATION_MIGRATION_SET = "animation"

#: 生成编程题走**独立迁移集**（理由同 quiz / animation：不动既有验收口径）。
CODE_MIGRATION_SET = "code"

#: :meth:`LearningStore.question_attempt` 单次扫描的学习记录行数上限。
#: ★ 为什么是「有界扫描 + 内存比对 qid」而不是加索引 / 加列：见那个方法的 docstring
#:   （``qid`` 在 ``detail`` 的 JSON 字符串里，按它查在现有表结构下无索引可用；
#:   加索引/加列都要动 ``migrations.py`` 的已发布迁移，超出「零迁移」的边界）。
_ATTEMPT_SCAN_LIMIT = 200

# --------------------------------------------------------------------------- #
# 冷启动画像（迁移 v5）：白名单二次校验 + 两道闸 + 短期情绪 TTL
# --------------------------------------------------------------------------- #

#: ★ 短期情绪标签：**必须**带过期时间（执行报告 §0.6.5，禁做 #11「长期负面情绪档案」）。
#: 把「上次考崩了、情绪低落」长期记着既伤人也可能被用来操控他 —— 所以这三个键读出来时
#: 一律先过 TTL。与 TS 的 `EPHEMERAL_TAGS` 逐字一致。
EPHEMERAL_TAGS: tuple[str, ...] = ("emotion", "intensity", "trigger")
EPHEMERAL_TAG_SET: frozenset[str] = frozenset(EPHEMERAL_TAGS)

#: ★ 「3 轮**或** 24 小时，取先到」。轮次口径 = `grade_signals` 的 id 差（见 `turn_mark`）；
#: 24 小时用秒（本文件的 `ts` 全是 Unix 秒，不引第二种时间单位）。
EPHEMERAL_TTL_TURNS = 3
EPHEMERAL_TTL_SECONDS = 24 * 60 * 60

#: 情绪取值域（禁做 #12）：**有限枚举，不是临床词汇，也不是自由文本**。
#: 自由文本会让「我最近有点抑郁」原样进库 —— 那就从「记录情绪」变成「心理诊断」了。
EMOTION_VALUES: tuple[str, ...] = ("happy", "calm", "confused", "frustrated", "angry")
EMOTION_VALUE_SET: frozenset[str] = frozenset(EMOTION_VALUES)

#: 情绪强度：0–3 的小整数（与 TS 的 `INTENSITY_MIN` / `INTENSITY_MAX` 同值）。
#: 刻意不是 0–100 的分 —— 分值会诱发「优化分数」的坏文化。
INTENSITY_MIN = 0
INTENSITY_MAX = 3

#: 标签来源（L2 声明 / L1 观察 / L3 推断，见执行报告 §5.1）。
TAG_SOURCES: frozenset[str] = frozenset({"declared", "observed", "inferred"})

#: ★ 标签变更的**来源出处**（origin，迁移 v7）—— 与 `source` 是**正交**的两个维度：
#:   · `source` 回答「这条值**有多可信**」（declared > observed > inferred）；
#:   · `origin` 回答「它**从哪条写入路径来的**」。
#:
#:   为什么两维不能合并：`observed` 同时来自两条路（行为投影 / 持续迭代概括），
#:   而这两件事对「画像怎么变成现在这样的」是**不同的故事**。详见 migrations.py v7。
#:
#: ★★ 封闭词表，只有三态。**不预置「未知」值** —— 旧行（v7 前）的 origin 是 NULL，
#:    那是「查询时还没这个概念」，由读取侧折成一句中性中文，而不是第四个枚举值。
TAG_ORIGINS: frozenset[str] = frozenset({"cold_start", "refresh", "projection"})

#: origin 的默认值：写入路径**没显式声明**时按 `source` 推断（见 `_origin_for_source`）。
#: 「冷启动」是默认，因为唯一无 origin 的遗留写入路径是五问（declared）。
TAG_ORIGIN_COLD_START = "cold_start"
TAG_ORIGIN_REFRESH = "refresh"
TAG_ORIGIN_PROJECTION = "projection"

#: ★ 禁做 #10「敏感属性推断」：`source='inferred'` 只允许**白名单内的风格 / 倾向类**键。
#: 取值 = 学习偏好（维度 7 四键）+ 情绪动机（维度 9 四键）
#:      + 类型与性格（维度 13 两键，**2026-09-30 用户裁决新增**）。
#: 学段 / 掌握度 / 知识点这类**客观量一律不许被推断写**：那会变成「模型觉得你懂了就改分」，
#: 与 `PreferenceKey` 封闭词表同一条纪律（L3 永远不能写 L1）。
#:
#: ★★ 8 → 10 是一次**红线移动的代码面**（决策日 2026-09-30），必须记清移动的边界：
#:   新增的两键（`learner_style` / `personality`）与既有八键**同属一类** ——
#:   它们都是「从行为与对话里看出的**倾向**」，而不是「客观量」。
#:   移动的是「性格可以被推断」这一条（原红线原文含「性格」），
#:   **心理状态 / 家庭情况 / 智能水平三条禁令一字未动**；
#:   配套的三道闸见 `personality` 的封闭词表 + 写入侧取值域校验 + G-M-7 的三断言。
INFERRED_ALLOWED_TAG_KEYS: frozenset[str] = frozenset(
    {
        "explain_style",
        "output_length",
        "pace",
        "practice_type",
        "emotion",
        "intensity",
        "trigger",
        "confidence",
        # 维度 13（2026-09-30）：从对话里看出的学习倾向与性格倾向
        "learner_style",
        "personality",
    }
)

#: ★ 学习类型（`learner_style`）的**封闭词表** —— 与 TS 的 `LEARNER_STYLE_VALUES` 逐字一致。
#:
#: 两条写入路径（分档矩阵天然仲裁，见 :meth:`LearningStore.sync_learner_style`）：
#:   · **规则投影**（`observed` / `origin=projection`）—— 按学习数据判定，权威；
#:   · **持续概括**（`inferred` / `origin=refresh`）—— LLM 从对话判断，候补。
#:
#: ⚠️ 值是**中文显示值**（与 :data:`OBSERVED_ERROR_TYPES` 同一条纪律）：
#:   它要进画像卡给学生看。封闭性由本常量在**写入侧**保证（见 :meth:`upsert_tag`）。
#: ⚠️「均衡型」在词表里但规则不主动打 —— 数据不显著时宁可不写（不把「没看出来」
#:   冒充成「观察到了」，与「还没练过」不写占位值同一条纪律）。
LEARNER_STYLE_VALUES: tuple[str, ...] = ("天赋型", "努力型", "钻研型", "速通型", "均衡型")
LEARNER_STYLE_VALUE_SET: frozenset[str] = frozenset(LEARNER_STYLE_VALUES)

#: ★ 性格（`personality`）的**封闭词表** —— 与 TS 的 `PERSONALITY_VALUES` 逐字一致。
#: 中性、口语、无临床色彩（选词的三条约束写在 TS 那一份的文件头，此处不重复）。
#: ★★ 它是本轮红线移动的**那道闸**：性格允许被推断，但只能落在这十个词里 ——
#:   越界值（尤其「多动」「焦虑型」这类医学/心理学词）在写入侧直接 ValueError。
PERSONALITY_VALUES: tuple[str, ...] = (
    "开朗",
    "安静",
    "好奇",
    "沉稳",
    "细心",
    "勇敢",
    "急性子",
    "慢性子",
    "爱提问",
    "爱琢磨",
)
PERSONALITY_VALUE_SET: frozenset[str] = frozenset(PERSONALITY_VALUES)

#: ★ 学段内难度档（`zpd_level`，票 30）的**封闭词表** —— 与 TS 的
#: `prompts/adaptation.ts` 的 `WORD_TIERS` 认得的那几个词同源。
#:
#: ★★ 为什么这个键以前**永远是空的**（本轮修的缺口）：
#:   `prompts/adaptation.ts` 的 `resolveDifficultyTier()` 读 `zpd_level` 决定
#:   「这一轮偏易 / 正常 / 偏难讲」，但全仓**没有任何生产方**写它 ——
#:   五问概括与持续概括的 prompt 都没点名这个键，`sync_observed_tags` 也没投影它。
#:   结果 `resolveDifficultyTier()` 恒回 `normal`、`renderDifficultySectionBody()`
#:   恒返回空串：整套学段内微调**接好了但没通电**。
#:
#: ★ 为什么生产方是**规则投影**而不是让模型写：
#:   `zpd_level` 是**客观量**（从掌握度算出来的最近发展区），与 `mastery` / `error_type`
#:   同一类。禁做 #10 明确「客观量一律不许被推断写」，所以它**不在**
#:   `INFERRED_ALLOWED_TAG_KEYS` 里；正确的生产方是「读该生已有的判分数据投影一次」，
#:   与 `sync_learner_style` 完全同构（observed / origin=projection）。
#:
#: ★ 值是**中文显示值**（与 learner_style / error_type / safety_level 同一条纪律）：
#:   它要进画像卡给学生看，库里存的就是给人看的那三个词。
#:   ⚠️ TS 侧 `NUMERIC_TIERS`（1/2/3）保留为**读取侧的向后兼容**，生产方不再写数字。
ZPD_LEVEL_VALUES: tuple[str, ...] = ("偏易", "正常", "偏难")
ZPD_LEVEL_VALUE_SET: frozenset[str] = frozenset(ZPD_LEVEL_VALUES)

#: 难度档投影的**最小样本门槛**（总 attempts 低于它不判定）。
#: ★ 与 `LEARNER_STYLE_MIN_ATTEMPTS` 同一条理由：3 道题定不了「这个孩子该讲多细」，
#:   宁可不写（画像上就没有这一条，讲法回到模板本来的正常难度），也不给一个撑不住的档。
ZPD_MIN_ATTEMPTS = 6

#: 正确率低于它 → 偏易（他正在吃力，讲法降一档：先给结论、术语密度降、例子更具体）。
ZPD_EASIER_MAX_ACCURACY = 0.5
#: 正确率高于它 → 偏难（他明显吃得下，例子抽象一层、先给推导）。
ZPD_HARDER_MIN_ACCURACY = 0.85

#: 学习类型规则投影的**最小样本门槛**（总 attempts 低于它不判定）。
#: ★ 为什么必须有：3 道题里对了 3 道就判「天赋型」，那个标签不可信、家长一问就崩。
#:   宁可不写（画像上就没有这一条），也不给一个撑不住的结论 ——
#:   与「读不到数据就不写」同一条纪律（那个是数据缺失，这个是数据不足）。
LEARNER_STYLE_MIN_ATTEMPTS = 10

#: 判定「天赋型」的正确率门槛（首试通过率的高位）。
LEARNER_STYLE_GIFTED_MIN_ACCURACY = 0.85
#: 判定「速通型」的每知识点平均尝试次数上限（一遍过为主）与正确率下界。
LEARNER_STYLE_FAST_MAX_ATTEMPTS_PER_KP = 1.5
LEARNER_STYLE_FAST_MIN_ACCURACY = 0.7
#: 判定「钻研型」的每知识点平均尝试次数下界（反复打磨同一处）。
LEARNER_STYLE_DEEP_MIN_ATTEMPTS_PER_KP = 3.0
#: 判定「努力型」的总尝试次数下界与「错题重做占比」下界（二选一命中即可）。
LEARNER_STYLE_DILIGENT_MIN_ATTEMPTS = 30
LEARNER_STYLE_DILIGENT_MIN_RETRY_RATIO = 0.4
#: 「努力型」要求正确率**低于**这个值（正确率很高就该是天赋/速通，而不是努力）。
LEARNER_STYLE_DILIGENT_MAX_ACCURACY = 0.85

#: 引导流程状态的封闭词表（与 TS 的 `ONBOARDING_STATES` 逐字一致）。
ONBOARDING_STATES: tuple[str, ...] = ("not_started", "in_progress", "done", "skipped")
#: 唯一允许弹引导的状态（G-I）：其余三态一律绝不弹。
ONBOARDING_STATE_NOT_STARTED = "not_started"

#: ★ 「错误模式」的**封闭词表**（计划 §1.6「判分/答题已有数据 → error_type」）。
#:
#: ★★ 为什么必须是封闭词表、而且值是**中文**：
#:   ① 会**进 prompt、也进画像卡** —— 自由文本迟早会被写成「他连分数都不会」这类
#:      **评价性**内容，那是对孩子的标签化，不是学习信号（与 emotion 走有限枚举同一个道理）；
#:   ② 学生面不该看到 `concept_confusion` 这种标识 —— 所以库里存的就是**中文显示值**，
#:      封闭性由本常量在写入侧保证（不在取值域里的写不进去）。
#: ⚠️ 「还没练过」**不在此列**：没数据时我们**什么都不写**，绝不写占位值
#:   把「不知道」冒充成「观察到了」。
OBSERVED_ERROR_TYPES: tuple[str, ...] = ("概念混淆", "粗心")
OBSERVED_ERROR_TYPE_SET: frozenset[str] = frozenset(OBSERVED_ERROR_TYPES)

#: 连续错几次才算「概念混淆」（1 次可能是手滑，不足以定性）。
ERROR_TYPE_CONFUSION_MIN_ATTEMPTS = 2
#: 掌握度低于它、且**曾经做对过** → 归到「粗心」（会做但不稳）。
ERROR_TYPE_CARELESS_MAX_SCORE = 0.6

#: ★ 「安全级别」的封闭词表（计划 §1.6「safety guard → safety_level」）。
#: ⚠️ **只记档位、不记内容**：拦截了什么话、为什么被拦，一概不进画像 ——
#: 那属于**当轮**的处置，不属于「这个学生是什么样的人」。长期留着会变成另一种档案。
SAFETY_LEVELS: tuple[str, ...] = ("正常", "需留意")
SAFETY_LEVEL_SET: frozenset[str] = frozenset(SAFETY_LEVELS)

#: ``generated_question`` 表：LLM 生成的变式题（**含标准答案**，见模块头第 2 条）。
_QUIZ_V1 = """
CREATE TABLE IF NOT EXISTS generated_question (
  qid              TEXT PRIMARY KEY,
  kp_id            TEXT NOT NULL,
  grade_level      TEXT NOT NULL,
  type             TEXT NOT NULL,             -- choice | blank | code_blank
  stem             TEXT NOT NULL,
  options          TEXT,                      -- JSON 数组或 NULL
  reference_answer TEXT NOT NULL,             -- JSON（字符串或字符串数组）★ 标准答案，不出后端
  explanation      TEXT,
  rubric           TEXT,                      -- 主观题评分细则（非空 = 主观题，只能走 LLM 判分路径）
  source           TEXT NOT NULL DEFAULT 'generated',
  created_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_generated_kp ON generated_question(kp_id);
"""


def _apply_quiz_v1(conn: sqlite3.Connection) -> None:
    # ★ 用 ``execute_script`` 而不是 ``conn.executescript``：后者会**隐式提交**
    #   （sqlite3 的既有行为），让「失败整体回滚」在这条迁移上失效。
    execute_script(conn, _QUIZ_V1)


#: v2：补 ``rubric`` 列（主观题评分细则）。
#: ★ 不改 v1 那条迁移（``migrations.py`` 的纪律：**不要改已发布的那条**），
#:   追加一条新的 —— 已经建过库的学生（v1 已记账）靠它补列，新学生两条一起跑。
def _apply_quiz_v2(conn: sqlite3.Connection) -> None:
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(generated_question)").fetchall()
    }
    if "rubric" not in columns:
        conn.execute("ALTER TABLE generated_question ADD COLUMN rubric TEXT")


def _apply_quiz_v3(conn: sqlite3.Connection) -> None:
    """给生成题加 ``student_id``（D-088）：生成的题从此**归到具体学生名下**。

    ★ 为什么需要这一列：``qid`` 里只有随机段、没有学生（`quiz.ts` 的 `variantQid`），
      表里也就没有归属 —— 于是「学生自己的题」在数据层根本表达不出来：
      只能靠 qid 判分，谁都列不出「这个学生做过哪些生成题」。
    ★ 旧行留空：迁移不改历史（它们当时确实没有归属），读路径按学生过滤时自然把它们排除。
    """
    columns = {
        str(row["name"])
        for row in conn.execute("PRAGMA table_info(generated_question)").fetchall()
    }
    if "student_id" not in columns:
        conn.execute("ALTER TABLE generated_question ADD COLUMN student_id TEXT")
    # 读路径一律「某学生的题，按知识点/时间」→ 这条复合索引正好盖住
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_generated_student ON generated_question(student_id, kp_id)"
    )


QUIZ_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="LLM 变式题仓库（含标准答案，仅 Python 侧）", apply=_apply_quiz_v1),
    Migration(version=2, name="主观题评分细则列（rubric）", apply=_apply_quiz_v2),
    Migration(version=3, name="生成题归属学生（student_id）", apply=_apply_quiz_v3),
)


#: ``saved_animation`` 表：该学生生成过的动画（**复用键 = 知识点 + 学段 + 请求指纹**）。
#:
#: ★ 为什么复用键里必须有 ``grade_level``（用户点名要求）：同一个知识点在小学低与初中
#:   是**两份不同的产物**（讲法不同），少了这一维就会把初中生的动画端给小学生。
#: ★ 为什么只有 ``prompt_hash`` 没有原话（合规硬约束）：见模块头第 3 条 ——
#:   「SQLite 不存对话正文」这条纪律在这里的形态就是「只留指纹，不留原话」。
#: ★ ``html_path`` 而不是把 HTML 存进库：正文是**大块文本**且已按学生分目录落盘，
#:   入库会让一人一库的 ``learning.db`` 迅速膨胀，还要在两处之间保持一致（以文件为准）。
_ANIMATION_V1 = """
CREATE TABLE IF NOT EXISTS saved_animation (
  id             TEXT PRIMARY KEY,
  kp_id          TEXT NOT NULL,
  grade_level    TEXT NOT NULL,                -- 四学段之一（复用键的一维）
  concept        TEXT NOT NULL,                -- 展示用概念名，**不是**学生原话
  prompt_hash    TEXT NOT NULL,                -- ★ 请求指纹（十六进制摘要），原话不进库
  title          TEXT NOT NULL,
  duration_ms    INTEGER NOT NULL,
  html_path      TEXT NOT NULL,                -- 沙箱 HTML 的落盘路径（正文不进库）
  fallback_text  TEXT NOT NULL,
  fallback_image TEXT,
  created_at     INTEGER NOT NULL,             -- Unix **秒**（路由层用 to_contract_ms 转毫秒）
  uses           INTEGER NOT NULL DEFAULT 0    -- 被复用了几次（每次 lookup 命中 +1）
);
-- ★ **UNIQUE** 而不是普通索引：它就是「复用键」本身 —— 同学生 + 同知识点 + 同学段 +
--   同指纹只允许一条，``save_animation`` 的 ON CONFLICT 也认它（普通索引做不了冲突目标）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_animation_key
  ON saved_animation(kp_id, grade_level, prompt_hash);
"""


def _apply_animation_v1(conn: sqlite3.Connection) -> None:
    # 与 ``_apply_quiz_v1`` 同一纪律：用 ``execute_script``（逐条 execute），
    # 不用会隐式提交的 ``conn.executescript``（见 ``migrations.py`` 的模块头）。
    execute_script(conn, _ANIMATION_V1)


ANIMATION_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="学生动画库（知识点 + 学段 + 请求指纹复用）", apply=_apply_animation_v1),
)

#: ``generated_code_template`` 表：**学生自己的**生成编程题（一题一行）。
#:
#: ★ 为什么不写进 `resources/code-templates/`：那是**随包只读内容资产**（打包态在安装目录里），
#:   往里写等于改安装目录 —— 与题库同一条理由，生成的题必须有自己的落点。
#: ★ ``hints`` / ``solution`` 都进库、都不外发：与题库的 ``answer``、随包模板的 ``solution``
#:   同一条纪律（§6.3）。提示按级由服务端发（「一次只升一级」的落点在编排层），答案只用于对照。
#: ★ ``prompt_hash`` 而不是原话：「SQLite 不存对话正文」这条纪律在这里的形态。
_CODE_V1 = """
CREATE TABLE IF NOT EXISTS generated_code_template (
  saved_id          TEXT PRIMARY KEY,
  student_id        TEXT NOT NULL,
  kp_id             TEXT NOT NULL,
  grade_level       TEXT NOT NULL,
  title             TEXT NOT NULL,
  expected_behavior TEXT NOT NULL,
  scaffold          TEXT NOT NULL,
  expected_output   TEXT NOT NULL,
  hints             TEXT NOT NULL,
  solution          TEXT NOT NULL DEFAULT '',
  prompt_hash       TEXT NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_generated_code_student
  ON generated_code_template(student_id, kp_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generated_code_key
  ON generated_code_template(student_id, kp_id, grade_level, prompt_hash);
"""


def _apply_code_v1(conn: sqlite3.Connection) -> None:
    # 与 ``_apply_quiz_v1`` / ``_apply_animation_v1`` 同一纪律：用 ``execute_script``
    execute_script(conn, _CODE_V1)


CODE_MIGRATIONS: tuple[Migration, ...] = (
    Migration(version=1, name="学生的生成编程题（提示与参照实现只留后端）", apply=_apply_code_v1),
)


def new_saved_code_id() -> str:
    """生成一条「生成编程题」的 id（URL 安全、形状与 ``payload_id`` 白名单一致）。"""
    return "code-" + secrets.token_urlsafe(9).replace("-", "a").replace("_", "b")


@dataclass(frozen=True)
class GeneratedCodeTemplateRecord:
    """``generated_code_template`` 表的一行（**含 hints 与 solution**，只供 Python 侧使用）。"""

    saved_id: str
    student_id: str
    kp_id: str
    grade_level: str
    title: str
    expected_behavior: str
    scaffold: str
    expected_output: str
    hints: tuple[dict[str, object], ...]
    solution: str
    prompt_hash: str
    created_at: int | None


def new_saved_animation_id() -> str:
    """生成一个动画库条目 id（短、URL 安全，形状与 ``payload_id`` 白名单一致）。

    形状与 ``app/animation/compose.py`` 的 ``_fallback_payload_id`` 同一套
    （``[A-Za-z0-9_-]{1,64}``）：它会被拼进文件名（经 sha1）与 URL 路径。
    """
    return "anim-" + secrets.token_hex(8)


@dataclass(frozen=True)
class StudentRecord:
    student_id: str
    nickname: str
    grade_level: str
    created_at: int
    last_active_at: int
    #: 学生当前在学的教材章节标题；**空串 = 未选择**（库里的 NULL 也读成空串）。
    #: ★ 只在 ``student.current_chapter`` 一列里存 —— 章节**清单**归 ``kb.sqlite``，
    #:   这里只存「学生选了哪一个」这一个值（软偏好，见 ``app/contracts.ChapterUpdateRequest``）。
    current_chapter: str = ""


@dataclass(frozen=True)
class GradeHistoryRecord:
    """``grade_history`` 的一行（学段变化轨迹）。

    ★ ``ts`` 是**秒**（由路由层经 ``to_contract_ms`` 转毫秒，与画像/学段同一处换算）。
    ★ 冷启动基线那行 ``from_level`` 为 ``None`` —— 学生还没有「上一段」。
    """

    id: int
    ts: int
    turn: int
    from_level: str | None
    to_level: str
    source: str
    #: 哪一层判的（D-066）：``rules`` / ``llm`` / ``None``（历史行或手动指定行）。
    decided_by: str | None
    confidence: float


@dataclass(frozen=True)
class MistakeRecord:
    """按知识点聚合后的错题（``is_correct = 0`` 的那些）。

    ``stem`` / ``last_qid`` 只可能来自 ``activity='quiz'`` 的行：其余轨（qa / coding）
    答错时 ``question`` 是空串，本记录如实留空 —— **不要**为此去 join 带标准答案的
    ``generated_question`` 表（见 ``app/contracts.py`` 的 ``MistakeItem`` 注释）。
    """

    kp_id: str
    #: 该知识点答错的**总次数**（含没有题干的那些）
    wrong_count: int
    #: 其中**取不到题干**的次数（qa / coding 轨答错）：显式报出来，别静默少几条
    blank_count: int
    #: 最近一次答错的时间（**秒**，由路由层转毫秒）
    last_wrong_at: int
    #: 最近一次**有题干**的错题的题干（没有则为空串）
    stem: str
    #: 该题干对应的题号（供「再练一遍」定位；空串 = 没有）
    last_qid: str


@dataclass(frozen=True)
class DayActivity:
    """某一**本地日期**的活动量（``day`` 形如 ``2026-09-17``）。

    ★ 按**本地日期**聚合而不是 UTC：学生晚上十点学的，跨了 UTC 零点还算「昨天」，
      报告里的「连续学习三天」就会莫名其妙断掉。
    """

    day: str
    count: int
    quiz_count: int
    correct_count: int


@dataclass(frozen=True)
class ProgressRecord:
    """``progress`` 表的一行（**闯关状态的唯一权威**，§8.3）。

    ``badge`` 为 ``None`` 表示这一关还没有徽章；一经授予**不因后续答错而清除**
    （徽章是「曾经通关」的事实，不是当前掌握度）。
    """

    kp_id: str
    stage: str
    badge: str | None
    updated_at: int | None


@dataclass(frozen=True)
class GeneratedQuestionRecord:
    """``generated_question`` 表的一行。

    ``reference_answer`` 是**标准答案**（``str | list[str]``，落库为 JSON）。
    ★ 本记录**不提供**任何「转成对外形态」的方法：转对外形态只允许走
    ``app/contracts.py`` 的 ``QuizQuestionOut.from_internal``，避免有人顺手把答案带出去。
    """

    qid: str
    kp_id: str
    grade_level: str
    type: str
    stem: str
    options: tuple[str, ...] | None
    reference_answer: Any
    explanation: str
    #: 主观题的评分细则；``None``/空 = 客观题（只能走规则判分）。
    rubric: str | None
    source: str
    created_at: int | None
    #: 这道题归哪个学生（D-088 起）。空串 = 历史遗留行（v3 迁移之前登记的），
    #: 它们不出现在任何学生的「我的题目」里 —— 没有归属的题不该被谁认领。
    student_id: str = ""


@dataclass(frozen=True)
class SavedAnimationRecord:
    """``saved_animation`` 表的一行（**学生动画库的一条**）。

    ★ 没有 ``html`` 字段，只有 :attr:`html_path`：正文落在磁盘上（见模块头第 3 条），
      读正文是路由层的事（它才能做「路径没跑出学生目录」的断言）。
    ★ :attr:`prompt_hash` 是**请求指纹**（十六进制摘要），不是学生原话 —— 它只用于复用命中。
    """

    id: str
    kp_id: str
    grade_level: str
    concept: str
    prompt_hash: str
    title: str
    duration_ms: int
    html_path: str
    fallback_text: str
    fallback_image: str | None
    #: Unix **秒**（与 ``learning.db`` 其它时间列同尺度；路由层用 ``to_contract_ms`` 换算）。
    created_at: int
    #: 被复用了几次（lookup 命中一次 +1）。
    uses: int


@dataclass(frozen=True)
class IdentityRecord:
    """``identity_local`` 的一行（**永不过桥**：主进程读它决定行为，不进任何 prompt）。

    ``parent_consent`` / ``memory_switch`` 是**闸**不是信息；
    ``real_name`` / ``real_grade`` / ``school`` / ``class_name`` 是本地身份列，
    除 join 钥匙外一个都不在白名单里（G-B）。
    ``class_name`` 映射库里的 ``class`` 列（``class`` 是 Python 关键字，不能当字段名）。
    """

    anon_student_id: str
    real_name: str
    real_grade: str
    school: str
    class_name: str
    parent_consent: bool
    memory_switch: bool
    onboarding_state: str


@dataclass(frozen=True)
class ProfileTagRecord:
    """``profile_tags`` 的一行（**已过 TTL 与白名单**，见 :meth:`LearningStore.tags`）。"""

    key: str
    value: str
    confidence: float | None
    source: str
    #: Unix 秒（路由层用 ``to_contract_ms`` 换算成毫秒给出参）。
    ts: int


@dataclass(frozen=True)
class ProfileTagHistoryRecord:
    """``profile_tag_history`` 的一行 —— 画像标签的**一次变更**（§5.2 #11 时间线的原料）。

    ★ 已过**白名单**与**短期情绪排除**（见 :meth:`LearningStore.tag_history`）：
      出栈的每一条都是「可以长期留着的画像事实」。
    """

    id: int
    key: str
    value: str
    #: 变更前的值；``None`` = 这个键**第一次**出现（不是「从空值变过来」）。
    previous_value: str | None
    source: str
    confidence: float | None
    #: 变更**出处**（迁移 v7，∈ :data:`TAG_ORIGINS`）；``None`` = v7 之前的旧行。
    #: ★ 与 :attr:`source` 正交：source 是「多可信」，origin 是「从哪条路来的」。
    origin: str | None
    #: Unix 秒（路由层用 ``to_contract_ms`` 换算成毫秒给出参）。
    ts: int


@dataclass(frozen=True)
class HistoryRecord:
    """``learning_history`` 的一行（**学习历史**分页的原料，2026-09-30）。

    ★ 只有**结构化列**：``question`` 恒为空串（G-K，SQLite 不存对话正文）、
      ``detail`` 是内部 JSON 摘要 —— 两者都**不在这个记录里**
      （读不到就不会漏出去；「读了再过滤」多一道会写错的关卡）。
    """

    id: int
    #: Unix 秒（路由层用 ``to_contract_ms`` 换算成毫秒给出参）。
    ts: int
    kp_id: str
    #: qa | animation | coding | quiz（合法性由合同层过滤，见 ``routes/profile.py``）。
    activity: str
    #: ``None`` = 这条记录**没有对错**（答疑 / 看动画 / 写代码）；
    #: ``False`` = 答错了。★ 两者绝不能混为一谈（见 :meth:`LearningStore.history_page`）。
    is_correct: bool | None


@dataclass(frozen=True)
class OnboardingAnswerRecord:
    """``onboarding_qa`` 的一行（冷启动五问的一问一答）。"""

    question_id: str
    question_text: str
    answer_text: str
    session_id: str
    answered_at: int


class AttemptRecord(NamedTuple):
    """某道题**最近一次**作答（:meth:`LearningStore.question_attempt` 的返回）。

    ★ 用 ``NamedTuple`` 而不是本文件其它记录那种 ``frozen dataclass``：它是判分
      热路径上的一个**小返回值**（每次提交都要取一次），只需要「不可变 + 按名字读」，
      没有默认值 / 校验的需求；NamedTuple 还顺带能按位置取值与元组解包。

    ★ 它**不是** :class:`MistakeRecord` 那样按知识点聚合的结果：后者回答
      「这个知识点错了几次」，本记录回答「**这道题**答过没有、上次对没对」——
      聚合粒度不同，不能拿错题本代替判分幂等（错题本只含答错的行，
      「上次答对了」的那一次在那里根本不存在）。
    """

    qid: str
    #: 该次作答落在哪个知识点（``detail`` 里只有 qid，kp_id 取自行本身）
    kp_id: str
    #: 那次作答的对错；``None`` = 该行没有对错概念（列可空，如实透传）
    is_correct: bool | None
    #: 那次作答的时间（**Unix 秒**，与 ``add_history`` / ``last_active_at`` 同尺度）
    ts: int


class LearningStore:
    """一个学生的 ``learning.db`` 读写入口。"""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.conn = connect(self.path, load_vec=False, wal=True, check_same_thread=False)
        ensure_learning(self.conn)
        # 变式题仓库（见模块头）**按需建表**：见 :meth:`ensure_quiz_tables` 的注释。
        self._quiz_ready = False
        self.quiz_version = 0
        # 学生动画库同一条口径（**不在 __init__ 里建**）：见 :meth:`ensure_animation_tables`。
        self._animation_ready = False
        self._code_ready = False
        self.code_version = 0
        self.animation_version = 0

    # ------------------------------------------- 冷启动画像（迁移 v5） --
    # ★★ 这一段是两张**物理隔离**表的唯一读写口：
    #   identity_local（永不过桥）与 profile_tags（白名单守卫）。
    #   路由层不许自己拼 SQL —— 两道闸（memory_switch / parent_consent）与白名单
    #   校验集中在这里，才谈得上「关掉就立刻生效」，也才有唯一的 G-A/G-F 落点。

    def _current_turn_mark(self) -> int:
        """当前「轮次位标」= grade_signals 的最大 id（单调、跨会话连续）。

        ★ 用它把 TTL 的「3 轮」变成可算的量（见 v5 DDL 的 turn_mark）。迁移 v3 已经
          确认过这条性质：每个轮次至少写一行读数，所以 id 差 ≈ 真实轮数。
        ★ 读不到（坏库 / 表被外力删）就回 0 —— TTL 退化成只剩 24 小时口径，不因此报错。
        """
        try:
            row = self.conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS mark FROM grade_signals"
            ).fetchone()
        except sqlite3.Error:  # pragma: no cover - 坏库
            return 0
        return int(row["mark"] or 0) if row is not None else 0

    def identity(self, student_id: str) -> IdentityRecord | None:
        """读身份行；**没有就返回 None**（不在这里建行，见 identity_or_default）。"""
        row = self.conn.execute(
            "SELECT anon_student_id, real_name, real_grade, school, class, "
            "parent_consent, memory_switch, onboarding_state FROM identity_local "
            "WHERE anon_student_id = ?",
            (student_id,),
        ).fetchone()
        return None if row is None else _identity_from_row(row)

    def identity_or_default(self, student_id: str) -> IdentityRecord:
        """读身份行；没有行就用**默认值**（两道闸默认开、状态 not_started）。

        ★ 默认值 = 用户裁决的选项 B（默认同意，家长可在设置页关）。读路径**不落行**：
          「读一次设置」不该在库里留下一行；真正需要留痕的是写
          （set_identity_flags / set_onboarding_state）。
        """
        return self.identity(student_id) or IdentityRecord(
            anon_student_id=student_id,
            real_name="",
            real_grade="",
            school="",
            class_name="",
            parent_consent=True,
            memory_switch=True,
            onboarding_state=ONBOARDING_STATE_NOT_STARTED,
        )

    def _ensure_identity_row(self, student_id: str) -> None:
        # 写之前先保证行在（默认值由 DDL 给，这里不重复写一遍默认值 —— 两处默认值会漂）。
        self.conn.execute(
            "INSERT OR IGNORE INTO identity_local(anon_student_id) VALUES(?)", (student_id,)
        )

    def set_identity_flags(
        self,
        student_id: str,
        *,
        parent_consent: bool | None = None,
        memory_switch: bool | None = None,
    ) -> None:
        """写两道闸；None = 本次不动那一项（设置页可能只翻其中一个开关）。"""
        if parent_consent is None and memory_switch is None:
            return
        self._ensure_identity_row(student_id)
        if parent_consent is not None:
            self.conn.execute(
                "UPDATE identity_local SET parent_consent = ? WHERE anon_student_id = ?",
                (1 if parent_consent else 0, student_id),
            )
        if memory_switch is not None:
            self.conn.execute(
                "UPDATE identity_local SET memory_switch = ? WHERE anon_student_id = ?",
                (1 if memory_switch else 0, student_id),
            )
        self.conn.commit()

    def set_real_name(self, student_id: str, real_name: str) -> None:
        """写本地真名（★ **永不过桥**：只给渲染层做 `{{student_name}}` 本地替换，永不进 prompt）。

        ★★ 为什么必须存在这个原语（集成期发现的功能死洞）：
           Q5 问「我该怎么称呼你」，主进程把答案脱敏成称呼、也把 `displayName` 交给了
           引导 Prompt —— 但**没有任何路径把它写进库**。后果是 `GET /identity` 恒回空
           `real_name`，渲染层于是永远把 `{{student_name}}` 替换成「同学」：
           **模型被要求用占位符，而占位符永远替换不出真名**。占位机制看起来在工作，
           实际上是静默失效的。

        ⚠️ 与两道闸的关键区别：这是**身份数据**，不是闸。所以它**不看** `memory_switch` ——
           「不再记学习画像」不等于「忘掉学生叫什么」；把两件事绑在一起，会让
           关掉记忆开关的学生连称呼都丢掉（那不是隐私保护，是功能坏了）。
        ⚠️ 它仍然**只在本地**：G-C 保证没有任何 prompt 拼装路径读这一列。
        ⚠️ 空串是合法写入（= 学生没给称呼）—— 读取端把空串统一折算成回落值。
        """
        self._ensure_identity_row(student_id)
        self.conn.execute(
            "UPDATE identity_local SET real_name = ? WHERE anon_student_id = ?",
            (real_name, student_id),
        )
        self.conn.commit()

    def set_nickname(self, student_id: str, nickname: str) -> None:
        """写 ``student.nickname``（**只写这一列**的单条 UPDATE）。

        ★★ 为什么必须存在这个原语（2026-10-04 用户报障）：「切账号以后画像部分的名字
          没有更新」。查出来**不是没联动**，是库里**同一个人有两个名字**：
          ``student.nickname``（账号列表读它）与 ``identity_local.real_name``
          （`GET /identity` 的 displayName 读它）—— 两者此前**没有任何同步**，
          于是侧栏显示「同学」、右栏画像显示真名。
          修法是让两者在**写入源头**同一个值，而不是让界面读两次。

        ★★ 为什么不用 ``upsert_student()``（与 :meth:`touch_last_active` 同一条纪律）：
          那是**整行 upsert**，``ON CONFLICT`` 分支会把 ``grade_level`` 按调用方手里的
          值一起写回 —— 而调用方（写称呼那条路）手里没有学段快照，写回等于把学段打回
          旧值且不留 ``grade_history``。单列 UPDATE 没有「读取 → 改 → 写回」的窗口。

        ★ 学生行不存在时**什么都不写**（UPDATE 影响 0 行，不静默建行）：
          建行要一并决定学段与昵称，那是路由层冷启动的事（``upsert_student``）。
        """
        self.conn.execute(
            "UPDATE student SET nickname = ? WHERE student_id = ?",
            (nickname, student_id),
        )
        self.conn.commit()

    def get_real_name(self, student_id: str) -> str:
        """读本地真名（空串 = 学生没给称呼）。**只在本地用**，不进 prompt。

        ★ 它是 ``set_real_name`` 的对称读口：写称呼那条路要拿它做同步判定
          （见 ``routes/profile.py`` 的 ``update_identity_flags``）。
        """
        row = self.conn.execute(
            "SELECT real_name FROM identity_local WHERE anon_student_id = ?",
            (student_id,),
        ).fetchone()
        if row is None:
            return ""
        return str(row["real_name"] or "")

    def parent_consent(self, student_id: str) -> bool:
        """家长同意闸：False 时**不外发任何画像**（G-G，由路由层把 tags 出参清空）。"""
        return self.identity_or_default(student_id).parent_consent

    def memory_switch(self, student_id: str) -> bool:
        """记忆闸：False 时**不写任何标签**（G-F，写入原语里直接 return）。"""
        return self.identity_or_default(student_id).memory_switch

    def onboarding_state(self, student_id: str) -> str:
        """读引导流程状态（无行 = not_started）。"""
        return self.identity_or_default(student_id).onboarding_state

    def set_onboarding_state(self, student_id: str, state: str) -> None:
        """写引导流程状态（封闭词表；非法值直接 ValueError，不静默落库）。"""
        if state not in ONBOARDING_STATES:
            raise ValueError(f"onboarding_state 非法：{state!r}（只允许 {ONBOARDING_STATES}）")
        self._ensure_identity_row(student_id)
        self.conn.execute(
            "UPDATE identity_local SET onboarding_state = ? WHERE anon_student_id = ?",
            (state, student_id),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 标签 --
    def upsert_tag(
        self,
        student_id: str,
        key: str,
        value: str,
        *,
        confidence: float | None = None,
        source: str = "declared",
        ts: int | None = None,
        origin: str | None = None,
    ) -> bool:
        """写一条画像标签。返回**是否真的落库**（False = 被 memory_switch 挡住）。

        ★★ 三道闸都在这里，**调用方绕不过去**：

        ① **白名单**（G-A）：不在 ALLOWED_TAG_KEYS 直接 ValueError ——
           这是「禁做 #2–6、#8」在**存储层**的实现（家庭收入 / 父母职业 / 消费画像 /
           广告 ID / 精确位置 / 社交关系都没有对应键）；
        ② **memory_switch=0**（G-F）：**不写任何标签**，直接 return False；
        ③ **敏感属性推断**（禁做 #10）：source='inferred' 只允许情绪/风格类键。

        另有取值域校验：emotion 只认有限枚举（禁做 #12），intensity 只认 0..3。

        :param origin: 变更出处（迁移 v7，∈ :data:`TAG_ORIGINS`）。**只影响时间线**，
            不参与任何分档/校验判断。``None`` = 由调用方按 source 推断：
            ``declared`` → ``cold_start``（五问是唯一写 declared 的路），其余 → ``refresh``。
            知道的调用点请**显式传**（行为投影传 ``projection``，概括传 ``refresh``）——
            因为 ``observed`` 的自动推断会落到 ``refresh``，那对投影是错的。
        """
        if key not in ALLOWED_TAG_KEY_SET:
            raise ValueError(f"标签键不在白名单里：{key!r}（G-A）")
        if source not in TAG_SOURCES:
            raise ValueError(f"标签来源非法：{source!r}（只允许 {sorted(TAG_SOURCES)}）")
        if source == "inferred" and key not in INFERRED_ALLOWED_TAG_KEYS:
            raise ValueError(
                f"source='inferred' 只能写风格/倾向类键（禁做 #10），收到：{key!r}"
            )
        if origin is not None and origin not in TAG_ORIGINS:
            raise ValueError(f"标签出处非法：{origin!r}（只允许 {sorted(TAG_ORIGINS)}）")

        text = " ".join(str(value).split())
        if key == "emotion" and text not in EMOTION_VALUE_SET:
            raise ValueError(
                f"emotion 只认有限枚举 {EMOTION_VALUES}（禁做 #12），收到：{value!r}"
            )
        # ★ 维度 13（2026-09-30）：两个新键都是**封闭词表**，理由分两层 ——
        #   learner_style 与 OBSERVED_ERROR_TYPES 同一条（会展示给学生，不许出现评价性长句）；
        #   personality 是**本轮红线移动的那道闸**（性格可被推断，但只能落在这十个词里，
        #   医学/心理学词一个都不许进来）。两处的词表与 TS 侧逐字一致。
        if key == "learner_style" and text not in LEARNER_STYLE_VALUE_SET:
            raise ValueError(
                f"learner_style 只认封闭词表 {LEARNER_STYLE_VALUES}，收到：{value!r}"
            )
        if key == "personality" and text not in PERSONALITY_VALUE_SET:
            raise ValueError(
                f"personality 只认封闭词表 {PERSONALITY_VALUES}，收到：{value!r}"
            )
        if key == "zpd_level" and text not in ZPD_LEVEL_VALUE_SET:
            # ★ 与 learner_style / personality 同一道闸：这个值会进画像卡，也会决定
            #   下一轮 prompt 的讲法，所以只认封闭词表里的三个中文词。
            raise ValueError(
                f"zpd_level 只认封闭词表 {ZPD_LEVEL_VALUES}，收到：{value!r}"
            )
        if key == "intensity":
            try:
                number = int(text)
            except ValueError as exc:
                raise ValueError(
                    f"intensity 只认 {INTENSITY_MIN}..{INTENSITY_MAX} 的整数，收到：{value!r}"
                ) from exc
            if not (INTENSITY_MIN <= number <= INTENSITY_MAX):
                raise ValueError(
                    f"intensity 只认 {INTENSITY_MIN}..{INTENSITY_MAX} 的整数，收到：{value!r}"
                )
            text = str(number)

        if not self.memory_switch(student_id):
            return False

        now = int(time.time() if ts is None else ts)
        # ★ 变更时间线（§5.2 #11）：**写之前**先读旧值，否则 upsert 之后旧值就没了。
        previous = self._tag_value(student_id, key)
        self.conn.execute(
            "INSERT INTO profile_tags(anon_student_id, key, value, confidence, source, ts, turn_mark) "
            "VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(anon_student_id, key) DO UPDATE SET value=excluded.value, "
            "confidence=excluded.confidence, source=excluded.source, ts=excluded.ts, "
            "turn_mark=excluded.turn_mark",
            (
                student_id,
                key,
                text,
                None if confidence is None else float(confidence),
                source,
                now,
                self._current_turn_mark(),
            ),
        )
        # ★ 同一事务里追加一笔变更（值没变则不记，见 _append_tag_history）
        #   出处（origin）在这里按 source 兜底推断：知道的调用点早已显式传入。
        self._append_tag_history(
            student_id, key, text, previous, source, confidence, now, origin
        )
        self.conn.commit()
        return True

    def tags(self, student_id: str, *, now: int | None = None) -> list[ProfileTagRecord]:
        """读该学生的全部标签（按 key 排序）；**TTL 过滤就在这一层**。

        ★ emotion / intensity / trigger 超过 **3 轮或 24 小时（取先到）**
          → 当作不存在（G-E）。轮次用「当前 mark − 写入时 mark」算（见 turn_mark）。
        ★ 出栈前**再过一次白名单**（G-A）：库里就算被外部工具塞了别的键，也不会流出去。
        ★ now 只给测试注入时间用；生产路径不传，取系统时钟。
        """
        now_s = int(time.time() if now is None else now)
        current_mark = self._current_turn_mark()
        rows = self.conn.execute(
            "SELECT key, value, confidence, source, ts, turn_mark FROM profile_tags "
            "WHERE anon_student_id = ? ORDER BY key",
            (student_id,),
        ).fetchall()
        records: list[ProfileTagRecord] = []
        for row in rows:
            key = str(row["key"])
            if key not in ALLOWED_TAG_KEY_SET:  # G-A：出栈再过一遍
                continue
            ts = int(row["ts"] or 0)
            if key in EPHEMERAL_TAG_SET:
                if now_s - ts > EPHEMERAL_TTL_SECONDS:
                    continue
                mark = row["turn_mark"]
                if mark is not None and current_mark - int(mark) > EPHEMERAL_TTL_TURNS:
                    continue
            records.append(
                ProfileTagRecord(
                    key=key,
                    value=str(row["value"] or ""),
                    confidence=None if row["confidence"] is None else float(row["confidence"]),
                    source=str(row["source"] or "declared"),
                    ts=ts,
                )
            )
        return records

    def _tag_value(self, student_id: str, key: str) -> str | None:
        """读一个键的**当前值**（不存在返回 None）。供变更时间线取「变更前」用。"""
        row = self.conn.execute(
            "SELECT value FROM profile_tags WHERE anon_student_id = ? AND key = ?",
            (student_id, key),
        ).fetchone()
        return None if row is None else str(row["value"] or "")

    def _append_tag_history(
        self,
        student_id: str,
        key: str,
        value: str,
        previous: str | None,
        source: str,
        confidence: float | None,
        now: int,
        origin: str | None = None,
    ) -> bool:
        """把一次标签变更追加进时间线（§5.2 #11）。返回是否真的记了一笔。

        ★★★ 两道闸，缺一不可（理由详见迁移 v6 的注释）：

          ① **短期情绪标签永不记**。emotion / intensity / trigger 在读取侧有 TTL
             （3 轮或 24 小时）。TTL 存在的**全部意义**是不让「上次考崩了、情绪低落」
             被长期记着（禁做 #11「长期负面情绪档案」）。
             一旦历史表把它们记下来，读取侧的 TTL 就被**彻底架空** ——
             当前值过期了，历史里却一行不少：档案照样存在，而且更隐蔽
             （看主表看不见，翻历史才看得见）。所以这里显式排除。

          ② **键必须仍在白名单里**。历史记录的是过去的**值**，不是过去的**身份** ——
             真名 / 精确年级 / 学校 / 班级任何时候都不许出现在这里，与主表同一条纪律。

        ★ **值没变就不记**：自动投影（sync_observed_tags）每一轮都会 upsert 一遍，
          不做这个判断的话时间线会被同一件事的重复噪音塞满，真正的变化反而淹没在里面。

        ★ ``origin``（迁移 v7）：这条变更的**出处**。``None`` = 调用方没声明 →
          按 :meth:`_origin_for_source` 推断。**落库前一律解析成具体值**（不留 NULL）——
          NULL 在历史表里**只**表示「v7 之前的旧行」（见迁移 v7 的回填说明）。
        """
        if key in EPHEMERAL_TAG_SET:
            return False
        if key not in ALLOWED_TAG_KEY_SET:
            return False
        if previous == value:
            return False
        resolved_origin = self._origin_for_source(source) if origin is None else origin
        self.conn.execute(
            "INSERT INTO profile_tag_history("
            "ts, anon_student_id, key, value, previous_value, source, confidence, origin"
            ") VALUES(?,?,?,?,?,?,?,?)",
            (
                now,
                student_id,
                key,
                value,
                previous,
                source,
                None if confidence is None else float(confidence),
                resolved_origin,
            ),
        )
        return True

    @staticmethod
    def _origin_for_source(source: str) -> str:
        """按 `source` 推断变更出处（**:meth:`_append_tag_history` 的兜底**）。

        ★ 只在调用方**没显式声明** origin 时用，判据是实测出来的唯一映射：
          · ``declared`` —— 全项目**只有**五问冷启动写（契约层 RefreshApplyTag
            明确禁止概括声明 declared），所以它必然是 ``cold_start``；
          · 其余（``observed`` / ``inferred``）—— 兜底取 ``refresh``。

        ⚠️ 兜底**不等于**正确：``observed`` 也可能是**行为投影**（sync_observed_tags），
          而投影会显式传 ``projection``（见该函数），所以实际走到这条兜底的
          ``observed`` 只剩「五问之外、未被显式标注」的历史遗留调用点。把这里
          说清楚是为了：**新增写入路径时必须想清楚自己是哪一种，别默认吃 refresh**。
        """
        return TAG_ORIGIN_COLD_START if source == "declared" else TAG_ORIGIN_REFRESH

    def tag_history(
        self, student_id: str, *, limit: int = 200
    ) -> list[ProfileTagHistoryRecord]:
        """读画像标签的变更时间线（**新的在前**，§5.2 #11）。

        ★ 出栈前**再过一遍白名单 + 短期情绪排除**：与 :meth:`tags` 同一条纵深防御 ——
          库里就算被外部工具塞了别的键，也不会从这条出口流出去。
        ★ **不在这里过滤 parent_consent**：那是路由层的闸（G-G），与 tags() 的分工一致
          （存储层管「读得到什么」，路由层管「能不能外发」）。
        """
        rows = self.conn.execute(
            "SELECT id, ts, key, value, previous_value, source, confidence, origin "
            "FROM profile_tag_history WHERE anon_student_id = ? "
            "ORDER BY ts DESC, id DESC LIMIT ?",
            (student_id, max(1, int(limit))),
        ).fetchall()
        records: list[ProfileTagHistoryRecord] = []
        for row in rows:
            key = str(row["key"])
            if key not in ALLOWED_TAG_KEY_SET or key in EPHEMERAL_TAG_SET:
                continue
            previous = row["previous_value"]
            # ★ origin 过一遍封闭词表（纵深防御，与 key 的白名单过滤同一纪律）：
            #   库里被外部塞了脏值也不流出去 —— 脏值一律当「不知道」（None），
            #   由读取侧折成中性中文，而不是把内部枚举名当人话显示。
            raw_origin = row["origin"]
            origin = str(raw_origin) if raw_origin in TAG_ORIGINS else None
            records.append(
                ProfileTagHistoryRecord(
                    id=int(row["id"]),
                    key=key,
                    value=str(row["value"] or ""),
                    previous_value=None if previous is None else str(previous),
                    source=str(row["source"] or "declared"),
                    confidence=None if row["confidence"] is None else float(row["confidence"]),
                    origin=origin,
                    ts=int(row["ts"] or 0),
                )
            )
        return records

    def sync_observed_tags(
        self,
        student_id: str,
        *,
        kp_names: Mapping[str, str] | None = None,
        now: int | None = None,
    ) -> dict[str, str]:
        """把**该生已有的数据**投影成 `source='observed'` 的画像标签（计划 §1.6 的数据源映射）。

        ★★ 为什么必须有这个函数（2026-09-28 集成期发现的**功能缺口**）：
          计划 §1.6 的表格明写三条数据源**早就有、只是从没被整理成标签**：
            · 贯穿全程「判分/答题已有数据」 → `knowledge_point / mastery / error_type`
            · 当轮「`signals.py` 元认知路（已有！）」 → `emotion / intensity`
            · 「已有 safety guard」 → `safety_level`
          但在此之前，全项目 `upsert_tag` **只有人工纠错一个调用点** ——
          也就是说除了五问那条路，画像**从来不会自己长**，「系统观察」那一层是空的。

        ★★ 为什么收敛成**一个**函数，而不是在 quiz / grade / safety 三处各写一遍：
          三处各写一遍的后果是同一件事有三个口径 —— 错题归类的词表会漂、TTL 语义会漂、
          `memory_switch` 的检查会漏一处。收敛之后**只有一条写路径**，守卫也只需盯这一条。

        ★ 四条纪律：
          ① 所有写入走 :meth:`upsert_tag`（白名单 G-A / `memory_switch` G-F / 推断限键 禁做#10 /
             取值域 禁做#12 全在那里，**绕不过去**）；
          ② **读不到数据就不写** —— 绝不写占位默认值，那会把「不知道」冒充成「观察到了」；
          ③ **绝不跨学生**：只读 `student_id` 自己的库（禁做 #9）；
          ④ **逐条独立**：某一条不合法/被闸挡住，不影响其它条。

        ⚠️ `kp_names` 由调用方给（学生库里没有知识点中文名，清单在只读的 `kb.sqlite`）：
          拿不到名字时**不写** `knowledge_point` —— 宁可少一条，也不把 `jr-py-data-features`
          这种内部 id 写进会进 prompt / 进画像卡的地方。

        返回**实际写入**的 `{键: 值}`（调用方可据此记日志，测试可据此断言）。
        """
        now_s = int(time.time() if now is None else now)
        written: dict[str, str] = {}

        def put(key: str, value: str, confidence: float | None = None) -> None:
            try:
                if self.upsert_tag(
                    student_id,
                    key,
                    value,
                    confidence=confidence,
                    source="observed",
                    ts=now_s,
                    # ★ 显式声明出处（迁移 v7）：投影**不是**持续迭代概括，
                    #   两者都写 observed，只有 origin 分得开（这就是加 origin 的全部理由）。
                    origin=TAG_ORIGIN_PROJECTION,
                ):
                    written[key] = value
            except ValueError:
                # 取值域/白名单不合法：丢这一条，不影响其它（逐条独立）
                logger.warning("观察标签被拒（不影响其它）：%s=%r", key, value)

        # ── ① 最近练过的知识点 + 掌握度（判分/答题的已有数据）─────────────
        row = self.conn.execute(
            "SELECT kp_id, score, attempts, correct FROM mastery "
            "WHERE attempts > 0 ORDER BY last_seen_at DESC LIMIT 1"
        ).fetchone()
        if row is not None:
            kp_id = str(row["kp_id"])
            score = float(row["score"] or 0.0)
            attempts = int(row["attempts"] or 0)
            correct = int(row["correct"] or 0)
            put("mastery", f"{score:.2f}", score)
            name = (kp_names or {}).get(kp_id, "")
            if name:
                put("knowledge_point", name, score)
            # ── ② 错误模式（同样是判分数据，只是要归类）───────────────────
            if correct == 0 and attempts >= ERROR_TYPE_CONFUSION_MIN_ATTEMPTS:
                # 反复错、从没对过 → 概念没建立（不是手滑）
                put("error_type", "概念混淆", min(1.0, attempts / 4.0))
            elif correct > 0 and score < ERROR_TYPE_CARELESS_MAX_SCORE:
                # 曾经做对过、现在却不稳 → 会做但粗心
                put("error_type", "粗心", 0.5)

        # ── ③ 情绪 / 强度：signals.py 的元认知路（**早就有**，从没被整理成标签）──
        signal = self.conn.execute(
            "SELECT raw FROM grade_signals WHERE signal_type = 'meta_cognition' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if signal is not None:
            raw = str(signal["raw"] or "")
            # ⚠️ 只认元认知路**自己**的措辞（「受挫=」/「求复述=」），不另起一套关键词表：
            #   两套词表迟早会漂，而漂的表现是「信号说受挫、标签说平静」。
            if "受挫" in raw:
                put("emotion", "frustrated", 0.6)
                put("intensity", "2")
            elif "求复述" in raw:
                put("emotion", "confused", 0.5)
                put("intensity", "1")

        # ── ④ 安全级别：只记档位、不记内容 ──────────────────────────────
        history = self.conn.execute(
            "SELECT COUNT(*) AS n FROM learning_history"
        ).fetchone()
        if history is not None and int(history["n"] or 0) > 0:
            # 有学习记录才谈「观察到的安全级别」——没记录时说「正常」是凭空断言
            flagged = self.conn.execute(
                "SELECT COUNT(*) AS n FROM learning_history "
                "WHERE detail LIKE '%拦截%' OR detail LIKE '%安全%'"
            ).fetchone()
            caution = flagged is not None and int(flagged["n"] or 0) > 0
            put("safety_level", "需留意" if caution else "正常", 0.8)

        # ── ⑤ 学习类型（维度 13，2026-09-30）：一次聚合判定 ─────────────────
        #   ★ 挂在这里而不是在 quiz 路由里另加一次调用：本函数就是「把该生已有数据
        #     投影成标签」的**唯一收口**（见它的 docstring 第二条）。多挂一处 =
        #     多一个可能漏调的调用点。判定口径全在 sync_learner_style 里。
        style = self.sync_learner_style(student_id, now=now_s)
        if style is not None:
            written["learner_style"] = style

        # ── ⑥ 学段内难度档（票 30，2026-10-22）：`zpd_level` 的**唯一生产方** ──
        #   ★ 与 ⑤ 完全同构、同一处收口：本函数就是「把该生已有数据投影成标签」的
        #     **唯一入口**，多挂一处 = 多一个可能漏调的调用点。
        #   ★ 此前这个键全仓无人写 → `prompts/adaptation.ts` 的难度微调恒为「正常」
        #     （`renderDifficultySectionBody('normal')` 返回空串）。见 sync_zpd_level 的 docstring。
        tier = self.sync_zpd_level(student_id, now=now_s)
        if tier is not None:
            written["zpd_level"] = tier

        return written

    def sync_learner_style(self, student_id: str, *, now: int | None = None) -> str | None:
        """把学习数据投影成 `learner_style`（`observed` / `origin=projection`）。

        ★★ 这是「预置分类标签」的**权威路**（2026-09-30）。它与持续概括那条路
        （`inferred` / `origin=refresh`）的关系由既有分档矩阵自动仲裁：
          · 本函数写 `observed` → 概括的 `inferred` **推不翻**它（分档②）；
          · 数据不足时本函数**不写**，概括的 `inferred` 先占位；
            等数据够了本函数写出 `observed` → **升级**（分档③把推断挤掉）。

        ★ 为什么用规则而不是让模型判：分类的依据是**行为数据**（练了多少、对了多少、
          是不是反复打磨同一处），这些量本就在库里，算出来可解释、可复现、可断言；
          交给模型判会有两个问题 —— 每次概括可能翻转（标签不稳定），
          且「模型觉得你聪明」这种东西没有可审计的依据。

        ★ 四条纪律（与 :meth:`sync_observed_tags` 同一套）：
          ① 写入走 :meth:`upsert_tag`（白名单 / 闸 / 取值域 / 推断限键全在那里）；
          ② **样本不足就不写** —— 绝不用 3 道题的数据给人分类（见
             :data:`LEARNER_STYLE_MIN_ATTEMPTS`）；
          ③ **绝不跨学生**：只读 `student_id` 自己的库（禁做 #9）；
          ④ **特征不显著就不写**（判不出就留空，不写「均衡型」当垫底）。

        :returns: 实际写入的类型（``None`` = 没写：样本不足 / 特征不显著 / 被闸挡住）。
        """
        now_s = int(time.time() if now is None else now)

        # ── 一次聚合读全量掌握度（不逐 kp 查库：这条投影每次判分后都会跑）──
        row = self.conn.execute(
            "SELECT COALESCE(SUM(attempts), 0) AS attempts, "
            "COALESCE(SUM(correct), 0) AS correct, "
            "COUNT(*) AS kp_count, "
            "COALESCE(SUM(CASE WHEN attempts > 1 THEN 1 ELSE 0 END), 0) AS retry_kp_count "
            "FROM mastery WHERE attempts > 0"
        ).fetchone()
        attempts = int(row["attempts"] or 0) if row is not None else 0
        correct = int(row["correct"] or 0) if row is not None else 0
        kp_count = int(row["kp_count"] or 0) if row is not None else 0
        retry_kp_count = int(row["retry_kp_count"] or 0) if row is not None else 0

        if kp_count <= 0 or attempts < LEARNER_STYLE_MIN_ATTEMPTS:
            # 样本不足：**不写**（不是写「均衡型」）—— 不把「没看出来」冒充成「观察到了」
            return None

        accuracy = correct / attempts
        per_kp = attempts / kp_count
        retry_ratio = retry_kp_count / kp_count

        # ── 顺序判定：第一个命中即定（重叠时的优先级是有意的）──────────────
        #   天赋 > 钻研 > 速通 > 努力。
        #   「准确率高位」是最强的信号，放在最前；「反复打磨同一处」比「总练习量大」
        #   更具体，所以钻研在努力之前。都不命中 → 不写（见上）。
        style: str | None = None
        if accuracy >= LEARNER_STYLE_GIFTED_MIN_ACCURACY:
            style = "天赋型"
        elif per_kp >= LEARNER_STYLE_DEEP_MIN_ATTEMPTS_PER_KP:
            style = "钻研型"
        elif (
            per_kp <= LEARNER_STYLE_FAST_MAX_ATTEMPTS_PER_KP
            and accuracy >= LEARNER_STYLE_FAST_MIN_ACCURACY
        ):
            style = "速通型"
        elif (
            attempts >= LEARNER_STYLE_DILIGENT_MIN_ATTEMPTS
            or retry_ratio >= LEARNER_STYLE_DILIGENT_MIN_RETRY_RATIO
        ) and accuracy < LEARNER_STYLE_DILIGENT_MAX_ACCURACY:
            style = "努力型"

        if style is None:
            return None

        try:
            written = self.upsert_tag(
                student_id,
                "learner_style",
                style,
                # 把握程度：样本越多越有把握（10 次 → 0.6，30 次及以上 → 0.8）。
                confidence=min(0.8, 0.6 + attempts / 100.0),
                source="observed",
                ts=now_s,
                # ★ 显式声明出处：这条是**行为投影**，不是持续迭代概括（两者都写
                #   observed，只有 origin 分得开 —— 与 sync_observed_tags 同一条理由）。
                origin=TAG_ORIGIN_PROJECTION,
            )
        except ValueError:
            # 取值域 / 白名单不合法（理论上不会：值来自本文件的封闭词表）：
            # 丢这一条，不影响其它（与 sync_observed_tags 的 put() 同一条纪律）。
            logger.warning("学习类型投影被拒（不影响其它）：%s", style)
            return None
        return style if written else None

    def sync_zpd_level(self, student_id: str, *, now: int | None = None) -> str | None:
        """把学习数据投影成 `zpd_level`（`observed` / `origin=projection`）—— 票 30 的生产方。

        ★★ 这个函数修的是一个**整条链路接好了但没通电**的缺口：
          `desktop/src/main/agent/prompts/adaptation.ts` 的 `resolveDifficultyTier()`
          读 `zpd_level` 决定「这一轮偏易 / 正常 / 偏难讲」，`renderDifficultySectionBody()`
          据此往 system prompt 里注入微调段。但此前**全仓没有任何生产方写这个键** ——
          五问概括与持续概括的 prompt 都没点名它，本文件的 `sync_observed_tags` 也没投影它。
          于是 `resolveDifficultyTier()` 恒回 `normal`、微调段恒为空串，
          票 30 的整套机制**永远走不到**。

        ★ 口径与 :meth:`sync_learner_style` **完全同构**（同一个数据源、同一条纪律）：
          ① 只读该生**自己的**判分数据（禁做 #9）；
          ② **样本不足就不写**（`ZPD_MIN_ATTEMPTS`）—— 不把「没看出来」冒充成「观察到了」；
          ③ 走 :meth:`upsert_tag`，白名单 / `memory_switch` / 取值域三道闸一条不少；
          ④ 显式声明 `origin=projection`（与概括的 `refresh` 分得开）。

        ★ 为什么是 `observed` 而不是 `inferred`：这是**从判分结果算出来的客观量**
          （和 `mastery` / `error_type` 同类），不是「模型从对话里猜的倾向」。
          禁做 #10 把 `inferred` 限制在情绪/风格类，`zpd_level` **不在**那个集合里 ——
          所以它只能由规则投影写，模型推不翻（分档矩阵天然仲裁）。

        ★ 三档的判据（只用两个已有的客观量，不新增数据源）：
          · 正确率 < `ZPD_EASIER_MAX_ACCURACY` → **偏易**（他正在吃力）；
          · 正确率 ≥ `ZPD_HARDER_MIN_ACCURACY` 且样本够多 → **偏难**（他明显吃得下）；
          · 其余 → **正常**。

        ★★ 为什么中段也要**写出来**（而不是「不写 = 默认正常」）：
          这一条是**有状态的**。只写两端的话，一个学生曾经偏易、后来追上来了，
          库里那条「偏易」会**永远留着**（没人覆盖它）—— 他就被永久按偏易讲。
          写「正常」是让档位能**回到中间**的唯一手段。
          代价可接受：`renderDifficultySectionBody('normal')` 返回空串，
          所以「正常」这一档**不往 prompt 里注入任何字**，零 token 成本。

        :returns: 实际写入的档位（`None` = 没写：样本不足 / 被闸挡住）。
        """
        now_s = int(time.time() if now is None else now)

        # ── 一次聚合读全量掌握度（与 sync_learner_style 同一条查询口径）──
        row = self.conn.execute(
            "SELECT COALESCE(SUM(attempts), 0) AS attempts, "
            "COALESCE(SUM(correct), 0) AS correct "
            "FROM mastery WHERE attempts > 0"
        ).fetchone()
        attempts = int(row["attempts"] or 0) if row is not None else 0
        correct = int(row["correct"] or 0) if row is not None else 0

        if attempts < ZPD_MIN_ATTEMPTS:
            # ★ 样本不足：**不写**（不是写「正常」）—— 与 sync_learner_style 同一条纪律。
            #   写「正常」会把「不知道」冒充成「观察到了」，而且它会进画像卡给学生看。
            return None

        accuracy = correct / attempts
        if accuracy < ZPD_EASIER_MAX_ACCURACY:
            tier = "偏易"
        elif accuracy >= ZPD_HARDER_MIN_ACCURACY:
            tier = "偏难"
        else:
            tier = "正常"

        try:
            written = self.upsert_tag(
                student_id,
                "zpd_level",
                tier,
                # 把握程度：样本越多越有把握（6 次 → 0.6，26 次及以上 → 0.8）。
                confidence=min(0.8, 0.6 + attempts / 100.0),
                source="observed",
                ts=now_s,
                # ★ 显式声明出处：这条是**行为投影**，不是持续迭代概括。
                origin=TAG_ORIGIN_PROJECTION,
            )
        except ValueError:
            # 取值域 / 白名单不合法（理论上不会：值来自本文件的封闭词表）：
            # 丢这一条，不影响其它（与 sync_learner_style 同一条纪律）。
            logger.warning("难度档投影被拒（不影响其它）：%s", tier)
            return None
        return tier if written else None

    def upsert_tag_from_summary(
        self,
        student_id: str,
        key: str,
        value: str,
        *,
        source: str = "inferred",
        confidence: float | None = None,
        reason: str = "",
        ts: int | None = None,
    ) -> bool:
        """带**来源分档**的写入（持续画像迭代专用入口，计划 §2.3）。

        ★★ 与 :meth:`upsert_tag` 的关系（**为什么是"加一个"而不是"改那个"**）：
          本函数**内部仍调 upsert_tag** —— 白名单（G-A）/ `memory_switch`（G-F）/
          推断限键（禁做 #10）/ 取值域（禁做 #12）四道校验一条不少，全部照过。
          它**只多一道**「这条该不该覆盖现有那条」的前置判断。

          不把分档逻辑写进 `upsert_tag` 的原因：那个函数有 6 个调用点，其中
          「人工纠错」（`PUT /profile/{sid}/tags/{key}`）的**语义就是"学生明确要求改"**
          —— 那是唯一**允许**覆盖 declared 的路径。把分档塞进去会把纠错一起挡掉，
          那是功能倒退（学生说了不算，猜测反倒说了算）。

        ★★★ 分档矩阵（用户裁决：「自述不覆盖，其余可更新」）：

          | 现有 source | 新来 source | 处理                       |
          | ----------- | ----------- | -------------------------- |
          | declared    | 任意        | **绝不覆盖**（安全底线）    |
          | observed    | observed    | 可更新（值没变时 upsert_tag 内部也不记账） |
          | observed    | inferred    | **不覆盖**（量到的 > 猜的） |
          | inferred    | observed    | **可覆盖**（观察坐实猜测）  |
          | inferred    | inferred    | 置信度**更高才**写          |
          | （无）       | 任意        | 新增                        |

        ★ 为什么「现有是 declared 就永不覆盖」单独放在最前面：它是整条回路的安全
          底线 —— 学生亲口说的偏好/兴趣是他的真相，模型从对话里**猜**出来的东西
          不得推翻它。这一条必须独立可测（G-M-1）。

        ★ 为什么「现有 observed + 新来 inferred」要挡：observed 是**系统量到的**
          （判分结果投影、行为事实），inferred 是**模型猜的**。让猜的覆盖量的，
          等于「模型觉得你懂了就改分」，与 :data:`INFERRED_ALLOWED_TAG_KEYS` 的
          设计意图（L3 永远压不过 L1）同一条纪律。

        ★ 为什么 inferred 之间要比 confidence：猜测可以被**更好的猜测**取代，
          但同分/更低分的重复猜测不该把更可信的那条挤掉；同时若无脑覆盖，
          每一轮概括都会写一遍（时间线被噪音塞满，且 turn_mark 被无意义地刷新，
          影响短期情绪 TTL 的轮次口径）。

        :param reason: **只用于日志**（可观测这条标签是"哪次概括"带进来的）。
            不入库 —— `profile_tags` 没有这一列，也不该有：多一列自由文本
            就多一个「把对话正文塞进画像」的侧门。
        :returns: 是否真的写了（False = 被 memory_switch 挡 / 分档拒绝 / 值无变化）。
        """
        if source not in TAG_SOURCES:
            raise ValueError(f"标签来源非法：{source!r}（只允许 {sorted(TAG_SOURCES)}）")
        # ★ 白名单校验放在最前：不属于白名单的键连「查现有值」都不必做，
        #   直接按 upsert_tag 的同一口径抛 ValueError（调用方/端点翻成 422）。
        if key not in ALLOWED_TAG_KEY_SET:
            raise ValueError(f"标签键不在白名单里：{key!r}（G-A）")

        current_source = self._tag_source(student_id, key)

        # ── 分档①：现有是 declared → 永不覆盖（安全底线，必须最先判）─────────
        if current_source == "declared":
            logger.info(
                "画像概括写入被拒（现有为学生自述，不得覆盖）：学生=%s 键=%s 来源=%s 缘由=%s",
                student_id,
                key,
                source,
                reason or "-",
            )
            return False

        # ── 分档②：现有 observed + 新来 inferred → 不覆盖（量的 > 猜的）─────
        if current_source == "observed" and source == "inferred":
            logger.info(
                "画像概括写入被拒（系统观察优先于推断）：学生=%s 键=%s 缘由=%s",
                student_id,
                key,
                reason or "-",
            )
            return False

        # ── 分档③：inferred → inferred 且置信度没更高 → 不覆盖（保留更可信的猜测）──
        if current_source == "inferred" and source == "inferred":
            current_confidence = self._tag_confidence(student_id, key)
            if current_confidence is not None and (
                confidence is None or float(confidence) <= current_confidence
            ):
                logger.info(
                    "画像概括写入被拒（推断置信度未提升）：学生=%s 键=%s 现有=%.2f 新来=%s",
                    student_id,
                    key,
                    current_confidence,
                    "None" if confidence is None else f"{float(confidence):.2f}",
                )
                return False

        # ── 通过分档 → 走既有写原语（四道校验照过）─────────────────────────
        written = self.upsert_tag(
            student_id,
            key,
            value,
            confidence=confidence,
            source=source,  # type: ignore[arg-type]
            ts=ts,
            # ★ 显式声明出处（迁移 v7）：这条路**就是**持续画像迭代，
            #   与五问冷启动（cold_start）/ 行为投影（projection）区分开。
            origin=TAG_ORIGIN_REFRESH,
        )
        if written:
            logger.info(
                "画像概括写入：学生=%s 键=%s 来源=%s 缘由=%s",
                student_id,
                key,
                source,
                reason or "-",
            )
        return written

    def _tag_source(self, student_id: str, key: str) -> str:
        """读一个键当前的**来源层**（不存在返回空串）。

        ★ 与 :meth:`_tag_value` 成对：分档判断要看的是**来源**（谁写的）而不是
          值本身 —— 「同一个值、不同来源」在分档里待遇完全不同。
        ★ 脏值（库里被外力塞了不在 :data:`TAG_SOURCES` 里的来源）一律当**空串**
          处理，即"没有可信来源"→ 允许写入。这是刻意的：把未知来源当成最高优先级
          保护起来，会让一条坏行把一个键**永久锁死**（再也写不进去），
          而 :meth:`upsert_tag` 下一次写入就会把来源规整成合法值 —— 自愈。
        """
        row = self.conn.execute(
            "SELECT source FROM profile_tags WHERE anon_student_id = ? AND key = ?",
            (student_id, key),
        ).fetchone()
        if row is None:
            return ""
        value = str(row["source"] or "")
        return value if value in TAG_SOURCES else ""

    def tag_source_of(self, student_id: str, key: str) -> str:
        """:meth:`_tag_source` 的**公开读口**（路由层诊断「为什么这条被分档拒绝」用）。

        ★ 为什么开这个口而不是让路由层直接调 `_tag_source`：跨模块读私有方法会让
          「分档判据」出现第二处知识 —— 哪天判据改了，路由层的诊断文案会静默失真。
          公开一个只读投影，语义上就是「这条标签现在是什么来源」，与判据解耦。
        """
        return self._tag_source(student_id, key)

    def _tag_confidence(self, student_id: str, key: str) -> float | None:
        """读一个键当前的置信度（不存在 / 为 NULL 返回 None）。供 inferred 分档比较用。"""
        row = self.conn.execute(
            "SELECT confidence FROM profile_tags WHERE anon_student_id = ? AND key = ?",
            (student_id, key),
        ).fetchone()
        if row is None or row["confidence"] is None:
            return None
        return float(row["confidence"])

    def delete_tag(self, student_id: str, key: str) -> bool:
        """删一个标签（L3 一键撤销）；返回是否真的删掉了。

        ★ 不校验白名单：删一个本来就不该存在的键是无害的 no-op，回 False 就够
          （校验留给写入路径 —— 能写进去的才需要挡住）。
        """
        cursor = self.conn.execute(
            "DELETE FROM profile_tags WHERE anon_student_id = ? AND key = ?",
            (student_id, key),
        )
        self.conn.commit()
        return cursor.rowcount > 0

    # ---------------------------------------------------- 冷启动五问审计 --
    def save_onboarding_answer(
        self,
        *,
        question_id: str,
        question_text: str,
        answer_text: str,
        session_id: str = "",
    ) -> None:
        """写一问的回答（**幂等**：同一 question_id 覆盖，不追加）。

        ★ 本表是「SQLite 不存对话正文」这条不变量的**唯一例外**（见模块头与
          routes/profile.py 的合规章节）：有界、一次性、明确知道写了什么，
          作用域不扩大到普通对话。UNIQUE(question_id) 是覆盖语义的落点。
        """
        now = int(time.time())
        self.conn.execute(
            "INSERT INTO onboarding_qa(ts, session_id, question_id, question_text, answer_text, answered_at) "
            "VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(question_id) DO UPDATE SET ts=excluded.ts, session_id=excluded.session_id, "
            "question_text=excluded.question_text, answer_text=excluded.answer_text, "
            "answered_at=excluded.answered_at",
            (now, session_id, question_id, question_text, answer_text, now),
        )
        self.conn.commit()

    def onboarding_answers(self) -> list[OnboardingAnswerRecord]:
        """读冷启动五问已收的回答（按 question_id 排序，天然 q1..q5）。"""
        rows = self.conn.execute(
            "SELECT question_id, question_text, answer_text, session_id, answered_at "
            "FROM onboarding_qa ORDER BY question_id"
        ).fetchall()
        return [
            OnboardingAnswerRecord(
                question_id=str(row["question_id"]),
                question_text=str(row["question_text"] or ""),
                answer_text=str(row["answer_text"] or ""),
                session_id=str(row["session_id"] or ""),
                answered_at=int(row["answered_at"] or 0),
            )
            for row in rows
        ]

    # ------------------------------------------------------------ 学生 --
    def upsert_student(self, student_id: str, nickname: str, grade_level: str) -> StudentRecord:
        now = int(time.time())
        self.conn.execute(
            "INSERT INTO student(student_id, nickname, grade_level, created_at, last_active_at) "
            "VALUES(?,?,?,?,?) "
            "ON CONFLICT(student_id) DO UPDATE SET nickname=excluded.nickname, "
            "grade_level=excluded.grade_level, last_active_at=excluded.last_active_at",
            (student_id, nickname, grade_level, now, now),
        )
        self.conn.commit()
        got = self.get_student(student_id)
        assert got is not None
        return got

    def get_student(self, student_id: str) -> StudentRecord | None:
        row = self.conn.execute(
            "SELECT student_id, nickname, grade_level, created_at, last_active_at, current_chapter "
            "FROM student WHERE student_id = ?",
            (student_id,),
        ).fetchone()
        if row is None:
            return None
        return StudentRecord(
            student_id=str(row["student_id"]),
            nickname=str(row["nickname"] or ""),
            grade_level=str(row["grade_level"]),
            created_at=int(row["created_at"] or 0),
            last_active_at=int(row["last_active_at"] or 0),
            current_chapter=str(row["current_chapter"] or ""),
        )

    def touch_last_active(self, student_id: str) -> None:
        """刷新 ``student.last_active_at``（**只写这一列**的单条 UPDATE）。

        列名与单位**以 DDL 为准**：``migrations.py`` 的 ``_LEARNING_V1`` 里是
        ``last_active_at INTEGER``，写 ``int(time.time())``（**Unix 秒**，
        与 ``upsert_student`` / ``add_history`` 同一尺度；路由层用 ``to_contract_ms``
        换算成毫秒给出参）。

        ★★ **为什么不能用 ``upsert_student()`` 来刷活跃时间**（这条方法存在的全部理由）：
          那个方法做的是**整行 upsert** —— ``ON CONFLICT`` 分支会把 ``nickname``
          与 **``grade_level``** 按调用方手里的值一起写回去。而刷新活跃时间的调用方
          只能先 ``get_student()`` 读一份快照、在请求收尾时再写回，**这一读一写之间
          学段可能已经被别处改掉**（``app/grade/rules.py`` 的自动规则引擎、
          ``POST /api/grade/override`` 的手动选择）。于是这次「刷新活跃时间」
          会把刚生效的新学段**打回旧值**，而且**不留 ``grade_history``** ——
          库里的学段与轨迹互相矛盾，现象是「学生明明被切到初中了，几轮后又变回小学」，
          属最难查的那类故障。单列 UPDATE 里没有「读取 → 改 → 写回」的窗口，天然免疫。

        ★ 同理**不碰** ``current_chapter`` / ``created_at`` / 任何其它列：
          这个方法的名字就是它的全部职责（与 D-038 的「学段变更才清章节」分得干干净净）。

        ★ 学生行不存在时**什么都不写**（``UPDATE`` 影响 0 行，不静默建行）——
          与 :meth:`set_current_chapter` 同一口径：建行要一并决定学段与昵称，
          那是路由层冷启动的事（``upsert_student``），存储层不替它决定。
        """
        self.conn.execute(
            "UPDATE student SET last_active_at = ? WHERE student_id = ?",
            (int(time.time()), student_id),
        )
        self.conn.commit()

    # ------------------------------------------------------- 当前教材章节 --
    # ★ 这一对方法是 ``student.current_chapter`` 这一列**唯一的读写实现**：
    #   ``routes/profile.py`` 的两条章节端点调它们，别处（学段变更清空在 rules.py 里
    #   是同一张表的一次 UPDATE，属学段轨自己的事务）不许再拼一份 SELECT/UPDATE。
    #   两处各写一份 SQL 的典型后果：「清空」一处写 NULL、一处写 ''，读出来两种空值。
    def current_chapter(self, student_id: str) -> str:
        """读该学生当前章节标题（无行 / ``NULL`` / 空串 → **空串**）。"""
        row = self.conn.execute(
            "SELECT current_chapter FROM student WHERE student_id = ?", (student_id,)
        ).fetchone()
        if row is None:
            return ""
        return str(row["current_chapter"] or "")

    def set_current_chapter(self, student_id: str, title: str | None) -> None:
        """写/清除当前章节（**空串 / ``None`` → 写 ``NULL``**，读回仍是空串）。

        ★ 为什么统一落成 ``NULL`` 而不是 ``''``：库里只留一种「空」的表示，
          否则 ``WHERE current_chapter = ''`` 这类查询会漏掉 ``NULL`` 的行
          （三值逻辑），排查起来是「明明没选章节却查不出来」。
        ★ 学生行不存在时**什么都不写**（不静默建行）：建行是路由层的冷启动口径
          （``upsert_student`` 要一并写学段），存储层不该替它决定学段。
        """
        value = (title or "").strip()
        self.conn.execute(
            "UPDATE student SET current_chapter = ? WHERE student_id = ?",
            (value or None, student_id),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 掌握度 --
    def mastery(self, kp_id: str) -> tuple[float, int, int]:
        row = self.conn.execute(
            "SELECT score, attempts, correct FROM mastery WHERE kp_id = ?", (kp_id,)
        ).fetchone()
        if row is None:
            return 0.0, 0, 0
        return float(row["score"]), int(row["attempts"]), int(row["correct"])

    def apply_mastery(
        self, kp_id: str, delta: float, *, correct: bool | None = None
    ) -> float:
        """更新掌握度并返回新值。``delta`` **限幅 ±0.2**。

        ★ **算术全部下推到一条 SQL**（``RETURNING`` 直接读回新值），不做
        「先 ``SELECT`` 读旧值 → 在 Python 里算 → 再写回」：那是两步之间的竞态，
        同一学生并发两次判分（前端双击、模型并发调两次 ``submit_quiz``、
        判分与 ``/profile/events`` 交叉）时**后写的会覆盖先写的** ——
        ``attempts`` 只涨一次，不报错、不回滚，而返回值还与库里的值不一致
        （闯关解锁与推荐路径据此失真）。SQLite 3.35+ 支持 ``RETURNING``
        （本机 3.45.3），一条语句天然原子，不需要读-改-写。

        几个容易写错的点：

        - ``max()/min()`` 在 ``UPDATE SET`` 里是**标量**函数（两个参数就是标量语义，
          不会退化成聚合），所以钳位可以直接写在 SQL 里；
        - ``ON CONFLICT`` 分支里的 ``mastery.score`` 是**库里的当前值**（行级并发安全），
          不是调用方读到的旧值；
        - 冷启动那一行（``INSERT`` 分支）也要钳：直接写 ``delta`` 的话首次答对
          能一次跳到 1.0，限幅形同虚设。
        """
        clamped = max(-MASTERY_DELTA_LIMIT, min(MASTERY_DELTA_LIMIT, float(delta)))
        initial = max(0.0, min(1.0, clamped))
        row = self.conn.execute(
            "INSERT INTO mastery(kp_id, score, attempts, correct, last_seen_at) "
            "VALUES(:kp_id, :initial_score, 1, :hit, :now) "
            "ON CONFLICT(kp_id) DO UPDATE SET "
            "score = max(0.0, min(1.0, mastery.score + :delta)), "
            "attempts = mastery.attempts + 1, "
            "correct = mastery.correct + :hit, "
            "last_seen_at = :now "
            "RETURNING score",
            {
                "kp_id": kp_id,
                "initial_score": initial,
                "delta": clamped,
                "hit": 1 if correct else 0,
                "now": int(time.time()),
            },
        ).fetchone()
        self.conn.commit()
        if row is None:  # pragma: no cover - 有 INSERT .. RETURNING 就必有行
            return initial
        return float(row["score"])

    def mastery_map(self) -> dict[str, float]:
        """全部掌握度（``kp_id → score``）。

        推荐路径要「按掌握度排序」而不是只看「是否过阈值」，逐条 ``mastery()`` 会变成
        N 次查询；一次读全表更简单也更快（学生规模是「一台机器上的几个孩子」）。
        """
        rows = self.conn.execute("SELECT kp_id, score FROM mastery").fetchall()
        return {str(r["kp_id"]): float(r["score"] or 0.0) for r in rows}

    # ------------------------------------------------------------ 学习偏好 --
    def preferences(self) -> dict[str, str]:
        """读全部学习偏好（``profile_pref`` 的键值视图，供画像端点出参）。

        ★ **读只有一处实现**：``routes/profile.py`` 的 ``GET /profile`` 调这里，
          不再自己写 ``SELECT key, value FROM profile_pref`` —— 与 :meth:`set_preference`
          构成这一张表的唯一一对读写（两处各写一份 SQL 迟早会漂移）。
        """
        rows = self.conn.execute("SELECT key, value FROM profile_pref").fetchall()
        return {str(row["key"]): str(row["value"] or "") for row in rows}

    def set_preference(self, key: str, value: str) -> None:
        """写一条学习偏好（**幂等 upsert**：同 key 覆盖，不追加）。

        ``key`` 由调用方（契约的 ``PreferenceKey``）保证是封闭词表 —— 本方法**不再校验**，
        因为「校验只有一处」比「两处各校验一遍」更不容易漂移（与 ``students.py``
        的 ``validate_student_id`` 同一口径：入口校验，存储层只管写）。

        ★ 顺带一个结构性好处：``key`` 是主键 → 总行数天然 ≤ 词表大小（4），
          永远不需要清理逻辑，也没有「攒了几百条偏好把每轮 Prompt 挤爆」这条路径。
        """
        self.conn.execute(
            "INSERT INTO profile_pref(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(key), str(value)),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 闯关进度 --
    def progress_rows(self) -> list[ProgressRecord]:
        """读全部闯关进度（**按 kp_id 排序**，保证出参稳定可比对）。"""
        rows = self.conn.execute(
            "SELECT kp_id, stage, badge, updated_at FROM progress ORDER BY kp_id"
        ).fetchall()
        return [
            ProgressRecord(
                kp_id=str(r["kp_id"]),
                stage=str(r["stage"] or ""),
                badge=None if r["badge"] is None else str(r["badge"]),
                updated_at=None if r["updated_at"] is None else int(r["updated_at"]),
            )
            for r in rows
        ]

    def progress_map(self) -> dict[str, ProgressRecord]:
        """``kp_id → ProgressRecord``（缺行 = 这一关还没被初始化）。"""
        return {record.kp_id: record for record in self.progress_rows()}

    def upsert_progress(self, kp_id: str, *, stage: str, badge: str | None = None) -> None:
        """写/更新一关的进度。

        ★ ``badge`` 的合并语义很关键（防「徽章被后来的答错抹掉」）：
          - 传入 ``None`` → **保留库里已有的徽章**（``badge`` 列取 ``COALESCE(existing, NULL)``）；
          - 传入字符串 → 覆盖。
        徽章代表「曾经通关」，不该因为后来答错一次就消失；而重新通关时会给一个更好的徽章。
        """
        self.conn.execute(
            "INSERT INTO progress(kp_id, stage, badge, updated_at) VALUES(?,?,?,?) "
            "ON CONFLICT(kp_id) DO UPDATE SET stage=excluded.stage, "
            "badge=COALESCE(excluded.badge, progress.badge), "
            "updated_at=excluded.updated_at",
            (kp_id, stage, badge, int(time.time())),
        )
        self.conn.commit()

    def seed_progress(self, kp_ids: Sequence[str], *, stage: str = "locked") -> int:
        """给还没有进度行的知识点补默认行（**只插不覆盖**），返回新插了几行。

        冷启动用：新学生第一次打开练习时，`progress` 表是空的 —— 前端拿到空数组会显示
        「一关都没有」。这里按调用方给的**依赖图顺序**初始化默认路径，
        已有的行（学生真做过的）一个字都不动。
        """
        existing = set(self.progress_map())
        inserted = 0
        now = int(time.time())
        for kp_id in kp_ids:
            if not kp_id or kp_id in existing:
                continue
            self.conn.execute(
                "INSERT OR IGNORE INTO progress(kp_id, stage, badge, updated_at) VALUES(?,?,?,?)",
                (kp_id, stage, None, now),
            )
            existing.add(kp_id)
            inserted += 1
        if inserted:
            self.conn.commit()
        return inserted

    # ------------------------------------------------------------ 变式题仓库 --
    def ensure_quiz_tables(self) -> int:
        """确保 ``generated_question`` 存在，返回该迁移组的版本号。

        ★ **为什么不在 ``__init__`` 里建**（与 ``ensure_learning`` 的处理不同）：
          建表会在 ``schema_version`` 里多记一行 ``("quiz", 1)``，而「开了库就有哪几张表」
          是既有验收的断言口径（``tests/test_profile_routes.py`` 断言 ``schema_version``
          只有 ``("learning", 1)`` 这一条）。变式题只有练习轨真的用到时才存在，
          把建表推迟到**第一次读写生成题**，既拿到了 ``migrations.py`` 预留的独立迁移通道，
          又不动「只画像不练习」那条路径的既有事实。
        """
        if not self._quiz_ready:
            self.quiz_version = ensure_migrated(
                self.conn, QUIZ_MIGRATIONS, set_name=QUIZ_MIGRATION_SET
            )
            self._quiz_ready = True
        return self.quiz_version

    def save_generated_questions(self, records: Sequence[GeneratedQuestionRecord]) -> int:
        """落库一批 LLM 生成的变式题（同 ``qid`` 覆盖），返回写入条数。

        ★ 这是**答案进入 ``learning.db``** 的唯一入口，所以只接受
        :class:`GeneratedQuestionRecord`（已经是校验过的结构），不接受裸 dict ——
        裸 dict 会让「答案字段叫什么」变成一个到处猜的问题。
        """
        self.ensure_quiz_tables()
        for record in records:
            self.conn.execute(
                "INSERT INTO generated_question"
                "(qid, kp_id, grade_level, type, stem, options, reference_answer, explanation, rubric, source, created_at, student_id) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(qid) DO UPDATE SET kp_id=excluded.kp_id, grade_level=excluded.grade_level, "
                "type=excluded.type, stem=excluded.stem, options=excluded.options, "
                "reference_answer=excluded.reference_answer, explanation=excluded.explanation, "
                "rubric=excluded.rubric, source=excluded.source, created_at=excluded.created_at, "
                "student_id=excluded.student_id",
                (
                    record.qid,
                    record.kp_id,
                    record.grade_level,
                    record.type,
                    record.stem,
                    json.dumps(list(record.options), ensure_ascii=False)
                    if record.options is not None
                    else None,
                    json.dumps(record.reference_answer, ensure_ascii=False),
                    record.explanation,
                    record.rubric,
                    record.source,
                    int(record.created_at or time.time()),
                    record.student_id or None,
                ),
            )
        self.conn.commit()
        return len(records)

    def find_generated_question(self, qid: str) -> GeneratedQuestionRecord | None:
        """按 ``qid`` 查一条生成题（判分用；**返回的记录含标准答案**）。"""
        self.ensure_quiz_tables()
        row = self.conn.execute(
            "SELECT qid, kp_id, grade_level, type, stem, options, reference_answer, "
            "explanation, rubric, source, created_at, student_id FROM generated_question WHERE qid = ?",
            (qid,),
        ).fetchone()
        if row is None:
            return None
        return _generated_from_row(row)

    def generated_questions(
        self, *, kp_id: str | None = None, student_id: str | None = None
    ) -> list[GeneratedQuestionRecord]:
        """列生成题（可按知识点 / **学生**过滤）；**含标准答案**，只供 Python 侧使用。

        ★ ``student_id`` 是「我的题目」那条路的唯一入口（D-088）：给了它就只列**这个学生的**题
          （历史遗留的 `student_id IS NULL` 行不会被任何人认领）。
        ★★ 判分路径**不要**用这个过滤：`find_generated_question(qid)` 按 qid 直查 ——
          qid 本身就带随机段、不可能撞车，多一层学生过滤只会让「换学生会话后判分 404」。
        """
        self.ensure_quiz_tables()
        sql = (
            "SELECT qid, kp_id, grade_level, type, stem, options, reference_answer, "
            "explanation, rubric, source, created_at, student_id FROM generated_question"
        )
        where: list[str] = []
        params: list[object] = []
        if kp_id:
            where.append("kp_id = ?")
            params.append(kp_id)
        if student_id:
            where.append("student_id = ?")
            params.append(student_id)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at, qid"
        return [_generated_from_row(row) for row in self.conn.execute(sql, tuple(params))]

    # ------------------------------------------------------------ 学生动画库 --
    # ------------------------------------------------- 生成编程题（学生级） --
    def ensure_code_tables(self) -> int:
        """确保 ``generated_code_template`` 存在，返回该迁移组的版本号。

        ★ 与 :meth:`ensure_quiz_tables` / :meth:`ensure_animation_tables` 同一条做法：
          独立 ``set_name``（``"code"``）—— 不搅动既有验收口径。
        """
        if not self._code_ready:
            self.code_version = ensure_migrated(
                self.conn, CODE_MIGRATIONS, set_name=CODE_MIGRATION_SET
            )
            self._code_ready = True
        return self.code_version

    def save_generated_code_template(self, record: GeneratedCodeTemplateRecord) -> str:
        """落库一条生成编程题（同 ``saved_id`` 覆盖），返回 ``saved_id``。

        ★ 复用键（学生 + 知识点 + 学段 + 指纹）上有 UNIQUE 索引；调用方先按它查、命中就直接复用
          （见 :meth:`find_generated_code_by_key`），所以这里只负责按 id 写入 / 覆盖。
        """
        self.ensure_code_tables()
        self.conn.execute(
            "INSERT INTO generated_code_template"
            "(saved_id, student_id, kp_id, grade_level, title, expected_behavior, scaffold, "
            "expected_output, hints, solution, prompt_hash, created_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(saved_id) DO UPDATE SET student_id=excluded.student_id, "
            "kp_id=excluded.kp_id, grade_level=excluded.grade_level, title=excluded.title, "
            "expected_behavior=excluded.expected_behavior, scaffold=excluded.scaffold, "
            "expected_output=excluded.expected_output, hints=excluded.hints, "
            "solution=excluded.solution, prompt_hash=excluded.prompt_hash, "
            "created_at=excluded.created_at",
            (
                record.saved_id,
                record.student_id,
                record.kp_id,
                record.grade_level,
                record.title,
                record.expected_behavior,
                record.scaffold,
                record.expected_output,
                json.dumps(list(record.hints), ensure_ascii=False),
                record.solution,
                record.prompt_hash,
                int(record.created_at or time.time()),
            ),
        )
        self.conn.commit()
        return record.saved_id

    def find_generated_code_template(
        self, saved_id: str, *, student_id: str | None = None
    ) -> GeneratedCodeTemplateRecord | None:
        """按 ``saved_id`` 取一条；给了 ``student_id`` 就只在这个学生名下找。**含 hints/solution**。"""
        self.ensure_code_tables()
        sql = (
            "SELECT saved_id, student_id, kp_id, grade_level, title, expected_behavior, scaffold, "
            "expected_output, hints, solution, prompt_hash, created_at "
            "FROM generated_code_template WHERE saved_id = ?"
        )
        params: tuple[object, ...] = (saved_id,)
        if student_id:
            sql += " AND student_id = ?"
            params = (saved_id, student_id)
        row = self.conn.execute(sql, params).fetchone()
        return None if row is None else _generated_code_from_row(row)

    def generated_code_templates(
        self, *, student_id: str, kp_id: str | None = None
    ) -> list[GeneratedCodeTemplateRecord]:
        """列某学生的生成编程题（可按知识点过滤）；**含 hints/solution**，只供 Python 侧使用。"""
        self.ensure_code_tables()
        sql = (
            "SELECT saved_id, student_id, kp_id, grade_level, title, expected_behavior, scaffold, "
            "expected_output, hints, solution, prompt_hash, created_at "
            "FROM generated_code_template WHERE student_id = ?"
        )
        params: list[object] = [student_id]
        if kp_id:
            sql += " AND kp_id = ?"
            params.append(kp_id)
        sql += " ORDER BY created_at, saved_id"
        return [_generated_code_from_row(row) for row in self.conn.execute(sql, tuple(params))]

    def find_generated_code_by_key(
        self, *, student_id: str, kp_id: str, grade_level: str, prompt_hash: str
    ) -> GeneratedCodeTemplateRecord | None:
        """按**复用键**取一条（同学生 + 同知识点 + 同学段 + 同指纹）—— 命中就直接复用。"""
        self.ensure_code_tables()
        row = self.conn.execute(
            "SELECT saved_id, student_id, kp_id, grade_level, title, expected_behavior, scaffold, "
            "expected_output, hints, solution, prompt_hash, created_at "
            "FROM generated_code_template WHERE student_id = ? AND kp_id = ? AND grade_level = ? "
            "AND prompt_hash = ? LIMIT 1",
            (student_id, kp_id, grade_level, prompt_hash),
        ).fetchone()
        return None if row is None else _generated_code_from_row(row)

    def ensure_animation_tables(self) -> int:
        """确保 ``saved_animation`` 存在，返回该迁移组的版本号。

        ★ 与 :meth:`ensure_quiz_tables` **同一条理由与做法**（这里只差一个 set_name）：
          建表会在 ``schema_version`` 里多记一行 ``("animation", 1)``，而
          「新学生的 ``schema_version`` 恰为 learning 1..4」是既有验收的断言口径
          （``tests/test_profile_routes.py`` / ``tests/test_chapter_selection.py``）。
          动画库只有真被用到时才建，因此那两条断言对「只画像不存动画」的路径逐字不变。

        ★ 它**不改 learning 组**：新增表一律走 ``set_name="animation"`` 这条并行通道
          （``migrations.py`` 预留），learning 组的版本号留给画像/学段那些轨。
        """
        if not self._animation_ready:
            self.animation_version = ensure_migrated(
                self.conn, ANIMATION_MIGRATIONS, set_name=ANIMATION_MIGRATION_SET
            )
            self._animation_ready = True
        return self.animation_version

    def save_animation(
        self,
        *,
        saved_id: str,
        kp_id: str,
        grade_level: str,
        concept: str,
        prompt_hash: str,
        title: str,
        duration_ms: int,
        html_path: str,
        fallback_text: str,
        fallback_image: str | None = None,
    ) -> SavedAnimationRecord:
        """保住一条动画（**复用键冲突时覆盖那一条**，不追加第二行）。

        ★ 为什么冲突就覆盖：复用键是 ``(kp_id, grade_level, prompt_hash)``，
          同一个学生、同一个知识点、同一个学段、同一句提问 —— 那是**同一件事**。
          追加会让「再问一次」每次多一条几乎相同的记录，动画库越用越乱；
          覆盖则让「重新生成」自然地更新那一份（``id`` 换成新的，旧 HTML 文件由路由层
          在调用本方法之后删掉 —— 库里以新 id 为准，不会有两条指向同一个文件）。

        ★ 冲突目标是 :data:`_ANIMATION_V1` 里那个 **UNIQUE** 索引，所以它是「复用键本身」，
          不是一条顺手加的普通索引（普通索引做不了 ``ON CONFLICT`` 的目标）。
        """
        self.ensure_animation_tables()
        self.conn.execute(
            "INSERT INTO saved_animation"
            "(id, kp_id, grade_level, concept, prompt_hash, title, duration_ms, html_path, "
            " fallback_text, fallback_image, created_at, uses) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,0) "
            "ON CONFLICT(kp_id, grade_level, prompt_hash) DO UPDATE SET "
            "id=excluded.id, concept=excluded.concept, title=excluded.title, "
            "duration_ms=excluded.duration_ms, html_path=excluded.html_path, "
            "fallback_text=excluded.fallback_text, fallback_image=excluded.fallback_image, "
            "created_at=excluded.created_at",
            (
                saved_id,
                kp_id,
                grade_level,
                concept,
                prompt_hash,
                title,
                int(duration_ms),
                html_path,
                fallback_text,
                fallback_image or None,
                int(time.time()),
            ),
        )
        self.conn.commit()
        got = self.get_animation(saved_id)
        assert got is not None
        return got

    def get_animation(self, saved_id: str) -> SavedAnimationRecord | None:
        """按 id 取一条（**不带学生维度**：学生维度的隔离由路由层用库文件归属保证）。"""
        self.ensure_animation_tables()
        row = self.conn.execute(
            "SELECT id, kp_id, grade_level, concept, prompt_hash, title, duration_ms, "
            "html_path, fallback_text, fallback_image, created_at, uses "
            "FROM saved_animation WHERE id = ?",
            (saved_id,),
        ).fetchone()
        return None if row is None else _saved_animation_from_row(row)

    def find_animation(
        self, *, kp_id: str, grade_level: str, prompt_hash: str
    ) -> SavedAnimationRecord | None:
        """按**复用键**取一条（不含学生维：学生维由库文件归属承担）。

        学段是键的一部分，所以「小学低存的那份」与「初中问的同一件事」**必然不命中**。
        """
        self.ensure_animation_tables()
        row = self.conn.execute(
            "SELECT id, kp_id, grade_level, concept, prompt_hash, title, duration_ms, "
            "html_path, fallback_text, fallback_image, created_at, uses "
            "FROM saved_animation WHERE kp_id = ? AND grade_level = ? AND prompt_hash = ?",
            (kp_id, grade_level, prompt_hash),
        ).fetchone()
        return None if row is None else _saved_animation_from_row(row)

    def list_animations(
        self, *, kp_id: str | None = None, grade_level: str | None = None
    ) -> list[SavedAnimationRecord]:
        """列该学生的动画库（**按创建时间倒序**，最新的在前）。

        ★ 倒序**显式写在 SQL 里**（不靠调用方 reverse）：`created_at` 是**秒**，
          同一秒内保存的两条光看时间分不出先后，所以再按 ``id`` 兜一层 ——
          否则「刚存的那条排第二」这种偏差会随保存速度随机出现。
        """
        self.ensure_animation_tables()
        sql = (
            "SELECT id, kp_id, grade_level, concept, prompt_hash, title, duration_ms, "
            "html_path, fallback_text, fallback_image, created_at, uses FROM saved_animation"
        )
        params: list[object] = []
        if kp_id:
            sql += " WHERE kp_id = ?"
            params.append(kp_id)
            if grade_level:
                sql += " AND grade_level = ?"
                params.append(grade_level)
        elif grade_level:
            sql += " WHERE grade_level = ?"
            params.append(grade_level)
        sql += " ORDER BY created_at DESC, id DESC"
        return [_saved_animation_from_row(row) for row in self.conn.execute(sql, tuple(params))]

    def touch_animation_use(self, saved_id: str) -> None:
        """复用它一次（``uses`` 自增 1）。**自增下推到 SQL**：不做「读出来加一再写回」。"""
        self.ensure_animation_tables()
        self.conn.execute(
            "UPDATE saved_animation SET uses = uses + 1 WHERE id = ?", (saved_id,)
        )
        self.conn.commit()

    def delete_animation(self, saved_id: str) -> bool:
        """删一条（返回是否真的删掉了）。

        ★ 学生维度由**库文件归属**承担（每条路由都先开这个学生的库），所以这里按 id 删
          天然只可能删到自己的 —— 别人的记录在别人的文件里，这条路根本看不见它。
        """
        self.ensure_animation_tables()
        cursor = self.conn.execute("DELETE FROM saved_animation WHERE id = ?", (saved_id,))
        self.conn.commit()
        return cursor.rowcount > 0

    # ------------------------------------------------------------ 学习记录 --
    def add_history(
        self,
        *,
        kp_id: str,
        activity: str,
        session_id: str = "",
        question: str = "",
        is_correct: bool | None = None,
        detail: str = "",
    ) -> None:
        """写一条学习记录（``session_id`` 关联 Pi JSONL 会话；**不写对话正文**）。"""
        self.conn.execute(
            "INSERT INTO learning_history(ts, session_id, kp_id, activity, question, is_correct, detail) "
            "VALUES(?,?,?,?,?,?,?)",
            (
                int(time.time()),
                session_id,
                kp_id,
                activity,
                question,
                None if is_correct is None else (1 if is_correct else 0),
                detail,
            ),
        )
        self.conn.commit()

    def add_grade_signal(
        self, *, signal_type: str, value: float, raw: str = "", session_id: str = ""
    ) -> None:
        """写一条学段信号（自动推断的原料）。

        ⚠️ 这里**只落信号**，不做任何判定：学段的唯一写路径是 ``app/grade/rules.py``
        的规则引擎 —— 达到阈值时它把新学段**自动生效**并写
        ``grade_history(source="inferred")``。学生端没有选择器、也没有确认动作
        （D-020 翻转；旧的「只写建议、改学段须学生确认」口径已废止）。
        """
        self.conn.execute(
            "INSERT INTO grade_signals(ts, session_id, signal_type, value, raw) VALUES(?,?,?,?,?)",
            (int(time.time()), session_id, signal_type, float(value), raw),
        )
        self.conn.commit()

    # ------------------------------------------------------------ 学习记录读 --
    # ★ 四个读原语（判分幂等 / 学习档案：错题本 / 学习报告）与 :meth:`add_history`
    #   构成 ``learning_history`` 这一张表唯一的读写对 —— 路由层不再自己拼 SQL，
    #   两处各写一份 ``SELECT`` 迟早会在「要不要过滤 activity」这类地方分叉。
    #
    # ⚠️ 「读全部学习记录」的原语（``history_rows``）当时**刻意没加**：零引用的读原语
    #   就是零测试覆盖的死代码（实测：给它注入「``is_correct`` 的 NULL 与 False
    #   混为一谈」这种回归，全部测试依然绿，因为根本没走到）。
    # ★★ 2026-09-30 **调用方来了**（学习档案 → 学习历史分页，见 :meth:`history_page`）——
    #   于是按当时的约定「等真的有调用方时再加」补上，并把当初用来论证「不加」的
    #   那条 NULL/False 回归**钉成断言**（现在它有调用方了，必须被测试覆盖）。
    #   ⚠️ 加的是**分页**读原语（不是「读全部」）：学生的历史会长到几千条，
    #   一次读全表只为了显示前 30 条，是拿内存换一个没人在乎的完整性。
    def history_page(self, *, limit: int, offset: int) -> list[HistoryRecord]:
        """读一页学习记录（**按时间倒序**，最新的在前）—— 「学习历史」分页的原料。

        ★ 只取**结构化列**：``question``（恒空）与 ``detail``（内部 JSON）**不读出来**。
        ★ 排序 ``ts DESC, id DESC``：``ts`` 是**秒**，同一秒内的多条（一轮里连做几道题、
          判分与解锁写两行）靠自增 ``id`` 定先后 —— 少了它翻页会出现重复 / 丢失。
        """
        rows = self.conn.execute(
            "SELECT id, ts, kp_id, activity, is_correct FROM learning_history "
            "ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?",
            (max(0, int(limit)), max(0, int(offset))),
        ).fetchall()
        out: list[HistoryRecord] = []
        for row in rows:
            raw_correct = row["is_correct"]
            out.append(
                HistoryRecord(
                    id=int(row["id"]),
                    ts=int(row["ts"] or 0),
                    kp_id=str(row["kp_id"] or ""),
                    activity=str(row["activity"] or ""),
                    # ★★ NULL → None（这条没有对错），0 → False（答错了）。
                    #    混为一谈的后果是界面上「答错了」与「没判分」长得一模一样 ——
                    #    这正是当初不加这条读原语的理由，现在是断言（见上）。
                    is_correct=None if raw_correct is None else bool(int(raw_correct)),
                )
            )
        return out

    def history_count(self) -> int:
        """该生学习记录的总条数（分页用；与 :meth:`history_page` 读同一张表）。"""
        row = self.conn.execute("SELECT COUNT(*) AS n FROM learning_history").fetchone()
        return int(row["n"] or 0) if row is not None else 0

    def question_attempt(self, qid: str) -> AttemptRecord | None:
        """**这道题答过没有**：返回 ``detail.qid == qid`` 的最近一次作答，没有则 ``None``。

        用途是**判分幂等**：同一题被重复提交时（前端双击、模型并发调两次
        ``submit_quiz``）要能认出「这一题已经有记录」，而不是再记一次掌握度。

        - **只认 ``activity == 'quiz'`` 的行**（与 :meth:`mistakes` 的过滤口径一致）：
          ``qa`` / ``coding`` / ``animation`` 轨的记录里没有题目概念，
          它们的 ``detail`` 里就算凑巧有 qid 也不能算「做过这道题」。
        - 判据是 ``detail`` 里的 qid，取自 :func:`_qid_from_detail`
          —— ``detail`` 是 ``routes/quiz.py`` 的 ``_record_attempt`` 写的 JSON 串，
          **不另写一份 JSON 解析**（两处解析迟早对「格式坏了怎么办」给出不同答案）。
        - 「最近一条」按 ``ts DESC, id DESC``：与 :meth:`mistakes` /
          :meth:`grade_history` 的既有取法一致；同一秒内的多条靠自增 ``id`` 分先后
          （``ts`` 是**秒**，同一秒里的两次提交光看时间分不出来）。

        ★★ **为什么先按 ``learning_history`` 取最近 N 行、再在内存里比对 qid**
          （而不是 ``WHERE detail LIKE '%qid%'`` 或加索引）：

          1. ``qid`` **不是一个列**，它藏在 ``detail`` 的 JSON 字符串里 ——
             现有表结构下按它过滤**无索引可用**，SQL 层做不了等值查询；
             ``LIKE '%...%'`` 既走不了索引又会被子串误命中
             （``q-1`` 会匹配到 ``q-12``），而且要依赖 JSON 的书写格式。
          2. 加真实的索引 / 把 ``qid`` 提成列都要动 ``migrations.py`` 的**已发布迁移**
             —— 那是本模块明令的边界（见表头「不动 migrations.py」的口径），
             代价远大于收益：学生规模是「一台机器上的几个孩子」，
             ``learning_history`` 是每人的小表，**有界扫描（``_ATTEMPT_SCAN_LIMIT`` 行）
             完全够用**，且这条路径只走一次 PK 顺序扫描 + 若干次 JSON 解析。
          3. ``ORDER BY ts DESC, id DESC LIMIT N`` 拿到的**就是最近的那批行**，
             所以「最近一次作答」只要它落在窗口内就一定能找到（同一题的两次提交
             在时间上相邻）；即使窗口被更近的其它题占满而失手，退回 ``None``
             也只是「按没答过处理」，不会给出**错误的**结论。

          ⚠️ 调用方通常还知道 ``kp_id``（判分时手上就有），但本方法**不加 kp_id 参数**：
             ``detail`` 里只有 qid、没有 kp_id，让调用方多传一个只用于「顺手缩窄扫描」
             的参数会把「这道题答过没」的定义绑到调用方传参的正确性上。
             ``idx_history_kp`` 因此在本查询上帮不上忙 —— **不为此新增迁移**。
        """
        rows = self.conn.execute(
            "SELECT kp_id, ts, is_correct, detail FROM learning_history "
            "WHERE activity = 'quiz' ORDER BY ts DESC, id DESC LIMIT ?",
            (int(_ATTEMPT_SCAN_LIMIT),),
        ).fetchall()
        for row in rows:
            if _qid_from_detail(str(row["detail"] or "")) != qid:
                continue
            correct = row["is_correct"]
            return AttemptRecord(
                qid=str(qid),
                kp_id=str(row["kp_id"] or ""),
                is_correct=None if correct is None else bool(int(correct)),
                ts=int(row["ts"] or 0),
            )
        return None

    def mistakes(self, *, limit: int | None = 50) -> list[MistakeRecord]:
        """**错题聚合**：``is_correct = 0`` 的记录按 ``kp_id`` 分组。

        ★ 只取 ``is_correct = 0``：``is_correct IS NULL`` 的行是「没有对错概念」的活动
          （qa / animation / 生成题等），把它们算成错题会让错题本里冒出一堆学生没做错的题。
        ★ **不 join ``generated_question``**：那张表带 ``reference_answer``（标准答案）。
          完整题干换不来什么（``question`` 的前 120 字足够认出是这道题），
          却会把一条「带答案的表」接进对外响应 —— 收益小、风险大（§6.3 答案泄漏防护）。
        ★ ``blank_count`` 显式统计「答错了但没有题干」的次数（qa / coding 轨），
          调用方据此提示「还有 N 次答错没有题目记录」，而不是让学生觉得记录少了。

        ★ ``limit=None`` → **全量返回**（不做切片）：错题本里的「累计答错 N 次」
          是**求和**得出的，在**截断之后**求和只会偏小 —— 学生练过头 50 个知识点
          以后，界面上那个数字就不再涨了。默认仍是 50（既有调用方行为逐字不变），
          要统计全量的调用方显式传 ``None``。

        ★ 边界语义**保持不变**：``limit=0`` / 负数仍走 ``max(1, ...)`` → 至少 1 条
          （这是个历史口径，不是笔误 —— 顺手改成「0 就返回空」会静默改变既有调用方的行为）。
        """
        rows = self.conn.execute(
            "SELECT kp_id, activity, question, ts, detail FROM learning_history "
            "WHERE is_correct = 0 ORDER BY ts DESC, id DESC"
        ).fetchall()

        grouped: dict[str, dict[str, object]] = {}
        for row in rows:
            kp_id = str(row["kp_id"] or "")
            if not kp_id:
                # kp_id 为空 = 这条记录没关联知识点（例如 qa 轨未识别出知识点）：
                # 错题本按知识点聚合，无归属的行无处可放，跳过。
                continue
            entry = grouped.setdefault(
                kp_id,
                {"wrong": 0, "blank": 0, "last_ts": 0, "stem": "", "qid": "", "stem_ts": -1},
            )
            entry["wrong"] = int(entry["wrong"]) + 1  # type: ignore[arg-type]
            ts = int(row["ts"] or 0)
            if ts > int(entry["last_ts"]):  # type: ignore[arg-type]
                entry["last_ts"] = ts
            stem = str(row["question"] or "")
            if stem:
                # 「最近一次**有题干**的错题」与「最近一次答错」是两件事：
                # 之后又错了一道没题干的，不该把已有的题干抹掉。
                if ts >= int(entry["stem_ts"]):  # type: ignore[arg-type]
                    entry["stem"] = stem
                    entry["stem_ts"] = ts
                    entry["qid"] = _qid_from_detail(str(row["detail"] or ""))
            else:
                entry["blank"] = int(entry["blank"]) + 1  # type: ignore[arg-type]

        records = [
            MistakeRecord(
                kp_id=kp_id,
                wrong_count=int(data["wrong"]),  # type: ignore[arg-type]
                blank_count=int(data["blank"]),  # type: ignore[arg-type]
                last_wrong_at=int(data["last_ts"]),  # type: ignore[arg-type]
                stem=str(data["stem"]),
                last_qid=str(data["qid"]),
            )
            for kp_id, data in grouped.items()
        ]
        # ★ 排序显式钉死（错得多的在前，平局按 kp_id）：依赖 SQL 行序的话，
        #   「同错 2 次」的两个知识点顺序会随插入顺序漂 —— 前端列表会莫名跳动。
        records.sort(key=lambda item: (-item.wrong_count, item.kp_id))
        if limit is None:
            # 全量：**不切片**（统计口径要的是「一共错了多少次」，截断会让和偏小）。
            # ⚠️ 这里不能沿用 `records[: max(1, limit)]` —— 那个写法对 None 会抛
            # ``TypeError: '>' not supported between instances of 'int' and 'NoneType'``
            # （``max(1, None)`` 直接比较就炸），所以先分流再切。
            return records
        return records[: max(1, int(limit))]

    def daily_activity(self, *, since: int, tz_offset_seconds: int = 0) -> list[DayActivity]:
        """按**本地日期**聚合活动量（``since`` 是 **Unix 秒**下限，含边界）。

        ★ ``tz_offset_seconds`` 由调用方给（本机时区偏移）：SQLite 的
          ``date(ts, 'unixepoch')`` 默认按 **UTC** 切天，晚上八点以后的活动会被算到第二天，
          「连续学习 N 天」就断了。用 ``date(ts, 'unixepoch', '+08:00')`` 这种修饰符
          让切天发生在本地零点。
        """
        modifier = f"{int(tz_offset_seconds) // 3600:+03d}:00"
        rows = self.conn.execute(
            "SELECT date(ts, 'unixepoch', ?) AS day, COUNT(*) AS n, "
            "  SUM(CASE WHEN activity = 'quiz' THEN 1 ELSE 0 END) AS quiz_n, "
            "  SUM(CASE WHEN activity = 'quiz' AND is_correct = 1 THEN 1 ELSE 0 END) AS correct_n "
            "FROM learning_history WHERE ts >= ? "
            "GROUP BY day ORDER BY day",
            (modifier, int(since)),
        ).fetchall()
        return [
            DayActivity(
                day=str(row["day"]),
                count=int(row["n"] or 0),
                quiz_count=int(row["quiz_n"] or 0),
                correct_count=int(row["correct_n"] or 0),
            )
            for row in rows
            if row["day"]
        ]

    def activity_days(self, *, tz_offset_seconds: int = 0) -> list[str]:
        """全部**有活动的本地日期**（去重、升序）。

        打卡（连续学习天数）要的是**全量**而不是时间窗 —— 只看最近七天的话，
        一个坚持了三十天的学生会被算成「连续 7 天」。
        """
        modifier = f"{int(tz_offset_seconds) // 3600:+03d}:00"
        rows = self.conn.execute(
            "SELECT DISTINCT date(ts, 'unixepoch', ?) AS day FROM learning_history "
            "WHERE ts IS NOT NULL ORDER BY day",
            (modifier,),
        ).fetchall()
        return [str(row["day"]) for row in rows if row["day"]]

    def badges(self) -> list[str]:
        """已获得的徽章（去重、按字典序）。

        ★ 徽章是「曾经通关」的事实，``upsert_progress`` 用 ``COALESCE`` 保证它不被后续答错抹掉
          （见那个方法的注释）—— 这里只负责把它们取出来。
        """
        rows = self.conn.execute(
            "SELECT DISTINCT badge FROM progress WHERE badge IS NOT NULL AND badge <> '' ORDER BY badge"
        ).fetchall()
        return [str(row["badge"]) for row in rows]

    def grade_history(self, *, limit: int = 200) -> list[GradeHistoryRecord]:
        """读 ``grade_history`` 轨迹（**按时间正序**，最早的在前）。

        ★ 正序：报告要讲的是「**怎么变成现在这个学段**」这条线，
          倒序读出来还得让每个调用方自己 reverse 一遍。
        ★ 与 ``app/grade/rules.py`` 的 ``GradeEngine.history()`` 是两个用途：
          那个是**引擎自己**判冷却/连轮用的（限量、倒序读再翻正）；
          这个给报告用（只读、正序）。两者都只读，**不构成两套状态推导**。
        """
        rows = self.conn.execute(
            "SELECT id, ts, turn, from_level, to_level, source, decided_by, confidence "
            "FROM grade_history ORDER BY id DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [
            GradeHistoryRecord(
                id=int(row["id"]),
                ts=int(row["ts"] or 0),
                turn=int(row["turn"] or 0),
                from_level=None if row["from_level"] is None else str(row["from_level"]),
                to_level=str(row["to_level"] or ""),
                source=str(row["source"] or ""),
                decided_by=None if row["decided_by"] is None else str(row["decided_by"]),
                confidence=float(row["confidence"] or 0.0),
            )
            for row in reversed(rows)
        ]

    def close(self) -> None:
        self.conn.close()


def _identity_from_row(row: sqlite3.Row) -> IdentityRecord:
    """identity_local 行 → 记录（列全是标量；class 列映射成 class_name）。"""
    return IdentityRecord(
        anon_student_id=str(row["anon_student_id"]),
        real_name=str(row["real_name"] or ""),
        real_grade=str(row["real_grade"] or ""),
        school=str(row["school"] or ""),
        class_name=str(row["class"] or ""),
        parent_consent=bool(int(row["parent_consent"] or 0)),
        memory_switch=bool(int(row["memory_switch"] or 0)),
        onboarding_state=str(row["onboarding_state"] or ONBOARDING_STATE_NOT_STARTED),
    )


def _qid_from_detail(detail: str) -> str:
    """从 ``learning_history.detail`` 的 JSON 里取题号（取不到就返回空串）。

    ``detail`` 由 ``routes/quiz.py`` 的 ``_record_attempt`` 写成
    ``{"qid": ..., "type": ..., "masteryDelta": ...}``。这里**宽松解析**：
    它是一列辅助信息，格式坏了不该让错题本整体 500（与 ``_generated_from_row``
    对 ``options`` 的处理同一口径）。
    """
    if not detail:
        return ""
    try:
        parsed = json.loads(detail)
    except json.JSONDecodeError:
        return ""
    if not isinstance(parsed, dict):
        return ""
    qid = parsed.get("qid")
    return "" if qid is None else str(qid)


def _generated_from_row(row: sqlite3.Row) -> GeneratedQuestionRecord:
    """``generated_question`` 行 → 记录（JSON 列的**宽松解析**）。"""
    options_raw = row["options"]
    options: tuple[str, ...] | None = None
    if options_raw:
        try:
            parsed = json.loads(str(options_raw))
        except json.JSONDecodeError:  # pragma: no cover - 只有人工改坏库才会到这里
            logger.warning("生成题的 options 不是合法 JSON，已按「无选项」处理：%s", row["qid"])
            parsed = None
        if isinstance(parsed, list):
            options = tuple(str(item) for item in parsed)

    try:
        reference: Any = json.loads(str(row["reference_answer"]))
    except json.JSONDecodeError:  # pragma: no cover - 同上
        logger.warning("生成题的 reference_answer 不是合法 JSON，按原样文本处理：%s", row["qid"])
        reference = str(row["reference_answer"])

    return GeneratedQuestionRecord(
        qid=str(row["qid"]),
        kp_id=str(row["kp_id"]),
        grade_level=str(row["grade_level"]),
        type=str(row["type"]),
        stem=str(row["stem"]),
        options=options,
        reference_answer=reference,
        explanation=str(row["explanation"] or ""),
        rubric=(str(row["rubric"]) if row["rubric"] else None),
        source=str(row["source"] or "generated"),
        created_at=None if row["created_at"] is None else int(row["created_at"]),
        # 这一列是 v3 迁移才加的：老行取不到就当「无归属」（不会被任何学生认领）
        student_id=(
            str(row["student_id"]) if "student_id" in row.keys() and row["student_id"] else ""
        ),
    )


def _generated_code_from_row(row: sqlite3.Row) -> GeneratedCodeTemplateRecord:
    """``generated_code_template`` 行 → 记录（``hints`` 是 JSON 列，**宽松解析**）。"""
    hints: tuple[dict[str, object], ...] = ()
    raw = row["hints"]
    if raw:
        try:
            parsed = json.loads(str(raw))
        except json.JSONDecodeError:  # pragma: no cover - 只有人工改坏库才会到这里
            logger.warning("生成编程题的 hints 不是合法 JSON，已按「无提示」处理：%s", row["saved_id"])
            parsed = None
        if isinstance(parsed, list):
            hints = tuple(item for item in parsed if isinstance(item, dict))
    return GeneratedCodeTemplateRecord(
        saved_id=str(row["saved_id"]),
        student_id=str(row["student_id"]),
        kp_id=str(row["kp_id"]),
        grade_level=str(row["grade_level"]),
        title=str(row["title"]),
        expected_behavior=str(row["expected_behavior"]),
        scaffold=str(row["scaffold"]),
        expected_output=str(row["expected_output"]),
        hints=hints,
        solution=str(row["solution"] or ""),
        prompt_hash=str(row["prompt_hash"]),
        created_at=None if row["created_at"] is None else int(row["created_at"]),
    )


def _saved_animation_from_row(row: sqlite3.Row) -> SavedAnimationRecord:
    """``saved_animation`` 行 → 记录（列全是标量，无需宽松解析）。"""
    image = row["fallback_image"]
    return SavedAnimationRecord(
        id=str(row["id"]),
        kp_id=str(row["kp_id"]),
        grade_level=str(row["grade_level"]),
        concept=str(row["concept"]),
        prompt_hash=str(row["prompt_hash"]),
        title=str(row["title"] or ""),
        duration_ms=int(row["duration_ms"] or 0),
        html_path=str(row["html_path"]),
        fallback_text=str(row["fallback_text"] or ""),
        fallback_image=None if image is None or not str(image) else str(image),
        created_at=int(row["created_at"] or 0),
        uses=int(row["uses"] or 0),
    )


__all__ = [
    "ALLOWED_TAG_KEYS",
    "ALLOWED_TAG_KEY_SET",
    "ANIMATION_MIGRATIONS",
    "ANIMATION_MIGRATION_SET",
    "AttemptRecord",
    "EMOTION_VALUES",
    "EPHEMERAL_TAGS",
    "GeneratedQuestionRecord",
    "HistoryRecord",
    "IDENTITY_LOCAL_FIELDS",
    "INFERRED_ALLOWED_TAG_KEYS",
    "IdentityRecord",
    "JOIN_KEY",
    "LEARNER_STYLE_VALUES",
    "LearningStore",
    "MASTERY_DELTA_LIMIT",
    "OBSERVED_ERROR_TYPES",
    "ONBOARDING_STATES",
    "OnboardingAnswerRecord",
    "PERSONALITY_VALUES",
    "ProfileTagHistoryRecord",
    "ProfileTagRecord",
    "ProgressRecord",
    "QUIZ_MIGRATIONS",
    "QUIZ_MIGRATION_SET",
    "SAFETY_LEVELS",
    "SavedAnimationRecord",
    "StudentRecord",
    "TAG_ORIGINS",
    "new_saved_animation_id",
]
