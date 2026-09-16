"""嵌入模型封装：**本地 fastembed（主） + 云端 OpenAI 兼容 API（降级级 2）**。

三条硬约束（业务陷阱清单 §2 / 执行文档 §8.4）：

1. **纯 CPU、离线可用、不依赖 Ollama、不需要 torch**。模型随包分发（约 90MB），
   维度只有一个来源：``app.config.EMBEDDING_DIM``（**不许在这里写 512**）。
2. **模型缺失不是崩溃理由**：本模块任何失败都收敛成 :class:`EmbedderUnavailable`，
   由检索链降级到云端 → FTS5 → 大纲。进程绝不允许因为「模型没下载」而起来不了。
3. 运行期**禁止联网下载模型**（``local_files_only=True``）：演示现场断网时，
   fastembed 若尝试联网会**先卡住几十秒再失败**，把「优雅降级」变成「界面卡死」。
   拉取模型是 ``scripts/fetch_embedding_model.py`` 的职责，不在请求路径上。
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Sequence

import numpy as np

from app.config import EMBEDDING_DIM, EMBEDDING_MODEL_DIR, EMBEDDING_MODEL_ID
from app.store.kb import l2_normalize

logger = logging.getLogger(__name__)

# 演示/排障用：把模型目录指到别处（例如一个空目录）即可观察降级链，
# 不必真的改文件夹名 —— 现场演示「降级」时这条比改名更可控。
MODEL_DIR_ENV = "K12_EMBEDDING_MODEL_DIR"

# 云端嵌入请求超时（秒）。**必须有**：断网时 urllib 的默认行为是长时间挂住。
CLOUD_TIMEOUT_S = 8.0


class EmbedderUnavailable(RuntimeError):
    """嵌入不可用（模型缺失/加载失败/云端不可达）。**调用方应降级，不要重试到超时。**"""


def resolve_model_dir() -> Path:
    override = os.environ.get(MODEL_DIR_ENV)
    return Path(override).expanduser() if override else Path(EMBEDDING_MODEL_DIR)


def model_files_present(model_dir: str | Path | None = None) -> bool:
    """模型文件是否就位（只看文件，不加载 —— 探活端点要轻量）。"""
    root = Path(model_dir) if model_dir else resolve_model_dir()
    return root.is_dir() and any(root.rglob("*.onnx"))


# --------------------------------------------------------------------------- #
# 本地：fastembed
# --------------------------------------------------------------------------- #
class LocalEmbedder:
    """fastembed ``BAAI/bge-small-zh-v1.5``（512 维，ONNX，CPU）。

    **懒加载**：sidecar 启动时不碰 ONNX（探活要快），第一次真正检索时才加载；
    加载失败会被记下来，后续请求直接走降级，不会每次请求都重试一遍慢路径。
    """

    def __init__(
        self,
        model_dir: str | Path | None = None,
        model_name: str = EMBEDDING_MODEL_ID,
    ) -> None:
        self.model_dir = Path(model_dir) if model_dir else resolve_model_dir()
        self.model_name = model_name
        self._model: Any = None
        self._failure: str | None = None

    # ------------------------------------------------------------ 状态 --
    @property
    def available(self) -> bool:
        if self._failure:
            return False
        return model_files_present(self.model_dir)

    @property
    def failure_reason(self) -> str | None:
        return self._failure

    def reset(self) -> None:
        """清掉失败标记（模型目录改成可用后重新尝试）。"""
        self._failure = None
        self._model = None

    def _load(self) -> Any:
        if self._model is not None:
            return self._model
        if self._failure:
            raise EmbedderUnavailable(self._failure)
        if not model_files_present(self.model_dir):
            self._failure = (
                f"嵌入模型文件缺失：{self.model_dir}（跑 uv run python scripts/fetch_embedding_model.py）"
            )
            raise EmbedderUnavailable(self._failure)
        try:
            from fastembed import TextEmbedding

            self._model = TextEmbedding(
                model_name=self.model_name,
                cache_dir=str(self.model_dir),
                # ★ 运行期只认本地文件：断网时宁可立刻降级，也不要卡在下载上
                local_files_only=True,
            )
        except Exception as exc:  # noqa: BLE001 - 任何加载失败都归入「不可用」
            self._failure = f"fastembed 加载失败：{type(exc).__name__}: {exc}"
            logger.warning("%s（检索将降级）", self._failure)
            raise EmbedderUnavailable(self._failure) from exc
        return self._model

    # ------------------------------------------------------------ 编码 --
    def _encode(self, texts: Sequence[str], *, query: bool) -> np.ndarray:
        model = self._load()
        try:
            vectors = (
                list(model.query_embed(list(texts)))
                if query
                else list(model.embed(list(texts)))
            )
        except Exception as exc:  # noqa: BLE001
            self._failure = f"fastembed 推理失败：{type(exc).__name__}: {exc}"
            raise EmbedderUnavailable(self._failure) from exc

        arr = np.vstack([np.asarray(v, dtype=np.float32).reshape(1, -1) for v in vectors])
        if arr.shape[1] != EMBEDDING_DIM:
            raise EmbedderUnavailable(
                f"嵌入维度 {arr.shape[1]} != EMBEDDING_DIM {EMBEDDING_DIM}"
                "（换模型必须同步改 vec0 维度并重建索引，见 app/config.py）"
            )
        return np.vstack([l2_normalize(v) for v in arr])

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        """文档向量（建库用），返回 ``(n, EMBEDDING_DIM)`` 的 L2 归一化矩阵。"""
        if not texts:
            return np.zeros((0, EMBEDDING_DIM), dtype=np.float32)
        return self._encode(texts, query=False)

    def embed_query(self, text: str) -> np.ndarray:
        """查询向量（检索用）。bge 系列查询侧不加指令前缀。"""
        return self._encode([text], query=True)[0]

    def warmup(self) -> None:
        self._encode(["预热"], query=True)


# --------------------------------------------------------------------------- #
# 云端：OpenAI 兼容 /embeddings（降级级 2）
# --------------------------------------------------------------------------- #
class CloudEmbedder:
    """用户自填的云端嵌入（``EmbeddingConfig.mode = "cloud_api"``）。

    只用一个 stdlib 的 ``urllib``：本项目为嵌入功能**不引入 HTTP 客户端依赖**
    （httpx 只在 dev 组里，打包产物里没有），少一个打包变量。
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model_id: str,
        timeout: float = CLOUD_TIMEOUT_S,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model_id = model_id
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.base_url and self.api_key and self.model_id)

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        return self._request(list(texts))

    def embed_query(self, text: str) -> np.ndarray:
        return self._request([text])[0]

    def _request(self, texts: Sequence[str]) -> np.ndarray:
        if not self.available:
            raise EmbedderUnavailable("云端嵌入未配置完整（base_url / api_key / model_id）")
        url = f"{self.base_url}/embeddings"
        payload = json.dumps({"model": self.model_id, "input": list(texts)}).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",  # ★ 绝不进日志
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise EmbedderUnavailable(f"云端嵌入不可达：{type(exc).__name__}: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise EmbedderUnavailable(f"云端嵌入返回非 JSON：{exc}") from exc

        try:
            arr = np.asarray([item["embedding"] for item in body["data"]], dtype=np.float32)
        except (KeyError, TypeError) as exc:
            raise EmbedderUnavailable(f"云端嵌入响应结构异常：{exc}") from exc

        if arr.ndim != 2 or arr.shape[1] != EMBEDDING_DIM:
            raise EmbedderUnavailable(
                f"云端嵌入维度 {arr.shape[1] if arr.ndim == 2 else '未知'} != EMBEDDING_DIM {EMBEDDING_DIM}"
            )
        return np.vstack([l2_normalize(v) for v in arr])


class NullEmbedder:
    """显式「无嵌入」：``EmbeddingConfig.mode = "none"``。"""

    available = False

    def embed_documents(self, texts: Sequence[str]) -> np.ndarray:
        raise EmbedderUnavailable("嵌入被配置为 none")

    def embed_query(self, text: str) -> np.ndarray:
        raise EmbedderUnavailable("嵌入被配置为 none")


# --------------------------------------------------------------------------- #
# 配置桥 + 单例
# --------------------------------------------------------------------------- #
_LOCAL_SINGLETON: LocalEmbedder | None = None


def get_local_embedder() -> LocalEmbedder:
    """进程内单例（避免每次请求都重新加载 ONNX）。"""
    global _LOCAL_SINGLETON
    if _LOCAL_SINGLETON is None:
        _LOCAL_SINGLETON = LocalEmbedder()
    return _LOCAL_SINGLETON


def reset_local_embedder() -> None:
    """丢掉单例（单测 / 模型就位后手动恢复用）。"""
    global _LOCAL_SINGLETON
    _LOCAL_SINGLETON = None


def read_embedding_config(data_dir: str | Path | None) -> dict[str, str]:
    """从 ``<data-dir>/config.json`` 里读嵌入配置（**只读、容错**）。

    ``config.json`` 的写入归票 07（设置页）。这里只做一次容错读取：
    文件不存在 / 字段缺失 / JSON 坏了，都返回 ``mode=none``（=不启用云端降级），
    **绝不因为配置文件问题让检索失败**。
    """
    if not data_dir:
        return {"mode": "none"}
    path = Path(data_dir) / "config.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"mode": "none"}
    cfg = data.get("embedding") or {}
    if not isinstance(cfg, dict):
        return {"mode": "none"}
    return {
        "mode": str(cfg.get("mode") or "none"),
        "base_url": str(cfg.get("base_url") or cfg.get("baseUrl") or ""),
        "api_key": str(cfg.get("api_key") or cfg.get("apiKey") or ""),
        "model_id": str(cfg.get("model_id") or cfg.get("modelId") or ""),
    }


def build_cloud_embedder(embedding_config: dict[str, str] | None) -> CloudEmbedder | None:
    """按配置构造云端嵌入器；未配置返回 ``None``（=该降级级不可用）。"""
    cfg = embedding_config or {}
    if cfg.get("mode") != "cloud_api":
        return None
    embedder = CloudEmbedder(
        base_url=cfg.get("base_url", ""),
        api_key=cfg.get("api_key", ""),
        model_id=cfg.get("model_id", ""),
    )
    return embedder if embedder.available else None


__all__ = [
    "CloudEmbedder",
    "EmbedderUnavailable",
    "LocalEmbedder",
    "MODEL_DIR_ENV",
    "NullEmbedder",
    "build_cloud_embedder",
    "get_local_embedder",
    "model_files_present",
    "read_embedding_config",
    "reset_local_embedder",
    "resolve_model_dir",
]
