# -*- coding: utf-8 -*-
"""批量截图 + 几何检查（溢出 viewBox / 文本重叠 / JS 错）。"""
from __future__ import annotations

import json
from pathlib import Path
from playwright.sync_api import sync_playwright

# ★ 相对本文件（本脚本住在 preset-content/_meta/）：产物与 render_anim_html.py 同级，
#   已被 .gitignore 挡住，不会再变成未跟踪杂物。
ROOT = Path(__file__).resolve().parent
HTML_DIR = ROOT / "rendered"
SHOT_DIR = ROOT / "shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

files = sorted(p for p in HTML_DIR.glob("*.html") if p.name != "index.html")
print("pages", len(files))

CHECK_JS = r"""
() => {
  const problems = [];
  for (const svg of document.querySelectorAll('svg[viewBox]')) {
    const vb = svg.viewBox.baseVal;
    for (const el of svg.querySelectorAll('text,rect,circle,line,path')) {
      let bb;
      try { bb = el.getBBox(); } catch { continue; }
      if (!bb || (bb.width === 0 && bb.height === 0)) continue;
      const pad = 2;
      if (bb.x < vb.x - pad || bb.y < vb.y - pad ||
          bb.x + bb.width > vb.x + vb.width + pad ||
          bb.y + bb.height > vb.y + vb.height + pad) {
        problems.push({
          tag: el.tagName,
          text: (el.textContent || '').slice(0, 20),
          bbox: [bb.x, bb.y, bb.width, bb.height].map(n => Math.round(n * 10) / 10),
          viewBox: [vb.x, vb.y, vb.width, vb.height]
        });
      }
    }
  }
  const texts = [...document.querySelectorAll('svg text')].map(el => {
    const bb = el.getBBox();
    return { bb, t: (el.textContent || '').trim() };
  });
  const overlaps = [];
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].bb, b = texts[j].bb;
      if (!a.width || !b.width) continue;
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ox > 4 && oy > 4) {
        overlaps.push([texts[i].t.slice(0, 14), texts[j].t.slice(0, 14), Math.round(ox), Math.round(oy)]);
      }
    }
  }
  return { overflow: problems, overlaps };
}
"""

report = []
with sync_playwright() as p:
    browser = p.chromium.launch()
    for f in files:
        tid = f.stem
        errors: list[str] = []
        page = browser.new_page(viewport={"width": 720, "height": 520})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f.as_uri(), wait_until="load")
        page.screenshot(path=str(SHOT_DIR / f"{tid}-0.png"))
        page.wait_for_timeout(1200)
        page.screenshot(path=str(SHOT_DIR / f"{tid}-1.png"))
        page.wait_for_timeout(2000)
        page.screenshot(path=str(SHOT_DIR / f"{tid}-2.png"))
        geom = page.evaluate(CHECK_JS)
        item = {"id": tid, "errors": errors, **geom}
        report.append(item)
        print(tid, "overflow", len(geom["overflow"]), "overlaps", len(geom["overlaps"]), "jsErr", len(errors), flush=True)
        page.close()
    browser.close()

(SHOT_DIR / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
bad = [r for r in report if r["errors"] or r["overflow"] or r["overlaps"]]
print("---")
print("clean", len(report) - len(bad), "flagged", len(bad))
for r in bad:
    print(r["id"], json.dumps({"err": r["errors"][:2], "ov": r["overflow"][:3], "ol": r["overlaps"][:4]}, ensure_ascii=False))
