"""★ 接口契约唯一来源（pydantic）。

（对应 `项目执行文档.md` 第 6 节；S02 冻结）

约束与约定
----------
1. **这是唯一手写契约的地方**。前端 TS 类型由
   `scripts/export_openapi.py` → `openapi-typescript` 生成到
   `desktop/src/shared/api-types.ts`，**不手改**。
   改了本文件必须重跑生成脚本（见 `scripts/gen_api_types.py`）。
2. **字段命名只做一次约定**：Python 侧 `snake_case`，出参统一 `camelCase`
   （由 `CamelModel.alias_generator=to_camel` + `populate_by_name=True` 实现，
   入参两种写法都收，出参一律 camelCase）。
3. **请求模型 `extra="forbid"`**：前端多传/少传字段立刻 422，这是防契约漂移的
   第一道闸门（比运行期 KeyError 早得多）。
4. **凭据字段标注 `SecretStr`/`repr=False`**：`LlmConfig.api_key` 等不得随
   `repr` / 日志泄露（配合 `app/redact.py` 的全局日志过滤器）。
5. **枚举值即持久化值**：`GradeLevel` 等字符串枚举的字面量会写进 SQLite 与
   日志，改名等于数据迁移，不要随手改。
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

# --------------------------------------------------------------------------- #
# 基础：camelCase 基类
# --------------------------------------------------------------------------- #


class CamelModel(BaseModel):
    """全契约基类：snake_case 入参 / camelCase 出参，未知字段直接拒绝。

    ⚠️ **不开全局 `str_strip_whitespace`**：学生提交的代码前后空白/缩进是有意义
    的内容，全局 strip 会静默改坏代码。只对明确需要 trim 的字段逐个加
    `field_validator`（见 `LlmConfig._trim`）。
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class GradeLevel(str, Enum):
    """学段。**由前端按钮切换并随请求传入**；SubAgent 不得自行推断（AGENTS §5.1）。"""

    PRIMARY_LOW = "primary_low"  # 小学低年级（1–3 年级）
    PRIMARY_HIGH = "primary_high"  # 小学高年级（4–6 年级）
    JUNIOR = "junior"  # 初中
    SENIOR = "senior"  # 高中


class Intent(str, Enum):
    """主 Agent 的意图路由结果。四个值对应四种核心交互，无第五种。"""

    QA = "qa"  # 对话答疑
    ANIMATION = "animation"  # 动画讲解
    CODING = "coding"  # 编程环境
    QUIZ = "quiz"  # 游戏化练习


class AnswerKind(str, Enum):
    """`event: payload` 里承载的是哪种 SubAgent 产物。"""

    ANIMATION = "animation"
    CODING = "coding"
    QUIZ = "quiz"


# --------------------------------------------------------------------------- #
# 配置（执行文档 6.2）
# --------------------------------------------------------------------------- #


class LlmConfig(CamelModel):
    """主模型配置（OpenAI 兼容）。

    `base_url` / `model_id` 必须可改：**不得把任何供应商硬编码进代码**
    （执行文档 5.1；答辩时会被问「换供应商要不要改代码」）。
    """

    provider_name: str = Field(
        default="DeepSeek", description="供应商名称，仅用于界面展示，不参与调用"
    )
    base_url: str = Field(
        default="https://api.deepseek.com/v1",
        description="OpenAI 兼容 BaseURL（含 /v1 之类路径前缀）",
    )
    api_key: str = Field(default="", repr=False, description="本地存储；不上传、不入日志")
    model_id: str = Field(default="deepseek-chat", description="模型 ID，如 deepseek-chat")

    @field_validator("provider_name", "base_url", "model_id", "api_key")
    @classmethod
    def _trim(cls, v: str) -> str:
        """凭据与 URL 的粘贴场景极易带上首尾空白/换行，这里统一 trim。"""
        return v.strip()

    @field_validator("base_url")
    @classmethod
    def _check_base_url(cls, v: str) -> str:
        if not v:
            return v
        if not v.startswith(("http://", "https://")):
            raise ValueError("baseUrl 必须以 http:// 或 https:// 开头")
        return v.rstrip("/")


class EmbeddingConfig(CamelModel):
    """嵌入配置。默认本地 fastembed（离线可用）；云端为可选降级路径（执行文档 8.4 [2]）。"""

    mode: Literal["local_fastembed", "cloud_api", "none"] = "local_fastembed"
    base_url: Optional[str] = None
    api_key: Optional[str] = Field(default=None, repr=False)
    model_id: Optional[str] = None


class SettingsResponse(CamelModel):
    """`GET /api/settings` 响应。

    ⚠️ **绝不回传明文 API Key**：返回 `has_key` 与掩码，前端只用来回显「已配置」。
    保存时若 `apiKey` 为掩码原样或为空串，视为「不修改」（见 `app/settings.py`）。
    """

    llm: LlmConfig
    embedding: EmbeddingConfig
    has_key: bool = Field(default=False, description="是否已配置 API Key（不含明文）")
    api_key_masked: str = Field(default="", description="掩码，如 sk-…abcd；从不含完整明文")
    #: 配置文件绝对路径（便于排查，不含敏感内容）。
    config_path: str = ""
    #: 只读：随包分发的嵌入模型 ID，界面用来展示「本地模式用的是哪个模型」。
    embedding_model_id: str = ""


class SettingsUpdateRequest(CamelModel):
    """`PUT /api/settings` 请求。

    API Key 三态语义（**避免「点保存把 key 清空」**）：
    - 传空串或掩码（`…abcd`）→ 保留原值；
    - 传新值 → 覆盖；
    - `clearApiKey=true` → 显式清空（前端「清除密钥」按钮才用）。
    """

    llm: LlmConfig
    embedding: EmbeddingConfig = Field(default_factory=EmbeddingConfig)
    clear_api_key: bool = Field(default=False, description="显式清除 API Key")


# --------------------------------------------------------------------------- #
# 学生与画像（执行文档 6.3 / 8.2）
# --------------------------------------------------------------------------- #


class StudentCreateRequest(CamelModel):
    """`POST /api/students` 请求。**最小化采集**：只要昵称与学段。"""

    nickname: str = Field(min_length=1, max_length=24, description="昵称，不采集真实姓名")
    grade_level: GradeLevel


class Student(CamelModel):
    """学生档案（对应 `student` 表）。"""

    student_id: str
    nickname: str
    grade_level: GradeLevel
    created_at: int = Field(description="Unix 秒")
    last_active_at: int = Field(description="Unix 秒")


class StudentListResponse(CamelModel):
    students: list[Student]


class MasteryItem(CamelModel):
    """单知识点掌握度（对应 `mastery` 表）。"""

    kp_id: str
    kp_name: Optional[str] = Field(default=None, description="知识点中文名，便于界面直出")
    score: float = Field(default=0.0, ge=0.0, le=1.0, description="0..1 掌握度")
    attempts: int = 0
    correct: int = 0
    last_seen_at: Optional[int] = None


class ProgressItem(CamelModel):
    """闯关进度（对应 `progress` 表），S09 使用。"""

    kp_id: str
    stage: Literal["locked", "learning", "quizzed", "mastered"]
    badge: Optional[str] = None
    updated_at: Optional[int] = None


class StudentProfile(CamelModel):
    """`GET /api/profile/{student_id}` 响应：画像 + 掌握度。"""

    student_id: str
    nickname: str = ""
    grade_level: Optional[GradeLevel] = None
    mastery: list[MasteryItem] = Field(default_factory=list)
    weak_points: list[str] = Field(
        default_factory=list, description="薄弱知识点 kp_id，供主 Agent 注入上下文"
    )
    progress: list[ProgressItem] = Field(default_factory=list)
    updated_at: Optional[int] = None


class DepNode(CamelModel):
    """依赖图节点（`GET /api/graph/deps/{kp_id}`）。

    **双用途**（执行文档 8.5，创新点）：
    ① 推荐路径规划（`relation=prerequisite` 反向找前置 / 正向找下一步）；
    ② 检索上下文扩展（把相邻知识点纳入检索范围）。
    """

    kp_id: str
    name: str = ""
    grade_level: Optional[GradeLevel] = None
    relation: Literal["prerequisite", "related"] = "prerequisite"
    weight: float = Field(default=1.0, ge=0.0)
    distance: int = Field(default=1, ge=1, description="相对查询节点的跳数")


# --------------------------------------------------------------------------- #
# 检索引用（SSE `citation` 事件载荷）
# --------------------------------------------------------------------------- #


class Citation(CamelModel):
    """检索命中的引用。

    `compat=True` 表示「允许向上兼容命中了更高学段的内容」——
    **必须显式标注**，前端会展示「已为你补充高年级内容」提示（AGENTS §5.4）。
    """

    chunk_id: str
    chapter_title: str = ""
    section_title: str = ""
    grade_level: GradeLevel
    compat: bool = False


# --------------------------------------------------------------------------- #
# SubAgent 产物 Payload（执行文档 6.5）
# --------------------------------------------------------------------------- #


class AnimationPayload(CamelModel):
    """动画讲解产物。**必须带降级文本**：生成失败也要能讲课（执行文档 11.2）。"""

    concept: str
    html: str = Field(
        default="", description="完整自包含 HTML（内联 Anime.js v3 调用），在 sandboxed iframe 内运行"
    )
    duration_ms: int = Field(default=6000, ge=0)
    fallback_text: str = Field(description="降级为文字讲解（生成失败/沙箱不可用时使用）")
    fallback_image: Optional[str] = Field(
        default=None, description="静态兜底图（SVG dataURL），无网络依赖"
    )
    source: Literal["template", "generated"] = "template"


class CodeTemplate(CamelModel):
    """编程题脚手架。"""

    kp_id: str
    language: Literal["python"] = "python"
    scaffold: str = Field(description="预置代码框架，含 TODO 标记")
    expected_behavior: str


class CodingHint(CamelModel):
    """分级提示（1 最弱、3 最强）。提示要「引导」而不是「给答案」。"""

    level: Literal[1, 2, 3]
    hint: str


class CodeError(CamelModel):
    """代码运行错误（执行文档 6.5 引用但未展开，此处冻结）。"""

    type: str = Field(description="异常类型，如 ZeroDivisionError")
    message: str
    line: Optional[int] = None


class CodeEvaluation(CamelModel):
    """`POST /api/code/run-hint` 响应：评估 + 下一级提示。"""

    ok: bool
    stdout: str = ""
    error: Optional[CodeError] = None
    feedback: str = Field(description="面向学生的中文反馈")
    next_hint: Optional[CodingHint] = None


class QuizQuestion(CamelModel):
    """练习题。"""

    qid: str
    kp_id: str
    type: Literal["choice", "blank", "code_blank"]
    stem: str
    options: Optional[list[str]] = None
    answer: Union[str, list[str]]
    explanation: str


class QuizPayload(CamelModel):
    """出题产物（`event: payload`，kind=quiz）。"""

    kp_id: str
    questions: list[QuizQuestion]
    source: Literal["bank", "generated"] = "bank"


class QuizAnswer(CamelModel):
    """单题作答。"""

    qid: str
    answer: Union[str, list[str]]


class QuizGradeRequest(CamelModel):
    """`POST /api/quiz/grade` 请求（混合批改：客观题规则、主观题大模型）。"""

    student_id: str
    kp_id: str
    answers: list[QuizAnswer]


class QuizResult(CamelModel):
    """单题批改结果。"""

    qid: str
    correct: bool
    scored_by: Literal["rule", "llm"]
    feedback: str
    mastery_delta: float = Field(description="对掌握度的增量，可正可负")


class QuizGradeResponse(CamelModel):
    """`POST /api/quiz/grade` 响应：逐题结果 + 整体掌握度变化。"""

    kp_id: str
    results: list[QuizResult]
    mastery_delta: float = 0.0
    feedback: str = ""


# --------------------------------------------------------------------------- #
# 代码提交（`POST /api/code/run-hint` 请求体）
# --------------------------------------------------------------------------- #


class CodeRunRequest(CamelModel):
    """学生提交的代码与报错。

    ⚠️ 代码**在渲染进程的 Pyodide Worker 里执行**（沙箱要求，AGENTS §5.7）；
    这里只接收执行结果，后端不执行学生代码。
    """

    student_id: str
    kp_id: str
    code: str
    stdout: str = ""
    stderr: str = ""


# --------------------------------------------------------------------------- #
# 对话请求（非流式部分）
# --------------------------------------------------------------------------- #


class ChatRequest(CamelModel):
    """`POST /api/chat/stream` 请求体（执行文档 6.3）。

    - `grade` 由前端按钮决定，**不让模型推断**。
    - `session_id` 为空时后端生成；S04 起作为 LangGraph `thread_id`（跨会话记忆 / 断点续跑）。
    """

    student_id: str
    grade: GradeLevel
    message: str = Field(min_length=1, max_length=4000)
    session_id: Optional[str] = None


# --------------------------------------------------------------------------- #
# SSE 事件契约（执行文档 6.4）
# --------------------------------------------------------------------------- #

#: 6 种事件名（前端解析器与后端发送端都必须用它，禁止裸写字符串）。
SseEventName = Literal["delta", "citation", "payload", "blocked", "done", "error"]

SSE_EVENT_NAMES: tuple[str, ...] = ("delta", "citation", "payload", "blocked", "done", "error")


class SseDeltaData(CamelModel):
    request_id: str
    delta: str


class SseCitationData(CamelModel):
    request_id: str
    citations: list[Citation]


class SsePayloadData(CamelModel):
    request_id: str
    kind: AnswerKind
    payload: dict[str, Any] = Field(description="具体结构由 kind 决定，见 AnimationPayload 等")


class SseBlockedData(CamelModel):
    """内容安全拦截（执行文档 12：流式输出 + 生成结束后整段终审，违规撤回替换）。"""

    request_id: str
    reason: str
    safe_text: str


class SseDoneData(CamelModel):
    request_id: str
    message_id: str


class SseErrorData(CamelModel):
    """降级/异常收尾。**已在流中途，不能改成 HTTP 500**（响应头已发出）。"""

    request_id: str
    message: str
    degraded: bool = False


#: 事件名 → data 模型。用于测试与文档，避免「发了 7 种事件、前端只认 6 种」。
SSE_DATA_MODELS: dict[str, type[CamelModel]] = {
    "delta": SseDeltaData,
    "citation": SseCitationData,
    "payload": SsePayloadData,
    "blocked": SseBlockedData,
    "done": SseDoneData,
    "error": SseErrorData,
}


def mask_secret(value: Optional[str], *, keep: int = 4) -> str:
    """掩码函数（**唯一实现**，禁止各处自己拼）。

    前端回显、日志、API 响应都走它，保证「永远不出现完整明文」。
    """
    if not value:
        return ""
    if len(value) <= keep:
        return "…"
    return f"…{value[-keep:]}"


# --------------------------------------------------------------------------- #
# 契约清单（供 OpenAPI 导出与自检使用）
# --------------------------------------------------------------------------- #

#: 全部对外数据模型。
#:
#: ⚠️ 为什么要显式登记：FastAPI 只会把**路由可达**的模型放进 `components.schemas`。
#: 而 SSE 的 `payload` / `citation` 事件载荷（`QuizPayload`、`AnimationPayload`、
#: `Citation` …）不走 response_model，天然不在 schema 里——前端就会拿不到类型，
#: 只能手写一套，契约立刻漂移。
#:
#: 登记在这里后，`export_openapi.py` 会把它们全部并入 components，
#: `openapi-typescript` 生成 `components["schemas"]["QuizPayload"]` 供前端使用。
#: **新增契约模型必须同时登记到本元组**（`tests/test_contract.py` 会强制检查）。
CONTRACT_MODELS: tuple[type, ...] = (
    # 基础
    GradeLevel,
    Intent,
    AnswerKind,
    LlmConfig,
    EmbeddingConfig,
    SettingsResponse,
    SettingsUpdateRequest,
    # 学生与画像
    StudentCreateRequest,
    Student,
    StudentListResponse,
    MasteryItem,
    ProgressItem,
    StudentProfile,
    DepNode,
    # 检索
    Citation,
    # SubAgent 产物
    AnimationPayload,
    CodeTemplate,
    CodingHint,
    CodeError,
    CodeEvaluation,
    QuizQuestion,
    QuizPayload,
    QuizAnswer,
    QuizGradeRequest,
    QuizResult,
    QuizGradeResponse,
    CodeRunRequest,
    # 对话
    ChatRequest,
    # SSE 事件载荷
    SseDeltaData,
    SseCitationData,
    SsePayloadData,
    SseBlockedData,
    SseDoneData,
    SseErrorData,
)

