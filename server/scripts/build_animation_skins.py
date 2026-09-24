# -*- coding: utf-8 -*-
"""由设计令牌生成动画沙箱的**皮肤样式** ``server/resources/templates/_shared/skins.css``。

## 为什么需要这个脚本（而不是手写一份 CSS）

沙箱里的动画此前**只有一套配色**（``_shared/base.css`` 里写死的 ``--accent: #2f6fd0``），
四个学段的动画长得一模一样 —— 小学低年级和高中生的卡片是同一张脸。而项目**本来就有**
一套分学段调色板（``desktop/scripts/design/tokens.source.json``，渲染进程的
``tokens.generated.css`` 也是从它生成的）—— 沙箱只是从没用过它。

所以这里做同一件事的第二次：**同一处来源（tokens.source.json）→ 生成 → 比对**。
多一份手写调色板 = 多一处必然漂移的地方。

## 生成物长什么样

``skins.css`` = ① **学段调色板**（本脚本生成）+ ② **皮肤与舞台基元**（作者手写，
原样写进生成物；要改就改本脚本的 :data:`SKIN_RULES`）。

::

    :root[data-grade="primary_low"], :root[data-grade="primary-low"] { --accent: …; … }
    :root[data-grade="primary_high"], … { … }
    :root[data-grade="junior"] { … }
    :root[data-grade="senior"] { … }
    :root[data-grade="default"] { … }
    /* 皮肤级刻度 + 舞台基元类（.k12-*） */

服务端在 ``<html>`` 上打两个属性（``data-grade`` / ``data-skin``，见
``app/routes/resources.py`` 的 ``SKIN_BY_GRADE``），样式因此自动落在对应学段上。

## 两条纪律

1. **颜色只能来自令牌**：本文件里除生成区以外的任何地方都不许出现裸色值
   （``tests/test_sandbox_palette.py`` 会扫）；基元类只引用变量。
2. **两轴**：``data-grade`` 决定色板（本脚本生成），``data-skin`` 决定形态与动效
   （``illustrated`` / ``technical``，见 :data:`SKIN_RULES`）。

跑法::

    cd server
    uv run python scripts/build_animation_skins.py            # 写文件
    uv run python scripts/build_animation_skins.py --check    # 只比对（CI 用）
    uv run python -m unittest tests.test_sandbox_palette -v   # 漂移守卫
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping

#: 仓库根 = 本文件的上三级（scripts → server → 仓库根）
REPO_ROOT = Path(__file__).resolve().parents[2]
#: 设计令牌（**唯一来源**，与渲染进程的 `npm run gen:tokens` 同一份）
TOKENS_PATH = REPO_ROOT / "desktop" / "scripts" / "design" / "tokens.source.json"
#: 生成物：随动画 HTML 内联（见 `app/routes/resources.py::compose_animation_html`）
OUTPUT_PATH = REPO_ROOT / "server" / "resources" / "templates" / "_shared" / "skins.css"

#: 用哪一档饱和度。``soft``（索引 1）= 舞台面用色：够区分学段，又不至于把文字压死。
#: ``vivid`` 留给渲染进程的强调色；``mono`` 是控制台式的灰阶。
SATURATION = "soft"

#: 沙箱学段值（``Sandbox.grade``）→ 令牌里的学段家族名。
#:
#: ★ 两套写法差一个字符（``primary_low`` vs ``primary-low``）是**历史事实**：
#:   令牌/渲染进程用连字符，动画沙箱的 ``grade_level`` 用下划线（``GRADE_LEVELS``）。
#:   生成时两种选择器都写（见 :func:`palette_blocks`），谁改都不会漏一边。
GRADE_FAMILIES: tuple[tuple[str, str], ...] = (
    ("primary_low", "primary-low"),
    ("primary_high", "primary-high"),
    ("junior", "junior"),
    ("senior", "senior"),
    ("default", "default"),
)

#: 每个学段块的说明（只影响生成物里的注释，方便下一个人读）
GRADE_NOTES: Mapping[str, str] = {
    "primary_low": "小学低年级：插画化皮肤（illustrated），暖橙",
    "primary_high": "小学高年级：插画化皮肤（illustrated），晴空蓝",
    "junior": "初中：工程化皮肤（technical），靛蓝",
    "senior": "高中：工程化皮肤（technical），青绿",
    "default": "未指定学段时的兜底主题（base.css 里的值仍是最终回退）",
}

#: 随学段变化的配色家族（``themed`` 里是 18 元素扁平数组，索引 = gradeIndex * 3 + satIndex）。
THEMED_VARS: tuple[str, ...] = (
    "accent",
    "accent-soft",
    "accent-ink",
    "accent-border",
    "accent-2",
    "page",
    "surface",
    "surface-2",
    "chip-bg",
    "chip-fg",
)

#: 全学段统一、但沙箱也要用的家族（``single`` 是一个普通对象）。
#: 也写进每个学段块：舞台上只用一套变量名，少一层「这个变量在哪个作用域」的心智负担。
SINGLE_VARS: tuple[tuple[str, str], ...] = (
    ("fg", "ink"),
    ("muted", "muted"),
    ("border", "line"),
    ("warn", "warn"),
    ("good", "ok"),
)

#: 生成区的边界标记（守卫靠它把「生成区」与「手写区」分开扫）。
PALETTE_BEGIN = "/* ==== 生成区开始（学段调色板；勿手改） ==== */"
PALETTE_END = "/* ==== 生成区结束 ==== */"

HEADER = '''\
/* ==========================================================================
 * 本文件由 server/scripts/build_animation_skins.py 自动生成，请勿手工编辑。
 * 源数据：desktop/scripts/design/tokens.source.json（soft 饱和度 · 学段轴）
 * 学段配色来自设计令牌（唯一来源）；皮肤形态与动效在生成器里手写。
 *
 * 重新生成：cd server && uv run python scripts/build_animation_skins.py
 * 漂移守卫：cd server && uv run python -m unittest tests.test_sandbox_palette -v
 *
 * 两个轴（都由服务端打在 <html> 上，见 app/routes/resources.py）：
 *   data-grade  学段 → 下面这五块调色板之一
 *   data-skin   皮肤 → illustrated（小学）/ technical（中学以上）
 * ========================================================================== */'''


# --------------------------------------------------------------------------- #
# 皮肤与舞台基元（手写区）
# --------------------------------------------------------------------------- #
#: ★ 这一整段是**作者手写**的，由生成器原样写进 skins.css。
#:
#: 三条硬约束（守卫 ``tests/test_sandbox_palette.py`` 会查）：
#:   ① 除状态类外不许出现裸色值（`#rrggbb`）—— 颜色只能引用上面的学段变量，
#:      否则「改一次令牌、四处不同步」的老毛病会立刻回来；
#:   ② 用到的每个 ``var(--x)`` 都必须在 ``base.css`` 的 ``:root`` 里有兜底值
#:      （没有 data-grade 的产物 —— 例如自由生成路径 —— 也能完整渲染）；
#:   ③ 只在根元素上挂 ``:root[data-skin="…"]``，别把皮肤判定写进 JS。
SKIN_RULES = '''\
/* ==========================================================================
 * 皮肤与舞台基元（手写区，由生成器原样写出 —— 要改请改生成器）
 *
 * 两种皮肤（illustrated / technical）**共用同一套结构类**，差别全部落在下面这些
 * 规则里；舞台基元脚本（_shared/runtime.js）不写任何色值与字号，只挂类名。
 * 所以「一份代码、两种皮肤」这条纪律是靠本文件成立的。
 *
 * 命名：基元类统一 k12- 前缀（与设计令牌 --k12-* 同族），BEM 修饰符用 --。
 * ========================================================================== */

/* ---- 皮肤级刻度：字号 / 圆角 / 线宽 / 内边距（runtime.js 会读它们做折行与测量） ---- */
:root[data-skin="illustrated"] {
  --k12-fs-node: 19px;
  --k12-fs-node-sub: 14px;
  --k12-fs-link: 13.5px;
  --k12-fs-bubble: 16.5px;
  --k12-fs-actor: 13px;
  --k12-fs-readout-label: 12.5px;
  --k12-fs-readout-value: 27px;
  --k12-fs-axis: 13px;
  --k12-radius-node: 18px;
  --k12-radius-panel: 18px;
  --k12-radius-head: 13px;
  --k12-radius-body: 12px;
  --k12-stroke: 2.6;
  --k12-pad: 18px;
}

:root[data-skin="technical"] {
  --k12-fs-node: 16px;
  --k12-fs-node-sub: 12px;
  --k12-fs-link: 12.5px;
  --k12-fs-bubble: 14.5px;
  --k12-fs-actor: 12px;
  --k12-fs-readout-label: 11.5px;
  --k12-fs-readout-value: 24px;
  --k12-fs-axis: 12px;
  --k12-radius-node: 5px;
  --k12-radius-panel: 6px;
  --k12-radius-head: 3px;
  --k12-radius-body: 4px;
  --k12-stroke: 1.6;
  --k12-pad: 13px;
}

/* ---- 外壳（标题 / 字幕 / 步骤条）—— 旧选择器一个都没改名，只加了皮肤刻度 ---- */
:root[data-skin="illustrated"] .anim-title {
  font-size: 15.5px;
  letter-spacing: 0.01em;
}

:root[data-skin="technical"] .anim-title {
  font-size: 14px;
  letter-spacing: 0;
}

:root[data-skin="illustrated"] .anim-caption {
  line-height: 1.72;
}

:root[data-skin="technical"] .anim-caption {
  line-height: 1.5;
}

:root[data-skin="illustrated"] .chip {
  border-radius: 999px;
  padding: 3px 11px;
}

:root[data-skin="technical"] .chip {
  border-radius: 4px;
  padding: 2px 9px;
  letter-spacing: 0.02em;
  font-variant-numeric: tabular-nums;
}

/* ---- 舞台底板 ---- */
.k12-stage {
  display: block;
}

.k12-stage-bg {
  fill: var(--surface);
  stroke: none;
}

:root[data-skin="technical"] .k12-stage-bg {
  stroke: var(--accent-border);
  stroke-width: 1;
}

/* ---- 网格与坐标轴（背景层；插画皮肤里几乎是暗示，工程皮肤里是刻度纸） ---- */
.k12-grid {
  opacity: 0.28;
}

:root[data-skin="technical"] .k12-grid {
  opacity: 0.8;
}

.k12-grid-line {
  stroke: var(--accent-border);
  stroke-width: 1;
}

.k12-grid-frame {
  fill: none;
  stroke: var(--accent-border);
  stroke-width: 1;
}

.k12-axis-line {
  fill: none;
  stroke: var(--line);
  stroke-width: 1.7;
  stroke-linecap: round;
}

.k12-axis-arrow {
  fill: var(--line);
}

.k12-axis-tick {
  stroke: var(--line);
  stroke-width: 1;
}

.k12-axis-label {
  fill: var(--muted);
  font-size: var(--k12-fs-axis);
}

.k12-axis-origin {
  fill: var(--muted);
  font-size: var(--k12-fs-axis);
}

/* ---- 节点（rounded rect + 居中文字） ---- */
.k12-node-body {
  fill: var(--surface);
  stroke: var(--accent-border);
  stroke-width: var(--k12-stroke);
  rx: var(--k12-radius-node);
}

.k12-node--accent .k12-node-body {
  fill: var(--accent-soft);
  stroke: var(--accent);
}

.k12-node--muted .k12-node-body {
  fill: var(--surface-2);
  stroke: var(--line);
}

.k12-node--warn .k12-node-body {
  fill: var(--surface-2);
  fill: color-mix(in srgb, var(--warn) 14%, var(--surface));
  stroke: var(--warn);
}

.k12-node--focus .k12-node-body {
  stroke: var(--accent);
  stroke-width: calc(var(--k12-stroke) + 1.4);
}

.k12-node-label {
  fill: var(--ink);
  font-size: var(--k12-fs-node);
  font-weight: 650;
}

.k12-node--accent .k12-node-label {
  fill: var(--accent-ink);
}

.k12-node--muted .k12-node-label {
  fill: var(--muted);
}

.k12-node-sub {
  fill: var(--muted);
  font-size: var(--k12-fs-node-sub);
}

/* ---- 人物（插画皮肤的当家角色；工程皮肤里变成一个克制的示意体） ---- */
.k12-actor-head {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: var(--k12-stroke);
  rx: var(--k12-radius-head);
}

.k12-actor-body {
  fill: var(--accent-soft);
  stroke: var(--accent);
  stroke-width: var(--k12-stroke);
  rx: var(--k12-radius-body);
}

.k12-actor-limb {
  fill: none;
  stroke: var(--accent);
  stroke-width: calc(var(--k12-stroke) + 0.6);
  stroke-linecap: round;
  stroke-linejoin: round;
}

.k12-actor-prop {
  fill: var(--surface-2);
  stroke: var(--accent-border);
  stroke-width: 1.5;
  rx: 4px;
}

.k12-actor-label {
  fill: var(--muted);
  font-size: var(--k12-fs-actor);
}

:root[data-skin="technical"] .k12-actor-limb {
  stroke-linecap: square;
  stroke-linejoin: miter;
}

/* ---- 气泡 ---- */
.k12-bubble-body {
  fill: var(--surface);
  stroke: var(--accent-border);
  stroke-width: 1.6;
  rx: var(--k12-radius-panel);
}

.k12-bubble-tail {
  fill: var(--surface);
  stroke: var(--accent-border);
  stroke-width: 1.6;
}

.k12-bubble-tail-seam {
  fill: none;
  stroke: var(--surface);
  stroke-width: 2.6;
}

.k12-bubble-text {
  fill: var(--ink);
  font-size: var(--k12-fs-bubble);
}

.k12-bubble--narrator .k12-bubble-body,
.k12-bubble--narrator .k12-bubble-tail {
  fill: var(--surface-2);
  stroke: var(--line);
}

.k12-bubble--narrator .k12-bubble-tail-seam {
  stroke: var(--surface-2);
}

.k12-bubble--accent .k12-bubble-body,
.k12-bubble--accent .k12-bubble-tail {
  fill: var(--accent-soft);
  stroke: var(--accent);
}

.k12-bubble--accent .k12-bubble-tail-seam {
  stroke: var(--accent-soft);
}

/* ---- 连接线 ---- */
.k12-link-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: var(--k12-stroke);
  stroke-linecap: round;
}

.k12-link-arrow {
  fill: var(--accent);
}

.k12-link--dashed .k12-link-line {
  stroke: var(--muted);
  stroke-dasharray: 9 7;
  stroke-width: 1.8;
}

.k12-link--dashed .k12-link-arrow {
  fill: var(--muted);
}

.k12-link-pipe {
  fill: none;
  stroke: var(--accent);
  stroke-width: 9;
  opacity: 0.22;
  stroke-linecap: round;
}

.k12-link--pipe .k12-link-line {
  stroke-width: 2;
}

.k12-link-label {
  fill: var(--accent-ink);
  font-size: var(--k12-fs-link);
  font-weight: 600;
}

.k12-link-label-bg {
  fill: var(--surface);
  opacity: 0.94;
}

/* ---- 数值读数（工程皮肤的主力；插画皮肤里当「记分牌」用） ---- */
.k12-readout-bg {
  fill: var(--surface-2);
  stroke: var(--accent-border);
  stroke-width: 1;
  rx: var(--k12-radius-node);
}

.k12-readout-label {
  fill: var(--muted);
  font-size: var(--k12-fs-readout-label);
  letter-spacing: 0.04em;
}

.k12-readout-value {
  fill: var(--accent-ink);
  font-size: var(--k12-fs-readout-value);
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, "Cascadia Mono", Consolas, "SFMono-Regular", "Courier New", monospace;
}

.k12-readout-unit {
  fill: var(--muted);
  font-size: var(--k12-fs-axis);
}
'''


# --------------------------------------------------------------------------- #
# 生成
# --------------------------------------------------------------------------- #
def load_tokens(path: Path | str = TOKENS_PATH) -> dict[str, Any]:
    """读设计令牌源文件（缺文件时抛 :class:`FileNotFoundError`，由调用方决定跳过还是炸）。"""
    return json.loads(Path(path).read_text(encoding="utf-8"))


def derive_palette(source: Mapping[str, Any]) -> dict[str, dict[str, str]]:
    """从令牌**现算**每个学段的沙箱变量 → ``{沙箱学段: {CSS 变量: 值}}``。

    索引规则与 ``desktop/scripts/design/gen-tokens.mjs`` 一字不差：
    ``index = grades.indexOf(家族) * sats.length + sats.indexOf(饱和度)``。
    任何一处缺值都当场抛 —— 静默少一个变量，舞台上就是一片「没有颜色的糊」。
    """
    grades = list(source.get("grades") or [])
    sats = list(source.get("sats") or [])
    themed = dict(source.get("themed") or {})
    single = dict(source.get("single") or {})
    if SATURATION not in sats:
        raise ValueError(f"tokens.source.json 的 sats 里没有 {SATURATION!r}：{sats}")
    sat_index = sats.index(SATURATION)

    palette: dict[str, dict[str, str]] = {}
    for grade, family in GRADE_FAMILIES:
        if family not in grades:
            raise ValueError(f"tokens.source.json 里没有学段家族 {family!r}：{grades}")
        index = grades.index(family) * len(sats) + sat_index
        values: dict[str, str] = {}
        for name in THEMED_VARS:
            series = themed.get(name)
            if not isinstance(series, list) or index >= len(series):
                raise ValueError(f"令牌 {name!r} 取值缺失（索引 {index}）")
            values[name] = str(series[index])
        for token_name, var_name in SINGLE_VARS:
            if token_name not in single:
                raise ValueError(f"令牌 single.{token_name} 缺失")
            values[var_name] = str(single[token_name])
        palette[grade] = values
    return palette


def palette_blocks(palette: Mapping[str, Mapping[str, str]]) -> str:
    """把调色板写成 ``:root[data-grade="…"]`` 块。

    ★ 每个学段写**两个选择器**：沙箱值（下划线，``Sandbox.grade``）与令牌家族名
    （连字符）。两套写法来自两套历史命名，谁改都不会漏一边。
    """
    chunks: list[str] = []
    for grade, family in GRADE_FAMILIES:
        values = palette[grade]
        selectors = [f':root[data-grade="{grade}"]']
        if family != grade:
            selectors.append(f':root[data-grade="{family}"]')
        note = GRADE_NOTES.get(grade, grade)
        chunks.append(f"/* {note} */")
        chunks.append(",\n".join(selectors) + " {")
        for name in THEMED_VARS:
            chunks.append(f"  --{name}: {values[name]};")
        for _token_name, var_name in SINGLE_VARS:
            chunks.append(f"  --{var_name}: {values[var_name]};")
        chunks.append("}")
        chunks.append("")
    return "\n".join(chunks).rstrip() + "\n"


def render_css(source: Mapping[str, Any]) -> str:
    """令牌 → skins.css 全文（纯函数：守卫直接拿它和磁盘上的文件比对）。"""
    body = [
        HEADER,
        "",
        PALETTE_BEGIN,
        "",
        palette_blocks(derive_palette(source)).rstrip(),
        "",
        PALETTE_END,
        "",
        SKIN_RULES.rstrip(),
        "",
    ]
    return "\n".join(body)


def write_css(text: str, path: Path | str = OUTPUT_PATH) -> Path:
    """落盘（强制 LF：仓库 .gitattributes 规定换行统一，别让 Windows 侧写出 CRLF）。"""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8", newline="\n")
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="由设计令牌生成动画沙箱皮肤 skins.css")
    parser.add_argument("--check", action="store_true", help="只比对，不写盘；不一致时退出码 1")
    args = parser.parse_args(argv)

    try:
        source = load_tokens()
    except FileNotFoundError:
        print(f"✗ 找不到设计令牌：{TOKENS_PATH}", file=sys.stderr)
        return 1

    text = render_css(source)
    palette = derive_palette(source)

    if args.check:
        current = OUTPUT_PATH.read_text(encoding="utf-8") if OUTPUT_PATH.is_file() else ""
        if current != text:
            print(f"✗ {OUTPUT_PATH} 与生成结果不一致（跑一次不带 --check 的即可更新）", file=sys.stderr)
            return 1
        print(f"✓ {OUTPUT_PATH} 与生成结果一致")
        return 0

    write_css(text)
    print(f"✓ 生成 {OUTPUT_PATH}")
    for grade, family in GRADE_FAMILIES:
        values = palette[grade]
        print(
            f"  {grade:<13}（{family}）accent {values['accent']} · "
            f"soft {values['accent-soft']} · ink {values['accent-ink']} · page {values['page']}"
        )
    print(f"  饱和度 {SATURATION} · 变量 {len(THEMED_VARS) + len(SINGLE_VARS)} 个/学段")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
