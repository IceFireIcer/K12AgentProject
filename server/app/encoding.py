"""标准流编码强制为 UTF-8。

⚠️ **为什么不能只靠环境变量**（S01 实测踩到的坑）：

PyInstaller 的 bootloader 会设置 `Py_IgnoreEnvironmentFlag`，因此打包后的进程
**完全忽略** `PYTHONUTF8` 与 `PYTHONIOENCODING`。实测打包产物：

    sys.flags.utf8_mode = 0
    sys.stdout.encoding = 'gbk'
    sys.stderr.encoding = 'gbk'      # 即便 env 里两个变量都已设对

后果：
- 握手 JSON 里的中文（如「拒绝绑定非回环地址」）会按 GBK 字节输出，
  而 Electron 按 UTF-8 解码 → 乱码，甚至 `UnicodeEncodeError` 直接崩在 print 上；
- 日志文件被 GBK 污染。

所以必须在 Python 层面显式 reconfigure，不能指望 spawn 时传 env。
（`项目执行文档.md` 风险表 #3 只写了「spawn 时传 env」，这里是它的必要补充。）
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
    """一步到位：流编码 + 控制台代码页。"""
    force_utf8_stdio()
    force_windows_console_utf8()
