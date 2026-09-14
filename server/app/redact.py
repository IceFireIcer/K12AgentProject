"""凭据脱敏：日志过滤器 + 文本擦除。

（对应 `项目执行文档.md` 第 6.2/12 节与 AGENTS §5.9）

**硬约束**：LLM 与嵌入模型的凭据（API Key）**不得明文进日志**。
任何"顺手 `logger.info(f"{payload}")`"都可能把 key 打出来，所以这里提供一个
挂在 **logging 根 logger 上的全局过滤器**，作为与个人记性无关的兜底。

两条防线：
1. `SecretRedactingFilter`：拦截所有 `LogRecord`，对 `record.args` 与最终的
   `record.getMessage()` 做正则擦除——**包括第三方库（openai/httpx/uvicorn）的日志**，
   因为它们会把 `Authorization: Bearer sk-xxx` 打进 DEBUG 日志。
2. `redact_text()`：给非日志场景（异常消息回给前端、写审计文件）复用同一套规则。

⚠️ 正则只能兜住"已知形态"的密钥。真正的第一原则仍是：**不要把凭据传进日志调用**。
"""

from __future__ import annotations

import logging
import re

#: 占位符（擦除后留下的可读线索，便于确认"确实脱敏了"）。
REDACTED = "***"
#: 日志中常见的凭据键名。
KEY_NAMES = r"(?:api[_-]?key|apikey|authorization|auth[_-]?token|access[_-]?token|password|secret)"

#: 形如 `%s` / `%(name)s` / `%d` 的 logging 惰性格式化占位符。
#:
#: ★ 为什么必须单独识别：日志模块允许 `logger.info("api_key=%s", key)`，
#: 此时 `record.msg` 是**模板**、真值在 `record.args` 里。
#: 如果无脑把 `%s` 擦成 `***`，`record.getMessage()` 里的 `msg % args` 就会
#: 抛 `TypeError: not all arguments converted during string formatting`
#: —— 脱敏过滤器反而把日志系统搞崩了（真实踩到过）。占位符要原样留给 args 阶段。
_PLACEHOLDER_RE = re.compile(
    r"^%(\d+\$)?"  # %s / %1$s
    r"[-#0 +]*\d*(\.\d+)?"  # 宽度/精度
    r"[diouxXeEfFgGcrsa]$"
    r"|^%\([^)]+\)[-#0 +]*\d*(\.\d+)?[diouxXeEfFgGcrsa]$"  # %(name)s
)

#: 不是凭据的词：`Authorization: Bearer <token>` 里值的位置是 `Bearer`，
#: 擦掉它会让最关键的一条鉴权日志变成 `Authorization: *** ***`，
#: 反而看不出发生了什么。真值（args 或后面的串）照样会被脱敏。
_NON_SECRET_WORDS = frozenset({"bearer", "basic", "token", "digest", "none", "null", "true", "false"})


def _key_value_replacer(match: re.Match[str]) -> str:
    """键值形态的替换器：占位符与"协议关键字"原样保留，真值擦成 `***`。"""
    prefix, value = match.group(1), match.group(2)
    if _PLACEHOLDER_RE.match(value) or value.lower() in _NON_SECRET_WORDS:
        return match.group(0)
    return f"{prefix}{REDACTED}"


_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # 键值形态：api_key=xxx / "apiKey": "xxx" / api-key: xxx
    (
        re.compile(rf"(?i)([\"']?{KEY_NAMES}[\"']?\s*[:=]\s*[\"']?)([^\"'\s,;){{}}\]]+)"),
        _key_value_replacer,
    ),
    # Authorization 头：Bearer sk-xxx（openai/httpx 的 DEBUG 日志会带）
    (re.compile(r"(?i)\b(bearer\s+)([A-Za-z0-9._\-]{8,})"), rf"\1{REDACTED}"),
    # 已知密钥前缀（DeepSeek / OpenAI 风格），即使裸奔也能兜住
    (re.compile(r"\bsk-[A-Za-z0-9._\-]{8,}"), REDACTED),
    # 本项目的 hex token（32 字节 → 64 位 hex；放宽到 32 位以上）
    (re.compile(r"\b[0-9a-fA-F]{32,}\b"), REDACTED),
    # 形如 …abcd 的掩码保留原样（这是允许出现的），不处理。
)


def redact_text(text: str) -> str:
    """擦除文本中的疑似凭据。**纯函数**，可单测。"""
    if not text:
        return text
    out = text
    for pattern, repl in _PATTERNS:
        out = pattern.sub(repl, out)
    return out


class SecretRedactingFilter(logging.Filter):
    """日志过滤器：擦除 message 与 args 中的凭据。

    挂到 **根 logger**（`logging.getLogger().addFilter(...)`）才能覆盖第三方库——
    logger 的 filter 只作用于该 logger 自己发出的记录，而 handler 的 filter
    才能覆盖冒泡上来的全部记录。这里两个都加，见 `install_log_redaction()`。
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 (logging API)
        # ⚠️ 只擦「值」，不碰「模板里的占位符」——否则 `msg % args` 会抛 TypeError。
        #    `redact_text` 已识别 `%s` / `%(name)s` 并原样保留（见 _PLACEHOLDER_RE）。
        if isinstance(record.args, tuple) and record.args:
            record.args = tuple(
                redact_text(a) if isinstance(a, str) else a for a in record.args
            )
        elif isinstance(record.args, dict) and record.args:
            record.args = {
                k: (redact_text(v) if isinstance(v, str) else v) for k, v in record.args.items()
            }
        if isinstance(record.msg, str):
            record.msg = redact_text(record.msg)
        # 异常信息（traceback 里也常带 URL/key）
        if record.exc_text:
            record.exc_text = redact_text(record.exc_text)
        return True


def install_log_redaction() -> None:
    """安装全局脱敏过滤器（幂等）。在 `main()` 里配置完 logging 后立刻调用。"""
    root = logging.getLogger()
    if any(isinstance(f, SecretRedactingFilter) for f in root.filters):
        return
    root.addFilter(SecretRedactingFilter())
    # 覆盖"第三方库自己 addHandler + 自带 handler"的路径（uvicorn / httpx）
    for handler in root.handlers:
        if not any(isinstance(f, SecretRedactingFilter) for f in handler.filters):
            handler.addFilter(SecretRedactingFilter())
