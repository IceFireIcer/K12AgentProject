# -*- coding: utf-8 -*-
"""从 _meta/generation-input.json 生成 57 概念动画模板 + 228 by-kp 文案。

★ 沙箱脚本纪律（与 routes/resources.py 校验器、runtime.js 对齐）：
  - 必须出现 `Sandbox.play(` 与 `Sandbox.ready(`
  - 不许用不存在的 API（禁止 Sandbox.animate）
  - 用本地 rAF 进度循环 + Sandbox.progress 上报
  - play() 返回可 pause/restart 的轻量 handle
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(r"E:\FolderForVibeCoding\Zcode\K12Agent")
META = ROOT / "preset-content" / "_meta"
OUT_T = ROOT / "preset-content" / "animations" / "templates"
OUT_K = ROOT / "preset-content" / "animations" / "by-kp"
OUT_T.mkdir(parents=True, exist_ok=True)
OUT_K.mkdir(parents=True, exist_ok=True)

GRADE_LEVELS = ["primary_low", "primary_high", "junior", "senior"]
GRADE_LABEL = {
    "primary_low": "小学低年级",
    "primary_high": "小学高年级",
    "junior": "初中",
    "senior": "高中",
}

data = json.loads((META / "generation-input.json").read_text(encoding="utf-8"))

# 本地进度动画助手：rAF，返回可 pause/restart 的 handle（Sandbox.attach 用）
HELPER = r"""
function makeTicker(durationMs, onFrame) {
  var startTs = 0;
  var raf = 0;
  var running = false;
  var lastT = 0;
  function frame(ts) {
    if (!running) return;
    if (!startTs) startTs = ts;
    var t = Math.min(1, (ts - startTs) / durationMs);
    lastT = t;
    onFrame(t);
    if (t < 1) {
      raf = requestAnimationFrame(frame);
    } else {
      running = false;
      Sandbox.progress(1);
    }
  }
  return {
    restart: function () {
      if (raf) cancelAnimationFrame(raf);
      startTs = 0;
      running = true;
      raf = requestAnimationFrame(frame);
    },
    play: function () {
      if (running) return;
      running = true;
      // 简化：从头续播（pause/play 场景够用）
      startTs = 0;
      raf = requestAnimationFrame(frame);
    },
    pause: function () {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
"""

READY_TAIL = "\nSandbox.ready();\n"


def body_steps(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">一步一步看…</p>\n'
        '<div class="anim-canvas">\n'
        '  <svg id="flow" viewBox="0 0 460 220" width="100%" height="100%" role="img" aria-label="步骤动画">\n'
        '    <g id="stages"></g>\n'
        '    <g id="dots"></g>\n'
        '  </svg>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="step-chip">步骤</span></p>\n'
    )


SCRIPT_STEPS = (
    HELPER
    + r"""
var SPEED = {{speed}};
var DURATION = Math.round(4200 / SPEED);
var stageGroup = document.getElementById('stages');
var dotGroup = document.getElementById('dots');
var caption = document.getElementById('caption');
var chip = document.getElementById('step-chip');
var STAGES = __STAGES__;
var N = STAGES.length;
var W = 460;
var cardW = Math.min(120, Math.floor((W - 40) / N) - 8);
var gap = N > 1 ? (W - 40 - cardW * N) / (N - 1) : 0;
var nodes = [];
for (var s = 0; s < N; s += 1) {
  var x = 20 + s * (cardW + gap);
  var rect = Sandbox.svgEl('rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', '48');
  rect.setAttribute('width', String(cardW));
  rect.setAttribute('height', '88');
  rect.setAttribute('rx', '12');
  rect.setAttribute('fill', '#ffffff');
  rect.setAttribute('stroke', '#d6ddec');
  rect.setAttribute('stroke-width', '1.6');
  stageGroup.appendChild(rect);
  var num = Sandbox.svgEl('text');
  num.setAttribute('x', String(x + 10));
  num.setAttribute('y', '70');
  num.setAttribute('style', 'font-size:11px;fill:#8aa0bd');
  num.textContent = String(s + 1);
  stageGroup.appendChild(num);
  var title = Sandbox.svgEl('text');
  title.setAttribute('x', String(x + cardW / 2));
  title.setAttribute('y', '96');
  title.setAttribute('text-anchor', 'middle');
  title.setAttribute('style', 'font-size:13px;font-weight:650;fill:#12233b');
  title.textContent = STAGES[s].title;
  if (title.textContent.length > 5) title.textContent = title.textContent.slice(0, 4) + '…';
  stageGroup.appendChild(title);
  var hint = Sandbox.svgEl('text');
  hint.setAttribute('x', String(x + cardW / 2));
  hint.setAttribute('y', '118');
  hint.setAttribute('text-anchor', 'middle');
  hint.setAttribute('style', 'font-size:11px;fill:#5b6b82');
  hint.textContent = STAGES[s].hint;
  stageGroup.appendChild(hint);
  if (s < N - 1 && gap > 6) {
    var ax = x + cardW;
    var arrow = Sandbox.svgEl('path');
    arrow.setAttribute('d', 'M' + (ax + 2) + ' 92 L' + (ax + gap - 2) + ' 92');
    arrow.setAttribute('stroke', '#d6ddec');
    arrow.setAttribute('stroke-width', '2');
    stageGroup.appendChild(arrow);
  }
  nodes.push(rect);
}
var dot = Sandbox.svgEl('circle');
dot.setAttribute('r', '6');
dot.setAttribute('fill', '#3b82f6');
dot.setAttribute('cy', '160');
dotGroup.appendChild(dot);

function play() {
  caption.textContent = STAGES[0].caption;
  chip.textContent = '1 / ' + N;
  nodes[0].setAttribute('fill', '#eef4ff');
  var handle = makeTicker(DURATION, function (t) {
    var i = Math.min(N - 1, Math.floor(t * N));
    var local = t * N - i;
    var x0 = 20 + i * (cardW + gap) + cardW / 2;
    var x1 = 20 + Math.min(N - 1, i + 1) * (cardW + gap) + cardW / 2;
    dot.setAttribute('cx', String(x0 + (x1 - x0) * local));
    if (caption.textContent !== STAGES[i].caption) {
      caption.textContent = STAGES[i].caption;
      chip.textContent = (i + 1) + ' / ' + N;
      for (var k = 0; k < N; k += 1) {
        nodes[k].setAttribute('fill', k === i ? '#eef4ff' : '#ffffff');
      }
    }
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)


def body_flow(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">看东西怎么流过去…</p>\n'
        '<div class="anim-canvas">\n'
        '  <svg id="flow" viewBox="0 0 460 200" width="100%" height="100%" role="img" aria-label="流程动画">\n'
        '    <g id="nodes"></g>\n'
        '    <g id="packet"></g>\n'
        '  </svg>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="phase">阶段</span></p>\n'
    )


SCRIPT_FLOW = (
    HELPER
    + r"""
var SPEED = {{speed}};
var DURATION = Math.round(4200 / SPEED);
var gN = document.getElementById('nodes');
var gP = document.getElementById('packet');
var caption = document.getElementById('caption');
var phase = document.getElementById('phase');
var STAGES = __STAGES__;
var N = STAGES.length;
var pts = [];
for (var s = 0; s < N; s += 1) {
  var x = N === 1 ? 230 : 40 + s * (380 / (N - 1));
  var y = 100;
  pts.push({ x: x, y: y });
  var c = Sandbox.svgEl('circle');
  c.setAttribute('cx', String(x));
  c.setAttribute('cy', String(y));
  c.setAttribute('r', '30');
  c.setAttribute('fill', '#ffffff');
  c.setAttribute('stroke', '#d6ddec');
  c.setAttribute('stroke-width', '1.6');
  gN.appendChild(c);
  var t1 = Sandbox.svgEl('text');
  t1.setAttribute('x', String(x));
  t1.setAttribute('y', String(y - 2));
  t1.setAttribute('text-anchor', 'middle');
  t1.setAttribute('style', 'font-size:12px;font-weight:650;fill:#12233b');
  t1.textContent = STAGES[s].title;
  if (t1.textContent.length > 5) t1.textContent = t1.textContent.slice(0, 4) + '…';
  gN.appendChild(t1);
  var t2 = Sandbox.svgEl('text');
  t2.setAttribute('x', String(x));
  t2.setAttribute('y', String(y + 16));
  t2.setAttribute('text-anchor', 'middle');
  t2.setAttribute('style', 'font-size:10px;fill:#5b6b82');
  t2.textContent = STAGES[s].hint;
  gN.appendChild(t2);
  if (s < N - 1) {
    var x2 = 40 + (s + 1) * (380 / (N - 1));
    var line = Sandbox.svgEl('line');
    line.setAttribute('x1', String(x + 32));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(x2 - 32));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#e4eaf3');
    line.setAttribute('stroke-width', '2');
    gN.appendChild(line);
  }
}
var ball = Sandbox.svgEl('circle');
ball.setAttribute('r', '8');
ball.setAttribute('fill', '#3b82f6');
ball.setAttribute('cx', String(pts[0].x));
ball.setAttribute('cy', String(pts[0].y));
gP.appendChild(ball);

function play() {
  caption.textContent = STAGES[0].caption;
  phase.textContent = '1 / ' + N;
  var handle = makeTicker(DURATION, function (t) {
    var f = t * (N - 1);
    var i = Math.min(N - 2, Math.floor(f));
    if (N === 1) { i = 0; }
    var local = N === 1 ? 0 : f - i;
    var a = pts[i];
    var b = pts[Math.min(N - 1, i + 1)];
    var x = a.x + (b.x - a.x) * local;
    var y = a.y + (b.y - a.y) * local - Math.sin(local * Math.PI) * 18;
    ball.setAttribute('cx', String(x));
    ball.setAttribute('cy', String(y));
    var idx = Math.min(N - 1, Math.round(t * (N - 1)));
    caption.textContent = STAGES[idx].caption;
    phase.textContent = (idx + 1) + ' / ' + N;
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)


def body_compare(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">左右比一比…</p>\n'
        '<div class="anim-canvas">\n'
        '  <svg id="flow" viewBox="0 0 460 230" width="100%" height="100%" role="img" aria-label="对比动画">\n'
        '    <g id="cols"></g>\n'
        '  </svg>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="side">对照</span></p>\n'
    )


SCRIPT_COMPARE = (
    HELPER
    + r"""
var SPEED = {{speed}};
var DURATION = Math.round(4200 / SPEED);
var g = document.getElementById('cols');
var caption = document.getElementById('caption');
var side = document.getElementById('side');
var PAIRS = __PAIRS__;
var N = PAIRS.length;
function panel(x, fill) {
  var r = Sandbox.svgEl('rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', '30');
  r.setAttribute('width', '200');
  r.setAttribute('height', '150');
  r.setAttribute('rx', '14');
  r.setAttribute('fill', fill);
  r.setAttribute('stroke', '#d6ddec');
  r.setAttribute('stroke-width', '1.6');
  g.appendChild(r);
}
panel(20, '#f8fafc');
panel(240, '#eef4ff');
var left = Sandbox.svgEl('text');
var right = Sandbox.svgEl('text');
left.setAttribute('x', '120');
left.setAttribute('y', '120');
left.setAttribute('text-anchor', 'middle');
left.setAttribute('style', 'font-size:15px;font-weight:600;fill:#12233b');
right.setAttribute('x', '340');
right.setAttribute('y', '120');
right.setAttribute('text-anchor', 'middle');
right.setAttribute('style', 'font-size:15px;font-weight:600;fill:#12233b');
g.appendChild(left);
g.appendChild(right);
var sideTitle = Sandbox.svgEl('text');
sideTitle.setAttribute('x', '120');
sideTitle.setAttribute('y', '58');
sideTitle.setAttribute('text-anchor', 'middle');
sideTitle.setAttribute('style', 'font-size:11px;fill:#8aa0bd');
sideTitle.textContent = '常见误解';
g.appendChild(sideTitle);
var sideTitleB = Sandbox.svgEl('text');
sideTitleB.setAttribute('x', '340');
sideTitleB.setAttribute('y', '58');
sideTitleB.setAttribute('text-anchor', 'middle');
sideTitleB.setAttribute('style', 'font-size:11px;fill:#8aa0bd');
sideTitleB.textContent = '正确理解';
g.appendChild(sideTitleB);

function play() {
  left.textContent = PAIRS[0].left;
  right.textContent = PAIRS[0].right;
  caption.textContent = PAIRS[0].caption;
  side.textContent = '1 / ' + N;
  var handle = makeTicker(DURATION, function (t) {
    var i = Math.min(N - 1, Math.floor(t * N));
    var pair = PAIRS[i];
    left.textContent = pair.left;
    right.textContent = pair.right;
    caption.textContent = pair.caption;
    side.textContent = (i + 1) + ' / ' + N;
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)


def body_layers(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">一层一层搭起来…</p>\n'
        '<div class="anim-canvas">\n'
        '  <svg id="flow" viewBox="0 0 460 240" width="100%" height="100%" role="img" aria-label="层级动画">\n'
        '    <g id="stack"></g>\n'
        '  </svg>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="layer-chip">层</span></p>\n'
    )


SCRIPT_LAYERS = (
    HELPER
    + r"""
var SPEED = {{speed}};
var DURATION = Math.round(4200 / SPEED);
var g = document.getElementById('stack');
var caption = document.getElementById('caption');
var chip = document.getElementById('layer-chip');
var LAYERS = __STAGES__;
var N = LAYERS.length;
var nodes = [];
for (var i = 0; i < N; i += 1) {
  var y = 200 - i * 48;
  var x = 60 + i * 10;
  var w = 340 - i * 20;
  var r = Sandbox.svgEl('rect');
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(Math.max(160, w)));
  r.setAttribute('height', '40');
  r.setAttribute('rx', '10');
  r.setAttribute('fill', '#ffffff');
  r.setAttribute('stroke', '#d6ddec');
  r.setAttribute('stroke-width', '1.6');
  r.setAttribute('opacity', '0');
  g.appendChild(r);
  var t = Sandbox.svgEl('text');
  t.setAttribute('x', String(x + Math.max(160, w) / 2));
  t.setAttribute('y', String(y + 25));
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('style', 'font-size:12px;font-weight:600;fill:#12233b');
  var label = LAYERS[i].title + (LAYERS[i].hint ? ' · ' + LAYERS[i].hint : '');
  if (label.length > 16) label = label.slice(0, 15) + '…';
  t.textContent = label;
  t.setAttribute('opacity', '0');
  g.appendChild(t);
  nodes.push({ rect: r, text: t });
}
function play() {
  for (var i = 0; i < N; i += 1) {
    nodes[i].rect.setAttribute('opacity', '0');
    nodes[i].text.setAttribute('opacity', '0');
  }
  caption.textContent = LAYERS[0].caption;
  chip.textContent = '1 / ' + N;
  var handle = makeTicker(DURATION, function (t) {
    var i = Math.min(N - 1, Math.floor(t * N));
    for (var k = 0; k <= i; k += 1) {
      nodes[k].rect.setAttribute('opacity', '1');
      nodes[k].text.setAttribute('opacity', '1');
    }
    caption.textContent = LAYERS[i].caption;
    chip.textContent = (i + 1) + ' / ' + N;
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)


def body_loop(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">转一圈是一轮…</p>\n'
        '<div class="anim-canvas">\n'
        '  <svg id="flow" viewBox="0 0 460 240" width="100%" height="100%" role="img" aria-label="循环动画">\n'
        '    <g id="ring"></g>\n'
        '    <g id="mover"></g>\n'
        '  </svg>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="round">轮次</span></p>\n'
    )


SCRIPT_LOOP = (
    HELPER
    + r"""
var SPEED = {{speed}};
var ROUNDS = {{rounds}};
var DURATION = Math.round(3600 * ROUNDS / SPEED);
var gR = document.getElementById('ring');
var gM = document.getElementById('mover');
var caption = document.getElementById('caption');
var chip = document.getElementById('round');
var STAGES = __STAGES__;
var N = STAGES.length;
var cx = 230, cy = 115, R = 78;
var pts = [];
for (var s = 0; s < N; s += 1) {
  var ang = -Math.PI / 2 + (s * 2 * Math.PI) / N;
  var x = cx + R * Math.cos(ang);
  var y = cy + R * Math.sin(ang);
  pts.push({ x: x, y: y });
  var c = Sandbox.svgEl('circle');
  c.setAttribute('cx', String(x));
  c.setAttribute('cy', String(y));
  c.setAttribute('r', '26');
  c.setAttribute('fill', '#ffffff');
  c.setAttribute('stroke', '#d6ddec');
  c.setAttribute('stroke-width', '1.6');
  gR.appendChild(c);
  var t = Sandbox.svgEl('text');
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y + 4));
  t.setAttribute('text-anchor', 'middle');
  t.setAttribute('style', 'font-size:11px;font-weight:650;fill:#12233b');
  var label = STAGES[s].title;
  if (label.length > 4) label = label.slice(0, 3) + '…';
  t.textContent = label;
  gR.appendChild(t);
}
var ball = Sandbox.svgEl('circle');
ball.setAttribute('r', '7');
ball.setAttribute('fill', '#3b82f6');
ball.setAttribute('cx', String(pts[0].x));
ball.setAttribute('cy', String(pts[0].y));
gM.appendChild(ball);

function play() {
  caption.textContent = STAGES[0].caption;
  chip.textContent = '第 1 轮 · ' + STAGES[0].title;
  var handle = makeTicker(DURATION, function (t) {
    var total = ROUNDS * N;
    var f = t * total;
    var i = Math.floor(f) % N;
    var local = f - Math.floor(f);
    var a = pts[i];
    var b = pts[(i + 1) % N];
    ball.setAttribute('cx', String(a.x + (b.x - a.x) * local));
    ball.setAttribute('cy', String(a.y + (b.y - a.y) * local));
    var round = Math.min(ROUNDS, Math.floor(f / N) + 1);
    caption.textContent = STAGES[i].caption;
    chip.textContent = '第 ' + round + ' 轮 · ' + STAGES[i].title;
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)


def body_checklist(title: str) -> str:
    return (
        f'<h1 class="anim-title">{title}</h1>\n'
        '<p class="anim-caption" id="caption">一条条对一遍…</p>\n'
        '<div class="anim-canvas">\n'
        '  <div id="list" style="padding:8px 12px"></div>\n'
        '</div>\n'
        '<p class="anim-caption"><span class="chip" id="ok-count">0 / 0</span></p>\n'
    )


SCRIPT_CHECKLIST = (
    HELPER
    + r"""
var SPEED = {{speed}};
var DURATION = Math.round(3600 / SPEED);
var list = document.getElementById('list');
var caption = document.getElementById('caption');
var chip = document.getElementById('ok-count');
var STAGES = __STAGES__;
var N = STAGES.length;
var rows = [];
for (var i = 0; i < N; i += 1) {
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;align-items:flex-start;padding:10px 8px;border-bottom:1px solid #eef2f7;opacity:0.35';
  var mark = document.createElement('span');
  mark.textContent = '○';
  mark.style.cssText = 'width:18px;flex:0 0 18px;color:#3b82f6';
  var body = document.createElement('div');
  var t = document.createElement('div');
  t.textContent = STAGES[i].title;
  t.style.cssText = 'font-size:14px;font-weight:600;color:#12233b';
  var h = document.createElement('div');
  h.textContent = STAGES[i].hint;
  h.style.cssText = 'font-size:12px;color:#5b6b82;margin-top:2px';
  body.appendChild(t);
  body.appendChild(h);
  row.appendChild(mark);
  row.appendChild(body);
  list.appendChild(row);
  rows.push({ row: row, mark: mark });
}
function play() {
  for (var i = 0; i < N; i += 1) {
    rows[i].row.style.opacity = '0.35';
    rows[i].mark.textContent = '○';
  }
  caption.textContent = STAGES[0].caption;
  chip.textContent = '1 / ' + N;
  var handle = makeTicker(DURATION, function (t) {
    var i = Math.min(N - 1, Math.floor(t * N));
    for (var k = 0; k <= i; k += 1) {
      rows[k].row.style.opacity = '1';
      rows[k].mark.textContent = '●';
    }
    caption.textContent = STAGES[i].caption;
    chip.textContent = (i + 1) + ' / ' + N;
    Sandbox.progress(t);
  });
  handle.restart();
  return handle;
}
Sandbox.play(play);
Sandbox.ready();
"""
)

ARCHETYPES = {
    "steps": (body_steps, SCRIPT_STEPS, "stages"),
    "flow": (body_flow, SCRIPT_FLOW, "stages"),
    "compare": (body_compare, SCRIPT_COMPARE, "pairs"),
    "layers": (body_layers, SCRIPT_LAYERS, "stages"),
    "loop": (body_loop, SCRIPT_LOOP, "stages"),
    "checklist": (body_checklist, SCRIPT_CHECKLIST, "stages"),
}

CHAPTER_ARCHETYPE = {
    "第1章": "compare",
    "第2章": "layers",
    "第3章": "flow",
    "第4章": "steps",
    "第5章": "flow",
    "第6章": "checklist",
    "第7章": "checklist",
    "第8章": "loop",
}

# 概念级覆盖：章节启发式会误伤的（截图 QA 修正，2026-09-22）
BASE_ARCHETYPE = {
    "ai-hierarchy": "layers",  # 包含层级，compare 会空板
    "ai-three-values": "steps",  # 三步走
    "narrow-ai": "compare",
    "strong-ai-agi": "compare",
    "data-processing": "flow",
    "training-inference": "steps",
    "hardware-accelerator": "layers",
    "algorithm": "steps",
    "deep-learning": "layers",
    "neural-network": "layers",
    "artificial-neuron": "flow",
    "transformer": "flow",
    "token": "steps",
    "machine-learning": "steps",
    "supervised-learning": "compare",
    "unsupervised-learning": "compare",
    "reinforcement-learning": "loop",
    "gradient-descent": "flow",
    "long-term-memory": "layers",
    "short-term-memory": "layers",
    "agent-planning": "steps",
    "agent-perception": "flow",
    "agent-action": "steps",
    "agent-reflection": "loop",
    "agent-tool-use": "flow",
    "limit-hallucination": "checklist",
    "limit-knowledge-cutoff": "checklist",
}


def pick_archetype(chapter: str, base: str) -> str:
    if base.startswith("prog-"):
        return "loop" if "loop" in base else ("steps" if "variable" in base else "flow")
    if base in BASE_ARCHETYPE:
        return BASE_ARCHETYPE[base]
    for pref, arch in CHAPTER_ARCHETYPE.items():
        if chapter.startswith(pref[:3]):
            return arch
    return "steps"


def short(text: str, n: int = 18) -> str:
    """硬截断（节点标签用）。中文按字数；超长加省略号。"""
    t = re.sub(r"\s+", " ", (text or "").strip()).replace("**", "")
    if not t:
        return ""
    return t if len(t) <= n else t[: max(1, n - 1)] + "…"


def one_line(text: str, max_len: int = 26) -> str:
    """caption 用：尽量在标点处断，避免半截词。"""
    t = re.sub(r"\s+", " ", (text or "").strip()).replace("**", "")
    if len(t) <= max_len:
        return t
    window = t[:max_len]
    for p in range(len(window), max(6, max_len - 12), -1):
        if window[p - 1] in "，。；、：！？":
            return window[:p]
    return window


def make_stages_for_grade(entry: dict, grade: str, archetype: str):
    name = entry["name"]
    item = entry["by_grade"][grade]
    summary = item.get("summary") or name
    chunks = item.get("chunks") or []
    sentences: list[str] = []
    for ch in chunks:
        for part in re.split(r"[。\n！？]", ch.get("text") or ""):
            part = part.strip()
            if 6 <= len(part) <= 28:
                sentences.append(part)
    while len(sentences) < 4:
        sentences.append(summary[:28] if summary else name)

    tone_open = {
        "primary_low": "先看这是什么",
        "primary_high": "先弄懂它是什么",
        "junior": "先抓住定义",
        "senior": "先明确概念边界",
    }[grade]
    tone_use = {
        "primary_low": "再想它像生活里的什么",
        "primary_high": "再看它有什么用",
        "junior": "再分析怎么起作用",
        "senior": "再拆机制与前提",
    }[grade]
    tone_edge = {
        "primary_low": "记住一点就好",
        "primary_high": "还要知道边界",
        "junior": "最后辨析易混点",
        "senior": "最后关联上下游与局限",
    }[grade]

    if archetype == "compare":
        # 左右必须是能读懂的短语，禁止占位词（截图 QA：「别记反/记牢这个」空板）
        concept = short(name, 8)
        s0 = short(sentences[0], 6) or "容易混的"
        s1 = short(concept, 6) or "正确理解"
        s2 = short(sentences[1], 6) or "关键作用"
        return [
            {"left": "不是这个", "right": concept, "caption": f"{tone_open}：{one_line(summary, 24)}"},
            {"left": s0, "right": s1, "caption": f"{tone_use}：{one_line(sentences[0], 24)}"},
            {"left": "记住这个", "right": s2, "caption": f"{tone_edge}：{one_line(sentences[2], 24)}"},
        ]

    # 圆/短框内标题 ≤ 5 字，完整意思放 hint / caption
    node_title = short(name, 5) if len(name) <= 6 else short(name.replace("：", ""), 5) or "概念"
    stages = [
        {"title": node_title, "hint": "是什么", "caption": f"{tone_open}：{one_line(summary, 24)}"},
        {"title": "关键点", "hint": short(sentences[0], 8), "caption": f"{tone_use}：{one_line(sentences[0], 24)}"},
        {"title": "再看步", "hint": short(sentences[1], 8), "caption": one_line(sentences[1], 24)},
        {"title": "收束", "hint": "记住", "caption": f"{tone_edge}：{one_line(sentences[2], 22)}"},
    ]
    if archetype == "layers":
        # 自下而上：先基础后抽象
        stages = [
            {"title": "基础", "hint": short(sentences[0], 8), "caption": one_line(sentences[0], 24)},
            {"title": "中间", "hint": short(sentences[1], 8).replace("*", ""), "caption": one_line(sentences[1], 24)},
            {"title": "上层", "hint": short(sentences[2], 8), "caption": one_line(sentences[2], 24)},
            {"title": node_title, "hint": "整体", "caption": f"{tone_edge}：{one_line(summary, 22)}"},
        ]
    if archetype == "checklist":
        stages = [
            {"title": short(sentences[0], 10) or "要点 1", "hint": short(summary, 12), "caption": one_line(sentences[0], 24)},
            {"title": short(sentences[1], 10) or "要点 2", "hint": tone_use, "caption": one_line(sentences[1], 24)},
            {"title": short(sentences[2], 10) or "要点 3", "hint": tone_edge, "caption": one_line(sentences[2], 24)},
        ]
    return stages


def fallback_text(entry: dict, grade: str) -> str:
    item = entry["by_grade"][grade]
    name = item["name"] or entry["name"]
    summary = (item.get("summary") or "").strip()
    chunks = item.get("chunks") or []
    extra = ""
    for ch in chunks:
        t = (ch.get("text") or "").strip().replace("\n", " ")
        if len(t) > 40:
            extra = t[:120]
            break
    summary = summary.replace("**", "")
    extra = extra.replace("**", "")
    grade_word = GRADE_LABEL[grade]
    body = f"{name}：{summary}" if summary else name
    if extra:
        body = f"{body} 再记一句：{extra}。"
    return f"（{grade_word}讲法）{body}"[:580]


def build_template(entry: dict) -> dict | None:
    base = entry["base"]
    chapter = entry["chapter_title"] or ""
    archetype = pick_archetype(chapter, base)
    body_fn, script_tpl, payload_key = ARCHETYPES[archetype]

    grades = [g for g in GRADE_LEVELS if g in entry["by_grade"]]
    if not grades:
        return None
    main_grade = "junior" if "junior" in grades else grades[-1]
    title = f"{entry['name']}：看懂它是怎么起作用的"
    stages = make_stages_for_grade(entry, main_grade, archetype)
    payload_js = json.dumps(stages, ensure_ascii=False)

    script = script_tpl.replace("__STAGES__", payload_js).replace("__PAIRS__", payload_js)

    if archetype == "loop":
        params = {
            "rounds": {"type": "int", "min": 1, "max": 4, "default": 2, "description": "循环几轮"},
            "speed": {"type": "float", "min": 0.5, "max": 3, "default": 1.2, "description": "播放速度倍数"},
        }
    else:
        params = {
            "speed": {"type": "float", "min": 0.5, "max": 3, "default": 1.2, "description": "播放速度倍数"}
        }

    kp_ids = [entry["by_grade"][g]["kp_id"] for g in grades]
    template_id = re.sub(r"[^a-z0-9-]+", "-", base.lower())[:60]
    if len(template_id) < 3:
        template_id = f"kp-{template_id}" if template_id else f"kp-{abs(hash(base)) % 10000}"

    return {
        "id": template_id,
        "label": entry["name"],
        "title": title,
        "concept": entry["name"],
        "kp_ids": kp_ids,
        "grade_levels": grades,
        "duration_ms": 4800,
        "params": params,
        "body": body_fn(title),
        "script": script,
        "fallback_text": fallback_text(entry, main_grade),
        "archetype": archetype,
    }


def main() -> None:
    # 清掉旧产物，避免残留坏模板
    for p in OUT_T.glob("*.json"):
        p.unlink()
    written = 0
    covered = 0
    for entry in data["concepts"]:
        tpl = build_template(entry)
        if not tpl:
            continue
        public = {k: v for k, v in tpl.items() if k != "archetype"}
        path = OUT_T / f"{tpl['id']}.json"
        path.write_text(json.dumps(public, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        written += 1
        covered += len(tpl["kp_ids"])

        for grade in GRADE_LEVELS:
            item = entry["by_grade"].get(grade)
            if not item:
                continue
            stages = make_stages_for_grade(entry, grade, tpl["archetype"])
            by = {
                "kp_id": item["kp_id"],
                "grade_level": grade,
                "name": item["name"],
                "concept": entry["name"],
                "template_id": tpl["id"],
                "archetype": tpl["archetype"],
                "title": f"{item['name']}：看懂它是怎么起作用的",
                "steps": stages,
                "fallback_text": fallback_text(entry, grade),
                "duration_ms": 4800,
                "params": tpl["params"],
            }
            (OUT_K / f"{item['kp_id']}.json").write_text(
                json.dumps(by, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )

    print(f"templates written: {written}, kp covered: {covered}")
    print(f"by-kp files: {len(list(OUT_K.glob('*.json')))}")


if __name__ == "__main__":
    main()
