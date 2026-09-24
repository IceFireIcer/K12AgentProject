# -*- coding: utf-8 -*-
"""临时验收工具：按「原型 × 皮肤」取样截图 + 末态几何体检（住 _meta，已忽略）。

用法（server 目录下）：
    uv run --with playwright python ../preset-content/_meta/_reskin_shots.py
    uv run --with playwright python ../preset-content/_meta/_reskin_shots.py --all
    uv run --with playwright python ../preset-content/_meta/_reskin_shots.py --ids=a,b,c

★★ 几何判定必须在**动画跑完之后**做（2026-09-25 踩到的假阳性）：任何「滑入 / 飞入」
动画在途中都会让元素偏离最终位置（layers 的未点亮层带 translateY 40px，正好压在
已就位的层上，中途量出来是「两层重叠 29px」，末态却是整齐的塔）。
所以这里**不看 duration_ms**（它是生成器的估算值，实测偏小），而是轮询步骤条
（runtime 的 `Sandbox.step()` 写的那颗 chip），等它到「第 N 步 / 共 N 步」再动手。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
HTML_DIR = ROOT / "rendered"
SHOT_DIR = ROOT / "shots"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

# 每个「原型 × 皮肤」组合一份代表（第一份即可）
SAMPLES = [
    "ai-hierarchy-pl", "agent-planning-pl", "ai-definition-jr", "ethics-fairness-ph",
    "prog-loop-ph", "algorithm-sr", "agent-reflection-pl", "agent-action-jr",
    "ai-hierarchy-ph", "ai-hierarchy-jr", "agent-reflection-jr", "aigc-media-jr",
    "autonomous-driving-sr", "agent-action-ph", "computing-power-jr", "agent-planning-jr",
]

CHECK_JS = r"""
() => {
  const svg = document.querySelector('#stage svg, .anim-canvas svg');
  if (!svg) return { error: 'no svg', outside: [], overlap: [] };
  const sr = svg.getBoundingClientRect();
  const boxEls = [...svg.querySelectorAll('g[class*="k12-"]')].filter(
    (g) => g.classList.contains('k12-node') || g.classList.contains('k12-readout') || g.classList.contains('k12-bubble')
  );
  const items = boxEls
    .map((g) => {
      const r = g.getBoundingClientRect();
      const cs = getComputedStyle(g);
      return {
        cls: (g.getAttribute('class') || '').slice(0, 40),
        t: (g.textContent || '').trim().slice(0, 12),
        x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height,
        hidden: r.width <= 0 || r.height <= 0 || Number(cs.opacity) < 0.05
      };
    })
    .filter((i) => !i.hidden);
  const outside = items
    .filter((i) => i.x < -2 || i.y < -2 || i.x + i.w > sr.width + 2 || i.y + i.h > sr.height + 2)
    .map((i) => 'OUT ' + i.cls + ' ' + Math.round(i.x) + ',' + Math.round(i.y) + ' ' + Math.round(i.w) + 'x' + Math.round(i.h));
  const overlap = [];
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const p = items[a], q = items[b];
      if (p.w <= 0 || q.w <= 0) continue;
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      if (ox > 4 && oy > 4) overlap.push('OLAP ' + p.t + ' x ' + q.t + ' ' + Math.round(ox) + 'x' + Math.round(oy));
    }
  }
  return { error: null, outside: outside.slice(0, 6), overlap: overlap.slice(0, 6) };
}
"""


STEP_JS = r"""
() => {
  const chips = document.querySelectorAll('#stage .chip, .anim-caption .chip');
  for (const chip of chips) {
    const m = /第\s*(\d+)\s*步\s*\/\s*共\s*(\d+)\s*步/.exec(chip.textContent || '');
    if (m) return { at: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}
"""


def wait_until_done(page, timeout_s: float = 30.0) -> bool:
    """轮询步骤条到「第 N 步 / 共 N 步」，再多给一秒让末相位的动画落定。"""
    deadline = timeout_s * 1000
    elapsed = 0
    while elapsed < deadline:
        state = page.evaluate(STEP_JS)
        if state and state["total"] > 0 and state["at"] >= state["total"]:
            page.wait_for_timeout(1200)
            return True
        page.wait_for_timeout(250)
        elapsed += 250
    return False


def main() -> int:
    files = sorted(p for p in HTML_DIR.glob("*.html") if p.name != "index.html")
    ids_arg = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--ids=")), "")
    if ids_arg:
        wanted = {s.strip() for s in ids_arg.split(",") if s.strip()}
        files = [p for p in files if p.stem in wanted]
    elif "--all" not in sys.argv:
        files = [p for p in files if p.stem in SAMPLES]
    print("pages", len(files))

    bad: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 720, "height": 520})
        errors: list[str] = []
        on_error = lambda e: errors.append(str(e))  # noqa: E731
        page.on("pageerror", on_error)
        for f in files:
            errors.clear()
            page.goto(f.as_uri(), wait_until="load")
            page.screenshot(path=str(SHOT_DIR / f"{f.stem}-0.png"))
            page.wait_for_timeout(1400)
            page.screenshot(path=str(SHOT_DIR / f"{f.stem}-1.png"))
            # 等到动画真正跑完（判据是步骤条到顶，不是 duration_ms 估算）
            settled = wait_until_done(page)
            page.screenshot(path=str(SHOT_DIR / f"{f.stem}-2.png"))
            geom = page.evaluate(CHECK_JS)
            problems = list(geom.get("outside") or []) + list(geom.get("overlap") or [])
            if geom.get("error"):
                problems.append("ERR " + str(geom["error"]))
            line = f"{f.stem}: geom={len(problems)} err={len(errors)}"
            if not settled:
                line += " (未跑到末相位)"
            if problems or errors:
                bad.append(line + " | " + "; ".join(problems[:3] + errors[:2]))
            print(("OK  " if not (problems or errors) else "BAD ") + line, flush=True)
        browser.close()

    print("\n=== summary ===")
    print("bad:", len(bad))
    for b in bad[:20]:
        print(" -", b)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())