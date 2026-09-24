# -*- coding: utf-8 -*-
"""把 preset-content 动画模板渲染成独立 HTML，供浏览器截图验收。"""
from __future__ import annotations

import sys
from pathlib import Path

# ★ 路径相对本文件（不再写死盘符）：本脚本住在 preset-content/_meta/，
#   仓库根 = 往上三层（_meta → preset-content → 仓库根）。
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from app.routes.resources import load_templates, render_animation  # noqa: E402

PACK = ROOT / "preset-content"
# 渲染结果落 _meta/rendered/（与截图同级、已被 .gitignore 挡住，不会再变成未跟踪杂物）。
OUT = Path(__file__).resolve().parent / "rendered"
OUT.mkdir(parents=True, exist_ok=True)

# 用仓库共享资源（anime/runtime/css），模板来自 preset-content
# ⚠️ 默认渲本包的 57 份概念模板；要复验**产品里真正发货的那批**（214 份）把目录当参数传：
#   uv run python preset-content/_meta/render_anim_html.py server/resources/templates
TEMPLATES_ROOT = (
    Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else PACK / "animations" / "templates"
)
SHARED_ROOT = ROOT / "server" / "resources" / "templates"  # 有 _shared/

templates = load_templates(TEMPLATES_ROOT)
print("loaded", len(templates))

ok = 0
fail = []
for t in templates:
    try:
        payload = render_animation(t, params=None, payload_id=f"qa-{t.id}", root=SHARED_ROOT)
        # QA 用：独立打开时自动 play（生产路径由宿主 postMessage 触发）
        html = payload.html.replace(
            "</body>",
            "<script>setTimeout(function(){try{if(window.Sandbox&&Sandbox.start)Sandbox.start()}catch(e){console.error(e)}},80)</script>\n</body>",
            1,
        )
        path = OUT / f"{t.id}.html"
        path.write_text(html, encoding="utf-8")
        ok += 1
    except Exception as exc:  # noqa: BLE001
        fail.append((t.id, str(exc)))

print("rendered", ok, "failed", len(fail))
for item in fail[:20]:
    print("FAIL", item)

# 索引页
items = sorted(p.stem for p in OUT.glob("*.html"))
rows = "\n".join(
    f'<li><a href="{name}.html" target="frame">{name}</a></li>' for name in items
)
index = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>动画 QA</title>
<style>
body{{font:14px/1.4 sans-serif;display:flex;height:100vh;margin:0}}
nav{{width:220px;overflow:auto;border-right:1px solid #ddd;padding:8px}}
iframe{{flex:1;border:0}}
a{{display:block;padding:4px 6px;color:#12233b;text-decoration:none}}
a:hover{{background:#eef4ff}}
</style></head><body>
<nav><h3>templates ({len(items)})</h3>{rows}</nav>
<iframe name="frame" src="{items[0] if items else ""}.html"></iframe>
</body></html>
"""
(OUT / "index.html").write_text(index, encoding="utf-8")
print("index at", OUT / "index.html")
