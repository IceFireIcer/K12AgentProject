"""设置持久化：`config.json` 读写（落在 `--data-dir`）。

（对应 `项目执行文档.md` 第 6.2/7.4 节）

设计取舍
--------
- **单文件 JSON**，不引 DB：设置项少、需要人工可读可改（演示时可现场改 BaseURL）。
- **原子写**（临时文件 + `os.replace`）：断电/崩溃不会留下半截 JSON 把应用锁死。
- **明文存盘是刻意的**：API Key 由用户在本地填写，仅存本机 `data-dir`，
  不上传、不进日志、不出现在 API 响应里（见 `app/redact.py` + `models.mask_secret`）。
  若后续要加固，升级路径是对称加密 + DPAPI/Keychain；**但不要**在这之前把 key
  写进任何可同步的目录。
- **空 key = 不修改**：避免「打开设置页点一下保存 → Key 被清空」这种致命交互。
  显式清除请用 `clearApiKey: true`。
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from app.config import EMBEDDING_MODEL_ID
from app.models import (
    EmbeddingConfig,
    LlmConfig,
    SettingsResponse,
    SettingsUpdateRequest,
    mask_secret,
)

#: 设置文件名（放在 data-dir 根，与 SQLite 同级，便于整体备份/清理）。
CONFIG_FILENAME = "config.json"


class SettingsError(RuntimeError):
    """配置文件不可用（损坏且无法回退）——启动期应据此给出可读错误。"""


@dataclass(frozen=True)
class AppSettings:
    """内存中的完整设置（含明文 key，**禁止直接序列化给前端**）。"""

    llm: LlmConfig
    embedding: EmbeddingConfig


def _default_settings() -> AppSettings:
    return AppSettings(llm=LlmConfig(), embedding=EmbeddingConfig())


def looks_masked(value: str) -> bool:
    """判断一个字符串是否是 `mask_secret()` 的产物。

    前端「回显 → 原样提交」会把掩码传回来，必须识别出来当作「不修改」，
    否则掩码会被真的存成 key（经典事故）。
    """
    if not value:
        return False
    return value.startswith("…") or value == "***"


class SettingsStore:
    """`config.json` 的唯一读写入口。"""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / CONFIG_FILENAME
        #: 上次读取失败的原因（如 JSON 损坏），供 UI 提示；不影响默认值回退。
        self.last_error: str | None = None

    # ---------------------------------------------------------------- 读 --

    def load(self) -> AppSettings:
        """读取设置；文件缺失或损坏时回退默认值（**不让设置问题阻断启动**）。"""
        self.last_error = None
        if not self.path.exists():
            return _default_settings()
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self.last_error = f"config.json 无法读取（已回退默认值）：{exc}"
            return _default_settings()
        try:
            return AppSettings(
                llm=LlmConfig.model_validate(raw.get("llm") or {}),
                embedding=EmbeddingConfig.model_validate(raw.get("embedding") or {}),
            )
        except ValidationError as exc:
            self.last_error = f"config.json 字段不合法（已回退默认值）：{exc.error_count()} 处错误"
            return _default_settings()

    # ---------------------------------------------------------------- 写 --

    def save(self, incoming: SettingsUpdateRequest) -> AppSettings:
        """合并并落盘。

        API Key 语义：
        - `clearApiKey=true` → 清空；
        - 传入空串或掩码（`…abcd`）→ **保留原值**；
        - 其他 → 覆盖。
        """
        current = self.load()

        api_key = incoming.llm.api_key
        if incoming.clear_api_key:
            api_key = ""
        elif not api_key or looks_masked(api_key):
            api_key = current.llm.api_key

        merged = AppSettings(
            llm=incoming.llm.model_copy(update={"api_key": api_key}),
            embedding=incoming.embedding,
        )
        self._write(merged)
        return merged

    def _write(self, settings: AppSettings) -> None:
        payload = {
            "llm": settings.llm.model_dump(mode="json"),
            "embedding": settings.embedding.model_dump(mode="json"),
        }
        self.data_dir.mkdir(parents=True, exist_ok=True)
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

        # 原子写：同目录临时文件 → os.replace（同分区保证原子性）
        fd, tmp_name = tempfile.mkstemp(
            prefix=f".{CONFIG_FILENAME}.", suffix=".tmp", dir=str(self.data_dir)
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_name, self.path)
        except OSError as exc:
            Path(tmp_name).unlink(missing_ok=True)
            raise SettingsError(f"设置写入失败：{exc}") from exc

    # ------------------------------------------------------------ 出参 --

    def to_response(self, settings: AppSettings | None = None) -> SettingsResponse:
        """构造**可安全回给前端**的响应（不含明文 key）。"""
        current = settings or self.load()
        api_key = current.llm.api_key
        return SettingsResponse(
            llm=current.llm.model_copy(update={"api_key": ""}),
            embedding=current.embedding.model_copy(update={"api_key": None}),
            has_key=bool(api_key),
            api_key_masked=mask_secret(api_key),
            config_path=str(self.path),
            embedding_model_id=EMBEDDING_MODEL_ID,
        )
