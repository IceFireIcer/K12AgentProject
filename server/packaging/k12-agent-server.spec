# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置（`--onedir`，**绝不用 onefile**）。

为什么不用 onefile：每次启动都要把上百 MB 解压到临时目录，冷启动 10s+，
演示体感极差。

用法（推荐走脚本，它打完会自检握手/health/中文编码）：
    cd server
    uv run python scripts/build_server.py
    uv run python scripts/build_server.py --verify     # 只自检已有产物

⚠️ 每新增一个「原生依赖」或「数据文件」依赖，都要重跑一次打包验证。
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all

# PyInstaller 以 exec 方式执行 spec，并注入 SPECPATH = spec 所在目录（server/packaging/）。
# 从它向上找到 server/（含 app/ 的那一层），不写死层级，免得挪动 spec 后就崩。
ROOT = Path(SPECPATH).resolve()  # noqa: F821
while not (ROOT / "app" / "main.py").exists() and ROOT.parent != ROOT:
    ROOT = ROOT.parent
if not (ROOT / "app" / "main.py").exists():
    raise SystemExit(f"[spec][FATAL] 向上找不到 server/（含 app/main.py），起点 {SPECPATH}")
print(f"[spec] 项目根目录 = {ROOT}")

# ---------------------------------------------------------------------------
# ① 先收集第三方包的全部内容（.dll、元数据、ONNX Runtime 供应商库、子模块）
#
# 必须在 Analysis 之前做：Analysis 接受 2 元组 (src, dest)，而 a.datas 产出后是
# 3 元组；先 Analysis 再 `a.datas += collect_all(...)` 会因元组长度不一致而崩。
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
    except Exception as _exc:  # noqa: BLE001
        # 打包时就显式暴露，而不是拖到运行期「找不到 .dll / 模型」
        print(f"[spec][WARN] collect_all('{_pkg}') 失败：{_exc}")

# ---------------------------------------------------------------------------
# ② 数据文件：随包分发的只读资源（模型、题库、动画模板、敏感词库…）
# ---------------------------------------------------------------------------
datas = [
    # fastembed 模型 90MB ONNX。漏掉这项 → 打包后运行期必然「找不到模型」。
    (str(ROOT / "resources"), "resources"),
    *_pkg_datas,
]

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
    "uvicorn.protocols.websockets.auto",
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
    upx=False,  # UPX 会破坏部分原生 DLL 的加载，得不偿失
    console=True,  # ★ 必须保留控制台：stdout 是握手通道
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
