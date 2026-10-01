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
- 学生与画像：`Student` / `StudentCreateRequest` / `StudentUpdateRequest` /
  `StudentDeleteResult` / `Mastery` / `StudentProfile` / `PreferenceUpdateRequest`
  （学习偏好的**唯一写入口径**：封闭键词表 `PreferenceKey` + ≤ 40 字单行值）；
- 检索与图：`Citation` / `RagSearchRequest` / `RagSearchResult` / `DepNode`；
- 学段信号：`GradeSignal` / `GradeSignals` / `GradeOverrideRequest` / `GradeOverrideResponse`；
- 六个 Extension 的 payload（§6.5）：`AnimationPayload` / `CodeTemplate` / `CodingHint` /
  `CodeError` / `CodeEvaluation` / `QuizQuestion`(内部) / `QuizQuestionOut`(对外) /
  `QuizPayload` / `QuizResult`；
- 学生动画库（`AnimationSaveRequest` / `AnimationSavedItem` / `AnimationSavedView` /
  `AnimationSavedListResponse` / `AnimationSavedLookupRequest`）：生成物**按学生存下来**、
  **按学段隔离**、可复用可删除。★ 表里只有请求指纹（`promptHash`），**不收学生原话**。

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
# 四学段（需求硬性要求，不要增删）
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

#: 学段判定信号（§10.2）。★ 2026-09-21（D-065）起是**三路**：词汇 / 深度 / 元认知，
#: 「答题表现」已整体移除（概念错位 + 与元认知重复计数，见 ``app/grade/signals.py``）。
#:
#: ⚠️ **``quiz_perf`` 这个取值刻意保留在联合类型里**：它已经不是任何提取器的输出，
#: 但**历史 ``learning.db`` 里存着**这类行，而 ``recent_signals()`` 会把库里的
#: ``signal_type`` 原样灌进 :class:`GradeSignal` —— 从联合类型里删掉它，
#: 会让「读一个升级前建立的库」直接校验失败（500）。
#: 所以删除信号 ≠ 删除取值：**库里的历史取值要留着能被读出来**。
GradeSignalType = Literal["vocab", "depth", "quiz_perf", "meta_cognition"]

#: ★ 允许写入的学习偏好键（**固定词表，不接受自由键**），对应 ``profile_pref.key``。
#: 为什么必须是封闭集合：``profile_pref`` 的 ``key`` 是主键 → 总条数天然 ≤ 4，
#: **不需要任何清理逻辑**；更重要的是「写掌握度」在类型层面就不可能
#: —— 掌握度是判分规则算出来的客观量，一旦模型能写，就会出现
#: 「模型觉得学生懂了就改分」的漏洞（D-020 那类多写路径的教训）。
PreferenceKey = Literal["interest", "explain_style", "pace", "note"]

#: 掌握度单次变化限幅（陷阱：不限幅则一次答题就从 0 到 1）。
MASTERY_DELTA_LIMIT = 0.2

#: 学习偏好值的长度上限（``profile_pref.value``）。
#: ★ 40 字是**上限而不是建议**：偏好值会按 ``key=value`` 拼进**每一轮** Prompt，
#:   一段长文会稳定挤掉真正相关的教材上下文（与画像里掌握度截断同一条纪律）。
PREFERENCE_VALUE_MAX_CHARS = 40

#: 章标题长度上限（``student.current_chapter`` / ``ChapterUpdateRequest.chapter_title``）。
#: ★ 与桌面端 ``study/chapter.ts`` 的 ``readChapterTitle`` 的 80 **同一个数**：
#:   学生当前章节会作为**软偏好**拼进每一轮 System Prompt（画像块），
#:   所以它同样是「上限而不是建议」—— 一段长文会稳定挤掉教材上下文。
CHAPTER_TITLE_MAX_CHARS = 80

# ---------------------------------------------------------------------------
# 设置默认值（§6.2 的 BaseURL 规范化约定）
#
# ★ 默认值**必须与 Pi 内置 provider 目录一字不差**，否则首轮对话直接抛
#   「Pi 里找不到模型」：
#     - `provider_id` = Pi 内置 provider 的 id（预设清单里的键，见
#       `desktop/src/main/agent/pi-bootstrap.ts` 的 `builtinCatalog()`）；
#     - `base_url`    = Pi 内置 DeepSeek provider 的 baseUrl，**无 /v1**；
#     - `model_id`    = Pi 内置 deepseek 目录里**真实存在**的模型。
#   ⚠️ 历史上这三项分别是 `DeepSeek` / `https://api.deepseek.com/v1` / `deepseek-chat`，
#   后两者在 Pi 目录里都**不存在**（Pi 的 deepseek 只有 `deepseek-v4-flash` /
#   `deepseek-v4-flash-vision-exp` / `deepseek-v4-pro`）—— 实测踩到过。
#
# `provider_id` 与 `provider_name` 的分工（不要合并）：
#   - `provider_id`   进 Pi：决定用哪一份 provider 定义（认证方式 / 模型目录 / 协议）；
#   - `provider_name` **只用于显示与排查**，填什么都行。
#   自定义网关（需求要求「不写死供应商」）用 `provider_id="custom"` 这类自己的 id。
#
# 仍然**不自动补 /v1**：`https://api.deepseek.com` 与 `https://api.deepseek.com/v1`
# 两种形式都可能连通，静默改写会重新制造「默认值能跑、用户改一下就连不上」（票 07 / D-022）。
# ---------------------------------------------------------------------------
DEFAULT_LLM_PROVIDER_ID = "deepseek"
DEFAULT_LLM_PROVIDER_NAME = "DeepSeek"
DEFAULT_LLM_BASE_URL = "https://api.deepseek.com"
DEFAULT_LLM_MODEL_ID = "deepseek-v4-flash"
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

    #: ★ Pi 的 provider id（预设清单里的键）：决定用哪一份 provider 定义。
    #: 与 ``provider_name``（纯显示）**分工不同，不要合并** —— 见模块顶部的默认值注释。
    provider_id: str = DEFAULT_LLM_PROVIDER_ID
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
        provider_id: str = DEFAULT_LLM_PROVIDER_ID,
        provider_name: str = DEFAULT_LLM_PROVIDER_NAME,
        base_url: str = DEFAULT_LLM_BASE_URL,
        api_key: str = "",
        model_id: str = DEFAULT_LLM_MODEL_ID,
    ) -> "LlmConfig":
        """由明文配置构造出参：明文**只**经由这里变成掩码。"""
        return cls(
            provider_id=provider_id,
            provider_name=provider_name,
            base_url=base_url,
            api_key=mask_api_key(api_key),
            has_key=bool(api_key),
            model_id=model_id,
        )


class LlmConfigIn(CamelModel):
    """LLM 配置的**入参形态**（``PUT /api/settings``）。

    ★ **字段级「省略即保留」**：除 ``api_key`` 外每个字段都是 ``X | None = None``，
    **没提交**（或提交空白）就保留已存值，只有真提交了非空值才覆盖。
    ⚠️ 这里**不许再出现出厂默认值**：`PUT {"llm": {"apiKey": "…"}}` 这种字段级局部提交
    （设置页分栏保存 / 只换 Key）若被当成「未提交字段取默认值」，就会把用户自填的
    校内网关静默换回 DeepSeek 默认值 —— 改一次 Key 丢一次配置。

    ``api_key`` 语义见模块头的「API Key 掩码语义」：
    空串/掩码/纯符号 = 保留已存值；明文 = 覆盖；``clear_api_key=true`` = 显式删除。
    """

    #: ★ **占位即保留**（``None``/空串 = 不改已存的 provider id），与嵌入那栏同一条规则：
    #: 否则「只改 BaseURL 的局部 PUT」会把 provider 静默重置回默认值。
    provider_id: str | None = None
    #: 只用于显示；省略/空白 = 保留现值（**不回落** ``DEFAULT_LLM_PROVIDER_NAME``）。
    provider_name: str | None = None
    #: 省略 = 保留现值；提交了就照提交的用（**不自动补 `/v1`**，只做规范化）。
    base_url: str | None = None
    #: ⚠️ 明文只在这里出现。``repr=False`` —— **Key 绝不出现在 repr()/str()/日志里**。
    api_key: str = Field(default="", repr=False)
    #: 省略/空白 = 保留现值（空 ModelID 调不通，不允许被静默清空）。
    model_id: str | None = None
    #: 显式清除已存 Key 的唯一方式（只有它能让 Key 变成空）。
    clear_api_key: bool = False
    #: **只作出参回显，入参忽略**：设置页会把 `GET` 读到的整个对象改完再提交回来，
    #: 其中就包含 `hasKey`。Key 的去留只由 ``api_key`` 与 ``clear_api_key`` 决定 ——
    #: 收到 `hasKey=false` 也**不会**删 Key（否则「读→改→写回」会静默抹掉凭据）。
    has_key: bool | None = None

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, value: str | None) -> str | None:
        return None if value is None else normalize_base_url(value)

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
    """嵌入配置的**入参形态**（``mode="cloud_api"`` 时才有 base_url/api_key/model_id）。

    ★ **四个字段都是「省略即保留」**（与 :class:`LlmConfigIn` 同一条规则）：
    只提交某一个字段（例如只换 API Key）不会顺手把 ``mode`` 退回 ``local_fastembed``，
    也不会清掉云端地址与模型 ID。
    """

    #: 省略 = 保留已存的模式（**不回落** ``local_fastembed``）。
    mode: EmbeddingMode | None = None
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


class ProviderModelsRequest(CamelModel):
    """``POST /api/settings/models`` 的请求体：**拉取某个地址可见的模型清单**。

    与探测同一条设计：提交的是**候选配置**（先看模型清单、满意再保存），
    ``api_key`` 允许是占位（== 用已存 Key），实现方用 :func:`resolve_api_key` 解析。
    """

    llm: LlmConfigIn


class ProviderModelsResult(CamelModel):
    """``POST /api/settings/models`` 的响应。

    ``ok=False`` 时 ``message`` 必须**可读**（与 ``ProbeResult`` 同一条口径）；
    ``ok=True`` 时 ``models`` 是端点 ``/models`` 报出来的模型 id（可能为空列表 ——
    有些兼容服务实现了端点但不返回清单，那不是错误）。
    """

    ok: bool
    models: list[str] = Field(default_factory=list)
    message: str


class LlmRuntimeConfig(CamelModel):
    """★★ **主进程专用**：真正生效的那份 LLM 配置（**含明文 Key**）。

    ⚠️⚠️ 与 :class:`LlmConfig` 的关键差异：``api_key`` 在这里**是明文**。
    它是「设置 → Pi」这条链路的唯一载体（Pi 需要明文 Key 才能发请求），
    因此**只允许主进程取用**：

    - 路由只有 ``GET /api/settings/runtime``，与其它 ``/api/*`` 一样需要 ``X-Auth-Token``；
    - **渲染进程没有对应 IPC 通道、preload 也没有对应方法**（架构守卫会断言这一点）；
    - 主进程拿到后**只经 ``setRuntimeApiKey`` 放进内存**，不落盘、不进日志。

    ``repr=False`` 兜住「异常里打印 dataclass/model」这类常见事故。
    """

    provider_id: str = DEFAULT_LLM_PROVIDER_ID
    provider_name: str = DEFAULT_LLM_PROVIDER_NAME
    base_url: str = DEFAULT_LLM_BASE_URL
    #: ★ 明文（**只有这一处**）。绝不进日志、绝不发渲染进程。
    api_key: str = Field(default="", repr=False)
    has_key: bool = False
    model_id: str = DEFAULT_LLM_MODEL_ID


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
    #: 学生当前学习的章节标题（= ``ChapterInfo.chapter_title``）；**空串 = 未选择**。
    #: ★ 它是**软偏好**：只进画像 Prompt，**不进检索契约、不做 SQL 硬过滤**
    #:   （学生问别的章节照常回答）。学段一变就清空 —— 那本教材已经不存在了。
    #: ★ 写入口只有 ``PUT /api/profile/{student_id}/chapter``（学生显式选择）；
    #:   **模型没有任何写它的 Tool**（与 ``PreferenceKey`` 同一条纪律）。
    current_chapter: str = ""


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


class StudentUpdateRequest(CamelModel):
    """``PATCH /api/students/{student_id}``：改昵称 / 学段。**两个字段都可选，省略 = 不动。**

    ★ 为什么是「可选字段」而不是整份 :class:`Student`：账号管理界面可能只改名字，
      提交整份对象意味着界面上没动过的字段（尤其是服务端自己维护的时间戳）也一起写回，
      那是「拿旧快照覆盖新值」的经典事故 —— 省略即由服务端保留原值，前端不必先读再写。

    ★ 改学段会**连带清空当前章节**：章节属于某本教材，学段一变那本教材就不存在了
      （与 ``app/grade/rules.py`` 的学段写入同一口径，D-038）。
    """

    nickname: str | None = Field(default=None, min_length=1, max_length=32)
    grade_level: GradeLevel | None = None

    @field_validator("nickname")
    @classmethod
    def _strip_nickname(cls, value: str | None) -> str | None:
        """与 :class:`StudentCreateRequest` 同一口径（空白昵称 422，不含首尾空格）。

        ★ 保留 ``None`` 表示「这次不改昵称」，所以判空只在**给了值**之后做。
        """
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("昵称不能为空白")
        return stripped


class StudentDeleteResult(CamelModel):
    """``DELETE /api/students/{student_id}``：删号回执。

    ★ **号不存在也回 200 + ``deleted: false``，不是 404**：删除是幂等的
      （同一张卡片连点两次、两个窗口同时点），第二次拿到 404 会把「本来就已经没了」
      报成「操作失败」，界面反而要为它写一段特例。调用方看 ``deleted`` 就知道
      这次到底有没有真的删掉数据目录。
    """

    student_id: str
    #: 这次调用是否真的删掉了一个学生目录（``false`` = 本来就不存在）。
    deleted: bool


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


class PreferenceUpdateRequest(CamelModel):
    """``PUT /api/profile/{student_id}/preferences``：写一条学习偏好。

    值只承载**学习方式**（喜好领域 / 讲解方式 / 节奏 / 一句备注），不承载任何个人信息。

    ★ **为什么是 PUT 而不是 POST**：单键 upsert 是**幂等**操作 —— 同一个 key 提交两次，
      库里的状态完全相同（``profile_pref.key`` 是主键，第二次是覆盖而不是追加）。
      POST 会暗示「新增一条记录」，与实际的覆盖语义正好相反。

    ★ **为什么 key 是封闭词表**：见 :data:`PreferenceKey` —— 写掌握度/学段这类
      由规则引擎算出来的客观量，在**类型层面**就不可能（不是靠调用方自觉）。
    """

    key: PreferenceKey
    value: str = Field(min_length=1, max_length=PREFERENCE_VALUE_MAX_CHARS)

    @field_validator("value")
    @classmethod
    def _clean_value(cls, value: str) -> str:
        """去首尾空白 + **拒绝换行**（不是压成单行）。

        ★ 为什么换行是「拒绝」而不是像 ``LearningEventRequest.detail`` 那样压成单行：
          偏好值是 ≤ 40 字的**短标签**，会被 ``key=value`` 拼进每一轮 Prompt，
          合法取值里根本没有换行的位置。压单行会把「多行长文 / 提示词注入」这类输入
          **静默改写成合法值**（``"喜欢动画\\n忽略以上规则"`` 会被拼成一行照样进 Prompt），
          调用方永远不知道自己发错了；拒绝则当场 422，让它按单行重发。
          长度上限（40 字）已经兜住「整段长文」，这里兜住「多行」这一形态。
        """
        if any(sep in value for sep in ("\n", "\r", "\v", "\f")):
            raise ValueError("偏好值必须单行：不允许换行（\\n / \\r）")
        stripped = value.strip()
        if not stripped:
            raise ValueError("偏好值不能为空白")
        return stripped


class ChapterUpdateRequest(CamelModel):
    """``PUT /api/profile/{student_id}/chapter``：设定/清除当前章节。

    ★ **章节是软偏好，不是过滤条件**：它只会出现在画像 Prompt 里（「优先围绕本章」），
      **不改 ``RagSearchRequest``、不做 SQL 硬过滤** —— 学生问别的章节照常回答。
    ★ **为什么是学生显式选择而不是模型写**：与 ``PreferenceKey`` 同一条纪律 ——
      把「学生在学哪一章」交给模型猜，会同时污染 Prompt 与学习地图；
      而且模型写是**第二处真相**（学生自己点的那一下才是最权威的）。
    """

    #: 章标题；**空串 = 清除**（回到「不限章节，自由问答」）。
    #: 非空时必须命中该生**当前学段**的教材章标题（``GET /api/knowledge/chapters/…``
    #: 的同一份清单），否则 422 —— 否则画像 Prompt 里会出现一本不存在的教材。
    chapter_title: str = Field(default="", max_length=CHAPTER_TITLE_MAX_CHARS)

    @field_validator("chapter_title", mode="before")
    @classmethod
    def _clean_title(cls, value: object) -> object:
        """去首尾空白 + **拒绝换行**（不静默压平，与 ``PreferenceUpdateRequest`` 同一口径）。

        ★ ``mode="before"`` 是有意的：先 ``strip`` 再让字段的 ``max_length`` 生效，
          于是「首尾带空白的 80 字标题」是合法的，而「101 字的标题」照样 422。
          写在 ``mode="after"`` 的话，``max_length`` 会先对未清洗的原值判长度。
        ★ 换行检查在 **``strip`` 之前**做（检查 ``value`` 而不是 ``stripped``）：
          ``strip()`` 会把结尾的 ``\\r`` 一并吃掉 —— 检查清洗后的值会让
          ``"第2章\\r"`` 静默通过（实测踩到），而它与 ``"第2章\\n"`` 是同一种输入。
        ★ 换行是**拒绝**而不是压平：它是「把长文/提示词注入塞进每轮 Prompt」的典型形态，
          静默改写成合法值会让调用方永远不知道自己发错了。
        """
        if not isinstance(value, str):
            return value
        if any(sep in value for sep in ("\n", "\r", "\v", "\f")):
            raise ValueError("章节名必须单行：不允许换行（\\n / \\r）")
        return value.strip()


class ChapterStateOut(CamelModel):
    """``GET`` / ``PUT /api/profile/{student_id}/chapter``：当前章节状态（**读写同形**）。

    ``chapter_title`` 的语义统一为「**空串 = 未选择**」（不是 ``None``）——
    前端只需要处理一种空值形态，少一个「空串还是 null」的分支。
    """

    grade_level: GradeLevel
    #: 章标题；空串 = 未选择
    chapter_title: str = ""


# ---------------------------------------------------------------------------
# 主动发起对话（新会话开场引导）
# ---------------------------------------------------------------------------
#: ★ 推荐来源的**冻结词表**（取值不再变；前端按它决定提示语方向）。
#:
#: 它同时被「下一步学什么」（``/recommendation``）与「开场引导」（``/opening``）使用，
#: 所以定义放在这里、两处 import **同一个对象** —— 各写一份 ``Literal`` 会漂移，
#: 而漂移的表现是「推荐页说是重练、开场语说这是新起点」这类自相矛盾。
#:
#: | 取值 | 含义 |
#: | --- | --- |
#: | ``review`` | 优先重练（掌握度不足且练过） |
#: | ``graph`` | *历史值*： 依赖图后继（掌握某知识点后往前推） |
#: | ``random`` | 从「本学段、还没学过」里随机挑（D-074 起的主要来源） |
#: | ``cold_start`` | *历史值*：图里的入口知识点（D-074 起不再产出） |
#: | ``empty`` | 推不出内容（知识库不可用 / 已全部掌握）—— **不发开场**，不是错误 |
RecommendationSource = Literal["review", "random", "graph", "cold_start", "empty"]


class OpeningGuidance(CamelModel):
    """``GET /api/profile/{student_id}/opening``：新会话的**开场引导**。

    需求原文：「学生可主动提问对话，**智能体也能主动发起对话引导学习章节内容**。」
    这是全项目**唯一一处「AI 先开口」**的机制 —— 其余所有交互都是「学生问 → AI 答」。

    ★★ 为什么它必须是一个**契约模型**而不是一句硬编码的欢迎语：开场语的内容来自
      「依赖图 + 掌握度 + 冷启动」的推荐结论（``routes/profile.py`` 的
      :func:`build_recommendation`，那是推荐路径的**唯一实现**）。写死的欢迎语
      对谁都成立，等于没有引导 —— 而「针对性引导到合适的内容」才是这项功能的价值。

    ★ ``source == "empty"`` 时 ``text`` **必须是空串**：前端据此**不发**开场，
      而不是弹一句「今天想学什么？」这种对谁都成立的废话（没有依据的开场白
      与随机挑一个知识点没有区别）。

    ★ 它**不参与 6 事件词表**：开场语不是「一轮对话的流式事件」，而是
      「会话建立」这一步的产物 —— 主进程在新建会话时取一次，作为一条独立消息
      推给界面（与 `trace:changed` 同一性质：独立通道，不是第 7 个事件）。
    """

    #: 可直接显示给学生看的中文开场语；**空串 = 这一轮没有开场**（不是错误）。
    text: str = ""
    #: 学生接受引导时要定位的知识点；``None`` = 没有可去的地方（前端**不要**渲染动作按钮）。
    kp_id: str | None = None
    #: 那个知识点的**中文名**（与 `kp_id` 配对，前端拼「我想学「X」」时用它）。
    #:
    #: ★ 为什么必须由服务端给（D-074）：动作按钮要点名一个知识点，而名字此前是前端从
    #:   `/recommendation` 里按 kp_id 反查的 —— 推荐改成**随机**之后两者不再同源，
    #:   反查会落空（表现是「点了按钮没反应」）。名字与 kp_id 取自同一个 item 就不会错位。
    #: ⚠️ 库里没有中文名时不填（**绝不把 kp slug 推给界面**）。
    kp_name: str | None = None
    #: 与 ``RecommendationResponse.source`` 同口径（同一个 :data:`RecommendationSource`）。
    source: "RecommendationSource" = "empty"


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


class RagLevelAttempt(CamelModel):
    """降级链**一级**的尝试记录（展示用；判定仍然只发生在 ``RagService.search()`` 里）。

    与 Python 内部 ``app.rag.retriever.LevelAttempt`` **同形**（``level`` / ``ok`` /
    ``detail`` / ``hits``）—— 这里只是把它变成可序列化的契约模型，
    好让「四级降级链」这件事在界面上可观测、可答辩。
    """

    #: 档位：``vector`` | ``cloud`` | ``fts`` | ``outline``
    level: Degraded
    #: 这一级有没有命中（``False`` = 试过了但没结果 / 环境不具备）
    ok: bool = False
    #: 一句可读说明（例如「sqlite-vec KNN 无命中（学段内无内容？）」）
    detail: str = ""
    #: 这一级的命中条数（未尝试/未命中为 0）
    hits: int = 0


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
    #: ★ 降级链的**逐级记录**（``vector`` → ``cloud`` → ``fts`` → ``outline``）
    #:
    #: 从票 11 起 ``RetrievalResult`` 就一直在记 ``LevelAttempt(level, ok, detail, hits)``，
    #: 但当时**刻意没有对外暴露**（那边的注释写着「只进日志/轨迹，不进 HTTP 契约」）。
    #: 演示模式要展示「试了哪几级、哪一级命中、为什么落到下一级」，于是把它原样透传。
    #: ★ 它是**可选且只读**的展示数据：老消费方（不看这个字段的那批）行为一字不变；
    #:   编排层仍然**不许**据此重新实现降级逻辑（降级仍然只在这一个函数里发生）。
    attempts: list[RagLevelAttempt] = Field(default_factory=list)
    #: ★ 学段过滤条件**原文**（由生成 WHERE 的同一份白名单渲染，展示「隔离在 SQL 层强制」用）。
    grade_filter: str = ""


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
    """``GET /api/grade/signals/{student_id}``：学段信号与推断检视面。

    ⚠️ 学段**默认由系统自动推断、自动生效**，学生也可以**手动覆盖**：
    规则引擎（``app/grade/rules.py``）达到阈值时会直接改写 ``student.grade_level``
    并写 ``grade_history(source="inferred")``；学生手动切换则写 ``source="explicit"``
    并进入更长的冷却（``MANUAL_COOLDOWN_TURNS``）。``suggested_level`` 只是
    **本轮检视用的建议值**（置信度 < 0.6 时 ``None``），**不是**等待确认的动作入口。
    """

    student_id: str
    #: 当前**生效**的学段（由推断引擎或学生手动切换写入；无历史时是冷启动默认值）
    current_level: GradeLevel
    #: 当前学段来源：``inferred``（自动推断）| ``explicit``（学生手动选择）。
    source: Literal["inferred", "explicit"] = "inferred"
    #: 推断建议（``None`` = 无建议；置信度 < 0.6 不调整，§10.3）
    suggested_level: GradeLevel | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    signals: list[GradeSignal] = Field(default_factory=list)


class GradeOverrideRequest(CamelModel):
    """``POST /api/grade/override/{student_id}`` 的请求体。

    ★★ **刻意不提供 ``note``（留痕说明）字段** —— 这是取舍，不是省事：
    ``grade_history`` 只存结构化字段，没有放**任意文本**的列；多出来的说明
    **没有地方落盘**；退而求其次写进日志又违反「日志里不出现学生文本」的合规要求。
    收下一个**写不进去**的字段等于让接口撒谎：调用方以为自己留了痕，其实内容被静默丢弃，
    之后排查时还会以为「日志里没有是因为没填」。宁可不提供。

    ★ 请求体里**也不需要会话 id**：冷却锚点记的是 ``grade_signals`` 的**信号位标**
    （全局单调、跨会话可比），不是某个会话里的轮次号 —— 服务端写这一行时自己就能取到。
    详见 ``app/grade/rules.py`` 的 ``_cooldown_remaining``。
    """

    grade_level: GradeLevel


class GradeOverrideResponse(CamelModel):
    """学生手动设定学段的结果（**立即生效**，不依赖任何信号）。"""

    student_id: str
    #: 设定后的**当前生效**学段（= 请求里的 ``gradeLevel``）
    grade_level: GradeLevel
    #: 切换前的学段（与 ``gradeLevel`` 相同时 ``changed`` 为假，但仍会留一条轨迹行）
    previous_level: GradeLevel
    #: 手动设定必然是显式来源，这里收窄成唯一取值，调用方不必再判分支
    source: Literal["explicit"] = "explicit"
    changed: bool
    #: 这条轨迹行记在第几轮（服务端按轮次水位推算，见 ``GradeEngine.turn_watermark``）
    turn: int
    #: 手动切换后的冷却剩余轮数（= ``MANUAL_COOLDOWN_TURNS``，供前端提示「多久后恢复自动」）
    cooldown_remaining_turns: int


class GradeHistoryEntry(CamelModel):
    """``grade_history`` 的一行（学段变化轨迹）。

    ★ **为什么它在 ``contracts.py`` 而不在 ``routes/grade.py``**：学习报告的
      ``GET /api/profile/{id}/report`` 要**复用同一份**轨迹模型。留在路由文件里的话，
      报告轨只能「再定义一个同形模型」——那就违背了「pydantic 是唯一契约来源」，
      两边的字段迟早分叉（``routes/grade.py`` 的模块注释原本就把这条列为待补项）。
    ★ 冷启动基线那行 ``from_level`` 为空（学生还没有「上一段」，不是从一个学段变过来的）。
    ★ **手动覆盖重复选同一学段时也会写一行**（``from_level == to_level``，
      ``source="explicit"``）：那一行不改变学段，但它是「学生确认过」的留痕与冷却锚点。
    """

    #: Unix 毫秒（与 JS ``Date.now()`` 同尺度；库里的 ts 是秒，出参一律经 to_contract_ms）
    ts: int
    #: 第几轮（1 起）
    turn: int
    from_level: GradeLevel | None = None
    to_level: GradeLevel
    #: 写入来源：``inferred``（规则引擎自动调整）| ``explicit``（学生手动切换）。
    #: ★ 这里**刻意不收窄成 Literal**：库里可能已有更早版本写入的其它取值，
    #: 收窄会让一行旧数据把整条轨迹接口打成 500（读接口不该被历史脏值拖垮）。
    source: str
    #: **哪一层判的**（D-066）：``rules``（本地规则判定）/ ``llm``（AI 引擎判定）/
    #: ``None``（D-066 之前写入的历史行，或学生手动指定的行 —— 手动谈不上哪层引擎）。
    #: ★ 与 ``source``（**谁写的**：系统 / 学生）是两个轴，报告叙事两个都要用到：
    #: 「第 3 轮系统判定为初中（inferred, 本地规则判定）」与
    #: 「第 12 轮系统改判为高中（inferred, AI 引擎判定）」是两种不同的证据。
    decided_by: str | None = None
    confidence: float = 0.0


# ---------------------------------------------------------------------------
# 学习档案（章节 / 依赖图全览 / 错题本 / 学习报告）
#
# ⚠️ 这一组**都是派生视图**，不是新的数据来源：章节来自 ``kb.sqlite`` 的 ``kp.chapter_title``、
#    依赖图来自 ``knowledge_dependencies``、错题与报告来自该学生自己的 ``learning.db``。
#    这里定义的是**出参形状**，不引入任何新表（见 ``app/store/learning.py`` 的模块头）。
# ---------------------------------------------------------------------------
class ChapterInfo(CamelModel):
    """一章教材（四学段共 24 章，来自知识点 front-matter 的 ``chapter_title``）。"""

    chapter_title: str
    #: 该章包含的知识点数
    kp_count: int = 0
    #: 该章的知识点 id，**顺序 = 教材定义序**（kb.sqlite 的 rowid，不是字典序
    #: —— 字典序会让「第 10 章」排在「第 2 章」前面）
    kp_ids: list[str] = Field(default_factory=list)
    #: 已掌握（``progress.stage == "mastered"``）的知识点数。
    #: ★ 只有查询时带了 ``student_id`` 才有意义，否则恒为 0（见 ``with_progress``）。
    mastered_count: int = 0


class ChapterListResponse(CamelModel):
    """``GET /api/knowledge/chapters/{grade_level}``：某学段的章节清单。"""

    grade_level: GradeLevel
    chapters: list[ChapterInfo] = Field(default_factory=list)
    #: 本次是否带上了学生进度。**显式给出来**，前端据此决定显示「3/5 已掌握」还是「5 个知识点」
    #: —— 不做「mastered_count 全是 0 = 没传学生」这种猜测（真有学生一关没过时也会全是 0）。
    with_progress: bool = False


class KnowledgePointItem(CamelModel):
    """教材里**一个知识点**的一行（教材知识库页的表格）。

    ★ 与 :class:`ChapterInfo` 的关系：那个是「一章 = 多个知识点」，这个是「一个知识点 = 一行」。
    表格要按知识点列，所以单开一个模型，而不是让后端把 ``ChapterInfo.kp_ids`` 展开成
    「前端需要的样子」—— 拆解属于展示逻辑，不该由数据层代劳。
    """

    kp_id: str
    name: str
    grade_level: GradeLevel
    chapter_title: str = ""
    #: 内容类型：``concept`` / ``principle`` / ``practice`` / ``ethics`` / ``project``
    content_type: str = ""
    #: 该知识点在 kb 里的 chunk 总数（父子块都算）
    chunk_count: int = 0
    #: 该知识点是否有向量（``false`` = 该行只能靠 FTS/大纲命中，检索质量会降档）
    embedded: bool = False


class KnowledgePointListResponse(CamelModel):
    """``GET /api/knowledge/points``：知识点清单（可按学段过滤）。"""

    grade_level: GradeLevel | None = None
    points: list[KnowledgePointItem] = Field(default_factory=list)


class KnowledgeStats(CamelModel):
    """``GET /api/knowledge/stats``：知识库体检数字（统计卡 + 版本信息）。

    ★ 这些数字**必须由后端算**：它们来自 ``kb.sqlite`` 的表行数，
      前端既读不到 SQLite（架构硬边界：数据域只在 Python），也不该自己数一遍已知的行。
    """

    #: 各表行数：``kp`` / ``parent_chunk`` / ``child_chunk`` / ``chunk_vec`` /
    #: ``chunk_fts`` / ``dependencies``
    counts: dict[str, int] = Field(default_factory=dict)
    #: 有知识点数据的学段（按学段顺序）
    grade_levels: list[GradeLevel] = Field(default_factory=list)
    #: 当前生效的知识库文件路径。**只用于界面显示「用的是哪一份」**
    #: （不含学生标识；路径由服务端自己决定，渲染进程只读不回传）。
    kb_path: str = ""
    #: 这份 kb 是**用户重建**的（true）还是随包分发的只读资产（false）。
    #: ★ 学生重建完最想确认的就是「我刚才那次到底生效了没」，所以显式给出来。
    user_rebuilt: bool = False
    #: 嵌入维度（``EMBEDDING_DIM``；与 vec0 表维度不符时检索会整体降级）
    embedding_dim: int = 512
    #: 嵌入模型 id（如 ``BAAI/bge-small-zh-v1.5``）
    embedding_model: str = ""
    #: 向量引擎是否可用（``false`` = 只能靠 FTS/大纲降级）
    vec_ready: bool = False


class KnowledgeImportRequest(CamelModel):
    """``POST /api/knowledge/import``：导入一份教材 Markdown。

    ★ 为什么是**正文 JSON**而不是 multipart 文件上传：内容只有一份 Markdown 文本，
      走 multipart 要给 sidecar 加 ``python-multipart`` 依赖、还要让主进程处理二进制，
      换来的只是「省一次字符串传递」。渲染进程已经用 ``file.text()`` 读到了正文。
    """

    #: 文件名（**决定 kp_id**：约定「文件名 = kp_id.md」，与建库校验同一条规则）
    file_name: str = Field(min_length=1, max_length=200)
    #: Markdown 全文（含 ``---`` 文件头）
    markdown: str = Field(min_length=1, max_length=400_000)
    #: 期望学段。给定时必须与文件头 ``grade_level`` 一致（防止把初中的内容挂到高中）
    grade_level: GradeLevel | None = None
    #: 导入后是否立刻重建索引（默认 true：不重建的话这份内容检索不到，等于没导入）
    rebuild: bool = True


class KnowledgeImportResponse(CamelModel):
    """导入回执。

    ``ok=false`` 时 ``problems`` **逐条**列出未通过的原因（格式错 / 超纲术语 /
    语气错位 / 跨学段搬运）—— 这类错误必须能定位到具体是哪一条，
    只回一句「导入失败」等于让学生自己猜。
    """

    ok: bool = False
    #: 校验通过后的知识点 id（``ok=false`` 时为 ``null``）
    kp_id: str | None = None
    #: 落盘的相对位置（**不含完整用户目录结构**）
    saved_as: str | None = None
    #: 未通过的原因（``ok=true`` 时为空）
    problems: list[str] = Field(default_factory=list)
    #: 重建结果（``rebuild=false`` 或失败时为 ``null``）
    stats: KnowledgeStats | None = None
    #: 给界面直接显示的一句话结论
    message: str = ""


class KnowledgeRebuildResponse(CamelModel):
    """``POST /api/knowledge/rebuild``：重建索引的回执。

    ★ 重建是**重活**（分块 + ONNX 嵌入整份教材，秒级到十几秒），所以：
      ① 端点用线程池跑，不阻塞事件循环；
      ② 回执带 ``elapsed_ms``（界面要显示「用时 3.2s」，否则看起来像卡死）；
      ③ 失败必须给出**可读中文原因**（模型缺失 / 维度不符 / 教材格式错），而不是一个 500
         —— 界面有专门的失败横幅要显示它。
    """

    ok: bool = False
    #: 重建后的统计（``ok=false`` 时为 ``null``）
    stats: KnowledgeStats | None = None
    #: 重建耗时（毫秒）
    elapsed_ms: float = 0.0
    #: 本次重建涉及的教材文件数
    documents: int = 0
    #: 依赖边数
    dependencies: int = 0
    #: 失败原因 / 成功提示（界面直接显示）
    message: str = ""


class GraphNode(CamelModel):
    """依赖图里的一个知识点（学习地图的节点）。"""

    kp_id: str
    name: str
    grade_level: GradeLevel
    chapter_title: str = ""
    #: 分层（0 = 该子图里的入口节点）。**在同一学段的子图内**按最长前置链算出，
    #: 前端据此横向分层；跨学段的边不参与（否则「入口」会落在别的学段里）。
    layer: int = 0
    #: 学生是否已掌握（查 ``/overview`` 时带了 ``student_id`` 才有意义）
    mastered: bool = False


class GraphEdge(CamelModel):
    """一条依赖边。**``from`` 是前置、``to`` 是后继**（全项目一致，方向搞反是静默错）。"""

    from_kp_id: str
    to_kp_id: str
    relation: DepRelation = "prerequisite"
    weight: float = 1.0


class GraphOverview(CamelModel):
    """``GET /api/graph/overview/{grade_level}``：某学段依赖图的**全览**（学习地图用）。

    ★ 与 ``/api/graph/deps/{kp_id}``（单点邻域）的分工：那个接口回答「这个点的前后是什么」，
      这个回答「整张图长什么样」。**遍历逻辑仍只有一份**（``app.knowledge.deps``），
      本模型只是它的出参形状。

    ⚠️ ``edges`` 只包含**两端都在 ``nodes`` 里**的边：跨学段的边在单学段视图里没有落点，
      画不出来（传进来只会画出悬空的线）。
    """

    grade_level: GradeLevel
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)


class MistakeItem(CamelModel):
    """一条错题（按知识点聚合后的一条）。

    ★★ **合规口径（两条，都是刻意的）**：
      ① ``stem`` 来自 ``learning_history.question``，库里存的是**题干前 120 字**
         （``routes/quiz.py`` 的 ``_record_attempt`` 写入 ``stem[:120]``）——题干是题目本身，
         **不是学生原话**；学生作答与模型回答一律不入库（§8.1 合规红线），
         所以这个模型**结构上就没有**「你的答案」字段，不是忘了加。
      ② **绝不 join ``generated_question`` 取完整题干**：那张表带 ``reference_answer``（标准答案），
         把它读进对外响应会直接踩答案泄漏红线（``INTERNAL_MODELS`` / 答案属性白名单都在守这条）。
         120 字足够让学生认出「是这道题」，而认出之后要的是「再练一遍」而不是看答案。
    """

    kp_id: str
    #: 知识点的**人类可读名**（「循环」这类）；取不到时退化成 kp_id
    kp_name: str = ""
    chapter_title: str = ""
    #: 题干前 120 字（题目原文）
    stem: str = ""
    #: 该知识点答错的次数
    wrong_count: int = 0
    #: 最近一次答错的时间（Unix 毫秒）
    last_wrong_at: int = 0
    #: 最近一次答错的题号（供「再练一遍」定位变式题；题号不是答案）
    last_qid: str = ""


class MistakeListResponse(CamelModel):
    """``GET /api/quiz/mistakes/{student_id}``：错题本（按知识点聚合）。"""

    student_id: str
    grade_level: GradeLevel
    items: list[MistakeItem] = Field(default_factory=list)
    #: 答错总次数（同一个知识点错三次算三次）
    total_wrong: int = 0
    #: ★ **有错题但取不到题干的条数**（QA / 编程轨答错：``is_correct=0`` 但没有题干，
    #: 因为 ``profile.events`` 那一轨恒写空串）。**显式报出来而不是静默丢掉** ——
    #: 否则「错题比学生记得的少」会被当成 bug 查半天。
    without_stem: int = 0


class DailyActivity(CamelModel):
    """某一天的活动量（按**本地日期**聚合，不是 UTC —— 跨零点学习不该被算到前一天）。"""

    #: ``YYYY-MM-DD``（本地日期）
    day: str
    #: 全部活动条数
    count: int = 0
    quiz_count: int = 0
    correct_count: int = 0


class ChapterProgress(CamelModel):
    """一章的闯关进度（把 ``progress`` 按 ``chapter_title`` 聚合）。"""

    chapter_title: str
    kp_count: int = 0
    #: ``progress.stage == "mastered"`` 的个数
    mastered_count: int = 0
    #: ``stage == "quizzed"`` 的个数（已测验但还没掌握）
    quizzed_count: int = 0


class LearningReport(CamelModel):
    """``GET /api/profile/{student_id}/report``：学习报告（学生 / 家长）。

    ★ **四张表都在里面**（``mastery`` / ``learning_history`` / ``progress`` / ``grade_history``），
      此前它们各自只有零散出口，没有一个「这一周学得怎么样」的汇合点。
    ★ ``grade_history`` 直接复用 :class:`GradeHistoryEntry`（见该模型的注释）。
    """

    student_id: str
    nickname: str = ""
    grade_level: GradeLevel
    #: 时间窗口天数（查询参数回显，前端标题用它）
    days: int = 7
    #: 画像摘要（§5.2 #12「教师/家长报告含画像摘要」）：该学生**自己**的标签投影。
    #: ★ 与 ``GET /tags`` 同口径、同一道闸：parent_consent=0 → 空（G-G），因为摘要也是画像。
    #: ★ **绝不跨学生**（禁做 #9）——「家长报告」最容易被顺手写成「和班上别人比」，那是禁止的。
    profile_summary: list[ProfileTagOut] = Field(default_factory=list)
    #: 报告生成时间（Unix 毫秒）。★ 报告**不进 Prompt**，所以这里可以带时间
    #: （D-032 的逐字节稳定只约束注入 system prompt 的内容）。
    generated_at: int = 0
    #: 时间窗内**有活动的那些天**（没有活动的日期不补 0 —— 前端自己铺满整周，
    #: 补 0 会把「哪天没学」的表达权从界面挪到后端）。
    daily: list[DailyActivity] = Field(default_factory=list)
    total_activities: int = 0
    quiz_total: int = 0
    quiz_correct: int = 0
    #: 连续学习天数（今天学过就从今天起算；今天还没学则算到最近一次学习那天）
    streak_days: int = 0
    today_studied: bool = False
    #: 掌握度（按分数降序，与 ``GET /api/profile`` 同口径）
    mastery: list[Mastery] = Field(default_factory=list)
    #: 章节进度（按教材定义序）
    chapters: list[ChapterProgress] = Field(default_factory=list)
    #: ``progress.stage`` 计数（``locked`` / ``learning`` / ``quizzed`` / ``mastered``）
    stage_counts: dict[str, int] = Field(default_factory=dict)
    #: 已获得的徽章（去重；徽章一经授予不因后续答错而清除，见 ``store/learning.py``）
    badges: list[str] = Field(default_factory=list)
    #: 学段变化轨迹（「第 3 轮调为初中（0.75）」这类叙事就用它）
    grade_history: list[GradeHistoryEntry] = Field(default_factory=list)


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


# ---------------------------------------------------------------------------
# 学生动画库（``/api/animation/saved/**``）
#
# 生成过的动画**按学生存下来**：同一个学生再问同一件事时直接复用（零模型调用），
# 学生可以删除，且**按学段隔离**——同一个知识点在小学低与初中是两份不同的产物
# （讲法不同，混用会把孩子看不懂的那一份端出来）。
#
# ★★ 复用键是 ``(student_id, kp_id, grade_level, prompt_hash)``：
#    - ``student_id`` 由**库文件的归属**承担（一人一份 ``learning.db``，见 §8.2）；
#    - 后三维是 ``saved_animation`` 上的唯一索引（见 ``store/learning.py``）。
#
# ★★ **绝不收学生原话**：请求里没有任何承载正文的字段，只有调用方算好的
#    ``prompt_hash``（十六进制摘要）+ 展示文字（``concept`` / ``title`` / 降级文案）。
#    这与「SQLite 不存对话正文」（§8.1）是同一条纪律——原话归 Pi 的 JSONL 会话树。
# ---------------------------------------------------------------------------
#: 知识点 id 的长度上限（与 ``routes/profile.py`` 的 ``KP_ID_MAX_CHARS`` 同量级）。
ANIMATION_KP_ID_MAX_CHARS = 64
#: 学生 id 的长度上限（★ 与 ``routes/students.py`` 的 ``STUDENT_ID_RE`` **同一个数**：
#: 它们是同一套白名单，取小了一侧会拒掉合法 id、取大了另一侧会 422，两边都不好看）。
ANIMATION_STUDENT_ID_MAX_CHARS = 64
#: 概念名 / 标题的长度上限（它们会进卡片与 Prompt，是**上限而不是建议**）。
ANIMATION_CONCEPT_MAX_CHARS = 120
ANIMATION_TITLE_MAX_CHARS = 120
#: 降级文案上限：与 ``app/animation/compose.py`` 的 ``MAX_FALLBACK_TEXT_CHARS`` **同一个数**
#: （两处各写一个数就会出现「生成时能过、保存时被拒」这种自相矛盾）。
ANIMATION_FALLBACK_TEXT_MAX_CHARS = 600
#: ``prompt_hash`` 的长度上限：sha1 = 40 位、sha256 = 64 位，留一倍余量给将来的算法。
ANIMATION_PROMPT_HASH_MAX_CHARS = 128
#: 静态兜底图上限（dataURL SVG，几 KB 量级；上限只是拦住「整张位图塞进来」）。
ANIMATION_FALLBACK_IMAGE_MAX_CHARS = 256 * 1024
#: ``saved_animation.id`` 的字符集（与 ``validate_payload_id`` 同一形状）。
ANIMATION_SAVED_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"
#: 请求指纹的形状：**只收十六进制**——学生原话连一个字符都进不来（由类型承担，不靠人记得）。
ANIMATION_PROMPT_HASH_PATTERN = r"^[0-9a-fA-F]+$"


class AnimationSaveRequest(CamelModel):
    """``POST /api/animation/saved/{student_id}``：把一份动画**存进该学生的动画库**。

    ``html`` 是**完整自包含**的沙箱产物（模板渲染或自由生成的结果）；
    服务端会拿 ``validate_animation_html()`` 再校验一次——不合格 → 422 + 可读原因，
    因此库里不会出现「存下来了但播不出来」的产物（同托管路径的二次校验口径）。
    """

    kp_id: str = Field(min_length=1, max_length=ANIMATION_KP_ID_MAX_CHARS)
    #: ★ 复用键的一维：学段不同就是**两份不同的产物**（同知识点、不同讲法）。
    grade_level: GradeLevel
    #: 展示用的概念名（学生可见），**不是**学生原话。
    concept: str = Field(min_length=1, max_length=ANIMATION_CONCEPT_MAX_CHARS)
    #: 调用方算好的**十六进制请求指纹**（sha1 / sha256）。原话不进本接口，见模块头。
    prompt_hash: str = Field(
        min_length=8,
        max_length=ANIMATION_PROMPT_HASH_MAX_CHARS,
        pattern=ANIMATION_PROMPT_HASH_PATTERN,
    )
    #: 卡片标题；空串时服务端用 ``concept`` 兜底（与 ``/animation/compose`` 同一口径）。
    title: str = Field(default="", max_length=ANIMATION_TITLE_MAX_CHARS)
    duration_ms: int = Field(gt=0, le=120_000)
    html: str = Field(min_length=1)
    fallback_text: str = Field(min_length=1, max_length=ANIMATION_FALLBACK_TEXT_MAX_CHARS)
    #: 静态兜底图（dataURL）；空串 / 缺省一律落成 ``None``（库里只留一种「空」）。
    fallback_image: str | None = Field(default=None, max_length=ANIMATION_FALLBACK_IMAGE_MAX_CHARS)


class AnimationSavedItem(CamelModel):
    """动画库里的一条（**不含 html**）：列表与保存回执用它。

    ``html`` 单独由 :class:`AnimationSavedView` 带出去 —— 列表里回整份 HTML 会让
    「列出 20 条」的响应变成几 MB，而列表上根本没人看动画正文。
    """

    id: str
    kp_id: str
    grade_level: GradeLevel
    concept: str
    #: 请求指纹（**十六进制摘要**，见 :class:`AnimationSaveRequest`）—— 不是学生原话。
    prompt_hash: str
    title: str
    duration_ms: int
    fallback_text: str
    fallback_image: str | None = None
    #: 首次保存时间（**Unix 毫秒**，与 ``Student.createdAt`` 同尺度）。
    created_at: int = 0
    #: 被复用了几次（命中一次 lookup 加一）。
    uses: int = 0


class AnimationSavedView(AnimationSavedItem):
    """取一条（``GET .../{saved_id}`` / ``lookup`` 命中）：**带 html**（沙箱产物本体）。"""

    html: str


class AnimationSavedListResponse(CamelModel):
    """``GET /api/animation/saved/{student_id}``：该学生的动画库清单（**不含 html**）。

    ``grade_level`` / ``kp_id`` 回显**本次的过滤条件**（``None`` = 没过滤）：
    前端据此显示「初中 · 循环」这类筛选状态，而不是自己记一份。
    """

    student_id: str
    grade_level: str | None = None
    kp_id: str | None = None
    items: list[AnimationSavedItem] = Field(default_factory=list)
    total: int = 0


class AnimationSavedLookupRequest(CamelModel):
    """``POST /api/animation/saved/lookup``：按**复用键**取一条（命中即返回带 html 的那条）。

    ★ 学生 id 在**请求体**里（不是路径里）：这条路由与
    ``POST /api/animation/saved/{student_id}`` 同形，学生 id 再进路径就会有两个候选匹配
    （见路由模块里「静态路径必须先注册」那条注释）。
    """

    student_id: str = Field(min_length=1, max_length=ANIMATION_STUDENT_ID_MAX_CHARS)
    kp_id: str = Field(min_length=1, max_length=ANIMATION_KP_ID_MAX_CHARS)
    grade_level: GradeLevel
    prompt_hash: str = Field(
        min_length=8,
        max_length=ANIMATION_PROMPT_HASH_MAX_CHARS,
        pattern=ANIMATION_PROMPT_HASH_PATTERN,
    )


class CodeTemplate(CamelModel):
    """编程模板载荷（§11.3 / 票 19）。``scaffold`` 必须含明确的 TODO 标记。"""

    kp_id: str
    language: Literal["python"] = "python"
    #: 预置代码框架（含 TODO 标记）
    scaffold: str
    #: 填完 TODO 后应当表现出的行为（面向学生，中文）
    expected_behavior: str
    #: 这道题的**任务名**（面向学生：说清「要写什么」，例如「函数：求人工智能的特征平均值」）。
    #: ⚠️ 与知识点名不是一回事：知识点叫「人工智能的定义」，学生看不出要写什么代码。
    #: 缺省空串 = 老资产没这个字段，界面回落到知识点名。
    title: str = ""
    #: 做完以后**程序应当打印的东西**（原样，含换行）。界面用等宽块展示 ——
    #: 「做完长什么样」比一句描述更直观，也是学生自查「我到底做对没有」的凭据。
    expected_output: str = ""


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
    """★ **对外模型**：没有 ``answer``、也**没有** ``explanation``，发给 TS 与前端。

    判分所需的标准答案只留在 Python 侧：``POST /api/quiz/grade`` 按 ``qid`` 查库判分，
    前端与 TS 都不需要答案。

    ★★ **为什么连 ``explanation`` 也不下发**（2026-09-19 定案，它本来是契约字段）：
      ``explanation`` 是**解析**，而它的话术经常把答案直接写进去 ——
      实测 **295/684 道真题（约 43%）** 的解析含标准答案原文
      （形如「选 B。因为 range 是含头不含尾的……」）。发出去就等于把题做废：
      学生（或模型）只要读题面载荷就能白拿答案，``mastery`` 随之失去意义。

      ⚠️ 这个比例**有可复现的出处**：``tests/test_quizbank_coverage.py`` 的
      ``test_explanation_usually_contains_the_answer`` 每次运行都会打印它
      （不是从别处抄来的数字，题库改了它会跟着变）。

      而这与闯关页界面上的白纸黑字一致 —— ``views/Quiz.vue`` 写着
      「答案与解析都不下发到界面」。此前是契约与承诺不符：界面不渲染，
      但载荷一直带着它走完了 HTTP。

    ★ **解析的教学价值一个字没丢**：它仍然在 ``feedback_for()`` 里，
      只在**判分之后**经 ``QuizResult.feedback`` 回传给学生 ——
      「答完再讲为什么」正是有教育意义的那一步，而「答前先看到为什么」只是送答案。

    ⚠️ 不要为「前端想提前显示解析」把它加回来：那需要先答过一次，
      也就是说要先有一条判分记录（``store.question_attempt``），
      而那件事的完整形态是「判分后从 ``feedback`` 取」—— 不是第二条下发通道。
    """

    qid: str
    kp_id: str
    type: QuizQuestionType
    stem: str
    options: list[str] | None = None

    @classmethod
    def from_internal(cls, question: QuizQuestion) -> "QuizQuestionOut":
        """内部题 → 对外题的**唯一**转换入口（``answer`` / ``explanation`` 在这里被丢弃）。

        逐字段显式列出，**不用** ``model_dump(exclude=...)``：漏一个字段会立刻被
        ``extra="forbid"`` 与类型检查打死，而不是静默泄漏。

        ★ ``extra="forbid"`` 在这里还有第二层作用：**上游想多带一个字段会当场报错**，
        不会像 ``exclude`` 那样「今天裁对了、明天加字段忘了加进名单」。
        """
        return cls(
            qid=question.qid,
            kp_id=question.kp_id,
            type=question.type,
            stem=question.stem,
            options=question.options,
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

    ★★ **只有 ``text`` 一个字段，且与 ``desktop/src/main/ipc/channels.ts`` 的
      ``ChatSendRequest`` 逐字段同形**（守卫 G6c 把那一侧钉死为 ``['text']``）。
      这里曾经多出 ``student_id`` / ``session_id`` —— 那是**第二形状**，也是漂移温床：

      - **学生身份只能由主进程决定**（``resolveActiveStudentId()`` / ``currentAgentSession()``）。
        契约里放一个 ``student_id``，等于给「读渲染进程递来的身份」留了一个合法入口 ——
        而那条路一旦走通，就是读别人的画像与学习记录。身份不进对话请求。
      - **会话同理**：Pi 会话由主进程持有，渲染进程连会话 id 都不该知道。

      所以修法不是「把 TS 侧改成带上这两个字段」（那会把上面两条一起做废），
      而是**把契约收敛到真实形状**：``{text}``。测试 ``TestChatRequestContract``
      同时钉住字段集合恰好是这一个。

    ⚠️ **没有学段/章节字段**（AGENTS §5.1 / D-037 / D-038）：学段与章节都**不由每轮对话携带**
    —— 学段自动推断、自动生效（学生手动指定走 ``grade:set``），章节走 ``chapter:set``。
    把它们放回请求里会让「发一条消息」变成「顺带改一次学段/章节」的副作用。
    历史上这里有过 ``grade_level: GradeLevel``（必填），与它自己的注释正好相反 —— 已删除，
    且测试钉住「不许再加回来」。
    """

    text: str


# ---------------------------------------------------------------------------
# 登记表（导出脚本与测试的唯一依据，**新增模型必须登记**）
# ---------------------------------------------------------------------------
#: 需要出现在 OpenAPI / TS 生成物里的模型。
# --------------------------------------------------------------------------- #
# 对话式冷启动画像（票 25 / 28）：白名单投影的契约面
#
# ★ 本节只放**能过桥的数据形状**。identity_local 的本地身份列（真名 / 精确年级 /
#   学校 / 班级）**没有对应模型、也没有出头字段** —— 不是被过滤掉，是压根没有出口
#   （G-B / G-C）。ProfileTagOut 里的 key 由服务端再过一遍白名单之后才回。
# --------------------------------------------------------------------------- #

#: 标签来源：declared（学生自己说的 L2）/ observed（系统观察 L1）/ inferred（AI 推断 L3）。
TagSource = Literal["declared", "observed", "inferred"]

#: ★ 情绪取值域（禁做 #12）：有限枚举，**不是**临床词汇，也不是自由文本。
EmotionValue = Literal["happy", "calm", "confused", "frustrated", "angry"]

#: ★★ 学习类型（`learner_style`）取值域（2026-09-30 新增，维度 13）。
#: 封闭词表，值是**中文显示值**（要进画像卡给学生看）；与 TS 的
#: `LEARNER_STYLE_VALUES` 逐字一致。
LearnerStyleValue = Literal["天赋型", "努力型", "钻研型", "速通型", "均衡型"]

#: ★★ 性格（`personality`）取值域（2026-09-30 新增，维度 13）。
#: ⚠️ 它是本轮**红线最小移动**的那道闸：性格允许被 AI 推断，但值只能是这十个中性词，
#: 医学 / 心理学词汇一个都不许进来（与 EmotionValue 同一条纪律）。
PersonalityValue = Literal[
    "开朗", "安静", "好奇", "沉稳", "细心", "勇敢", "急性子", "慢性子", "爱提问", "爱琢磨"
]

#: 引导流程状态（与 TS 的 ONBOARDING_STATES 同形）；只有 not_started 才弹（G-I）。
OnboardingState = Literal["not_started", "in_progress", "done", "skipped"]

#: 五问问号（与 TS 的 OnboardingQuestionId 同形）。
OnboardingQuestionId = Literal["q1", "q2", "q3", "q4", "q5"]

#: 学生面称呼的回落值（真名过脱敏后为空 / 形态可疑时的统一值）。
STUDENT_FALLBACK_NAME = "同学"

#: 称呼的展示上限：它会被拼进每一轮 Prompt（同 PREFERENCE_VALUE_MAX_CHARS 的理由）。
DISPLAY_NAME_MAX_CHARS = 24

#: 命中这些形态就不当称呼用（学校 / 班级 / 电话学号）。
#: ★ 后端这道只是**兜底**，真正的过滤在收集侧（主进程写 identity_local 之前）。
_NAME_FORBIDDEN_MARKERS = ("学校", "小学", "中学", "大学", "班", "老师", "电话", "地址")


def safe_display_name(real_name: str | None) -> str:
    """真名 → 可安全展示的称呼（取不到 / 形态可疑 → STUDENT_FALLBACK_NAME）。

    ★ 为什么过滤要放在这里：{{student_name}} 占位机制下，展示名会进渲染层与 Prompt 片段，
      而真名只在本地。后端不判断「这是不是真名」，只负责**不给可疑串任何出口**。
    """
    name = " ".join((real_name or "").split()).strip()
    if not name or len(name) > DISPLAY_NAME_MAX_CHARS:
        return STUDENT_FALLBACK_NAME
    if any(marker in name for marker in _NAME_FORBIDDEN_MARKERS):
        return STUDENT_FALLBACK_NAME
    if any(char.isdigit() for char in name):
        return STUDENT_FALLBACK_NAME
    return name


#: 白名单键 → 维度（1..13，见执行报告 §0.5；界面按它分组）。
#: ★ 只登记白名单里的键：这张表本身就是「出栈键必须在这里」的又一重证据。
TAG_DIMENSIONS: dict[str, int] = {
    "anon_student_id": 1,
    "grade_band": 1,
    "subject": 2,
    "course_module": 2,
    "current_topic": 2,
    "knowledge_point": 3,
    "mastery": 3,
    "error_type": 4,
    "zpd_level": 4,
    "explain_style": 7,
    "output_length": 7,
    "pace": 7,
    "practice_type": 7,
    "interest_topic": 8,
    "emotion": 9,
    "intensity": 9,
    "trigger": 9,
    "confidence": 9,
    "tone": 10,
    "encouragement_freq": 10,
    "challenge_level": 10,
    "scene": 11,
    "task_goal": 11,
    "safety_level": 12,
    "boundary_topics": 12,
    # 维度 13：学习类型与性格（2026-09-30 新增）
    "learner_style": 13,
    "personality": 13,
}

#: 维度序号 → 中文名（**后端唯一来源**，画像卡用它给每一组标签起小标题）。
#: ★ 为什么要放这里：在它之前，这些维度名只以**注释**形态散在
#:   `shared/profile-tags.ts` 与 `store/migrations.py`（「维度 7：学习偏好」），
#:   渲染层拼不出来 —— 而画像卡按维度分组后，光有一串标签没有组标题，
#:   学生看不出「讲解风格 / 节奏 / 练习方式」是同一类东西。与 TAG_LABELS 同一条理由：
#:   中文名放后端，渲染层一个字符串字面量都不用写（kp-slug 守卫天然不打架）。
#: ⚠️ 计数以 TAG_DIMENSIONS 的实际取值为准（1..13，缺 5/6 是本项目有意留空的历史槽位）。
#: ★ 措辞是**学生面**的：这一列会直接当画像卡的小标题给学生看，
#:   所以用「怎么讲更好」而不是「学习偏好」，用「此刻的心情」而不是「情绪与动机」。
TAG_DIMENSION_LABELS: dict[int, str] = {
    1: "学段与身份",
    2: "在学什么",
    3: "知识掌握",
    4: "卡在哪里",
    7: "怎么讲更好",
    8: "兴趣与类比",
    9: "此刻的心情",
    10: "互动偏好",
    11: "场景与目标",
    12: "安全边界",
    13: "类型与性格",
}

#: 学段 → 中文名（**后端唯一来源**，时间线/报告叙事用它拼「从 X 变成 Y」）。
#: ★ 为什么要放这里：在它之前，这四个中文名只散落在各处的**注释与日志**里
#:   （「调为小学低年级（0.75）」这类），没有任何可 import 的映射 ——
#:   时间线要拼给学生看的句子，就必须有一个不靠散文的来源。
GRADE_LEVEL_LABELS: dict[str, str] = {
    "primary_low": "小学低年级",
    "primary_high": "小学高年级",
    "junior": "初中",
    "senior": "高中",
}

#: 白名单键 → 中文名。
#: ★ 刻意放后端（契约书 §2.1）：渲染层每个字符串字面量都会被 kp-slug 守卫扫到，
#:   中文名从后端来，守卫与界面天然不打架。
TAG_LABELS: dict[str, str] = {
    "anon_student_id": "匿名标识",
    "grade_band": "学段档位",
    "subject": "学科",
    "course_module": "课程模块",
    "current_topic": "当前话题",
    "knowledge_point": "知识点",
    "mastery": "掌握度",
    "error_type": "错误类型",
    "zpd_level": "难度档",
    "explain_style": "讲解风格",
    "output_length": "输出长度",
    "pace": "节奏",
    "practice_type": "练习方式",
    "interest_topic": "兴趣话题",
    "emotion": "情绪",
    "intensity": "情绪强度",
    "trigger": "情绪来源",
    "confidence": "置信度",
    "tone": "语气",
    "encouragement_freq": "鼓励频率",
    "challenge_level": "挑战程度",
    "scene": "场景",
    "task_goal": "任务目标",
    "safety_level": "安全级别",
    "boundary_topics": "边界话题",
    # 维度 13（2026-09-30）
    "learner_style": "学习类型",
    "personality": "性格",
}

#: ★★ 学习档案右栏「五行结构」的行标题与空态文案（2026-09-30 新增）。
#:
#: ★ 为什么放后端（不是渲染层硬编码）：本项目双视角纪律（D-063）要求**学生面每个中文字
#:   都由后端给** —— 渲染层写死一个行标题，就等于在渲染层留了一个会被
#:   `student-view-discipline` 守卫扫到的字符串字面量，那条守卫的口径就会被撕开。
#:   五行是「固定行」而不是按维度分组：行的**主题**（类型 / 性格 / 偏好 / 兴趣 / 小结）
#:   与 `TAG_DIMENSION_LABELS` 是两套口径（一行的数据可能来自多个维度，见 PORTRAIT_ROW_KEYS）。
PORTRAIT_ROW_LABELS: dict[str, str] = {
    "style": "类型",
    "personality": "性格",
    "preference": "偏好",
    "interest": "兴趣",
    "summary": "小结",
}

#: 每一行从哪些白名单键取数据（**唯一的映射真相**，渲染层不写任何键名分组）。
#: ★ 顺序即展示顺序；同一行里的多个键值用「 · 」连成一句（拼接在渲染层做，
#:   但**行标题与键名都不由渲染层决定** —— 它只按本表取数与拼接）。
#: ★ `summary` 行**不在本表**：它的数据不是标签值，而是 AI 小结（另一条读通道），
#:   所以下面单列一行说明。
PORTRAIT_ROW_KEYS: dict[str, tuple[str, ...]] = {
    "style": ("learner_style",),
    "personality": ("personality",),
    # 偏好 = 维度 7「怎么讲更好」（四键）+ 维度 10「互动偏好」（三键）
    "preference": (
        "explain_style",
        "output_length",
        "pace",
        "practice_type",
        "tone",
        "encouragement_freq",
        "challenge_level",
    ),
    # 兴趣 = 维度 8「兴趣与类比」+ 维度 11「场景与目标」
    "interest": ("interest_topic", "scene", "task_goal"),
}

#: 五行各自的**空态文案**（没有数据时显示，说的是「下一步做什么」，不是「无数据」）。
#: ★ 与 `StudyPortrait.vue` 既有的空态哲学一致：一个空面板会被学生读成「这里坏了」。
#: ★ 五行里 `summary`（AI 小结）的空态由小结那条读通道自己带（它知道「还没生成」）。
PORTRAIT_EMPTY_NOTES: dict[str, str] = {
    "style": "还不知道你属于哪一种，多练几道题我就看出来了。",
    "personality": "这个还没聊到，你愿意说的话我就记下来。",
    "preference": "还不知道你喜欢我怎么讲，告诉我一声？",
    "interest": "还没发现你喜欢什么，跟我说说你感兴趣的事吧。",
    "summary": "我们再聊几次，我就给你写一段小结。",
}


class OnboardingAnswerRequest(CamelModel):
    """POST /api/onboarding/{student_id}/answer 的请求体。

    ★ question_id 与 TS 的 OnboardingQuestionId 同形：**一条回答属于哪一问由位置决定**，
      不解析正文（见执行报告 §1.2）。
    """

    question_id: OnboardingQuestionId
    #: 学生原话（Q5 的称呼也走它入库为 onboarding_qa；真名另由主进程脱敏后落 identity_local）。
    answer_text: str = Field(max_length=400)
    session_id: str | None = Field(default=None, max_length=128)


class OnboardingStateOut(CamelModel):
    """引导状态出参（GET state / POST answer 共用；票 31 删掉了 POST skip）。"""

    onboarding_state: OnboardingState
    #: 已收齐的问号（重答是覆盖，不追加）。
    answered: list[OnboardingQuestionId] = Field(default_factory=list)
    #: 下一问；None = 不该再弹了（状态 done，或五问已齐）。
    #: ★ 票 31：done 是**唯一**终态；历史的 skipped 按「没答完」处理，照常给下一问。
    next_question_id: OnboardingQuestionId | None = None
    #: 供 {{student_name}} 本地替换的称呼（已过 safe_display_name）。
    display_name: str = ""


class OnboardingAnswerOut(CamelModel):
    """POST answer 的回执：accepted + 最新状态（主进程据此推 onboarding:changed）。"""

    accepted: bool = True
    state: OnboardingStateOut


class OnboardingAnswerItem(CamelModel):
    """一条五问问答（GET answers 的元素）。

    ★ 正文与 ``onboarding_qa`` **同源**：脱敏在写入侧（主进程）已经做过，这里只回读，
      不收窄、不改写；问句原文**不回传**（主进程有唯一脚本，配对在那边做，
      少一处会漂的副本）。
    """

    question_id: OnboardingQuestionId
    #: 学生原话（写入时已由主进程 sanitizeStudentText 处理过）。
    answer_text: str


class OnboardingAnswersOut(CamelModel):
    """GET /api/onboarding/{student_id}/answers 的出参（冷启动概括补跑用）。"""

    answers: list[OnboardingAnswerItem] = Field(default_factory=list)


class ProfileTagUpdateRequest(CamelModel):
    """PUT /api/profile/{student_id}/tags/{key} 的请求体。"""

    value: str = Field(max_length=200)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    source: TagSource = "declared"


class RefreshApplyTag(CamelModel):
    """一条要应用的概括结果（持续画像迭代的批量条目）。

    ★ **没有 `reason` / `evidence` 字段**：概括的「为什么这么猜」是**过程**，
      不是要长期留存的**画像**。留一个自由文本字段 = 多一个把对话正文
      （乃至助手复述的 PII）塞进画像的侧门 —— 与 `learning_history` 不存正文同一条纪律。
    """

    #: 必须 ∈ LLM_VISIBLE_TAGS（路由层再过一遍白名单，非白名单 → 422）。
    key: str = Field(min_length=1, max_length=64)
    #: 值 ≤ 200 字（与 :class:`ProfileTagUpdateRequest` 同口径，单行化在存储层做）。
    value: str = Field(min_length=1, max_length=200)
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    #: ★ 只允许观察 / 推断两种：概括**绝不能**产生 `declared`
    #:   （declared 只能来自五问那条真实自述路径；让 LLM 自称"学生说过"是伪造来源）。
    source: TagSource = "inferred"

    @model_validator(mode="after")
    def _no_declared(self) -> RefreshApplyTag:
        if self.source == "declared":
            raise ValueError(
                "概括结果不得声明 source='declared'（学生自述只能来自五问路径，不得伪造）"
            )
        return self


class RefreshApplyRequest(CamelModel):
    """POST /api/profile/{student_id}/tags/refresh-apply 的请求体。

    批量应用一次「持续画像迭代」概括出来的标签。**逐条独立**：某一条不合法
    （非白名单 / 取值域 / 被分档拒绝）不影响其它条 —— 与 `sync_observed_tags`
    的「逐条独立」同一条纪律（概括是尽力而为的增强，不该整体失败）。
    """

    #: 条目上限（与 TS 的 `REFRESH_MAX_TAGS` 同口径）：持续迭代是**小步修正**，
    #: 一次改一大片说明模型在编。超限直接 422，而不是静默截断 ——
    #: 静默截断会让「模型编了 20 条」这件事看起来像正常（前 8 条照写）。
    tags: list[RefreshApplyTag] = Field(min_length=1, max_length=8)
    #: 只用于日志（这条概括是哪一轮触发的）；不入库。
    reason: str = Field(default="", max_length=120)


class RefreshRejectOut(CamelModel):
    """一条被拒的概括结果（`reason` 是**封闭短标签**，不是异常文本）。"""

    key: str
    #: 白名单外 / 取值域非法 / 现有为学生自述 / 系统观察优先 / 置信度未提升 / 记忆开关已关。
    reason: str


class RefreshApplyOut(CamelModel):
    """refresh-apply 的回执：逐条结果 + 应用后的最新投影。

    ★ 为什么回**逐条结果**而不是只回一个计数：概括是**尽力而为**的，
      客户端（与运维）需要看得见「哪几条被分档拒绝了、为什么」，
      否则「模型每轮都在猜同一个键、每轮都被 declared 挡住」这类静默空转
      永远发现不了。`rejected` 里的 `reason` 是**封闭短标签**（见
      `app/routes/profile.py` 的 `_refresh_reject_reason`），不是自由文本。
    """

    #: 实际写入的键（去重后）。
    applied: list[str] = Field(default_factory=list)
    #: 被拒的 `[{key, reason}]`（白名单 / 取值域 / 分档 / memory_switch）。
    rejected: list[RefreshRejectOut] = Field(default_factory=list)
    #: 应用后的完整投影（与 GET /tags 同形，前端可直接换掉 store）。
    tags: list[ProfileTagOut] = Field(default_factory=list)
    parent_consent: bool = True
    memory_switch: bool = True
    #: 维度序号 → 中文名（与 `ProfileTagsOut` 同形，前端换 store 时不必再拉一次）。
    dimension_labels: dict[str, str] = Field(default_factory=lambda: {
        str(dim): name for dim, name in TAG_DIMENSION_LABELS.items()
    })


class ProfileTagOut(CamelModel):
    """一条对外的画像标签。"""

    key: str
    value: str
    confidence: float | None = None
    source: TagSource
    #: Unix **毫秒**（库里是秒，路由层用 to_contract_ms 换算）。
    ts: int = 0
    dimension: int = 0
    label: str = ""


class ProfileTagsOut(CamelModel):
    """GET /api/profile/{student_id}/tags 的响应。

    ★ parent_consent=False 时 tags **为空数组**（G-G）：落库本身不算外发，这一层才算。
    ★ 两道闸都回给前端：设置页要据此显示开关的当前状态。
    """

    tags: list[ProfileTagOut] = Field(default_factory=list)
    parent_consent: bool = True
    memory_switch: bool = True
    #: 维度序号 → 中文名（**后端唯一来源**，画像卡按它给每一组标签起小标题）。
    #: ★ 它随 tags 一起下发，而不是让渲染层自己拼：渲染层写维度名 = 在渲染进程里
    #:   留一批内部标识（kp-slug 守卫会当场报出来）。键是**字符串化的序号**，
    #:   因为 JSON 对象的键只能是字符串（前端按 group.dimension 去查时转一下）。
    #: ⚠️ 只回**有标签的那几维**的名字没必要 —— 一次全给更简单，前端按需取。
    dimension_labels: dict[str, str] = Field(default_factory=lambda: {
        str(dim): name for dim, name in TAG_DIMENSION_LABELS.items()
    })
    #: ★★ 学习档案右栏「五行结构」的展示口径（2026-09-30 新增）。三个都由后端给 ——
    #: 双视角纪律（D-063）要求**学生面的行标题与文案不由渲染层写**：
    #:   · `portrait_row_labels` —— 每行的标题（类型 / 性格 / 偏好 / 兴趣 / 小结）；
    #:   · `portrait_row_keys`   —— 每行从哪些白名单键取值（**行↔键映射的唯一真相**，
    #:     渲染层只按它取数与拼接，不自己决定「偏好包含哪些维度」）；
    #:   · `portrait_empty_notes`—— 每行没有数据时的空态文案（说下一步，不说「无数据」）。
    #: ⚠️ 三张表都**全量下发**（不管该生有没有对应标签）：与 dimension_labels 同一条理由 ——
    #: 一次全给更简单，渲染层按需取；空态文案也只有在没数据时才用得上。
    portrait_row_labels: dict[str, str] = Field(
        default_factory=lambda: dict(PORTRAIT_ROW_LABELS)
    )
    portrait_row_keys: dict[str, list[str]] = Field(
        default_factory=lambda: {key: list(keys) for key, keys in PORTRAIT_ROW_KEYS.items()}
    )
    portrait_empty_notes: dict[str, str] = Field(
        default_factory=lambda: dict(PORTRAIT_EMPTY_NOTES)
    )


#: 学习活动类型 → **学生面中文**（唯一来源；`learning_history.activity` 的四个取值）。
#: ★ 为什么放后端：这一列直接当「学习历史」每一条的**动作说明**给学生看 ——
#:   渲染层写死一份映射就是第二份真相（与 `TAG_LABELS` 同一条纪律）。
#: ★ 措辞是「他做了什么」（一句话），不是活动名 —— `qa` / `animation` 这类内部标识
#:   一个都不出现在学生面。
#: ⚠️ 这份字典的**键集合**就是「合法活动」的判据（守卫断言它等于 `LearningActivity`
#:   的取值集合）—— 所以新增活动类型时改这里一处即可，不另立第二份清单。
LEARNING_ACTIVITY_LABELS: dict[str, str] = {
    "qa": "问了一个问题",
    "animation": "看了一段动画",
    "coding": "写了一段代码",
    "quiz": "做了一道题",
}


class LearningEventEntry(CamelModel):
    """一条学习记录（学习历史明细）。

    ★★ 只给**结构化列**；两个库里的列刻意不给：
      · `question` —— 恒为空串（G-K「SQLite 不存对话正文」），本来就没内容；
      · `detail` —— 内部 JSON 摘要（闯关解锁标记等），**学生面不该看到内部载荷**。
      能给人的只有四件事：**什么时候、做了什么、关于哪个知识点、结果如何**。
    """

    id: int
    #: Unix **毫秒**（库里是秒，路由层用 `to_contract_ms` 换算）。
    at: int = 0
    activity: LearningActivity
    #: 学生面中文（后端给；渲染层不写这份映射）。
    activity_label: str = ""
    #: 关联知识点；空串 = 这条不挂在具体知识点上（如纯答疑）。
    kp_id: str = ""
    #: 只有 `activity == "quiz"` 才有意义；其余为 `None`
    #: （**不写 False** —— 那读起来像「答错了」，而没判分的活动根本无对错）。
    is_correct: bool | None = None


class LearningEventHistoryOut(CamelModel):
    """GET /api/profile/{student_id}/history 的响应（**倒序分页**：最新的在前）。"""

    student_id: str
    events: list[LearningEventEntry] = Field(default_factory=list)
    #: 符合条件的**总条数**（与 `events` 的长度不同：这一页只回 `limit` 条）。
    total: int = 0
    #: 还有没有下一页（= `offset + len(events) < total`）。
    has_more: bool = False


class IdentityFlagsRequest(CamelModel):
    """PUT /api/profile/{student_id}/identity/flags 的请求体（设置页开关 + 称呼落盘）。

    ★ `real_name` 为什么要挂在这里（集成期裁决）：
      它是**身份层的一次显式写入**，与两道闸同属 `identity_local`。再开一条独立端点
      只会让「谁在写 identity_local」多一个入口 —— 而这个模块的整个安全论证
      建立在「身份层只有一个写入面」上（见 store/learning.py 的 set_real_name）。
      ⚠️ 语义上它不是闸：写称呼**不看** `memory_switch`（不记画像 ≠ 忘掉称呼）。

    ★★ 渲染层**拿不到**这个字段的写权限：IPC 的 `identity:flags-set`
      只放行两道闸（`main/ipc/handlers-data.ts` 的白名单过滤），
      写称呼的只有**主进程的引导链路**。所以「渲染进程能不能改真名」的答案是结构性的「不能」。
    """

    parent_consent: bool | None = None
    memory_switch: bool | None = None
    #: 学生自述的称呼（主进程已过一遍脱敏；服务端再经 safe_display_name 兜底）。
    real_name: str | None = Field(default=None, max_length=DISPLAY_NAME_MAX_CHARS)

    @model_validator(mode="after")
    def _at_least_one(self) -> IdentityFlagsRequest:
        if self.parent_consent is None and self.memory_switch is None and self.real_name is None:
            raise ValueError(
                "parentConsent / memorySwitch / realName 至少要给一个（都不给等于空操作）"
            )
        return self


class IdentityOut(CamelModel):
    """GET /api/profile/{student_id}/identity 的响应。

    ★ real_name 只给**渲染层做本地替换**；任何 prompt 都不许读它（G-C）。
    ★ display_name 是 real_name 过 safe_display_name 之后的安全值（可能是「同学」）。
    """

    anon_student_id: str
    real_name: str = ""
    display_name: str = ""
    parent_consent: bool = True
    memory_switch: bool = True
    onboarding_state: OnboardingState = "not_started"


#: 时间线事件的类别（封闭词表）。
#: ★ 只有三类，各自对应**一处真实存在的时间序列**（见 routes/profile.py 的 _timeline_events）。
TimelineEventKind = Literal["grade", "tag", "onboarding"]

#: 标签变更的**出处**（origin，迁移 v7，封闭词表）。
#: ★ 与 tag 的 `source`（可信度）正交：source 说「多可信」，origin 说「从哪条路来的」。
#: ★★ 空串是一个**真实取值**：v7 之前的旧行 origin 为 NULL（当时还没这个概念），
#:    读取侧把它折成空串 —— 表示「这条变更发生时还没记出处」。不编造一个枚举值去填。
TagOrigin = Literal["cold_start", "refresh", "projection", ""]


class ProfileTimelineEvent(CamelModel):
    """画像时间线上的一件事（§5.2 #11「画像变化时间线」）。

    ★ 面向学生/家长：title 与 detail 都是**已经拼好的中文**，界面直接渲染。
      为什么在后端拼：渲染层的每个字符串字面量都被 kp-slug 守卫扫到，
      把「学段从小学高年级变成初中」这类句子写在渲染层等于给它开洞（契约书 §2.1 同一条理由）。
    ★ 不含任何内部 id 作为可读正文：标识只可能出现在 key 字段里，
      而 key 是给界面分组用的，不是给学生看的。
    """

    #: 事件时间（Unix **毫秒**，与本项目其它出参同单位）。
    at: int
    kind: TimelineEventKind
    #: 一句话标题（学生面可读）。
    title: str
    #: 补充说明（可为空）。
    detail: str = ""
    #: 标签键（只有 kind=tag 才有；界面据此分组/上色，**不直接显示**）。
    key: str = ""
    #: 标签中文名（后端唯一来源，同 TAG_LABELS）。
    label: str = ""
    #: 标签变更的出处（只有 kind=tag 才有；∈ TagOrigin）。
    #: ★ 空串 = 「这条变更发生时还没记出处」（v7 之前的旧行）或非标签事件 ——
    #:   界面据此**不显示**出处徽标，而不是显示一个内部枚举名。
    origin: TagOrigin = ""


class ProfileTimeline(CamelModel):
    """``GET /api/profile/{student_id}/timeline`` 的响应（§5.2 #11）。

    ★ ``events`` **新的在前**（界面上最近发生的事在最上面）。
    ★ 空数组是正常值：新学生还没发生过任何变化，或家长关了同意闸（G-G）。
    ★ **不跨学生**（禁做 #9）：端点只按一个 student_id 取数，结构上没有第二名学生的位置。
    """

    student_id: str
    events: list[ProfileTimelineEvent] = Field(default_factory=list)


#: 五问的问句脚本（落 onboarding_qa.question_text，便于事后核对口径变更）。
#: ★ 与 TS 的 ONBOARDING_QUESTIONS 同源：问句是「助手消息」不是卡片，这里只是审计副本。
ONBOARDING_QUESTION_TEXTS: dict[str, str] = {
    "q1": "你现在上几年级呀？",
    "q2": "最近在学什么呀？有没有特别想搞懂的？",
    "q3": "我讲的时候，你更喜欢哪种方式？",
    "q4": "想讲快一点还是慢一点？",
    # ★ 2026-10-01 换题：q5 从「称呼」换成兴趣/动机（称呼改由账号门在建号时写）。
    #   这里只是 onboarding_qa.question_text 的审计副本，必须与 TS 的 ONBOARDING_QUESTIONS 同源，
    #   否则事后核对时会看到一句学生从没见过的问题。
    "q5": "除了学习，你平时还喜欢琢磨什么？",
}


class GeneratedCodeSaveRequest(CamelModel):
    """``POST /api/code/generated/{student_id}`` 的请求体（D-089）。

    ★ 谁填哪个字段：`title/expectedBehavior/scaffold/expectedOutput/hints/solution` 由**模型**产出；
      `kpId/gradeLevel` 由**主进程**按会话填（学生身份与学段不由模型说了算）；
      `promptHash` 也由主进程算（学生原话不进库 —— 与动画库同一条合规口径）。
    ★ 服务端会**再校验一遍**（缺 TODO / 提示不是三级 / 第 1 级带代码…一律 422），
      校验规则在 `routes/code.py` 的 `validate_generated_code_template`。
    """

    kp_id: str
    grade_level: str
    title: str = ""
    expected_behavior: str
    scaffold: str
    expected_output: str = ""
    hints: list[dict] = Field(default_factory=list)
    solution: str = ""
    prompt_hash: str


CONTRACT_MODELS: tuple[type[BaseModel], ...] = (
    GeneratedCodeSaveRequest,
    # 对话式冷启动画像（票 25/28）：白名单投影的读写契约。
    # ★ 没有 identity_local 的本地身份模型 —— 那些列没有出口（G-B/G-C）。
    OnboardingAnswerRequest,
    OnboardingStateOut,
    OnboardingAnswerOut,
    # 补概括的只读出口（W8 / task-47）：只回五问正文；问句原文不回传（本地配对）。
    OnboardingAnswerItem,
    OnboardingAnswersOut,
    ProfileTagUpdateRequest,
    ProfileTagOut,
    ProfileTagsOut,
    IdentityFlagsRequest,
    IdentityOut,
    # 画像变化时间线（§5.2 #11）：profile_tags 只存当前值，过程由历史表回答。
    ProfileTimelineEvent,
    ProfileTimeline,
    # 持续画像迭代（二期）：概括结果的批量应用。
    # ⚠️ 二期漏登记了这四个（当时只跑了 test_profile_tags，没跑 test_contracts）——
    #    2026-09-30 三期跑全量时被 `test_every_camel_model_in_this_module_is_registered`
    #    当场逮到（它们会静默缺席 OpenAPI/TS）。登记守卫的价值正在于此。
    RefreshApplyTag,
    RefreshApplyRequest,
    RefreshRejectOut,
    RefreshApplyOut,
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
    ProviderModelsRequest,
    ProviderModelsResult,
    LlmRuntimeConfig,
    # 学生与画像
    Student,
    StudentCreateRequest,
    # 账号 CRUD 的另一半：改（PATCH）/ 删（DELETE）；不登记会静默缺席 OpenAPI/TS
    StudentUpdateRequest,
    StudentDeleteResult,
    Mastery,
    StudentProfile,
    PreferenceUpdateRequest,
    ChapterUpdateRequest,
    ChapterStateOut,
    # 主动发起对话（需求原文要求）：新会话的开场引导。
    # ★ 它不是 6 事件之一，也不走对话请求 —— 那是「会话建立」这一步的产物。
    OpeningGuidance,
    # 学段轨迹（报告与汇报的叙事素材；`routes/grade.py` 与报告轨**共用这一份**）
    GradeHistoryEntry,
    # 学习档案：章节 / 依赖图全览 / 错题本 / 学习报告
    ChapterInfo,
    ChapterListResponse,
    # 教材知识库：知识点清单 / 体检数字 / 导入 / 重建
    KnowledgePointItem,
    KnowledgePointListResponse,
    KnowledgeStats,
    KnowledgeImportRequest,
    KnowledgeImportResponse,
    KnowledgeRebuildResponse,
    GraphNode,
    GraphEdge,
    GraphOverview,
    MistakeItem,
    MistakeListResponse,
    DailyActivity,
    ChapterProgress,
    LearningReport,
    # 检索与引用
    Citation,
    RagHit,
    RagSearchRequest,
    RagSearchResult,
    RagLevelAttempt,
    DepNode,
    # 学段信号
    GradeSignal,
    GradeSignals,
    GradeOverrideRequest,
    GradeOverrideResponse,
    # 六个 Extension 的 payload
    AnimationPayload,
    # 学生动画库（生成物按学生存下来、按学段隔离、可复用可删除）
    AnimationSaveRequest,
    AnimationSavedItem,
    AnimationSavedView,
    AnimationSavedListResponse,
    AnimationSavedLookupRequest,
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
    # 学习历史（2026-09-30）：明细出参两件套（学习档案 → 学习历史分页）。
    LearningEventEntry,
    LearningEventHistoryOut,
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
#: ⚠️ 本模块里每个 `Literal` 别名都要登记（否则它只会以内联 enum 出现在别的模型里，
#: TS 侧拿不到具名类型）—— `tests/test_contracts.py` 会逐个点名断言。
CONTRACT_ENUMS: dict[str, object] = {
    "GradeLevel": GradeLevel,
    "IpcEventName": IpcEventName,
    "EmbeddingMode": EmbeddingMode,
    "PayloadKind": PayloadKind,
    "Degraded": Degraded,
    "LearningActivity": LearningActivity,
    "ProgressStage": ProgressStage,
    "QuizQuestionType": QuizQuestionType,
    "DepRelation": DepRelation,
    "DepDirection": DepDirection,
    "GradeSignalType": GradeSignalType,
    "PreferenceKey": PreferenceKey,
    # 推荐来源（`/recommendation` 与 `/opening` 共用）：前端按它决定提示语方向
    "RecommendationSource": RecommendationSource,
    # 冷启动画像（票 25）：来源 / 情绪取值域 / 引导状态 / 问号。
    # ★ EmotionValue 即使当前没有模型字段引用它也要登记：渲染层要用具名联合类型，
    #   否则它只会以内联 enum 出现在别处（TS 侧只能手写一份「差不多的字符串联合」）。
    "TagSource": TagSource,
    "EmotionValue": EmotionValue,
    "OnboardingState": OnboardingState,
    "OnboardingQuestionId": OnboardingQuestionId,
    # 画像变化时间线（§5.2 #11）：事件类别要具名，界面的分组/配色按它走。
    "TimelineEventKind": TimelineEventKind,
    # 标签变更出处（迁移 v7）：与 TimelineEventKind 同一条理由 ——
    # 它是 tag 事件的第二个维度（冷启动 / 持续迭代 / 行为投影），界面的配色按它走。
    "TagOrigin": TagOrigin,
    # 维度 13（2026-09-30）：学习类型与性格的取值域 —— 与 EmotionValue 同一条理由，
    # 即使当前没有模型字段直接引用它们，渲染层也要用**具名**联合类型。
    "LearnerStyleValue": LearnerStyleValue,
    "PersonalityValue": PersonalityValue,
}
