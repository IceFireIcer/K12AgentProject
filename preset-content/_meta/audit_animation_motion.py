# -*- coding: utf-8 -*-
"""动画**运动过程**体检：逐帧采样，查流畅度 / 跳变 / 卡顿 / 帧内重叠 / 文字溢出 / 曲线折角。

与 `audit_animation_settled.py` 的分工（两者互补，别互相替代）：

| 工具 | 查什么 | 判据 |
| --- | --- | --- |
| `audit_animation_settled.py` | **末态**几何（动画跑完那一刻） | 一律等到步骤条到顶 |
| 本工具 | **运动过程**（整段动画逐帧看） | 每 ~50ms 采一帧，逐帧判 |

为什么要单开一个：末态干净不等于过程干净。实测踩到过的两类问题只有逐帧看才现形 ——
① 元素在动画中段压住邻居（末态又是好的）；② 位置在某一帧突变（末态看不出跳变）。
另外「曲线是不是够平滑」「有没有掉帧」本来就只能从帧序列里量。

用法（server 目录下）：
    uv run --with playwright python ../preset-content/_meta/audit_animation_motion.py
    uv run --with playwright python ../preset-content/_meta/audit_animation_motion.py --all
    uv run --with playwright python ../preset-content/_meta/audit_animation_motion.py --ids=a,b

判据（阈值都在下面常量里，可调）：
  · 帧内重叠：两个**盒子**（node / readout / bubble）的屏幕矩形相交 > MIN_OVERLAP px，
    且**连续 ≥ SUSTAIN_FRAMES 帧**才报（瞬时穿越是滑入动画的正常现象，不算缺陷）；
  · 文字溢出：某盒子里的 text 矩形超出该盒子的底板（`.k12-*-body`/`-bg`）矩形；
  · 文字互压：两个 text 矩形相交 > MIN_OVERLAP px 且连续 ≥ SUSTAIN_FRAMES 帧；
  · 位置跳变：同一盒子相邻采样帧的**中心点**位移 > JUMP_PX（末态正常但途中瞬移 = 学生看到闪跳）；
  · 曲线折角：曲线类的 path/line 相邻段夹角 > MAX_ANGLE 度（16 段直线拼的"曲线"会有折角）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
HTML_DIR = ROOT / "rendered"
TEMPLATES = ROOT.parents[1] / "server" / "resources" / "templates"

#: 采样间隔（毫秒）。50ms ≈ 20Hz：够看出跳变与压邻居，又不会让数据量爆掉。
SAMPLE_EVERY_MS = 50
#: 盒子相交超过这么多像素才算"压住"（圆的圆角、描边会让矩形略微外扩）。
MIN_OVERLAP = 5.0
#: 连续这么多帧都重叠才报（≈ 4 × 50ms = 200ms：瞬时的滑入穿越不算）。
SUSTAIN_FRAMES = 4
#: 相邻采样帧中心点位移超过这么多像素算"跳变"。
JUMP_PX = 55.0
#: 曲线相邻段夹角超过这么多度算"折角明显"。
MAX_ANGLE = 32.0

SAMPLES = [
    "ai-hierarchy-pl", "agent-planning-pl", "ai-definition-jr", "ethics-fairness-ph",
    "prog-loop-ph", "algorithm-sr", "agent-reflection-pl", "agent-action-jr",
    "ai-hierarchy-ph", "ai-hierarchy-jr", "agent-reflection-jr", "aigc-media-jr",
    "autonomous-driving-sr", "agent-action-ph", "computing-power-jr", "agent-planning-jr",
]

#: 注入的采样器：rAF 数帧 + 每 SAMPLE_EVERY_MS 记一次快照。
#: 全部坐标换算成 **SVG 元素自身坐标**（减 svg 原点），这样与 JS 里的常量阈值同一尺度。
SAMPLER = r"""
(() => {
  const svg = document.querySelector('#stage svg, .anim-canvas svg');
  if (!svg) return { error: 'no svg' };
  const sr = svg.getBoundingClientRect();
  // ★ 一律用**屏幕像素**（不换算回 viewBox 单位）。实测踩到：按 x/y 各自的
  //   width/height 比例去缩（scaleX≠scaleY），而 SVG 其实是等比缩放 + 居中留白 ——
  //   y 会被压扁、整体还会平移，于是「文字与底板的相对关系」被扭曲，报出一堆假溢出。
  //   容器是固定 720×520、viewBox 720×420 且 scale=1，屏幕像素与 SVG 单位本就 1:1。
  const rel = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x - sr.x, y: r.y - sr.y, w: r.width, h: r.height };
  };
  const boxes = [...svg.querySelectorAll('g.k12-node, g.k12-readout, g.k12-bubble')];
  const texts = [...svg.querySelectorAll('svg text')];
  // 盒子的底板元素（文字溢出的判据要跟底板比，不是跟可能含尾巴的整组比）
  const plateOf = (g) => g.querySelector('.k12-node-body, .k12-readout-bg, .k12-bubble-body');

  const state = { frames: 0, samples: [], t0: performance.now() };
  let next = 0;
  function tick(now) {
    state.frames += 1;
    if (now >= next) {
      next = now + __SAMPLE_EVERY_MS__;
      const snap = { t: Math.round(now - state.t0), b: [], x: [] };
      for (const g of boxes) {
        const cs = getComputedStyle(g);
        const plate = plateOf(g);
        // ★ 盒子的"占位"取**底板**（node-body / readout-bg / bubble-body）而不是整组：
        //   组里可能含**空 text**（读数初值是空串，runtime 留下的 <text> 在 Chrome 里
        //   报零尺寸 box，却仍参与 <g> 的 bbox 并把它一度撑大）—— 实测这会让读数在
        //   "数值首次写入"那一帧记到一次 55px 以上的假跳变（aigc-media-jr /
        //   autonomous-driving-sr 各 1 次），而学生看的底板全程不动。
        //   没有底板的组（不该有，留兜底）才退回整组矩形。
        const box = plate ? rel(plate) : rel(g);
        // ★ 只带上**这个盒子自己的**文字（DOM 归属，不是坐标相交）：
        //   同位轮换的原型（dialogue / counter 的 alts）会把多个气泡放在同一坐标，
        //   交叉淡化时 A 的文字会落在 B 的底板上 —— 用坐标相交判溢出会把它误报成缺陷。
        const own = [...g.querySelectorAll('text')]
          .map((t) => { const r = rel(t); return { s: (t.textContent || '').trim().slice(0, 10), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }; })
          .filter((t) => t.w > 0 && t.h > 0);
        snap.b.push({
          c: (g.getAttribute('class') || '').slice(0, 28),
          x: Math.round(box.x), y: Math.round(box.y),
          w: Math.round(box.w), h: Math.round(box.h),
          o: Number(cs.opacity),
          p: plate ? rel(plate) : null,
          t: own
        });
      }
      for (const t of texts) {
        const r = rel(t);
        if (r.w <= 0 || r.h <= 0) continue;
        snap.x.push({
          s: (t.textContent || '').trim().slice(0, 10),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.w), h: Math.round(r.h)
        });
      }
      state.samples.push(snap);
    }
    if (!state.done) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.__k12Motion = state;
  return { ok: true };
})()
"""

STEP_JS = r"""
() => {
  const chips = document.querySelectorAll('#stage .chip, .anim-caption .chip');
  for (const chip of chips) {
    const m = /第\s*(\d+)\s*[^\s\/]+\s*\/\s*共\s*(\d+)\s*[^\s\/]+/.exec(chip.textContent || '');
    if (m) return { at: Number(m[1]), total: Number(m[2]) };
  }
  return null;
}
"""

CURVE_JS = r"""
() => {
  const svg = document.querySelector('#stage svg, .anim-canvas svg');
  if (!svg) return [];
  const out = [];
  // 曲线/轨迹类：link 的线元素（trace 的曲线由 16 段 link 拼成）
  const lines = [...svg.querySelectorAll('line.k12-link-line, path.k12-link-line')];
  const segs = lines.map((el) => {
    if (el.tagName.toLowerCase() === 'line') {
      return [[+el.getAttribute('x1'), +el.getAttribute('y1')], [+el.getAttribute('x2'), +el.getAttribute('y2')]];
    }
    const total = el.getTotalLength();
    const a = el.getPointAtLength(0), b = el.getPointAtLength(total);
    return [[a.x, a.y], [b.x, b.y]];
  }).filter((p) => p.every((q) => q.every((v) => isFinite(v))));
  const angles = [];
  for (let i = 1; i + 1 < segs.length; i += 1) {
    const [p0, p1] = segs[i - 1], [p1b, p2] = segs[i];
    // ★ 只把**端点相接**的两段当成同一条曲线的邻居：曲线由多段独立 link 拼成，
    //   没有分组标记；跨曲线比较会算出 150° 这种假折角（实测踩到）。
    const gap = Math.hypot(p1[0] - p1b[0], p1[1] - p1b[1]);
    if (gap > 2.5) continue;
    const v1 = [p1[0] - p0[0], p1[1] - p0[1]];
    const v2 = [p2[0] - p1b[0], p2[1] - p1b[1]];
    const n1 = Math.hypot(v1[0], v1[1]), n2 = Math.hypot(v2[0], v2[1]);
    if (n1 < 1 || n2 < 1) continue;
    const cos = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)));
    angles.push(Math.round(Math.acos(cos) * 180 / Math.PI));
  }
  const runs = [];
  if (angles.length) runs.push({ segs: segs.length, n: angles.length, max: Math.max(...angles), avg: Math.round(angles.reduce((a, b) => a + b, 0) / angles.length) });
  return runs;
}
"""


def overlap(a: dict, b: dict) -> tuple[float, float]:
    ox = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    oy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return ox, oy


def inside(inner: dict, outer: dict, tol: float = 2.0) -> bool:
    return (
        inner["x"] >= outer["x"] - tol
        and inner["y"] >= outer["y"] - tol
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + tol
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + tol
    )


def analyse(samples: list[dict], frames: int, span_ms: int) -> list[str]:
    """逐帧分析，返回问题描述（空 = 干净）。"""
    issues: list[str] = []

    # ---- ① 帧内盒子重叠（连续若干帧才算）----
    streaks: dict[tuple[int, int], int] = {}
    reported: set[str] = set()
    for snap in samples:
        live = [(i, b) for i, b in enumerate(snap["b"]) if b["o"] > 0.05 and b["w"] > 1 and b["h"] > 1]
        for ai in range(len(live)):
            for bi in range(ai + 1, len(live)):
                ia, a = live[ai]
                ib, b = live[bi]
                ox, oy = overlap(a, b)
                key = (min(ia, ib), max(ia, ib))
                if ox > MIN_OVERLAP and oy > MIN_OVERLAP:
                    streaks[key] = streaks.get(key, 0) + 1
                    if streaks[key] >= SUSTAIN_FRAMES:
                        tag = f"{a['c']}|{b['c']}"
                        if tag not in reported:
                            reported.add(tag)
                            issues.append(
                                f"重叠 {a['c']} x {b['c']} {int(ox)}x{int(oy)}px 持续≥{SUSTAIN_FRAMES}帧"
                            )
                else:
                    streaks[key] = 0

    # ---- ② 文字溢出底板（只看**这个盒子自己的**文字）----
    seen_overflow: set[str] = set()
    for snap in samples:
        for b in snap["b"]:
            if b["o"] <= 0.05 or not b.get("p"):
                continue
            plate = b["p"]
            for t in b.get("t") or []:
                if not inside(t, plate, tol=3.0):
                    tag = f"{b['c']}::{t['s']}"
                    if tag not in seen_overflow:
                        seen_overflow.add(tag)
                        issues.append(f"文字溢出 {b['c']} 里的「{t['s']}」")

    # ---- ③ 文字两两互压（只比**同一时刻都可见**的盒子自己的文字）----
    # ★ 用「可见盒子自己的文字」而不是全页文字：同位轮换的多个气泡里，不可见的那些
    #   不该参与比较（否则同一位置的两个轮换气泡永远"互压"）；而**都可见时**的重叠
    #   就是真的重影，必须报。
    tstreak: dict[tuple[str, str], int] = {}
    treported: set[str] = set()
    for snap in samples:
        live: list[dict] = []
        for b in snap["b"]:
            if b["o"] <= 0.05:
                continue
            live.extend(b.get("t") or [])
        for ai in range(len(live)):
            for bi in range(ai + 1, len(live)):
                a, b = live[ai], live[bi]
                if not a["s"] or not b["s"] or a["s"] == b["s"]:
                    continue
                ox, oy = overlap(a, b)
                key = (min(a["s"], b["s"]), max(a["s"], b["s"]))
                if ox > MIN_OVERLAP and oy > MIN_OVERLAP:
                    tstreak[key] = tstreak.get(key, 0) + 1
                    if tstreak[key] >= SUSTAIN_FRAMES and key not in treported:
                        treported.add(key)
                        issues.append(f"文字互压「{a['s']}」x「{b['s']}」{int(ox)}x{int(oy)}px")
                else:
                    tstreak[key] = 0

    # ---- ④ 位置跳变（同一序号的盒子相邻帧**左上角**位移）----
    # ★ 用左上角不用中心点：读数这类左对齐元素的值变长（「待扫」→「第 1 行第 3 列」）
    #   会让矩形变宽、中心点跟着移 —— 那是文字变了，不是元素跳了（实测踩到的假阳性）。
    prev: list[dict] | None = None
    jumps: dict[str, int] = {}
    for snap in samples:
        cur = snap["b"]
        if prev is not None and len(prev) == len(cur):
            for a, b in zip(prev, cur):
                if a["o"] <= 0.05 and b["o"] <= 0.05:
                    continue
                dist = ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5
                if dist > JUMP_PX:
                    jumps[b["c"]] = jumps.get(b["c"], 0) + 1
        prev = cur
    for cls, count in jumps.items():
        issues.append(f"位置跳变 {cls} 单帧位移>{int(JUMP_PX)}px 共 {count} 次")

    # ---- ⑤ 帧率（只记录，不作判据）----
    # ★ 为什么不当判据：无头 Chrome 里 rAF 不受 60Hz 限速（实测 240fps），
    #   量出来的"帧率"与真机掉帧无关 —— 拿它报红只会制造假问题。
    #   这里只把数值带回去给人看（真机掉帧要靠 UX 探针在真窗口里量）。
    return issues


def main() -> int:
    files = sorted(p for p in HTML_DIR.glob("*.html") if p.name != "index.html" and not p.name.startswith("_"))
    ids = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--ids=")), "")
    shard = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--shard=")), "")
    if ids:
        wanted = {s.strip() for s in ids.split(",") if s.strip()}
        files = [p for p in files if p.stem in wanted]
    elif "--all" not in sys.argv:
        files = [p for p in files if p.stem in SAMPLES]
    if shard:
        #: 分片并行跑全量用（每份要播完 16-32 秒的动画，214 份串行太慢）。
        #: `--shard=0/3` 表示「第 0 片 / 共 3 片」，按文件名奇偶稳定切分。
        index, total = (int(x) for x in shard.split("/"))
        files = [p for i, p in enumerate(files) if i % total == index]
    print("pages", len(files), flush=True)

    flagged: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        page = browser.new_page(viewport={"width": 720, "height": 520})
        errors: list[str] = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        for f in files:
            errors.clear()
            page.goto(f.as_uri(), wait_until="load")
            page.evaluate(SAMPLER.replace("__SAMPLE_EVERY_MS__", str(SAMPLE_EVERY_MS)))
            # 等步骤条到顶（末相位），再多采一点
            waited = 0
            while waited < 30000:
                state = page.evaluate(STEP_JS)
                if state and state["total"] > 0 and state["at"] >= state["total"]:
                    break
                page.wait_for_timeout(200)
                waited += 200
            page.wait_for_timeout(900)
            data = page.evaluate("() => { const s = window.__k12Motion; if (s) s.done = true; return s ? { frames: s.frames, samples: s.samples, t0: s.t0 } : null; }")
            curve = page.evaluate(CURVE_JS)
            if data is None:
                flagged.append(f"{f.stem}: 采样器没装上")
                print(f"BAD {f.stem}: 采样器没装上", flush=True)
                continue
            span = data["samples"][-1]["t"] if data["samples"] else 0
            issues = analyse(data["samples"], data["frames"], span)
            # 曲线折角
            for c in curve:
                if c["max"] > MAX_ANGLE:
                    issues.append(f"曲线折角 {c['max']}°（{c['segs']} 段，均值 {c['avg']}°）")
            if errors:
                issues.append("JS 报错：" + errors[0][:80])
            fps = data["frames"] / (span / 1000.0) if span > 500 else 0
            note = f"{f.stem}: frames={data['frames']} span={span}ms fps={fps:.0f} issues={len(issues)}"
            if issues:
                flagged.append(note + " | " + "; ".join(issues[:4]))
                print("BAD " + note, flush=True)
                for item in issues[:4]:
                    print("      - " + item, flush=True)
            else:
                print("OK  " + note, flush=True)
        browser.close()

    print("\n=== summary ===", flush=True)
    print("flagged:", len(flagged), flush=True)
    for line in flagged[:40]:
        print(" - " + line, flush=True)
    report = ROOT / "shots" / f"motion-report{('-' + shard.replace('/', '_')) if shard else ''}.json"
    report.write_text(json.dumps(flagged, ensure_ascii=False, indent=2), encoding="utf-8")
    print("report ->", report, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
