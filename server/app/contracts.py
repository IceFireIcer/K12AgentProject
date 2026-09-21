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
- 学生与画像：`Student` / `Mastery` / `StudentProfile` / `PreferenceUpdateRequest`
  （学习偏好的**唯一写入口径**：封闭键词表 `PreferenceKey` + ≤ 40 字单行值）；
- 检索与图：`Citation` / `RagSearchRequest` / `RagSearchResult` / `DepNode`；
- 学段信号：`GradeSignal` / `GradeSignals` / `GradeOverrideRequest` / `GradeOverrideResponse`；
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
#: | ``graph`` | 依赖图后继（掌握某知识点后往前推） |
#: | ``cold_start`` | 全新学生：给图里的入口知识点 |
#: | ``empty`` | 推不出内容（知识库不可用 / 已全部掌握）—— **不发开场**，不是错误 |
RecommendationSource = Literal["review", "graph", "cold_start", "empty"]


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
    ProviderModelsRequest,
    ProviderModelsResult,
    LlmRuntimeConfig,
    # 学生与画像
    Student,
    StudentCreateRequest,
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
    DepNode,
    # 学段信号
    GradeSignal,
    GradeSignals,
    GradeOverrideRequest,
    GradeOverrideResponse,
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
}
