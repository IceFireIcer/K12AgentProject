"""★ 契约唯一来源（pydantic）。**只在本文件手写模型，不要散落别处。**

防漂移链路（执行文档 §6.1）：

    server/app/contracts.py          ← 唯一手写处（本文件）
      → FastAPI 自动产出 /openapi.json
      → scripts/export_openapi.py 落 desktop/src/shared/openapi.json（--check 做字节比对）
      → desktop/scripts/gen-api-types.mjs（openapi-typescript）生成 shared/api-types.ts
      → npm run typecheck 报错即代表契约漂移

**为什么坚持 pydantic 唯一来源**：手写一份 TS 接口就等于放弃上面这条链——
两边各自演进，靠人眼核对，防漂移机制作废。生成物（`openapi.json` / `api-types.ts`）
一律不许手改，改了 `--check` 会红。

本文件包含（票 04 冻结）：

- 四学段、6 事件词表、各类冻结字面量（`GradeLevel` / `IpcEventName` / …）；
- 设置：`LlmConfig` / `LlmConfigIn` / `SettingsResponse` / `SettingsUpdateRequest`，
  **含 API Key 掩码语义**（读回恒为掩码，占位值不覆盖已存 Key，清除必须显式；
  Key 不出现在 `repr()` 里）；
- 学生与画像：`Student` / `Mastery` / `StudentProfile`；
- 检索与图：`Citation` / `RagSearchRequest` / `RagSearchResult` / `DepNode`；
- 学段信号：`GradeSignal` / `GradeSignals`；
- 六个 Extension 的 payload（§6.5）：`AnimationPayload` / `CodeTemplate` / `CodingHint` /
  `CodeError` / `CodeEvaluation` / `QuizQuestion`(内部) / `QuizQuestionOut`(对外) /
  `QuizPayload` / `QuizResult`。

**不定义** `Intent` 字面量（路由由 LLM 选 Tool 自然产生，不是代码级字段）；
**不引入** `ModuleResult<T>` / `ModuleError` 那套 `{success, error}` 包装
（失败统一走 `error` 事件带 `degraded`，否则前端要处理两套失败形态）。

所有契约模型登记在 `CONTRACT_MODELS`（导出脚本据此补齐 OpenAPI 里 FastAPI 看不到的模型）；
`INTERNAL_MODELS` 是**只在 Python 侧存在、绝不导出**的模型（答案防泄漏）。
`tests/test_contracts.py` 断言「本模块里每个 `CamelModel` 子类都被登记」——
新增模型忘了登记会立刻红，而不是悄悄缺席 OpenAPI。
"""

from __future__ import annotations

from typing import Literal, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic.alias_generators import to_camel

# ---------------------------------------------------------------------------
# 四学段（赛题硬要求，不要增删）
# ---------------------------------------------------------------------------
GradeLevel = Literal["primary_low", "primary_high", "junior", "senior"]

# ---------------------------------------------------------------------------
# ★ 6 事件词表（**冻结**）
#
# 与 desktop/src/shared/ipc-events.ts 必须一字不差；架构守卫测试会比对两边。
# 传输层是 IPC（不是 SSE），词表沿用不变。
# **改动词表需同步前端与守卫**（ipc-events.ts + desktop/tests/architecture-guards.test.ts
# + server/tests/test_baseline.py），任何一处不同步都会立刻红。
# ---------------------------------------------------------------------------
IPC_EVENT_NAMES: tuple[str, ...] = ("delta", "citation", "payload", "blocked", "done", "error")
IpcEventName = Literal["delta", "citation", "payload", "blocked", "done", "error"]

# ---------------------------------------------------------------------------
# 其余冻结字面量（都是「改一处就得改前端」的值集合，集中在此）
# ---------------------------------------------------------------------------
#: 嵌入配置三选一（§6.2）。
EmbeddingMode = Literal["local_fastembed", "cloud_api", "none"]

#: `payload` 事件的三种 `kind`（§9.3 的 Tool 名映射冻结在一起）。
PayloadKind = Literal["animation", "coding", "quiz"]

#: 检索降级链的四个档位（§8.5）：vector → cloud → fts → outline。
Degraded = Literal["vector", "cloud", "fts", "outline"]

#: 学习记录的活动类型（§8.3 `learning_history.activity`）。
LearningActivity = Literal["qa", "animation", "coding", "quiz"]

#: 闯关进度阶段（§8.3 `progress.stage`）。
ProgressStage = Literal["locked", "learning", "quizzed", "mastered"]

#: 题型：第一期只做这三种（拖拽排序 / 连线匹配属 P1）。
QuizQuestionType = Literal["choice", "blank", "code_blank"]

#: 依赖关系类型（§8.3 `knowledge_dependencies.relation`）。
DepRelation = Literal["prerequisite", "related"]

#: 依赖查询方向：`from` 是前置、`to` 是后继（全项目一致，方向搞反是静默错）。
#: 取值与 `app/knowledge/deps.py` 的用法逐字一致（`prerequisite` 不缩写，避免两套写法）。
DepDirection = Literal["successor", "prerequisite"]

#: 学段判定信号四类（§10.2）。
GradeSignalType = Literal["vocab", "depth", "quiz_perf", "meta_cognition"]

#: 掌握度单次变化限幅（陷阱：不限幅则一次答题就从 0 到 1）。
MASTERY_DELTA_LIMIT = 0.2

# ---------------------------------------------------------------------------
# 设置默认值（§6.2 的 BaseURL 规范化约定）
#
# 默认填 `https://api.deepseek.com/v1`（OpenAI 兼容习惯）；
# Pi 内置 DeepSeek provider 用的是 `https://api.deepseek.com`（**无 /v1**），
# 两种形式都要能连通 —— 所以这里**不自动补 /v1**，只在保存/探测时如实回显结果（票 07）。
# 默认值只是「设置页初始值」，**不得写死供应商**：四项必须可改（赛题硬要求）。
# ---------------------------------------------------------------------------
DEFAULT_LLM_PROVIDER_NAME = "DeepSeek"
DEFAULT_LLM_BASE_URL = "https://api.deepseek.com/v1"
DEFAULT_LLM_MODEL_ID = "deepseek-chat"
DEFAULT_EMBEDDING_MODEL_ID = "BAAI/bge-small-zh-v1.5"

# ---------------------------------------------------------------------------
# API Key 掩码语义（票 07 硬要求）
#
# 规则（读与写各一条，缺一不可）：
#   ① 读（出参）：永远只回掩码 `…abcd` + `hasKey`，**绝不回明文**；
#   ② 写（入参）：提交「空串 / 掩码 / 纯符号占位」= **保留原值**（用户没动这一栏时
#      不得把 `…abcd` 写回磁盘，那会把真 Key 抹掉）；只有显式 `clearKey=true`
#      才能删除，或用明文覆盖。
# ---------------------------------------------------------------------------
API_KEY_MASK_PREFIX = "…"  # U+2026，单字符；与前端显示一致
API_KEY_MASK_TAIL_LEN = 4  # 掩码保留的后缀长度
API_KEY_MASK_MIN_LEN = 8  # 短于这个长度不保留后缀（否则掩码约等于明文）
API_KEY_SYMBOL_PLACEHOLDERS = {"*", "•", ".", "·"}


def mask_api_key(key: str | None) -> str:
    """把明文 Key 转成掩码（``""`` → ``""``，表示未配置）。

    >>> mask_api_key("sk-1234567890abcd")
    '…abcd'
    """
    if not key:
        return ""
    tail = key[-API_KEY_MASK_TAIL_LEN:] if len(key) >= API_KEY_MASK_MIN_LEN else ""
    return f"{API_KEY_MASK_PREFIX}{tail}"


def is_api_key_placeholder(value: str | None) -> bool:
    """提交值是否「未修改」的占位（空串 / 掩码 / 纯符号）。

    占位一律解释为**保留已存的 Key**，不是「把 Key 设成这串字符」。
    """
    if value is None:
        return True
    stripped = value.strip()
    if not stripped:
        return True
    if stripped.startswith(API_KEY_MASK_PREFIX):
        return True
    # 前端可能用纯符号当占位（****** / ••••••），一律视为「未修改」
    return set(stripped) <= API_KEY_SYMBOL_PLACEHOLDERS


def resolve_api_key(submitted: str | None, stored: str, *, clear: bool = False) -> str:
    """把「请求里提交的 Key 字段」解析成**应当保存的明文**。

    这是掩码语义的唯一落点 —— 路由与存储都调它，不要各自实现一遍。
    """
    if clear:
        return ""
    if is_api_key_placeholder(submitted):
        return stored
    return str(submitted).strip()


def normalize_base_url(value: str) -> str:
    """BaseURL 规范化：去首尾空白、去尾部斜杠。

    **不自动补 `/v1`**：`https://api.deepseek.com` 与 `https://api.deepseek.com/v1`
    两种形式都能连通，自动改写会让「默认值能跑、用户改一下就连不上」（§6.2）。
    """
    return value.strip().rstrip("/")


# ---------------------------------------------------------------------------
# 基类
# ---------------------------------------------------------------------------
class CamelModel(BaseModel):
    """所有出参/入参模型的基类。

    - Python 侧写 ``snake_case``，出参自动转 ``camelCase``（前端统一 camelCase）。
      **只做一次约定，两边不要混用。**
    - ``extra="forbid"``：契约外字段直接 422 —— 这是防止「临时加个松散字段」的硬闸门。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


# ---------------------------------------------------------------------------
# 系统
# ---------------------------------------------------------------------------
class HealthResponse(CamelModel):
    """``GET /health`` 响应（执行文档 §6.3）。

    免鉴权，Electron 启动期轮询它判断 sidecar 是否可用。
    ``embedder_ready`` 为假**不代表 sidecar 不健康** —— 模型缺失时应用仍应能起来，
    只是检索会走降级链。
    """

    status: str
    version: str
    embedder_ready: bool


# ---------------------------------------------------------------------------
# 设置（§6.2 / §6.3）
# ---------------------------------------------------------------------------
class LlmConfig(CamelModel):
    """LLM 配置的**出参形态**（发给渲染进程 / 与磁盘一致的只读视图）。

    ⚠️ ``api_key`` 在这里**恒为掩码**（``…abcd``）或空串，绝不会是明文；
    需要明文的地方只有存储层，用 {@link LlmConfigIn} 提交。
    **请一律经 :meth:`from_plain` 构造**，别手拼 ``api_key=`` 把明文漏出去。
    """

    provider_name: str = DEFAULT_LLM_PROVIDER_NAME
    base_url: str = DEFAULT_LLM_BASE_URL
    #: 掩码（``…abcd``）；空串 = 未配置。**不是明文**。
    api_key: str = Field(default="", repr=False)
    has_key: bool = False
    model_id: str = DEFAULT_LLM_MODEL_ID

    @classmethod
    def from_plain(
        cls,
        *,
        provider_name: str = DEFAULT_LLM_PROVIDER_NAME,
        base_url: str = DEFAULT_LLM_BASE_URL,
        api_key: str = "",
        model_id: str = DEFAULT_LLM_MODEL_ID,
    ) -> "LlmConfig":
        """由明文配置构造出参：明文**只**经由这里变成掩码。"""
        return cls(
            provider_name=provider_name,
            base_url=base_url,
            api_key=mask_api_key(api_key),
            has_key=bool(api_key),
            model_id=model_id,
        )


class LlmConfigIn(CamelModel):
    """LLM 配置的**入参形态**（``PUT /api/settings``）。

    ``api_key`` 语义见模块头的「API Key 掩码语义」：
    空串/掩码/纯符号 = 保留已存值；明文 = 覆盖；``clear_api_key=true`` = 显式删除。
    """

    provider_name: str = DEFAULT_LLM_PROVIDER_NAME
    base_url: str = DEFAULT_LLM_BASE_URL
    #: ⚠️ 明文只在这里出现。``repr=False`` —— **Key 绝不出现在 repr()/str()/日志里**。
    api_key: str = Field(default="", repr=False)
    model_id: str = DEFAULT_LLM_MODEL_ID
    #: 显式清除已存 Key 的唯一方式（只有它能让 Key 变成空）。
    clear_api_key: bool = False
    #: **只作出参回显，入参忽略**：设置页会把 `GET` 读到的整个对象改完再提交回来，
    #: 其中就包含 `hasKey`。Key 的去留只由 ``api_key`` 与 ``clear_api_key`` 决定 ——
    #: 收到 `hasKey=false` 也**不会**删 Key（否则「读→改→写回」会静默抹掉凭据）。
    has_key: bool | None = None

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, value: str) -> str:
        return normalize_base_url(value)

    @model_validator(mode="after")
    def _reject_conflicting_clear(self) -> "LlmConfigIn":
        if self.clear_api_key and not is_api_key_placeholder(self.api_key):
            raise ValueError(
                "clear_api_key=true 时不得同时提交明文 api_key（清除与覆盖语义冲突）"
            )
        return self


class EmbeddingConfig(CamelModel):
    """嵌入配置的**出参形态**（§6.2）。``mode="none"`` 表示不用嵌入（检索走 FTS5 兜底）。"""

    mode: EmbeddingMode = "local_fastembed"
    base_url: str | None = None
    #: 掩码或空串（同 :class:`LlmConfig`），**不是明文**。
    api_key: str = Field(default="", repr=False)
    has_key: bool = False
    model_id: str | None = None

    @classmethod
    def from_plain(
        cls,
        *,
        mode: EmbeddingMode = "local_fastembed",
        base_url: str | None = None,
        api_key: str = "",
        model_id: str | None = None,
    ) -> "EmbeddingConfig":
        return cls(
            mode=mode,
            base_url=base_url,
            api_key=mask_api_key(api_key),
            has_key=bool(api_key),
            model_id=model_id,
        )


class EmbeddingConfigIn(CamelModel):
    """嵌入配置的**入参形态**（``mode="cloud_api"`` 时才有 base_url/api_key/model_id）。"""

    mode: EmbeddingMode = "local_fastembed"
    base_url: str | None = None
    #: ⚠️ 明文只在这里出现（``repr=False``）。
    api_key: str = Field(default="", repr=False)
    model_id: str | None = None
    clear_api_key: bool = False
    #: 同 :class:`LlmConfigIn`：只作出参回显，入参忽略。
    has_key: bool | None = None

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, value: str | None) -> str | None:
        return None if value is None else normalize_base_url(value)

    @model_validator(mode="after")
    def _reject_conflicting_clear(self) -> "EmbeddingConfigIn":
        if self.clear_api_key and not is_api_key_placeholder(self.api_key):
            raise ValueError(
                "clear_api_key=true 时不得同时提交明文 api_key（清除与覆盖语义冲突）"
            )
        return self


class SettingsResponse(CamelModel):
    """``GET`` / ``PUT /api/settings`` 的响应（§6.3）。**任何情况下都不含明文 Key。**"""

    llm: LlmConfig
    embedding: EmbeddingConfig


class SettingsUpdateRequest(CamelModel):
    """``PUT /api/settings`` 的请求体。

    两栏都可省略（``null`` = 不动那一栏）—— 设置页可以分栏保存；
    但**不能两栏都不给**（那样这次请求没有任何意义）。
    """

    llm: LlmConfigIn | None = None
    embedding: EmbeddingConfigIn | None = None

    @model_validator(mode="after")
    def _require_at_least_one_section(self) -> "SettingsUpdateRequest":
        if self.llm is None and self.embedding is None:
            raise ValueError("llm 与 embedding 至少要提交一栏")
        return self


class ProbeRequest(CamelModel):
    """``POST /api/settings/probe`` 的请求体（**票 07 实现探测**）。

    探测的是**提交的候选配置**而非已存配置，这样「先探测、满意再保存」才成立。
    ``api_key`` 允许是占位（== 用已存 Key）——实现方用 :func:`resolve_api_key` 解析。
    """

    llm: LlmConfigIn


class ProbeResult(CamelModel):
    """``POST /api/settings/probe`` 的响应（§6.3）。

    ``message`` 必须**可读**：401 / 超时 / DNS / 404 要说清是哪一种（票 07）。
    """

    ok: bool
    message: str


# ---------------------------------------------------------------------------
# 学生与画像（§8.3 `student` / `mastery` / `profile_pref`）
# ---------------------------------------------------------------------------
class Student(CamelModel):
    """一名学生。**一人一库**（``students/<student_id>/learning.db``），不跨学生复用连接。"""

    student_id: str
    nickname: str
    grade_level: GradeLevel
    #: Unix 毫秒（与 JS ``Date.now()`` 同尺度，避免前端再做单位换算）
    created_at: int
    last_active_at: int


class StudentCreateRequest(CamelModel):
    """``POST /api/students``：新建学生（含学段，学段也可后改）。``student_id`` 由服务端生成。"""

    #: 显示用昵称（**不采集真实姓名**：K12 数据最小化，见 §12）
    nickname: str = Field(min_length=1, max_length=32)
    #: 冷启动默认学段（§10.1）。**前端不参与学段决定**：没有选择器，请求也不带学段
    grade_level: GradeLevel

    @field_validator("nickname")
    @classmethod
    def _strip_nickname(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("昵称不能为空白")
        return stripped


class Mastery(CamelModel):
    """单知识点掌握度（§8.3 `mastery`）。``score`` 0..1。"""

    kp_id: str
    score: float = Field(default=0.0, ge=0.0, le=1.0)
    attempts: int = 0
    correct: int = 0
    last_seen_at: int | None = None


class StudentProfile(CamelModel):
    """``GET /api/profile/{student_id}``：画像与掌握度（§6.3）。

    ``recommended_kp_ids`` 由依赖图 + 掌握度算出（§8.6 用途一，票 12/20 填充）——
    **推荐必须来自依赖图**，不是随机取或按顺序取下一个。
    """

    student: Student
    mastery: list[Mastery] = Field(default_factory=list)
    #: `profile_pref` 的键值视图（偏好 / 节奏 / 易错点缓存）
    preferences: dict[str, str] = Field(default_factory=dict)
    recommended_kp_ids: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 检索与引用（§6.3 / §6.4 / §8.5）
# ---------------------------------------------------------------------------
class Citation(CamelModel):
    """检索命中的引用条目（§6.4 的 `citation` 事件载荷，**字段与顺序冻结**）。

    ``compat``：是否为「向上兼容」取用的更高学段内容 —— 跨学段时必须显式标注，
    前端要据此显示标记（执行文档 §6.3 / 业务陷阱清单 §2）。

    ⚠️ **只有这 5 个字段**：事件载荷「一字不改」是票 13 的验收口径。
    检索内部还需要父块正文、相关性、知识点 id 等 —— 那些在 :class:`RagHit` 里，
    发射 `citation` 事件时**从 hit 投影出这 5 个字段**，不要把 hit 直接塞进事件。
    """

    chunk_id: str
    chapter_title: str
    section_title: str
    grade_level: GradeLevel
    compat: bool


class RagHit(Citation):
    """检索命中的**完整记录**（HTTP 层，供 `rag_search` Tool 注入上下文与轨迹图）。

    在 :class:`Citation` 的 5 个冻结字段之上补齐内部字段。父块正文在这里
    （父子 chunk：小子块检索、命中回父块作上下文，§8.3），不要塞进 `Citation`。
    """

    #: 命中子块所属父块（``None`` = 命中的就是父块/独立块）
    parent_chunk_id: str | None = None
    #: ★ 父块完整内容（注入 LLM 的上下文，不是碎片）
    text: str = ""
    #: 人类可读的知识点名（由 kp 表解析）
    knowledge_point: str = ""
    #: 知识点 id（画像/依赖图对齐用）
    kp_id: str = ""
    #: 相关性 0..1，越大越相关
    score: float = 0.0
    #: 本次检索落在降级链的哪一级（整批同值；供轨迹图展示）
    degraded: Degraded = "vector"
    #: true = 依赖图补充的前置知识点（非直接命中，§8.6 用途二）
    expanded: bool = False


class RagSearchRequest(CamelModel):
    """``POST /api/rag/search`` 的请求体（供 Pi 的 `rag_search` Tool 调用）。

    ``grade_level`` 是**必填**：学段过滤写在 SQL 层，模型改不了 WHERE（AGENTS §5.2）。
    """

    query: str
    grade_level: GradeLevel
    top_k: int = Field(default=5, ge=1, le=20)
    #: 允许向上兼容（命中更高学段内容时 `Citation.compat=true`）
    allow_compat: bool = True
    #: 是否把依赖图里的前置知识点补进上下文（§8.6 用途二，有数量上限，不得挤满 top-k）
    include_expansion: bool = True


class RagSearchResult(CamelModel):
    """``POST /api/rag/search`` 的响应。

    降级链整条在 Python 侧一次调用内完成（§8.5）：调用方只读 ``degraded``，
    **不要**在编排层再实现一遍降级逻辑。
    """

    #: 命中列表（**不是**事件载荷的 `citations`；事件那一份由发射方投影 5 字段）
    hits: list[RagHit] = Field(default_factory=list)
    #: 命中的父块上下文（可直接注入 LLM 的拼接文本）
    context: str = ""
    #: 本次检索落在降级链的哪一级
    degraded: Degraded = "vector"


class DepNode(CamelModel):
    """依赖图查询结果条目（``GET /api/graph/deps/{kp_id}``）。

    **`from → to` 语义全项目一致：`from` 是前置、`to` 是后继。**
    ``direction`` 显式标明这条边相对被查询知识点是哪一侧，双用途据此分流：
    ``successor`` 用于推荐路径，``prereq`` 用于检索上下文扩展。
    """

    kp_id: str
    name: str
    grade_level: GradeLevel
    relation: DepRelation = "prerequisite"
    direction: DepDirection
    weight: float = 1.0
    #: 距被查询知识点的跳数（递归 CTE 的 depth，用于排序与截断）
    depth: int = 1


# ---------------------------------------------------------------------------
# 学段信号（§10.2 / §10.3）
# ---------------------------------------------------------------------------
class GradeSignal(CamelModel):
    """一条学段判定信号（§8.3 `grade_signals`）。"""

    signal_type: GradeSignalType
    value: float
    raw: str | None = None
    ts: int | None = None


class GradeSignals(CamelModel):
    """``GET /api/grade/signals/{student_id}``：学段信号与推断建议。

    ⚠️ **自动推断只写「建议」，不直接改**（AGENTS §5.1）：``suggested_level`` 供前端弹
    达到阈值时**自动生效**并写 `grade_history(source="inferred")`；
    学生端只读展示当前学段，**没有选择器、没有确认动作**（§10.3）。
    """

    student_id: str
    #: 当前**生效**的学段（由推断引擎写入；无历史时是冷启动默认值）
    current_level: GradeLevel
    #: 当前学段来源。**只有 inferred 一种**：学段完全由系统推断，
    #: `explicit` / `confirmed` 随手动选择入口一起废止（D-020）。
    source: Literal["inferred"] = "inferred"
    #: 推断建议（``None`` = 无建议；置信度 < 0.6 不调整，§10.3）
    suggested_level: GradeLevel | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    signals: list[GradeSignal] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# 六个 Extension 的 payload（§6.5）
#
# ⚠️ 这些 payload **不新增第二套错误语义**：失败一律走 `error` 事件（带 `degraded`），
#    不要引入 `ModuleResult<T>` / `ModuleError` 那套 `{success, error}` 包装。
# ---------------------------------------------------------------------------
class AnimationPayload(CamelModel):
    """动画讲解载荷（§11.2：**模板优先**，自由生成只是补充路径）。"""

    concept: str
    #: 完整自包含 HTML（内联 Anime.js 调用，**不引 CDN**——沙箱断网会白屏）
    html: str
    duration_ms: int
    #: 生成/校验失败时的降级文字讲解
    fallback_text: str
    #: 静态图（SVG dataURL），比纯文字更好但同样不依赖网络
    fallback_image: str | None = None
    #: template = 命中内置模板（首选）；generated = 自由生成（补充路径）
    source: Literal["template", "generated"]


class CodeTemplate(CamelModel):
    """编程模板载荷（§11.3 / 票 19）。``scaffold`` 必须含明确的 TODO 标记。"""

    kp_id: str
    language: Literal["python"] = "python"
    #: 预置代码框架（含 TODO 标记）
    scaffold: str
    #: 填完 TODO 后应当表现出的行为（面向学生，中文）
    expected_behavior: str


class CodingHint(CamelModel):
    """分级提示（票 19：**不许直接给答案**，level 1 指方向 → level 3 才贴近骨架）。"""

    level: Literal[1, 2, 3]
    hint: str


class CodeError(CamelModel):
    """归一化后的代码错误（面向学生）。原始 traceback 保留供家长/教师导出与排查。"""

    #: 归一化错误类（IndentationError / NameError / TypeError / IndexError …）
    type: str
    #: 面向学生的中文解释（票 19：至少覆盖缩进/未定义名/类型/越界四类）
    message: str
    raw_traceback: str = ""
    line: int | None = None


class CodeEvaluation(CamelModel):
    """``POST /api/code/run-hint`` 的响应：运行结果 + 评估 + 下一级提示（§6.3）。"""

    ok: bool
    stdout: str
    error: CodeError | None = None
    #: 面向学生的中文反馈
    feedback: str
    next_hint: CodingHint | None = None


class CodeRunRequest(CamelModel):
    """``POST /api/code/run-hint`` 的请求体：把「提交的代码 + 报错」交给后端评估。

    ⚠️ 学生代码**绝不在主进程（Pi Extension）执行**：它在渲染进程的 Pyodide Worker 里跑，
    这里收到的只是运行结果与 traceback（AGENTS §5.7）。
    """

    student_id: str
    kp_id: str
    code: str
    language: Literal["python"] = "python"
    stdout: str = ""
    #: Pyodide 的原始 traceback（可为空 = 运行成功）
    stderr: str = ""
    #: 同一知识点下的第几次尝试（分级提示与「连续失败 3 次主动介入」的依据）
    attempt: int = Field(default=1, ge=1)


class QuizQuestion(CamelModel):
    """★★ **内部模型**：含标准答案，**只在 Python 侧存在**（题库与判分用）。

    **绝不发给前端、绝不导出到 OpenAPI/TS**（见 `INTERNAL_MODELS`）。
    对外一律用 :class:`QuizQuestionOut`，**不要**靠 pydantic 的 ``exclude=True``
    临时裁剪 —— 那是最容易漏掉一处的地方（§6.3 答案泄漏防护）。
    """

    qid: str
    kp_id: str
    type: QuizQuestionType
    stem: str
    options: list[str] | None = None
    answer: str | list[str]
    explanation: str


class QuizQuestionOut(CamelModel):
    """★ **对外模型**：没有 ``answer``，发给 TS 与前端（§6.3 答案泄漏防护）。

    判分所需的标准答案只留在 Python 侧：``POST /api/quiz/grade`` 按 ``qid`` 查库判分，
    前端与 TS 都不需要答案。
    """

    qid: str
    kp_id: str
    type: QuizQuestionType
    stem: str
    options: list[str] | None = None
    explanation: str

    @classmethod
    def from_internal(cls, question: QuizQuestion) -> "QuizQuestionOut":
        """内部题 → 对外题的**唯一**转换入口（``answer`` 在这里被丢弃）。

        逐字段显式列出，**不用** ``model_dump(exclude=...)``：漏一个字段会立刻被
        ``extra="forbid"`` 与类型检查打死，而不是静默泄漏。
        """
        return cls(
            qid=question.qid,
            kp_id=question.kp_id,
            type=question.type,
            stem=question.stem,
            options=question.options,
            explanation=question.explanation,
        )


class QuizPayload(CamelModel):
    """出题载荷。``questions`` **一律是对外形态**，内部模型塞不进来（会被类型校验挡住）。"""

    kp_id: str
    questions: list[QuizQuestionOut] = Field(default_factory=list)
    source: Literal["bank", "generated"]

    @classmethod
    def from_internal(
        cls,
        *,
        kp_id: str,
        source: Literal["bank", "generated"],
        questions: Sequence[QuizQuestion],
    ) -> "QuizPayload":
        """由内部题库构造对外载荷（**唯一**推荐路径：先转 Out，再打包）。"""
        return cls(
            kp_id=kp_id,
            source=source,
            questions=[QuizQuestionOut.from_internal(question) for question in questions],
        )


class QuizGradeRequest(CamelModel):
    """``POST /api/quiz/grade`` 的请求体：提交答案并批改（判分只走后端）。"""

    student_id: str
    qid: str
    #: 选择题为单个选项文本；填空/代码填空可为多个空
    answer: str | list[str]
    #: 关联 Pi JSONL 会话（写 `learning_history.session_id` 用）
    session_id: str | None = None


class QuizResult(CamelModel):
    """批改结果（§6.5）。``scored_by`` 区分客观题规则判分与主观题 LLM 判分。"""

    qid: str
    correct: bool
    scored_by: Literal["rule", "llm"]
    #: 面向学生的中文反馈
    feedback: str
    #: 掌握度变化，**限幅 ±0.2**（陷阱：不限幅则一次答题就从 0 到 1）
    mastery_delta: float = Field(ge=-MASTERY_DELTA_LIMIT, le=MASTERY_DELTA_LIMIT)


class ChatRequest(CamelModel):
    """一轮对话请求（**渲染进程 → 主进程 IPC**，不是 HTTP 端点）。

    §6.3 v2 变更：``POST /api/chat/stream`` 已从 Python 侧移除，对话改由主进程的
    Pi Agent 处理；这里冻结的是 IPC 入参形状，供票 05/06 的主进程处理器与前端共用。
    ``requestId`` 由**主进程**生成并贯穿一轮（§9.4），所以不在请求体里。
    """

    student_id: str
    #: **学段不由这里决定**（§10.1）：请求不带学段，推断引擎是唯一写路径
    grade_level: GradeLevel
    text: str
    #: 关联 Pi 会话（省略 = 用当前会话）
    session_id: str | None = None


# ---------------------------------------------------------------------------
# 登记表（导出脚本与测试的唯一依据，**新增模型必须登记**）
# ---------------------------------------------------------------------------
#: 需要出现在 OpenAPI / TS 生成物里的模型。
CONTRACT_MODELS: tuple[type[BaseModel], ...] = (
    # 系统
    HealthResponse,
    # 设置
    LlmConfig,
    LlmConfigIn,
    EmbeddingConfig,
    EmbeddingConfigIn,
    SettingsResponse,
    SettingsUpdateRequest,
    ProbeRequest,
    ProbeResult,
    # 学生与画像
    Student,
    StudentCreateRequest,
    Mastery,
    StudentProfile,
    # 检索与引用
    Citation,
    RagHit,
    RagSearchRequest,
    RagSearchResult,
    DepNode,
    # 学段信号
    GradeSignal,
    GradeSignals,
    # 六个 Extension 的 payload
    AnimationPayload,
    CodeTemplate,
    CodingHint,
    CodeError,
    CodeEvaluation,
    CodeRunRequest,
    QuizQuestionOut,
    QuizPayload,
    QuizGradeRequest,
    QuizResult,
    ChatRequest,
)

#: ★★ **只在 Python 侧存在的模型：绝不导出到 OpenAPI / TS。**
#:
#: `QuizQuestion` 带标准答案；把它生成进 `api-types.ts` 就等于给前端一份「可泄漏的答案类型」，
#: 迟早有人顺手把它渲染出来。它仍然是 `CamelModel` 子类（同一套命名/校验规则），
#: 因此本模块的登记测试要求它出现在 `CONTRACT_MODELS` 或 `INTERNAL_MODELS` 里 —— 二选一，
#: 不许「哪都不在」（那样它会静默缺席 OpenAPI，或静默泄漏答案）。
INTERNAL_MODELS: tuple[type[BaseModel], ...] = (QuizQuestion,)

#: 非 BaseModel 的冻结字面量：路由/TS 需要具名联合类型时登记在此，
#: 导出脚本用 ``TypeAdapter`` 把它们补进 ``components.schemas``。
#: 键 = OpenAPI 里的 schema 名（也是 TS 里的类型名）。
CONTRACT_ENUMS: dict[str, object] = {
    "GradeLevel": GradeLevel,
    "IpcEventName": IpcEventName,
    "EmbeddingMode": EmbeddingMode,
    "PayloadKind": PayloadKind,
    "Degraded": Degraded,
    "LearningActivity": LearningActivity,
    "ProgressStage": ProgressStage,
    "QuizQuestionType": QuizQuestionType,
}
