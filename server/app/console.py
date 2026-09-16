"""把标准流强制切成 UTF-8。

⚠️ **为什么不能只靠环境变量**（本机实测踩过）：

PyInstaller 的 bootloader 会设置 ``Py_IgnoreEnvironmentFlag``，因此打包后的进程
**完全忽略** ``PYTHONUTF8`` 与 ``PYTHONIOENCODING``。实测打包产物：

    sys.flags.utf8_mode  == 0
    sys.stdout.encoding  == 'gbk'      # 即便 spawn 时两个 env 都已设对
    sys.stderr.encoding  == 'gbk'

后果有两层：

1. 握手 JSON 里的中文（如「拒绝绑定非回环地址」）按 GBK 输出，而 Electron 按 UTF-8
   解码 → 乱码；
2. 更糟的是 ``UnicodeEncodeError`` 可能直接崩在 print 上，表现为「sidecar 起不来」。

所以在 spawn 时传 env 只算**源码运行态的补充**，真正的兜底是这里的 ``reconfigure``。
**不要试图只靠 env 解决打包态乱码** —— 那条路是死的。
"""

from __future__ import annotations

import sys

_APPLIED = False


def force_utf8_stdio() -> None:
    """把 stdout / stderr 切到 UTF-8（幂等，可重复调用）。"""
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True

    for stream_name in ("stdout", "stderr"):
        stream = getattr(sys, stream_name, None)
        if stream is None:
            continue  # pythonw / 无控制台场景
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue  # 已被替换成非 TextIOWrapper，交给调用方自理
        try:
            # errors="replace"：宁可个别字符变问号，也绝不因编码异常中断握手
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            # 流已关闭或不可重配置（如被重定向到特殊对象）——不致命
            pass


def force_windows_console_utf8() -> None:
    """把 Windows 控制台代码页设为 UTF-8，避免手动运行时中文乱码。

    仅在有真实控制台时生效；被 Electron 以管道方式启动时无副作用。
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
        # 65001 = CP_UTF8；失败也不影响管道场景
        kernel32.SetConsoleOutputCP(65001)
        kernel32.SetConsoleCP(65001)
    except Exception:  # noqa: BLE001
        pass


def install_utf8_stdio() -> None:
    """一步到位：流编码 + 控制台代码页。**必须在任何输出之前调用**。"""
    force_utf8_stdio()
    force_windows_console_utf8()
