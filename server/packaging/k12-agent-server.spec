# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（``--onedir``，**绝不用 onefile**）。

为什么不用 onefile：每次启动都要把上百 MB 解压到临时目录，冷启动 10s+，演示体感极差。

用法（**统一走脚本**，它打完会自检握手 / health / 中文编码）::

    cd server
    uv run python scripts/build_server.py
    uv run python scripts/build_server.py --verify     # 只自检已有产物

⚠️ 每新增一个「原生依赖」或「数据文件」依赖，都要重跑一次打包验证 ——
打包成功 ≠ 运行得起来，这是本项目最容易「开发好好的、打包就炸」的地方。
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all

# PyInstaller 以 exec 方式执行 spec，并注入 SPECPATH = spec 所在目录（server/packaging/）。
# 从它向上找到含 app/main.py 的那一层（即 server/），不写死层级，免得挪动 spec 就崩。
ROOT = Path(SPECPATH).resolve()  # noqa: F821
while not (ROOT / "app" / "main.py").exists() and ROOT.parent != ROOT:
    ROOT = ROOT.parent
if not (ROOT / "app" / "main.py").exists():
    raise SystemExit(f"[spec][FATAL] 向上找不到 server/（含 app/main.py），起点 {SPECPATH}")
print(f"[spec] 项目根目录 = {ROOT}")

# ---------------------------------------------------------------------------
# ⓪ 随包只读知识库：**路径的唯一来源在 app/config.py**
#
# 这里刻意 import 配置而不是再写一份 "resources/kb/kb.sqlite"：运行期
# （app/rag/retriever.default_kb_path）与构建期（本文件）必须指向**同一个常量**，
# 否则「打包带了库但检索去别处找」这类缺陷会静默复现 —— 就是关卡 E 发现的那个。
# ---------------------------------------------------------------------------
import sys as _sys  # noqa: E402

if str(ROOT) not in _sys.path:
    _sys.path.insert(0, str(ROOT))
from app.config import BUNDLED_KB_RELATIVE, BUNDLED_KB_STAGING  # noqa: E402

if not BUNDLED_KB_STAGING.exists():
    # ★ **打包直接失败**，而不是打出一个「没有知识库」的包。
    #   少了这一条，产物能打成功、能启动、/health 也正常，只是新机器上检索
    #   一路降级到 outline（0 命中）—— 缺陷会一路漂到交付。
    raise SystemExit(
        f"[spec][FATAL] 随包知识库不存在：{BUNDLED_KB_STAGING}\n"
        "  先跑 uv run python scripts/build_server.py（它会先建库再打包）。"
    )
if BUNDLED_KB_STAGING.stat().st_size <= 0:
    raise SystemExit(f"[spec][FATAL] 随包知识库为空文件：{BUNDLED_KB_STAGING}")
print(f"[spec] 随包知识库 = {BUNDLED_KB_STAGING} ({BUNDLED_KB_STAGING.stat().st_size / 1048576:.1f} MB)")

# ---------------------------------------------------------------------------
# ① 先收集第三方包的全部内容（.dll、元数据、ONNX Runtime 供应商库、子模块）
#
# ★ 必须在 Analysis 之前做：Analysis 接受 2 元组 (src, dest)，而 a.datas 产出后是
#   3 元组；先 Analysis 再 `a.datas += collect_all(...)` 会因元组长度不一致而
#   `ValueError: not enough values to unpack`。
# ---------------------------------------------------------------------------
_pkg_datas: list[tuple[str, str]] = []
_pkg_binaries: list[tuple[str, str]] = []
_pkg_hidden: list[str] = []

for _pkg in ("sqlite_vec", "fastembed", "onnxruntime"):
    try:
        _d, _b, _h = collect_all(_pkg)
        _pkg_datas += _d
        _pkg_binaries += _b
        _pkg_hidden += _h
        print(f"[spec] collect_all('{_pkg}') → datas={len(_d)} binaries={len(_b)} hidden={len(_h)}")
    except Exception as _exc:  # noqa: BLE001
        # 打包时就显式暴露，而不是拖到运行期「找不到 .dll / 模型」
        print(f"[spec][WARN] collect_all('{_pkg}') 失败：{_exc}")

# ---------------------------------------------------------------------------
# ② 数据文件：随包分发的只读资源（模型、知识库、教材、题库、动画模板、敏感词库…）
#
# ★ 新增数据资产时**必须**在这里登记 —— 「漏登记」的表现是「能打包、能启动、
#   功能静默降级」，不是报错。文件清单见 server/resources/README.md。
# ---------------------------------------------------------------------------
datas = [
    # fastembed 模型（约 90MB ONNX）。漏掉这项 → 打包后运行期必然「找不到模型」。
    # 注意：模型文件不入 git，缺失时这里只是把空目录打进去，
    # 表现是 /health 的 embedder_ready=false（降级链仍可用），不会崩。
    (str(ROOT / "resources"), "resources"),
    # 教材 Markdown（约 200KB）：**同时随包分发**，让用户在没网/没源码时也能重建自己的库。
    # 它是「重建能力」的载体，不是首跑的前提（首跑用下面那个只读 kb）。
    (str(ROOT / "knowledge"), "knowledge"),
]

# ★ 随包只读知识库：**文件名必须保持 "kb.sqlite" 且落到 resources/kb/**，
#   因为运行期 app/config.py 的 BUNDLED_KB_RELATIVE 就是这么找它的。
#   PyInstaller 的 datas 目标是**文件而非目录**（file → (dest_dir, filename)），
#   这里写成显式目标而不是整个目录，顺带杜绝把 build/ 里别的中间产物带进包。
datas.append((str(BUNDLED_KB_STAGING), str(BUNDLED_KB_RELATIVE.parent)))

datas += _pkg_datas


# ---------------------------------------------------------------------------
# ③ 隐式导入：只在运行期动态加载、静态分析扫不到的模块
# ---------------------------------------------------------------------------
hiddenimports = [
    # sqlite-vec 通过 ctypes 加载 .dll，静态分析看不见
    "sqlite_vec",
    # uvicorn 的动态加载路径（standard extra 的 loop/http 实现）
    "uvicorn.logging",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    *_pkg_hidden,
]

# ---------------------------------------------------------------------------
# ④ 排除：明确不用的重型/无关模块
# ---------------------------------------------------------------------------
excludes = [
    # 本项目用 fastembed(ONNX)，不需要 torch —— 排除它可省数 GB
    "torch",
    "torchvision",
    "torchaudio",
    # 训练/可视化栈，运行期用不到
    "matplotlib",
    "scipy",
    "pandas",
    "IPython",
    "notebook",
    "jupyter",
    "tkinter",
    "PyQt5",
    "PySide2",
    "PySide6",
    # 测试框架
    "pytest",
    "unittest",
]

a = Analysis(  # noqa: F821
    [str(ROOT / "app" / "main.py")],
    pathex=[str(ROOT)],
    binaries=_pkg_binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)  # noqa: F821

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="k12-agent-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # UPX 会破坏部分原生 DLL 的加载（onnxruntime / sqlite_vec），得不偿失
    upx=False,
    # ★ 必须保留控制台：stdout 是握手通道。
    #   被 Electron 以管道方式 spawn 时不会弹出窗口（windowsHide），
    #   手动双击调试时反而需要它来看到握手那一行。
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="k12-agent-server",  # → dist/k12-agent-server/
)
