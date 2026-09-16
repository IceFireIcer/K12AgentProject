"""设置存储：``<data-dir>/config.json`` 的**原子读写**（票 07 落地）。

约定（执行文档 §8.2 / §6.2）：

- 位置：``<data-dir>/config.json``（Electron 传的是 ``userData``），**不在安装目录内** ——
  打包态那里是只读的；
- **API Key 只存本地**：不进日志、不上传；读接口只回掩码（``…abcd``）与 ``hasKey``
  （掩码语义的唯一落点在 ``app/contracts.py``，本模块只保证「写进去的是明文、读出来的没人看见」）；
- 写入必须**原子**（同目录临时文件 + ``os.replace``）：中途崩溃只会留下旧的完整文件，
  绝不会出现半截 JSON 把用户的配置（含 Key）整段作废；
- 文件损坏（截断/手改坏/编码异常）时**回退默认值并记录可读原因**，
  把原文件改名备份（``config.json.corrupt-<UTC 时间戳>``）后继续启动 —— 设置页坏掉不该让整个应用起不来。

**文件结构（其它模块按此读写，不要另立一套）**::

    {
      "version": 1,
      "saved_at": "2026-09-16T12:00:00+00:00",
      "llm":       {"provider_name": "...", "base_url": "...", "api_key": "<明文，仅本地>", "model_id": "..."},
      "embedding": {"mode": "local_fastembed", "base_url": null, "api_key": "", "model_id": "BAAI/bge-small-zh-v1.5"}
    }

键名用 **snake_case**（与 pydantic 内部字段一致）；出参的 camelCase 由契约模型
（``CamelModel`` 的 alias）负责，**存储层不做命名转换**。读取时同时容忍 camelCase
（手工编辑 / 其它语言写出来的文件），未知键忽略 —— 手写 ``config.json`` 调试是票 06 的既定用法。

数据类（``StoredLlm`` / ``StoredEmbedding`` / ``StoredSettings``）与 ``SettingsStore`` 协议也在这里，
由 ``app/routes/settings.py`` re-export：这样「存储」只依赖契约，HTTP 层只依赖存储，
不会出现互相 import 的环。
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from app.contracts import (
    DEFAULT_EMBEDDING_MODEL_ID,
    DEFAULT_LLM_BASE_URL,
    DEFAULT_LLM_MODEL_ID,
    DEFAULT_LLM_PROVIDER_NAME,
    EmbeddingMode,
    normalize_base_url,
)

logger = logging.getLogger("app.settings_store")

CONFIG_FILENAME = "config.json"
#: 原子写的临时文件名后缀（与正式文件同目录，``os.replace`` 才是一次原子改名）。
CONFIG_TEMP_SUFFIX = ".tmp"
#: 损坏文件的备份名前缀（保留用户手填的内容，不静默丢掉）。
CONFIG_CORRUPT_INFIX = ".corrupt-"
#: 文件结构版本：将来加字段时可据此迁移（现在只写不校验，多版本共存期不做迁移逻辑）。
CONFIG_SCHEMA_VERSION = 1

EMBEDDING_MODES: tuple[EmbeddingMode, ...] = ("local_fastembed", "cloud_api", "none")


def config_path(data_dir: Path | str) -> Path:
    """``<data-dir>/config.json`` 的完整路径（不创建目录、不落盘）。"""
    return Path(data_dir) / CONFIG_FILENAME


class SettingsWriteError(RuntimeError):
    """配置**没能落盘**。

    必须让调用方看见（路由转成可读的 5xx），**不能吞掉** ——
    「保存成功」的假象比直接报错更糟：老师会以为 Key 已经存好了。
    消息里只允许出现路径与系统错误文本，**绝不含 Key**。
    """


# --------------------------------------------------------------------------- #
# 存储形状
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class StoredLlm:
    """落盘的 LLM 配置（**含明文 Key**，只在本模块与存储层之间流转）。"""

    provider_name: str = DEFAULT_LLM_PROVIDER_NAME
    base_url: str = DEFAULT_LLM_BASE_URL
    #: ``repr=False`` —— **Key 绝不进 repr()/str()/日志**（日志/异常里打印 dataclass 是常见事故）。
    api_key: str = field(default="", repr=False)
    model_id: str = DEFAULT_LLM_MODEL_ID


@dataclass(frozen=True)
class StoredEmbedding:
    """落盘的嵌入配置（含明文 Key，同上）。"""

    mode: EmbeddingMode = "local_fastembed"
    base_url: str | None = None
    #: 同 :attr:`StoredLlm.api_key`：``repr=False``。
    api_key: str = field(default="", repr=False)
    model_id: str | None = DEFAULT_EMBEDDING_MODEL_ID


@dataclass(frozen=True)
class StoredSettings:
    """一份完整设置（LLM + 嵌入）。``repr`` 里看不到任何 Key。"""

    llm: StoredLlm = StoredLlm()
    embedding: StoredEmbedding = StoredEmbedding()


def default_settings() -> StoredSettings:
    """出厂默认值（**默认值只是初始值**：四项都可改，不得写死供应商）。"""
    return StoredSettings()


class SettingsStore(Protocol):
    """设置存储接口（路由只依赖它，测试/将来换实现都注入到这里）。"""

    def load(self) -> StoredSettings: ...

    def save(self, settings: StoredSettings) -> None: ...


class InMemorySettingsStore:
    """进程内存实现（**不落盘**，重启即失）。

    两个用途，都不是「占位」：

    1. 票 04 的契约与掩码语义测试需要一个干净、互不干扰的存储；
    2. 未显式指定 ``--data-dir`` 时（单测、`uv run uvicorn` 手动 curl 调试）没有「用户数据目录」
       可言，写进仓库里的 ``server/_data`` 会污染开发目录、还会让契约测试互相串状态 ——
       这种情况由 :func:`app.routes.settings.get_settings_store` 退到这里。

    真实运行（Electron 传 ``userData``）走 :class:`ConfigFileSettingsStore`。
    """

    def __init__(self, initial: StoredSettings | None = None) -> None:
        self._settings = initial or StoredSettings()
        self._lock = threading.Lock()

    def load(self) -> StoredSettings:
        with self._lock:
            return self._settings

    def save(self, settings: StoredSettings) -> None:
        with self._lock:
            self._settings = settings


class ConfigFileSettingsStore(InMemorySettingsStore):
    """``<data-dir>/config.json`` 落盘实现：**磁盘是权威**，内存副本只作缓存与兜底。

    继承 :class:`InMemorySettingsStore` 是为了复用它的**同一把锁**与内存快照
    （路由的 PUT 跑在线程池里，可能和 GET 并发），因此 ``isinstance(store, InMemorySettingsStore)``
    依然成立 —— 票 04 的注入断言与「换成落盘实现不用改路由」的接缝承诺同时保持。

    读写语义：

    - ``load()`` **每次都读盘**（票 06 允许手工编辑 ``config.json``；设置页读回必须与磁盘一致）；
      文件不存在 → 默认值（**不建文件**：GET 不该有写副作用）；文件损坏 → 默认值 + 备份 + 可读原因；
    - ``save()`` **先落盘、后更新内存**（写失败就抛 :class:`SettingsWriteError`，不留「假成功」）。
    """

    def __init__(self, data_dir: Path | str) -> None:
        super().__init__()
        self._path = config_path(data_dir)
        self._last_error: str | None = None

    # ------------------------------------------------------------- 只读属性 --
    @property
    def path(self) -> Path:
        """配置文件完整路径（诊断/日志用；**日志里只写文件名**）。"""
        return self._path

    @property
    def last_error(self) -> str | None:
        """最近一次读取发现的可读问题（``None`` = 一切正常）。

        契约里没有承载它的字段（``SettingsResponse`` 冻结），所以它只用于日志与诊断：
        设置页读到的仍是「已回退的默认值」，而不是一个打不开的界面。
        """
        return self._last_error

    # ----------------------------------------------------------------- 读 --
    def load(self) -> StoredSettings:
        with self._lock:
            settings, error = self._read_from_disk()
            self._settings = settings
            self._last_error = error
            return settings

    def _read_from_disk(self) -> tuple[StoredSettings, str | None]:
        self._remove_stale_temp()

        if not self._path.exists():
            return default_settings(), None

        try:
            raw = self._path.read_text(encoding="utf-8")
        except OSError as exc:
            return self._degrade(f"配置文件无法读取（{exc.strerror or exc}）")
        except UnicodeDecodeError as exc:
            return self._degrade(f"配置文件不是 UTF-8 文本（{exc.reason}），可能是被别的工具改坏了")

        if raw.strip() == "":
            return self._degrade("配置文件为空（上次写入可能被中断）")

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            return self._degrade(
                f"配置文件不是合法 JSON（第 {exc.lineno} 行第 {exc.colno} 列：{exc.msg}）"
            )

        if not isinstance(data, dict):
            return self._degrade("配置文件顶层不是 JSON 对象")

        settings, issues = settings_from_json(data)
        if not issues:
            return settings, None

        message = "；".join(issues)
        logger.warning("设置文件 %s 有可自动修正的问题：%s", self._path.name, message)
        return settings, message

    def _degrade(self, reason: str) -> tuple[StoredSettings, str]:
        """损坏/不可读 → 备份原文件 + 默认值 + 可读原因（**不抛异常、不静默**）。"""
        message = reason
        backup = self._backup_corrupt_file()
        if backup is not None:
            message = f"{message}；原文件已备份为 {backup.name}"

        # ★ 只记原因与文件名 —— 文件内容（可能含 API Key）绝不进日志。
        logger.warning("设置文件不可用，已回退默认值：%s", message)
        return default_settings(), message

    def _backup_corrupt_file(self) -> Path | None:
        """把损坏的文件改名留档（best effort：备份失败也不能拦住启动）。"""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = self._path.with_name(self._path.name + CONFIG_CORRUPT_INFIX + stamp)
        try:
            os.replace(self._path, backup)
        except OSError:
            return None
        return backup

    def _remove_stale_temp(self) -> None:
        """清掉上次进程被强杀留下的临时文件（用户目录里不该长垃圾）。"""
        temp_path = self._temp_path()
        if not temp_path.exists():
            return
        with contextlib.suppress(OSError):
            os.remove(temp_path)
            logger.info("已清理上次写入中断留下的临时文件：%s", temp_path.name)

    # ----------------------------------------------------------------- 写 --
    def save(self, settings: StoredSettings) -> None:
        payload = dump_settings(settings)

        with self._lock:
            try:
                self._write_atomically(payload)
            except OSError as exc:
                raise SettingsWriteError(
                    f"配置写入失败（{self._path.name}）：{exc.strerror or exc}"
                ) from exc

            # ★ 落盘成功后才更新内存：写失败绝不能留下「看起来存好了」的状态。
            # ★ 这里不调 super().save()：父类用的是同一把**非重入锁**，重入会死锁。
            self._settings = settings
            self._last_error = None

        # 只记「有没有 Key」，绝不记 Key 本身；用 %s 占位符（不要提前拼字符串）。
        logger.info(
            "设置已写入 %s（供应商=%s，API Key=%s，嵌入模式=%s）",
            self._path.name,
            settings.llm.provider_name.strip() or "未填",
            "已设置" if settings.llm.api_key else "未设置",
            settings.embedding.mode,
        )

    def _temp_path(self) -> Path:
        """临时文件与正式文件**同目录**：``os.replace`` 只有同盘同目录才是原子改名。"""
        return self._path.with_name(self._path.name + CONFIG_TEMP_SUFFIX)

    def _write_atomically(self, payload: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self._temp_path()

        try:
            # newline="\n"：Windows 上也不要写 CRLF（.gitattributes 统一 LF，手工 diff 才干净）。
            with open(temp_path, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                # fsync 之后「临时文件里是完整内容」才成立 —— 否则 rename 只是把半写内容改了个名。
                os.fsync(handle.fileno())
            os.replace(temp_path, self._path)
        finally:
            # 任何失败路径都不留临时文件；成功路径下 replace 已把它移走（exists() 为假）。
            if temp_path.exists():
                with contextlib.suppress(OSError):
                    os.remove(temp_path)

        with contextlib.suppress(OSError):
            # POSIX 生效、Windows 忽略：Key 是明文落盘（设计如此），别再让同机其他账号读到。
            os.chmod(self._path, 0o600)


# --------------------------------------------------------------------------- #
# 序列化（snake_case；读取容忍 camelCase）
# --------------------------------------------------------------------------- #
#: 「字段不存在」的哨兵（与 ``None`` 区分：``null`` 是显式取值）。
_MISSING = object()


def dump_settings(settings: StoredSettings) -> str:
    """设置 → JSON 文本（UTF-8 友好、两空格缩进、结尾换行）。"""
    document = {
        "version": CONFIG_SCHEMA_VERSION,
        "saved_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "llm": {
            "provider_name": settings.llm.provider_name,
            "base_url": settings.llm.base_url,
            "api_key": settings.llm.api_key,
            "model_id": settings.llm.model_id,
        },
        "embedding": {
            "mode": settings.embedding.mode,
            "base_url": settings.embedding.base_url,
            "api_key": settings.embedding.api_key,
            "model_id": settings.embedding.model_id,
        },
    }
    return json.dumps(document, ensure_ascii=False, indent=2) + "\n"


def settings_from_json(data: dict[str, Any]) -> tuple[StoredSettings, list[str]]:
    """JSON 对象 → 设置 + 可读的「自动修正」说明（空列表 = 完全一致）。

    **宽容读取**：类型不对/枚举不认识/必填为空 → 回退默认值并记一条说明，
    绝不因为一个字段写坏就整份配置作废（用户手改 ``config.json`` 是既定用法）。
    """
    issues: list[str] = []

    llm_raw = _section(data, "llm")
    embedding_raw = _section(data, "embedding")

    llm = StoredLlm(
        provider_name=_read_text(llm_raw, ("provider_name", "providerName"), DEFAULT_LLM_PROVIDER_NAME, issues, "llm.provider_name"),
        base_url=_read_base_url(llm_raw, DEFAULT_LLM_BASE_URL, issues, "llm.base_url"),
        api_key=_read_text(llm_raw, ("api_key", "apiKey"), "", issues, "llm.api_key"),
        model_id=_read_text(llm_raw, ("model_id", "modelId"), DEFAULT_LLM_MODEL_ID, issues, "llm.model_id"),
    )

    mode = _read_text(embedding_raw, ("mode",), "local_fastembed", issues, "embedding.mode")
    if mode not in EMBEDDING_MODES:
        issues.append(f"embedding.mode 取值不认识（{mode}），已按 local_fastembed 处理")
        mode = "local_fastembed"

    embedding = StoredEmbedding(
        mode=mode,  # type: ignore[arg-type]  # 上面已逐个校验过 EMBEDDING_MODES
        base_url=_read_optional_base_url(embedding_raw, issues, "embedding.base_url"),
        api_key=_read_text(embedding_raw, ("api_key", "apiKey"), "", issues, "embedding.api_key"),
        model_id=_read_optional_text(embedding_raw, ("model_id", "modelId"), DEFAULT_EMBEDDING_MODEL_ID),
    )
    return StoredSettings(llm=llm, embedding=embedding), issues


def _section(data: dict[str, Any], name: str) -> dict[str, Any]:
    """取一个子对象；不是对象就当空对象（每个字段各自回退默认值）。"""
    value = data.get(name)
    return value if isinstance(value, dict) else {}


def _pick(source: dict[str, Any], names: tuple[str, ...]) -> Any:
    for name in names:
        if name in source:
            return source[name]
    return _MISSING


def _read_text(
    source: dict[str, Any],
    names: tuple[str, ...],
    default: str,
    issues: list[str],
    label: str,
) -> str:
    value = _pick(source, names)
    if value is _MISSING or value is None:
        return default
    if not isinstance(value, str):
        issues.append(f"{label} 不是文本，已回退默认值")
        return default

    text = value.strip()
    if text == "" and default != "":
        issues.append(f"{label} 为空，已回退默认值")
        return default
    return text


def _read_base_url(
    source: dict[str, Any],
    default: str,
    issues: list[str],
    label: str,
) -> str:
    """BaseURL：去空白、去尾部斜杠，**不自动补 /v1**（与 `contracts.normalize_base_url` 一致）。"""
    value = _pick(source, ("base_url", "baseUrl"))
    if value is _MISSING or value is None:
        return default
    if not isinstance(value, str):
        issues.append(f"{label} 不是文本，已回退默认值")
        return default

    normalized = normalize_base_url(value)
    if normalized == "":
        issues.append(f"{label} 为空，已回退默认值")
        return default
    return normalized


def _read_optional_text(
    source: dict[str, Any], names: tuple[str, ...], default: str | None
) -> str | None:
    value = _pick(source, names)
    if value is _MISSING or value is None:
        return default
    if not isinstance(value, str):
        return default
    text = value.strip()
    return text if text != "" else default


def _read_optional_base_url(
    source: dict[str, Any], issues: list[str], label: str
) -> str | None:
    value = _pick(source, ("base_url", "baseUrl"))
    if value is _MISSING or value is None:
        return None
    if not isinstance(value, str):
        issues.append(f"{label} 不是文本，已忽略")
        return None

    normalized = normalize_base_url(value)
    return normalized if normalized != "" else None
