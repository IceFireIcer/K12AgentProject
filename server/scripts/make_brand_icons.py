#!/usr/bin/env python3
"""从仓库根的 `logos/` 生成桌面端要用的品牌素材（**可重复执行、幂等**）。

## 为什么要有这个脚本
`logos/` 里的原始图是 2048×2048、每张约 2MB（AI 出图四周有大量透明留白），
**不能直接进程序**：五张就 12MB，会白白撑大安装包，而界面上真正用到的尺寸只有 256px 上下。

本脚本做两件事，参数都写在常量里、不需要人记：
  1. Windows 可执行文件图标 `desktop/build/icon.ico`（多尺寸，electron-builder 自动取用）；
  2. 运行时素材 `desktop/resources/brand/*.png`（裁掉透明边 + 缩到 `RUNTIME_SIZE`），
     供界面按**当前学段**切换吉祥物形象。

## 用法
    cd server && uv run python scripts/make_brand_icons.py

## 学段 → logo 的映射
见下面 `GRADE_LOGOS`，**要改只改这一处**。当前依据是四张图的成熟度递进：
天使翅膀 / 云朵 → 草莓连帽衫 → 粉色连帽衫 + 领结 → 西装 + 书包（校服形态）。
"""
from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境问题，直接说清楚怎么修
    sys.exit("缺少 Pillow。请用本项目的虚拟环境跑：cd server && uv run python scripts/make_brand_icons.py")

REPO = Path(__file__).resolve().parent.parent.parent
LOGOS = REPO / "logos"
BUILD = REPO / "desktop" / "build"
BRAND_OUT = REPO / "desktop" / "resources" / "brand"

#: 运行时素材边长（界面头像 / 品牌标最多用到这个尺寸，再大没有收益、只是体积）。
RUNTIME_SIZE = 256
#: `.ico` 里打包的尺寸档（Windows 按 DPI 与场景各取所需）。
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
#: 图标内容四周留白比例（0.06 = 6%）。
ICON_MARGIN_RATIO = 0.06

#: 主 logo（窗口图标、关于页、安装包）。
MAIN_LOGO = "mainlogo.png"
#: 学段 → logo 文件。**改映射只改这里**。
GRADE_LOGOS: dict[str, str] = {
    "primary_low": "logo1.png",   # 天使翅膀 + 云朵：最梦幻的一档
    "primary_high": "logo2.png",  # 草莓连帽衫：活泼
    "junior": "logo3.png",        # 粉色连帽衫 + 领结：收敛一些
    "senior": "logo4.png",        # 西装 + 书包：校服形态，最成熟
}


def load_squared(source: Path, size: int, margin_ratio: float) -> Image.Image:
    """裁掉透明边 → 补成正方形 → 缩放。

    为什么要裁：AI 出图四周有大片透明区，不裁的话同一批图**视觉大小不一致**
    （每张留白比例不同），排在一起会忽大忽小。
    """
    image = Image.open(source).convert("RGBA")
    box = image.getchannel("A").getbbox()
    if box is not None:
        image = image.crop(box)

    # 补成正方形，内容居中、不拉伸（等比缩放是底线：头像变形比小一点更难看）
    side = max(image.width, image.height)
    square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2), image)

    # 再按比例加一圈留白，最后缩到目标尺寸
    if margin_ratio > 0:
        padded = round(side * (1 + margin_ratio * 2))
        canvas = Image.new("RGBA", (padded, padded), (0, 0, 0, 0))
        offset = (padded - side) // 2
        canvas.paste(square, (offset, offset), square)
        square = canvas

    return square.resize((size, size), Image.LANCZOS)


def main() -> int:
    if not LOGOS.is_dir():
        return _fail(f"找不到 logos 目录：{LOGOS}")

    missing = [n for n in [MAIN_LOGO, *GRADE_LOGOS.values()] if not (LOGOS / n).is_file()]
    if missing:
        return _fail(f"logos/ 里缺少这些文件：{', '.join(missing)}")

    BUILD.mkdir(parents=True, exist_ok=True)
    BRAND_OUT.mkdir(parents=True, exist_ok=True)

    # ── 1. Windows 可执行文件图标（electron-builder 自动取 build/icon.ico）──
    main_square = load_squared(LOGOS / MAIN_LOGO, 1024, ICON_MARGIN_RATIO)
    ico_path = BUILD / "icon.ico"
    main_square.save(ico_path, format="ICO", sizes=ICO_SIZES)
    print(f"[icons] 已写出 {_rel(ico_path)}（{len(ICO_SIZES)} 个尺寸）")

    # Linux / macOS 目标也认这张 PNG（现在只出 Windows，留一张不亏）
    png_path = BUILD / "icon.png"
    main_square.resize((512, 512), Image.LANCZOS).save(png_path, format="PNG", optimize=True)
    print(f"[icons] 已写出 {_rel(png_path)}（512×512）")

    # ── 2. 运行时素材：主 logo + 四学段（供界面按当前学段切换）──
    main_runtime = BRAND_OUT / "main.png"
    load_squared(LOGOS / MAIN_LOGO, RUNTIME_SIZE, ICON_MARGIN_RATIO).save(
        main_runtime, format="PNG", optimize=True
    )
    print(f"[brand] 已写出 {_rel(main_runtime)}（{RUNTIME_SIZE}×{RUNTIME_SIZE}）")

    for grade, filename in GRADE_LOGOS.items():
        out = BRAND_OUT / f"{grade}.png"
        load_squared(LOGOS / filename, RUNTIME_SIZE, ICON_MARGIN_RATIO).save(
            out, format="PNG", optimize=True
        )
        print(f"[brand] 已写出 {_rel(out)}  ← {filename}")

    total = sum(p.stat().st_size for p in BRAND_OUT.iterdir()) + ico_path.stat().st_size
    print(f"[icons] 完成：运行时素材合计 {total / 1024:.0f} KB（原始图约 12 MB）")
    return 0


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path)


def _fail(message: str) -> int:
    print(f"[icons] 失败：{message}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
