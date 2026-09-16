"""``config.json`` 的读写（LLM / 嵌入配置、数据目录）。

**落地时间是票 07**（设置页 + 连通性探测）。票 01 只固定「配置落在哪」这一件事，
避免后面各处自己拼路径。

约定（执行文档 §8.2）：

- 位置：``<data-dir>/config.json``，**不在安装目录内**（打包态那里只读）；
- **API Key 只存本地**，不进日志、不上传；读接口只回掩码（``…abcd``）与 ``hasKey``；
- 写入必须**原子**（临时文件 + ``os.replace``），避免半写导致配置损坏。
"""

from __future__ import annotations

from pathlib import Path

CONFIG_FILENAME = "config.json"


def config_path(data_dir: Path) -> Path:
    """``<data-dir>/config.json`` 的完整路径（不创建目录、不落盘）。"""
    return Path(data_dir) / CONFIG_FILENAME
