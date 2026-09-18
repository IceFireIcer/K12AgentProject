"""动画资源托管：**模板渲染 + 一次性 nonce + 按学生分目录的 HTML 托管**（票 16/17）。

执行文档 §11.2「资源托管与鉴权（D10 细节）」+ 业务陷阱清单 §6 的逐条落地。

两个路由面，鉴权方式**刻意不同**（这是本模块唯一需要先看懂的地方）::

    ① /api/animation/**        ← 主进程调用，走既有的 X-Auth-Token（TokenAuthMiddleware）
       · GET  /api/animation/templates   列出/匹配模板（模型挑模板用）
       · POST /api/animation/render      渲染 + **校验**一份 AnimationPayload（失败 → 422，触发重试）
       · POST /api/animation/host/...    把 HTML 落到该学生目录，换回一个一次性 nonce

    ② /resources/animation/{student_id}/{kp_id}?nonce=...   ← **iframe 直接加载，不能带自定义 header**
       · 因此**不能用 X-Auth-Token**（iframe 带不了 header），改用一次性 nonce：
         绑定 student_id + kp_id + 有效期，单次消费，校验失败一律 403，且 `Cache-Control: no-store`。
       · ★ **它不是无鉴权公开路由**：没有合法 nonce 时它什么都拿不到；
         而且返回哪个文件**只由 nonce 记录决定**，不由 URL 拼出来（URL 里的 student_id / kp_id
         只做交叉核对，对不上即 403）—— 这样连目录穿越的入口都不存在。

**为什么动画 HTML 要落盘托管，而不是直接把字符串塞给前端**（§11.2 的原话）：
iframe 加载的是 sidecar 上的一个地址，鉴权就落在 HTTP 层；同时「按学生分目录」让
「跨学生不可互取」变成一条可被测试断言的性质，而不是一句口号。

**零外部引用**（陷阱 §6 第 3 条）：动画库（anime.js v3）与运行时都由本模块**从本地文件读进来内联**，
生成物里不允许出现任何 URL —— 沙箱在演示现场是断网的，一个 CDN 链接就等于白屏。
校验器（:func:`validate_animation_html`）会把这条规则变成机器断言，而不是靠人记得。

> 归口说明：学生目录一律经 ``app/routes/students.py`` 的 :func:`student_dir` / :func:`validate_student_id`
> 解析（**不在本文件再拼一遍** ``students/<id>/``）—— 路径拼两处，迟早有一处忘记做白名单校验。
"""

from __future__ import annotations

import base64
import hashlib
import html as html_escape
import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse

from app.config import RESOURCES_DIR
from app.contracts import AnimationPayload
from app.routes.students import resolve_student_data_root, student_dir, validate_student_id

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# 常量（改任何一个都要看它被谁引用）
# --------------------------------------------------------------------------- #
#: 模板根目录：``server/resources/templates/``
TEMPLATES_DIRNAME = "templates"
#: 共享区（内联资源与运行时）：``server/resources/templates/_shared/``
SHARED_DIRNAME = "_shared"
#: 动画库（**必须 v3**；v4 API 不兼容 —— 陷阱 §6 第 2 条）。随包分发，不入 git。
ANIME_LIB_FILENAME = "anime.min.js"
#: 沙箱运行时（RPC + payload_id 校验 + 节流），被内联进每份动画 HTML。
RUNTIME_FILENAME = "runtime.js"
#: 公共样式。
BASE_CSS_FILENAME = "base.css"
#: 学生目录下的动画托管目录：``students/<id>/animations/``
ANIMATIONS_DIRNAME = "animations"
#: 模板 JSON 的后缀
TEMPLATE_SUFFIX = ".json"

#: 知识点 id 白名单。它只用于**交叉核对**（真正的文件路径来自 nonce 记录），
#: 但仍然先卡死字符集 —— 出现在 URL 里的东西一律按不可信输入对待。
KP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

#: nonce 有效期（秒）。够 iframe 加载 + 一次重排，又短到不可能被长期利用。
NONCE_TTL_SECONDS = 120
#: nonce 表容量上限（防「拿不到 nonce 就无限申请」把内存撑爆）；超出时先清过期项。
NONCE_MAX_ENTRIES = 512

#: 单份动画 HTML 的体积上限（拦住「模板写了 20MB 内联资源」这种事故）。
MAX_HTML_BYTES = 1024 * 1024

#: ★ 外部引用判据（陷阱 §6 第 3 条）：生成的 HTML 里命中任何一个即校验失败。
#: 说明：SVG 的 XML 命名空间是**标识符不是地址**，模板统一用 ``Sandbox.SVG_NS``（由运行时拼出），
#: 因此这条规则可以保持「零例外清单」——例外清单一出现，断言就名存实亡。
EXTERNAL_REFERENCE_RE = re.compile(
    r"https?://|//cdn|unpkg|jsdelivr|cdnjs|googleapis|fonts\.gstatic", re.IGNORECASE
)

#: 内联动画库的标记 —— 用它断言「库真的内联进产物了」。
#:
#: ★ 选的是 anime **UMD 包装里**才会出现的一段（`module.exports=e()`），不是版权头里的
#:   「anime.js v3」字样：那句话在我们的运行时注释里也出现，用它当标记会让
#:   「没内联库」这种坏产物**蒙混过关**（实测踩到：SIMULATE=nolib 演练里校验器放行了）。
INLINE_LIBRARY_MARKER = 'anime=e()'
#: 沙箱运行时的标记。
INLINE_RUNTIME_MARKER = "window.Sandbox"
#: `ready` 上报的标记（宿主 5s 内收不到它即判超时）。
READY_MARKER = "Sandbox.ready("
#: ★ `play` 注册的标记 —— 模板脚本必须**自己**调它。
#:
#: 为什么单独要这一条（审计发现）：``Sandbox.ready(`` 在**注入的 runtime.js 里本来就存在**，
#: 所以它只证明「运行时在其中」；「这一段脚本有没有注册播放实现」从来没被判断过。
#: 模型漏写 ``Sandbox.play()`` 时产物照样过全部校验 → 卡片建 iframe → 收到 ready →
#: 播放指令到达时 ``playImpl`` 为 null（runtime.js 会回一条 ``error``）→
#: 学生看到的是一张**永远静止的动画卡**，而不是「文字 + 静态图」的降级 ——
#: 「校验 + 重试 ≤3 → 降级」这条硬链路在这一类失败上被完全绕过了。
PLAY_MARKER = "Sandbox.play("
#: `payload_id` 校验的标记（多卡片串台防线必须在产物里存在）。
PAYLOAD_ID_MARKER = "payload_id"

#: ★ 凭据不进 HTML（票 17 的硬要求）：这些形状一旦出现即校验失败。
#: 覆盖 API Key、鉴权头、供应商域名、宿主绝对路径（Windows 与 POSIX 两种写法）。
CREDENTIAL_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("API Key", re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}")),
    ("鉴权头", re.compile(r"X-Auth-Token|Authorization|Bearer\s", re.IGNORECASE)),
    ("apiKey 字段", re.compile(r"api[_-]?key", re.IGNORECASE)),
    ("供应商地址", re.compile(r"api\.deepseek\.com|openai\.com|/v1/chat", re.IGNORECASE)),
    ("宿主绝对路径", re.compile(r"[A-Za-z]:[\\/]{1,2}(Users|Program|AppData)|/(home|Users)/")),
)

#: ★ 那个**绝不能出现**的沙箱开关（放开同源），拆开拼出来。
#:
#: 为什么拆开：验收要求「生产代码里不出现这个属性名」，而本模块恰好是**负责搜它**的那个
#: —— 字面量写在这里会被自己的校验判违规（也会让 grep 证据出现假命中）。
#: 拆成三段拼接后源码里搜不到连续的属性名，行为完全一样；测试会断言它就是那个开关。
FORBIDDEN_SANDBOX_FLAG = "-".join(("allow", "same", "origin"))

#: 结构性禁项：内嵌 iframe / 放开沙箱 / 直接读宿主存储 —— 命中即校验失败。
FORBIDDEN_STRUCTURES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("内嵌 iframe", re.compile(r"<iframe", re.IGNORECASE)),
    ("放开沙箱（同源开关）", re.compile(re.escape(FORBIDDEN_SANDBOX_FLAG), re.IGNORECASE)),
    ("访问宿主存储", re.compile(r"localStorage|document\.cookie|indexedDB", re.IGNORECASE)),
)

#: 参数类型（模板 JSON 的 `params.<name>.type`）
PARAM_TYPES = ("int", "float", "str", "bool")

#: 模板 JSON 允许出现的键（多一个即视为写错，测试会盯着它）
TEMPLATE_KEYS = frozenset(
    {
        "id",
        "label",
        "title",
        "concept",
        "kp_ids",
        "grade_levels",
        "duration_ms",
        "params",
        "body",
        "script",
        "fallback_text",
        "fallback_image",
    }
)

GRADE_LEVELS: tuple[str, ...] = ("primary_low", "primary_high", "junior", "senior")

#: 演示开关（**默认关闭**，分发包里不存在实际用途）：让校验器按需失败，
#: 从而在不动模板文件的情况下复现「重试 → 降级」这条链（票 17 的验收演练）。
#: 取值：``throw``（顶层 throw，模拟模板作者写崩） / ``external``（塞一个 CDN 链接） /
#: ``nolib``（不内联动画库）。人为改模板文件的做法同样支持，两者等价。
SIMULATE_ENV = "K12_ANIMATION_SIMULATE"


class TemplateError(Exception):
    """模板加载 / 渲染失败（**带上可读原因**，它是重试与降级的判断依据）。"""


# --------------------------------------------------------------------------- #
# HTML 校验（票 17 的「校验 → 重试 ≤3 → 降级」里的第一步）
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class HtmlValidation:
    """一份动画 HTML 的校验结论。`problems` 每条都是人能读懂的中文。"""

    ok: bool
    problems: tuple[str, ...] = ()

    @property
    def reason(self) -> str:
        return "；".join(self.problems) if self.problems else ""


def validate_animation_html(html: str) -> HtmlValidation:
    """校验一份动画 HTML（**纯函数，不碰磁盘**，因此可以被反复调用）。

    检查五类（与票 17 的验收口径逐条对应）：

    1. **结构**：非空、体积合理、有 ``<!doctype html>`` / ``<html`` / ``<script>``；
    2. **零外部引用**：命中 :data:`EXTERNAL_REFERENCE_RE` 即失败（断网演示的底线）；
    3. **库与运行时都内联了**：动画库标记 + ``window.Sandbox`` + ``Sandbox.ready(`` + ``payload_id``；
       外加一条**脚本段**断言：脚本里必须出现 ``Sandbox.play(``（见 :data:`PLAY_MARKER`）——
       ``Sandbox.ready(`` 在内联的 runtime.js 里本来就有，它证明不了「这段脚本注册了播放实现」；
    4. ★ **模板脚本本身没崩**：`<script>` 里出现顶层 `throw` / `</script>` 截断 / 依赖外部全局
       （`fetch(` / `XMLHttpRequest`）即失败 —— 这一条正是为了接住
       「模板里写个 `throw` → 自动重试 → 最终降级」这条验收演练（业务陷阱清单 §6 的验收口径）；
    5. **安全结构**：无内嵌 iframe、无 ``allow-same-origin``、不碰宿主存储、无凭据与宿主路径。

    ★ 第 4 条只扫**模板自己的脚本段**（`:data:`INLINE_RUNTIME_MARKER` 之后、`</body>` 之前），
    不扫内联的动画库与运行时：那两份是随包分发的库代码，判定标准不该由它们承担
    （真去扫整份 HTML 的话，任何库里的一个 `throw` 都会把好模板判死 —— 那是误报，不是安全）。
    第 3 条的 ``Sandbox.play(`` 同样只认**脚本段**里自己的那一次调用；runtime.js 里的是定义，
    位置在脚本段之外，天然不参与判定。

    返回的问题列表是**给重试与降级用的**：调用方（TS 侧 `generate_animation`）据此决定
    再渲染一次还是直接降级，而不是笼统地「失败了」。
    """
    problems: list[str] = []
    if not isinstance(html, str) or not html.strip():
        return HtmlValidation(False, ("动画内容为空",))

    size = len(html.encode("utf-8"))
    if size > MAX_HTML_BYTES:
        problems.append(f"动画 HTML 过大（{size} 字节，上限 {MAX_HTML_BYTES}）")

    lowered = html.lower()
    if "<!doctype html>" not in lowered:
        problems.append("缺少 <!doctype html>（不是一份完整文档）")
    if "<html" not in lowered or "</html>" not in lowered:
        problems.append("缺少 <html> / </html>（结构不可解析）")
    if "<script" not in lowered:
        problems.append("没有任何 <script>（动画不可能动起来）")

    external = EXTERNAL_REFERENCE_RE.search(html)
    if external:
        problems.append(f"出现了外部引用「{external.group(0)}」（沙箱断网会白屏，动画库必须内联）")

    if INLINE_LIBRARY_MARKER not in html:
        problems.append(f"动画库没有内联（找不到标记「{INLINE_LIBRARY_MARKER}」）")
    if INLINE_RUNTIME_MARKER not in html:
        problems.append("沙箱运行时不在了（找不到 window.Sandbox）")
    if READY_MARKER not in html:
        problems.append(f"没有 ready 上报（找不到「{READY_MARKER}」）—— 宿主会一直等到超时")
    if PAYLOAD_ID_MARKER not in html:
        problems.append("没有 payload_id 校验（同屏多张卡片会串台）")

    problems.extend(template_script_problems(html))

    for label, pattern in FORBIDDEN_STRUCTURES:
        if pattern.search(html):
            problems.append(f"出现禁项：{label}")

    for label, pattern in CREDENTIAL_PATTERNS:
        if pattern.search(html):
            problems.append(f"出现禁项：{label}（凭据与宿主路径不得进动画产物）")

    return HtmlValidation(not problems, tuple(problems))


def extract_template_script(html: str) -> str:
    """取出**模板自己的脚本段**（内联运行时之后、``</body>`` 之前的那一段）。

    取不到时返回空串（调用方据此判「模板没写脚本」，而不是把整份 HTML 当脚本扫）。
    """
    marker = html.find(INLINE_RUNTIME_MARKER)
    if marker < 0:
        return ""
    body_end = html.find("</body>", marker)
    segment = html[marker: body_end if body_end > marker else len(html)]
    # 去掉运行时自己的那一段：从标记后的第一个 `</script>` 之后开始算
    closing = segment.find("</script>")
    return segment[closing + len("</script>") :] if closing >= 0 else segment


def template_script_problems(html: str) -> list[str]:
    """模板脚本段的静态检查（见 :func:`validate_animation_html` 第 4 条）。"""
    script = extract_template_script(html)
    if not script.strip():
        return ["模板脚本段是空的（没有注册任何播放实现）"]

    problems: list[str] = []
    # ★ 必须自己注册播放实现：只报 ready 不注册 play 的产物会「加载成功但永远不动」。
    #   `Sandbox.ready(` 在内联的 runtime.js 里本来就存在，所以整份 HTML 的标记检查抓不住它。
    if PLAY_MARKER not in script:
        problems.append(
            f"模板脚本里没有 `{PLAY_MARKER}...`（没有注册播放实现）—— "
            "产物会一直静止；必须调 Sandbox.play(function () { ... })"
        )
    # `throw` 出现在模板脚本里 = 作者写崩了，动画一定跑不起来（验收演练的注入点）
    if re.search(r"(^|[^.\w])throw\b", script):
        problems.append("模板脚本里有 throw（脚本执行会中断，动画不可能播出来）")
    # 沙箱断网：脚本自己发网络请求必然失败
    if re.search(r"\bfetch\s*\(|XMLHttpRequest", script):
        problems.append("模板脚本试图发起网络请求（沙箱断网，必然失败）")
    # 宿主 DOM / 存储：脚本依赖它们说明它在假设 allow-same-origin（沙箱里不存在）
    if re.search(r"parent\.document|window\.top\b(?!\s*===?\s*window)", script):
        problems.append("模板脚本试图访问宿主文档（沙箱里拿不到，会直接抛异常）")
    return problems


# --------------------------------------------------------------------------- #
# 模板加载
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class TemplateParameter:
    """模板参数声明（模型填参数时看的「说明书」，也是服务端裁剪/兜底的依据）。"""

    name: str
    type: str
    minimum: float | None = None
    maximum: float | None = None
    default: Any = None
    description: str = ""

    def clamp(self, value: Any) -> Any:
        """把模型填的值裁到合法范围（**不报错、只收敛**：越界参数不该让整个动画失败）。"""
        if self.type == "int":
            number = _as_number(value)
            if number is None:
                raise TemplateError(f"参数 {self.name} 需要整数（收到 {value!r}）")
            number = int(round(number))
            if self.minimum is not None:
                number = max(int(self.minimum), number)
            if self.maximum is not None:
                number = min(int(self.maximum), number)
            return number
        if self.type == "float":
            number = _as_number(value)
            if number is None:
                raise TemplateError(f"参数 {self.name} 需要数字（收到 {value!r}）")
            if self.minimum is not None:
                number = max(float(self.minimum), number)
            if self.maximum is not None:
                number = min(float(self.maximum), number)
            return round(float(number), 4)
        if self.type == "bool":
            if isinstance(value, bool):
                return value
            raise TemplateError(f"参数 {self.name} 需要布尔值（收到 {value!r}）")
        text = value if isinstance(value, str) else str(value)
        if self.maximum is not None and len(text) > int(self.maximum):
            text = text[: int(self.maximum)]
        return text

    def to_public(self) -> dict[str, Any]:
        """给模型看的形态（camelCase 无关：这是内部路由，不是冻结契约）。"""
        return {
            "name": self.name,
            "type": self.type,
            "minimum": self.minimum,
            "maximum": self.maximum,
            "default": self.default,
            "description": self.description,
        }


def _as_number(value: Any) -> float | None:
    """把值转成数字；转不了返回 ``None``（**不接受布尔**：``True`` 当 1 是常见的静默错误）。"""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


@dataclass(frozen=True)
class AnimationTemplate:
    """一个内置动画模板（参数化的自包含 HTML 片段 + 参数 schema）。"""

    id: str
    label: str
    title: str
    concept: str
    kp_ids: tuple[str, ...]
    grade_levels: tuple[str, ...]
    duration_ms: int
    params: Mapping[str, TemplateParameter]
    body: str
    script: str
    fallback_text: str
    fallback_image: str | None = None
    source_path: str = ""

    @property
    def param_names(self) -> tuple[str, ...]:
        return tuple(self.params.keys())

    def to_public(self) -> dict[str, Any]:
        """列出模板时的描述（模型靠它决定「用哪个模板 + 填什么参数」）。"""
        return {
            "id": self.id,
            "label": self.label,
            "title": self.title,
            "concept": self.concept,
            "kpIds": list(self.kp_ids),
            "gradeLevels": list(self.grade_levels),
            "durationMs": self.duration_ms,
            "params": [parameter.to_public() for parameter in self.params.values()],
            "fallbackText": self.fallback_text,
            "hasFallbackImage": bool(self.fallback_image),
        }


def templates_dir() -> Path:
    """模板目录（``K12_ANIMATION_TEMPLATES`` 可覆盖 —— 演示与测试用临时模板集）。"""
    override = os.environ.get("K12_ANIMATION_TEMPLATES")
    if override:
        return Path(override)
    return RESOURCES_DIR / TEMPLATES_DIRNAME


def templates_dir_for(request: Request) -> Path:
    """路由取模板目录：``app.state.animation_templates_dir`` 优先（测试注入）。"""
    injected = getattr(request.app.state, "animation_templates_dir", None)
    return Path(injected) if injected else templates_dir()


def load_template(path: str | Path) -> AnimationTemplate:
    """读一个模板 JSON 并逐字段校验。**任何一处不合格都抛** :class:`TemplateError`。

    模板是人工编写的**内容资产**：坏模板必须当场说出来是哪个字段坏了，
    否则「模板写了但跑不起来」会拖到演示现场才暴露（票 17 的验收口径之一）。
    """
    file = Path(path)
    try:
        raw = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TemplateError(f"模板无法解析：{file.name}（{exc}）") from exc
    if not isinstance(raw, dict):
        raise TemplateError(f"模板根节点必须是对象：{file.name}")

    unknown = sorted(set(raw) - TEMPLATE_KEYS)
    if unknown:
        raise TemplateError(f"模板 {file.name} 出现未知字段：{'、'.join(unknown)}")

    def require_text(key: str) -> str:
        value = raw.get(key)
        if not isinstance(value, str) or not value.strip():
            raise TemplateError(f"模板 {file.name} 缺少 {key}")
        return value

    template_id = require_text("id")
    if not re.match(r"^[a-z0-9][a-z0-9-]{1,63}$", template_id):
        raise TemplateError(f"模板 id 非法（只允许小写字母/数字/连字符）：{template_id!r}")

    kp_ids = tuple(str(item) for item in (raw.get("kp_ids") or []))
    if not kp_ids:
        raise TemplateError(f"模板 {template_id} 没有声明任何 kp_ids（它永远不会被选中）")

    grade_levels = tuple(str(item) for item in (raw.get("grade_levels") or []))
    for level in grade_levels:
        if level not in GRADE_LEVELS:
            raise TemplateError(f"模板 {template_id} 的 grade_levels 含非法学段：{level!r}")

    duration_ms = raw.get("duration_ms")
    if not isinstance(duration_ms, int) or duration_ms <= 0:
        raise TemplateError(f"模板 {template_id} 的 duration_ms 必须是正整数")

    params: dict[str, TemplateParameter] = {}
    raw_params = raw.get("params") or {}
    if not isinstance(raw_params, dict):
        raise TemplateError(f"模板 {template_id} 的 params 必须是对象")
    for name, spec in raw_params.items():
        if not isinstance(spec, dict):
            raise TemplateError(f"模板 {template_id} 的参数 {name} 不是对象")
        param_type = str(spec.get("type") or "")
        if param_type not in PARAM_TYPES:
            raise TemplateError(f"模板 {template_id} 的参数 {name} 类型非法：{param_type!r}")
        default = spec.get("default")
        if default is None:
            raise TemplateError(f"模板 {template_id} 的参数 {name} 缺少 default")
        params[str(name)] = TemplateParameter(
            name=str(name),
            type=param_type,
            minimum=spec.get("min"),
            maximum=spec.get("max"),
            default=default,
            description=str(spec.get("description") or ""),
        )

    script = require_text("script")
    body = require_text("body")
    fallback_text = require_text("fallback_text")
    fallback_image = raw.get("fallback_image")
    if fallback_image is not None and not isinstance(fallback_image, str):
        raise TemplateError(f"模板 {template_id} 的 fallback_image 必须是字符串（SVG 或 dataURL）")

    placeholders = set(re.findall(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", f"{body}\n{script}"))
    undeclared = sorted(placeholders - set(params))
    if undeclared:
        raise TemplateError(
            f"模板 {template_id} 用了未声明的参数：{'、'.join(undeclared)}（params 里没有它们）"
        )
    unused = sorted(set(params) - placeholders)
    if unused:
        raise TemplateError(f"模板 {template_id} 声明了参数但没用上：{'、'.join(unused)}")

    return AnimationTemplate(
        id=template_id,
        label=require_text("label"),
        title=require_text("title"),
        concept=require_text("concept"),
        kp_ids=kp_ids,
        grade_levels=grade_levels,
        duration_ms=duration_ms,
        params=params,
        body=body,
        script=script,
        fallback_text=fallback_text,
        fallback_image=fallback_image,
        source_path=str(file),
    )


def load_templates(root: str | Path | None = None) -> list[AnimationTemplate]:
    """读整个模板目录（**坏模板只跳过、不抛**：一条手滑的记录不该让动画能力整体消失）。

    跳过原因进 WARNING 日志 —— 与 ``routes/quiz.py`` 的题库加载同一口径。
    """
    directory = Path(root) if root is not None else templates_dir()
    loaded: list[AnimationTemplate] = []
    if not directory.is_dir():
        logger.warning("动画模板目录不存在：%s（动画将只能降级为文字 + 静态图）", directory)
        return loaded

    seen: set[str] = set()
    for path in sorted(directory.glob(f"*{TEMPLATE_SUFFIX}")):
        try:
            template = load_template(path)
        except TemplateError as exc:
            logger.warning("动画模板不合格，已跳过：%s", exc)
            continue
        if template.id in seen:
            logger.warning("动画模板 id 重复，已跳过后者：%s（%s）", template.id, path.name)
            continue
        seen.add(template.id)
        loaded.append(template)
    return loaded


def template_usable_for(template: AnimationTemplate, grade_level: str) -> bool:
    """这个模板能不能给该学段用（**方向与检索一致**：不高于学生学段的内容才可用）。

    - 模板没声明 ``grade_levels`` = 通识类动画，任何学段都能用；
    - 学段未知（``""``）时也不拦（调用方多半是预览 / 列举）；
    - 判据是「**至少有一个**声明的学段不高于学生」：一份 `junior, senior` 的模板
      对初中生当然可用（它本来就要覆盖初中），只有 `senior` 的模板对初中生不可用（超纲）。

    ⚠️ 写成「全部声明的学段都 ≤ 学生」是**错的**：那会把跨学段模板全体误杀
    （实测踩到：初中生问「神经网络」，模板明明有 junior，却被退成小学的「图像分类」）。
    """
    if not template.grade_levels or grade_level not in GRADE_LEVELS:
        return True
    target_rank = GRADE_LEVELS.index(grade_level)
    return any(
        GRADE_LEVELS.index(level) <= target_rank
        for level in template.grade_levels
        if level in GRADE_LEVELS
    )


def match_templates(
    templates: Sequence[AnimationTemplate],
    *,
    kp_id: str = "",
    grade_level: str = "",
) -> list[AnimationTemplate]:
    """按知识点 + 学段挑模板（**顺序即优先级**，与文件名字典序一致，结果可复现）。

    给了 ``kp_id`` 且命中时只返回命中的那些（这才是「模板优先」的意义）；
    没命中时返回全部可用模板 —— 调用方靠 :func:`pick_template` 区分这两种情况。
    """
    usable = [t for t in templates if template_usable_for(t, grade_level)]
    if kp_id:
        exact = [t for t in usable if kp_id in t.kp_ids]
        if exact:
            return exact
    return usable


#: 选定模板的原因（写进日志与轨迹，用来回答「凭什么用了这个模板」）。
#: ``kp`` = 知识点精确命中；``grade`` = 只按学段兜底（该知识点没有专门模板）；``none`` = 无可用模板。
TemplateMatchReason = str


def pick_template(
    templates: Sequence[AnimationTemplate],
    *,
    kp_id: str = "",
    grade_level: str = "",
) -> tuple[AnimationTemplate | None, TemplateMatchReason]:
    """选定一个模板，并说明**凭什么选它**。

    ★ 调用方必须区分 ``kp`` 与 ``grade``：前者走「模板命中」这条首选路径；
    后者意味着**这个知识点没有专门的动画**，此时更适合直接走自由生成 / 降级，
    而不是硬塞一个不相关的模板（那会让学生看到一段讲别的东西的动画）。
    """
    usable = [t for t in templates if template_usable_for(t, grade_level)]
    if not usable:
        return None, "none"
    if kp_id:
        exact = [t for t in usable if kp_id in t.kp_ids]
        if exact:
            return exact[0], "kp"
    return usable[0], "grade"


def find_template(templates: Sequence[AnimationTemplate], template_id: str) -> AnimationTemplate | None:
    for template in templates:
        if template.id == template_id:
            return template
    return None


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #
#: 共享资源在进程内的缓存（键 = 文件绝对路径 + mtime，改了文件自动失效）。
_SHARED_CACHE: dict[str, tuple[float, str]] = {}
_SHARED_LOCK = threading.Lock()


def read_shared(root: Path, filename: str) -> str:
    """读共享资源（``_shared/`` 下的动画库 / 运行时 / 样式），带 mtime 缓存。

    ★ **从本地读进来内联**就是「零外部引用」的实现方式（陷阱 §6 第 3 条）：
    模板里不写 ``<script src=...>``，而是由这里读出正文拼进 HTML。
    """
    path = Path(root) / SHARED_DIRNAME / filename
    try:
        stat = path.stat()
    except OSError as exc:
        raise TemplateError(f"共享资源缺失：{path}（{exc}）") from exc
    key = str(path)
    with _SHARED_LOCK:
        cached = _SHARED_CACHE.get(key)
        if cached is not None and cached[0] == stat.st_mtime:
            return cached[1]
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise TemplateError(f"共享资源无法读取：{path}（{exc}）") from exc
    with _SHARED_LOCK:
        _SHARED_CACHE[key] = (stat.st_mtime, text)
    return text


def resolve_params(
    template: AnimationTemplate, overrides: Mapping[str, Any] | None
) -> dict[str, Any]:
    """按模板声明解析参数：缺省用 default，越界裁剪，类型不对则报错。"""
    provided = overrides or {}
    unknown = sorted(set(provided) - set(template.params))
    if unknown:
        raise TemplateError(f"模板 {template.id} 不认识这些参数：{'、'.join(unknown)}")
    resolved: dict[str, Any] = {}
    for name, parameter in template.params.items():
        if name in provided and provided[name] is not None:
            resolved[name] = parameter.clamp(provided[name])
        else:
            resolved[name] = parameter.default
    return resolved


def substitute_placeholders(text: str, values: Mapping[str, Any]) -> str:
    """把 ``{{name}}`` 换成 **JSON 字面量**（数字/字符串/布尔都安全，不存在拼接注入）。"""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values:
            raise TemplateError(f"模板占位符 {name} 没有对应的参数值")
        return json.dumps(values[name], ensure_ascii=False)

    return re.sub(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", replace, text)


def compose_animation_html(
    *,
    css: str,
    library: str,
    runtime: str,
    body: str,
    script: str,
    payload_id: str,
) -> str:
    """拼一份**完全自包含**的动画 HTML（CSS + 动画库 + 运行时 + 页面片段 + 模板脚本）。

    ``payload_id`` 以两种方式交给沙箱（沙箱运行时按优先级取用）：
      ① 注入 ``window.__K12_PAYLOAD_ID__``（``srcdoc`` 回退路径也能用 —— 那条路径没有 URL query）；
      ② 服务端托管时还会把它拼进 URL query（``?payload_id=...``）。
    """
    safe_payload_id = json.dumps(payload_id or "")
    return (
        "<!DOCTYPE html>\n"
        '<html lang="zh-CN">\n'
        "<head>\n"
        '<meta charset="utf-8" />\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1" />\n'
        "<title>动画讲解</title>\n"
        "<style>\n"
        f"{css}\n"
        "</style>\n"
        "<script>\n"
        "/* 动画库（本地内联，绝不引 CDN——沙箱断网） */\n"
        f"{library}\n"
        "</script>\n"
        "<script>\n"
        "/* ★ 先注入 payload_id：运行时在求值时就要读到它。顺序反了它会自造一个随机 id，\n"
        "   与卡片手里的 id 对不上，所有消息都被当成串台丢掉，卡片永远等不到 ready。 */\n"
        f"window.__K12_PAYLOAD_ID__ = {safe_payload_id};\n"
        "</script>\n"
        "<script>\n"
        f"{runtime}\n"
        "</script>\n"
        "</head>\n"
        "<body>\n"
        '<div id="stage">\n'
        f"{body}\n"
        "</div>\n"
        "<script>\n"
        f"{script}\n"
        "</script>\n"
        "</body>\n"
        "</html>\n"
    )


def apply_simulation(html: str) -> str:
    """演示开关：按 :data:`SIMULATE_ENV` 故意把产物弄坏，用来复现「重试 → 降级」链路。

    **默认关闭**；打开时会在日志里明确写出来（免得有人以为是真故障）。
    """
    mode = (os.environ.get(SIMULATE_ENV) or "").strip().lower()
    if not mode:
        return html
    logger.warning("动画校验演练开关已打开（%s=%s）：本产物**故意**不合格", SIMULATE_ENV, mode)
    if mode == "throw":
        # 模板作者把脚本写崩的典型形态：往**模板脚本段**里插一个顶层 throw。
        # 位置在 `Sandbox.ready(` 之前（同一段脚本里），因此校验器第 4 条会抓住它。
        index = html.rfind(READY_MARKER)
        if index < 0:
            return html
        return html[:index] + "throw new Error('boom')\n" + html[index:]
    if mode == "external":
        return html.replace("</head>", '<script src="https://cdn.unpkg.com/anime.js"></script>\n</head>', 1)
    if mode == "nolib":
        return html.replace(INLINE_LIBRARY_MARKER, "anime-missing", 1)
    if mode == "credential":
        return html.replace("</body>", "<script>var apiKey = 'sk-abcdef123456';</script>\n</body>", 1)
    logger.warning("未知的 %s 取值：%r（本产物原样返回）", SIMULATE_ENV, mode)
    return html


def render_animation(
    template: AnimationTemplate,
    *,
    params: Mapping[str, Any] | None = None,
    payload_id: str = "",
    root: str | Path | None = None,
    fallback_text: str | None = None,
) -> AnimationPayload:
    """渲染一个模板 → :class:`AnimationPayload`。

    **失败即抛** :class:`TemplateError`（校验不过也算失败）—— 调用方（TS 侧）据此重试或降级；
    这里绝不返回「半成品 HTML」，因为半成品的下场就是白屏。

    ``fallback_text`` / ``fallback_image`` 保证**非空**（票 17 的验收口径）：
    没有降级文案的动画等于没有兜底。
    """
    directory = Path(root) if root is not None else templates_dir()
    resolved = resolve_params(template, params)
    body = substitute_placeholders(template.body, resolved)
    script = substitute_placeholders(template.script, resolved)
    leftovers = re.findall(r"\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}", f"{body}\n{script}")
    if leftovers:
        raise TemplateError(f"模板 {template.id} 渲染后仍有未替换的占位符：{'、'.join(leftovers)}")

    html = compose_animation_html(
        css=read_shared(directory, BASE_CSS_FILENAME),
        library=read_shared(directory, ANIME_LIB_FILENAME),
        runtime=read_shared(directory, RUNTIME_FILENAME),
        body=body,
        script=script,
        payload_id=payload_id,
    )
    html = apply_simulation(html)

    validation = validate_animation_html(html)
    if not validation.ok:
        raise TemplateError(f"模板 {template.id} 渲染出的 HTML 未通过校验：{validation.reason}")

    text = (fallback_text or template.fallback_text or "").strip()
    if not text:
        raise TemplateError(f"模板 {template.id} 的降级文案为空（动画失败时就没有话可说了）")

    image = template.fallback_image or build_fallback_svg(
        concept=template.concept, title=template.title, text=text
    )

    return AnimationPayload(
        concept=template.concept,
        html=html,
        duration_ms=int(template.duration_ms),
        fallback_text=text,
        fallback_image=image,
        source="template",
    )


# --------------------------------------------------------------------------- #
# 静态 SVG（降级用的兜底图，且必须**自包含**）
# --------------------------------------------------------------------------- #
#: 兜底图的配色（与卡片样式一致）
_SVG_INK = "#12233b"
_SVG_MUTED = "#5b6b82"
_SVG_ACCENT = "#2f6fd0"
_SVG_SOFT = "#e8f0fd"
_SVG_LINE = "#d6ddec"


def _svg_lines(text: str, per_line: int = 18, max_lines: int = 4) -> list[str]:
    """把一段中文切成若干行（按标点与长度切，够用即可，不追求排版算法）。"""
    cleaned = re.sub(r"\s+", " ", text).strip()
    lines: list[str] = []
    current = ""
    for char in cleaned:
        current += char
        if len(current) >= per_line and (char in "，。；：！？、）" or len(current) >= per_line + 6):
            lines.append(current)
            current = ""
        if len(lines) >= max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if not lines:
        lines = ["（暂无讲解文字）"]
    if len(lines) == max_lines and len("".join(lines)) < len(cleaned):
        lines[-1] = lines[-1][: max(1, per_line - 1)] + "…"
    return lines


def build_fallback_svg(*, concept: str, title: str, text: str, width: int = 480, height: int = 220) -> str:
    """画一张兜底静态图，并返回 ``data:image/svg+xml;base64,...``。

    ★ 为什么用 base64：SVG 的 XML 命名空间是 ``http://www.w3.org/2000/svg`` 这个**字面量**，
    直接内联进 HTML 会让「零外部引用」那条 grep 出现一次命中。base64 之后 HTML 里只有编码串，
    断言可以保持「零例外」，而图本身仍然是完整、正确的 SVG。

    图上画的是「三根高低不同的柱子」这种最朴素的示意 —— 它的职责是**填满卡片、不白屏**，
    不是替代真正讲清楚概念的动画（那由模板承担）。
    """
    lines = _svg_lines(text)
    text_nodes = "\n".join(
        f'    <text x="24" y="{138 + index * 20}" class="body">{html_escape.escape(line)}</text>'
        for index, line in enumerate(lines)
    )
    bars = ""
    for index, bar_height in enumerate((54, 92, 36, 74)):
        bars += (
            f'    <rect x="{24 + index * 30}" y="{110 - bar_height}" width="18" height="{bar_height}" '
            f'rx="3" fill="{_SVG_ACCENT}" opacity="{0.45 + index * 0.12:.2f}" />\n'
        )
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{html_escape.escape(concept)}（静态示意图）">\n'
        f'  <rect width="{width}" height="{height}" rx="12" fill="#ffffff" />\n'
        f'  <rect x="0.5" y="0.5" width="{width - 1}" height="{height - 1}" rx="12" fill="none" '
        f'stroke="{_SVG_LINE}" />\n'
        f'  <text x="24" y="34" class="title">{html_escape.escape(title)}</text>\n'
        f'  <text x="24" y="58" class="label">概念：{html_escape.escape(concept)}</text>\n'
        "  <g>\n"
        f"{bars}"
        "  </g>\n"
        f"{text_nodes}\n"
        f'  <style>\n'
        f'    .title {{ font: 650 15px "Microsoft YaHei", "PingFang SC", sans-serif; fill: {_SVG_INK}; }}\n'
        f'    .label {{ font: 12px "Microsoft YaHei", "PingFang SC", sans-serif; fill: {_SVG_MUTED}; }}\n'
        f'    .body {{ font: 12.5px "Microsoft YaHei", "PingFang SC", sans-serif; fill: {_SVG_INK}; }}\n'
        f"  </style>\n"
        f"</svg>\n"
    )
    encoded = base64.b64encode(svg.encode("utf-8")).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


# --------------------------------------------------------------------------- #
# 一次性 nonce（票 16 的核心鉴权机制）
# --------------------------------------------------------------------------- #
@dataclass
class NonceRecord:
    """一次资源托管的凭据（绑定 student_id + kp_id + 有效期 + 具体的托管文件）。"""

    student_id: str
    kp_id: str
    filename: str
    expires_at: float
    used: bool = False


class NonceStore:
    """进程内的**一次性 nonce** 表。

    三条性质（对应票 16 的三个反向用例）::

        ① 单次消费  —— 用过的 nonce 立刻失效（`reused`）
        ② 绑定身份  —— student_id / kp_id 任一不符即拒（`wrong-student` / `wrong-kp`）
        ③ 有效期    —— 过期即拒（`expired`）

    ``now`` 可注入，所以「过期」能在单测里被确定性地断言，不必真睡 2 分钟。
    容量有上限：满了先清过期项，再清最旧的一批（宁可让个别卡片重新申请，也不无限增长）。
    """

    def __init__(self, *, ttl_seconds: int = NONCE_TTL_SECONDS, capacity: int = NONCE_MAX_ENTRIES) -> None:
        self.ttl_seconds = int(ttl_seconds)
        self.capacity = int(capacity)
        self._records: dict[str, NonceRecord] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------ 写 --
    def issue(self, *, student_id: str, kp_id: str, filename: str, now: float | None = None) -> tuple[str, float]:
        """签发一个 nonce，返回 ``(nonce, expires_at)``。"""
        stamp = time.time() if now is None else float(now)
        nonce = secrets.token_urlsafe(24)
        record = NonceRecord(
            student_id=student_id,
            kp_id=kp_id,
            filename=filename,
            expires_at=stamp + self.ttl_seconds,
        )
        with self._lock:
            self._prune(stamp)
            if len(self._records) >= self.capacity:
                # 先丢过期项（上面已做）；还满就丢最旧的一批 —— 同屏卡片远不会到这个量级
                oldest = sorted(self._records.items(), key=lambda item: item[1].expires_at)
                for key, _ in oldest[: max(1, self.capacity // 8)]:
                    self._records.pop(key, None)
            self._records[nonce] = record
        return nonce, record.expires_at

    def _prune(self, now: float) -> None:
        expired = [key for key, record in self._records.items() if record.expires_at <= now]
        for key in expired:
            self._records.pop(key, None)

    # ------------------------------------------------------------ 读 --
    def consume(
        self,
        nonce: str,
        *,
        student_id: str,
        kp_id: str,
        now: float | None = None,
    ) -> tuple[NonceRecord | None, str]:
        """校验并**消费**一个 nonce。返回 ``(record, reason)``；成功时 ``reason == "ok"``。

        `reason` 取值：``ok`` / ``missing`` / ``unknown`` / ``expired`` / ``used`` /
        ``wrong-student`` / ``wrong-kp`` —— 全部会写进日志（**只记原因，不记 nonce 本体**）。
        """
        stamp = time.time() if now is None else float(now)
        token = (nonce or "").strip()
        if not token:
            return None, "missing"
        with self._lock:
            record = self._records.get(token)
            if record is None:
                return None, "unknown"
            if record.expires_at <= stamp:
                self._records.pop(token, None)
                return None, "expired"
            if record.used:
                return None, "used"
            if record.student_id != student_id:
                return None, "wrong-student"
            if record.kp_id != kp_id:
                return None, "wrong-kp"
            record.used = True
            return record, "ok"

    def size(self) -> int:
        with self._lock:
            return len(self._records)


#: 进程内唯一的 nonce 表（路由与测试共用；测试可直接构造 :class:`NonceStore`）。
NONCE_STORE = NonceStore()


# --------------------------------------------------------------------------- #
# 托管
# --------------------------------------------------------------------------- #
def animation_dir(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/animations``（**按学生分目录**，§11.2）。"""
    return student_dir(data_dir, student_id) / ANIMATIONS_DIRNAME


def student_data_root(request: Request) -> Path:
    """取这个请求该用的**学生数据根**；拿不到就 503（**绝不退回共享目录**）。

    ★ 为什么必须用 `resolve_student_data_root` 而不是 `get_data_dir`：
    `get_data_dir` 在没显式传 `--data-dir` 时会兜底到 `server/_data`（打包态是 exe 同级的
    `_data`）—— 那是个**共享**目录：手工 curl、单测、连续多次运行都会写进同一棵
    `students/` 树。把学生动画写进去，既破坏「一人一库/一人一目录」的语义，
    也会让测试之间互相污染。`resolve_student_data_root` 正是为此把那个兜底值判成 `None`。
    """
    data_dir = resolve_student_data_root(request)
    if data_dir is None:
        raise HTTPException(
            status_code=503,
            detail="sidecar 未显式传入 --data-dir，无法按学生托管动画（真实运行由 Electron 传入）",
        )
    return data_dir


def validate_payload_id(payload_id: str) -> str:
    """payload_id 白名单（它是 RPC 的身份，会被拼进文件名与 URL）。"""
    if not isinstance(payload_id, str) or not re.match(r"^[A-Za-z0-9_-]{1,64}$", payload_id):
        raise HTTPException(status_code=422, detail="payloadId 不合法（只允许字母、数字、下划线、连字符）")
    return payload_id


def hosted_filename(kp_id: str, payload_id: str) -> str:
    """托管文件名：``<kp_id>-<payload_id 的 12 位摘要>.html``。

    带上摘要是为了「同一知识点的两张卡片互不覆盖」—— 覆盖会让先渲染的那张卡片的
    重载路径指向别人的内容。摘要取 SHA-1（**不是安全用途**，只是把 id 映射成短文件名）。
    """
    return f"{kp_id}-{_stable_digest(payload_id)}.html"


def _stable_digest(value: str) -> str:
    """12 位稳定摘要（同一 payload_id 永远得到同一个文件名，便于排查与断言）。"""
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:12]


def host_animation(data_dir: str | Path, student_id: str, kp_id: str, filename: str, html: str) -> Path:
    """把 HTML 写进该学生的动画目录，返回落盘路径。

    ★ **按学生分目录**不是形式：跨学生不可互取这条性质就建立在「文件只在各自目录里」之上，
    测试会用「拿 A 的 nonce 去请求 B 的路径」这条反向用例盯住它。
    """
    if not KP_ID_RE.match(kp_id):
        raise HTTPException(status_code=422, detail="kpId 不合法")
    directory = animation_dir(data_dir, student_id)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / filename
    path.write_text(html, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
#: 内部路由（主进程调用）：**不进 OpenAPI**。
#:
#: 为什么 `include_in_schema=False`：契约（`openapi.json` → `api-types.ts`）是**冻结**的，
#: 而这些是「主进程 ↔ sidecar」之间的资源管道，不是前端契约的一部分。
#: 不把它塞进生成物，`npm run check:api` 就仍然做字节比对，契约漂移防线保持原样。
router = APIRouter(prefix="/api", tags=["animation"], include_in_schema=False)

#: 沙箱路由（iframe 直接加载，**没有 X-Auth-Token**，靠一次性 nonce）。同样不进 OpenAPI。
public_router = APIRouter(tags=["animation"], include_in_schema=False)


@router.get("/animation/templates", summary="列出动画模板（可按知识点 + 学段过滤）")
def list_animation_templates(
    request: Request,
    kpId: str = Query("", description="知识点 id（给了就只返回能覆盖它的模板）"),
    gradeLevel: str = Query("", description="学生学段（四学段之一；只返回不高于它的模板）"),
) -> JSONResponse:
    """给模型看的模板清单：模板 id、适用知识点、以及**每个参数的取值说明与默认值**。

    默认路径 = 模板命中：模型只需要「选一个 id + 填参数」，不必自己编 HTML。
    """
    templates = load_templates(templates_dir_for(request))
    matched = match_templates(templates, kp_id=kpId.strip(), grade_level=gradeLevel.strip())
    return JSONResponse(
        {
            "total": len(templates),
            "matched": [template.to_public() for template in matched],
            "available": [template.id for template in templates],
        }
    )


@router.post("/animation/render", response_model=AnimationPayload, summary="渲染一份动画载荷（含校验）")
def render_animation_route(request: Request, body: dict[str, Any]) -> AnimationPayload:
    """渲染模板 → ``AnimationPayload``。

    - ``templateId`` 缺省时按 ``kpId`` + ``gradeLevel`` **自动匹配**（模板优先策略的落点）；
    - 渲染或校验不过 → **422** + 可读原因（TS 侧的 execute() 据此重试，≤3 次后降级）；
    - 模板都没有命中 → **404**（TS 侧据此走「自由生成 / 直接降级」的补充路径）。
    """
    directory = templates_dir_for(request)
    templates = load_templates(directory)
    if not templates:
        raise HTTPException(status_code=503, detail="本机没有可用的动画模板（server/resources/templates/ 为空）")

    template_id = str(body.get("templateId") or "").strip()
    kp_id = str(body.get("kpId") or "").strip()
    grade_level = str(body.get("gradeLevel") or "").strip()
    payload_id = validate_payload_id(str(body.get("payloadId") or "preview"))
    params = body.get("params") or {}
    if not isinstance(params, dict):
        raise HTTPException(status_code=422, detail="params 必须是对象")

    if template_id:
        template = find_template(templates, template_id)
        if template is None:
            raise HTTPException(status_code=404, detail=f"模板 {template_id!r} 不存在")
        match_reason = "explicit"
    else:
        template, match_reason = pick_template(templates, kp_id=kp_id, grade_level=grade_level)
        if template is None:
            raise HTTPException(
                status_code=404,
                detail=f"没有可用于学段 {grade_level!r} 的模板（走自由生成或降级）",
            )
        # ★ 知识点没有专门模板时不硬塞：模板优先的前提是「这个模板真在讲这个知识点」，
        #   塞一段讲别的东西的动画比降级成文字更糟。让调用方去走自由生成 / 降级。
        if kp_id and match_reason == "grade":
            raise HTTPException(
                status_code=404,
                detail=f"没有覆盖知识点 {kp_id!r} 的模板（只有学段兜底模板，改用自由生成或降级）",
            )

    try:
        payload = render_animation(
            template,
            params=params,
            payload_id=payload_id,
            root=directory,
            fallback_text=str(body.get("fallbackText") or "") or None,
        )
    except TemplateError as exc:
        # ★ 422：这是**内容不合格**，不是服务故障 —— 调用方应当重试或降级，而不是报错给用户
        logger.warning("动画渲染未通过校验：%s", exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    concept = str(body.get("concept") or "").strip()
    if concept:
        payload = payload.model_copy(update={"concept": concept})
    return payload


@router.post("/animation/host/{student_id}/{kp_id}", summary="托管动画 HTML，换一次性 nonce")
def host_animation_route(
    request: Request, student_id: str, kp_id: str, body: dict[str, Any]
) -> JSONResponse:
    """把主进程渲染好的 HTML 落到 ``students/<id>/animations/``，返回带 nonce 的地址。

    「主进程渲染、Python 托管」的分工是刻意的：**内容由编排层产出**（它才知道这一轮讲什么），
    **托管与鉴权归数据服务**（它才知道学生的目录与凭据账本）。
    """
    validate_student_id(student_id)
    if not KP_ID_RE.match(kp_id):
        raise HTTPException(status_code=422, detail="kpId 不合法")

    html = body.get("html")
    if not isinstance(html, str) or not html.strip():
        raise HTTPException(status_code=422, detail="缺少 html（要托管的动画内容）")
    if len(html.encode("utf-8")) > MAX_HTML_BYTES:
        raise HTTPException(status_code=413, detail=f"动画 HTML 超过 {MAX_HTML_BYTES} 字节上限")

    validation = validate_animation_html(html)
    if not validation.ok:
        # 托管入口再校验一次：**能落盘的东西一定已经过了校验**，
        # 免得有人在别处绕过 render 直接把坏产物塞进资源路由。
        raise HTTPException(status_code=422, detail=f"托管前校验未通过：{validation.reason}")

    data_dir = student_data_root(request)

    payload_id = validate_payload_id(str(body.get("payloadId") or ""))
    filename = hosted_filename(kp_id, payload_id)
    path = host_animation(data_dir, student_id, kp_id, filename, html)

    nonce, expires_at = NONCE_STORE.issue(student_id=student_id, kp_id=kp_id, filename=filename)
    expires_in_ms = int(max(0.0, expires_at - time.time()) * 1000)

    # ★ 返回**绝对地址**，而且由服务端自己拼：只有这里知道本机实际监听的端口
    #   （`--port 0` 由系统分配，主进程要到握手之后才知道）。
    #   这样渲染进程拿到的就是一段可直接塞进 `<iframe src>` 的字符串，
    #   **渲染进程里不需要出现任何回环地址字面量**（架构守卫 G3 盯着这一点）。
    origin = _loopback_origin(request)
    resource_path = f"/resources/animation/{student_id}/{kp_id}"
    url = f"{origin}{resource_path}?nonce={nonce}&payload_id={payload_id}"

    logger.info(
        "动画已托管：学生=%s 知识点=%s 文件=%s 字节=%d（nonce 有效期 %.0fs）",
        student_id,
        kp_id,
        path.name,
        len(html.encode("utf-8")),
        NONCE_STORE.ttl_seconds,
    )
    return JSONResponse(
        {
            "url": url,
            "path": resource_path,
            "payloadId": payload_id,
            "filename": filename,
            "expiresInMs": expires_in_ms,
            "singleUse": True,
        }
    )


def _loopback_origin(request: Request) -> str:
    """从请求里推出本机的 ``http://127.0.0.1:<port>`` 前缀（**只认回环**）。

    ``Host`` / ``request.base_url`` 都由调用方控制，所以这里先做回环白名单再拼 ——
    否则一个伪造的 Host 就能让主进程把动画托管地址指向别的机器（iframe 会去连它）。
    """
    raw = ""
    try:
        raw = str(request.base_url).rstrip("/")
    except Exception:  # noqa: BLE001 - 拿不到就退到 Host 头
        raw = ""
    if not raw:
        header = str(request.headers.get("host") or "")
        raw = f"http://{header}" if header else ""

    host_match = re.match(r"^https?://(\[[^\]]+\]|[^:/]+)(?::(\d+))?$", raw)
    if host_match is None:
        raise HTTPException(status_code=500, detail="无法确定本机回环地址（Host 头异常）")
    host = host_match.group(1)
    port = host_match.group(2) or "80"
    if host not in ("127.0.0.1", "localhost", "[::1]", "::1"):
        raise HTTPException(status_code=400, detail=f"只允许回环地址（收到 Host={host}）")
    return f"http://{host}:{port}"


@public_router.get("/resources/animation/{student_id}/{kp_id}", response_class=HTMLResponse, summary="取动画 HTML（一次性 nonce）")
def get_animation_resource(
    request: Request,
    student_id: str,
    kp_id: str,
    nonce: str = Query("", description="一次性 nonce（由主进程签发，绑定学生 + 知识点 + 有效期）"),
    payload_id: str = Query("", description="RPC 身份（沙箱据此丢弃别人的消息）"),
) -> HTMLResponse:
    """把某个学生的某份动画 HTML 交给 iframe。

    ★★ 这是**唯一一条不带 ``X-Auth-Token`` 的路由**（iframe 带不了自定义请求头）。
    它的安全性完全建立在一件事上：**没有合法 nonce 就什么都拿不到**。

    - 缺 nonce → 403；未知 / 过期 / 已用过 / 学生或知识点对不上 → 403；
    - 返回哪个文件**只由 nonce 记录决定**（URL 里的 student_id / kp_id 只做交叉核对），
      因此不存在「按 URL 拼路径读任意文件」的入口；
    - 响应头 ``Cache-Control: no-store``（不缓存）、``X-Content-Type-Options: nosniff``。
    """
    validate_student_id(student_id)
    if not KP_ID_RE.match(kp_id):
        raise HTTPException(status_code=422, detail="kpId 不合法")

    record, reason = NONCE_STORE.consume(nonce, student_id=student_id, kp_id=kp_id)
    if record is None:
        # ★ 不区分「不存在」与「已用过」以外的细节给外部，只在日志里说清楚（排查够用，外面看不出规律）
        logger.warning("动画资源被拒：学生=%s 知识点=%s 原因=%s", student_id, kp_id, reason)
        raise HTTPException(status_code=403, detail=f"动画资源未通过 nonce 校验（{reason}）")

    data_dir = student_data_root(request)
    directory = animation_dir(data_dir, student_id)
    path = directory / record.filename
    try:
        # 落盘的文件名来自 nonce 记录（服务端自己生成的），这里再断言一次它没跑出目录
        resolved = path.resolve()
        if directory.resolve() not in resolved.parents:
            raise HTTPException(status_code=403, detail="动画资源路径非法")
        html = resolved.read_text(encoding="utf-8")
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(status_code=404, detail="动画资源已不在磁盘上（重新讲解一次即可）")

    if payload_id and payload_id != record.filename.split("-")[-1].replace(".html", ""):
        # payload_id 只是给沙箱做 RPC 身份，**不参与鉴权**；这里只记一条诊断
        logger.debug("动画资源：URL 上的 payload_id 与文件摘要不一致（不影响返回）")

    return HTMLResponse(
        content=html,
        headers={
            # ★ 不缓存：一次性凭据背后的内容不该被任何一层缓存留下来
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            # 动画是沙箱里的自包含文档，**不允许**任何外部加载
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
        },
    )


__all__ = [
    "ANIMATIONS_DIRNAME",
    "ANIME_LIB_FILENAME",
    "AnimationTemplate",
    "CREDENTIAL_PATTERNS",
    "EXTERNAL_REFERENCE_RE",
    "FORBIDDEN_SANDBOX_FLAG",
    "HtmlValidation",
    "KP_ID_RE",
    "NONCE_STORE",
    "NONCE_TTL_SECONDS",
    "NonceRecord",
    "NonceStore",
    "PARAM_TYPES",
    "SIMULATE_ENV",
    "TEMPLATES_DIRNAME",
    "TemplateError",
    "TemplateParameter",
    "animation_dir",
    "apply_simulation",
    "build_fallback_svg",
    "compose_animation_html",
    "find_template",
    "host_animation",
    "host_animation_route",
    "hosted_filename",
    "load_template",
    "load_templates",
    "match_templates",
    "public_router",
    "read_shared",
    "render_animation",
    "render_animation_route",
    "resolve_params",
    "router",
    "student_data_root",
    "substitute_placeholders",
    "templates_dir",
    "validate_animation_html",
    "validate_payload_id",
]
