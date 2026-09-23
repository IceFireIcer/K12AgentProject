# -*- coding: utf-8 -*-
"""校验 preset-content：题库/代码模板/动画模板。"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(r"E:\FolderForVibeCoding\Zcode\K12Agent")
PACK = ROOT / "preset-content"
sys.path.insert(0, str(ROOT / "server"))

errors = []
notes = []

# ---- knowledge kp set ----
kp_ids = set()
for d in (ROOT / "server" / "knowledge").iterdir():
    if d.is_dir():
        for f in d.glob("*.md"):
            kp_ids.add(f.stem)
print("knowledge kps", len(kp_ids))

# ---- quizbank ----
q_kp = set()
q_n = 0
for f in sorted((PACK / "quizbank").glob("*.json")):
    d = json.loads(f.read_text(encoding="utf-8"))
    assert d.get("version") == 1
    for q in d["questions"]:
        q_n += 1
        q_kp.add(q["kp_id"])
        if q["type"] not in {"choice", "blank", "code_blank"}:
            errors.append(f"quiz type {q['qid']}")
        if q["type"] == "choice":
            if not isinstance(q.get("answer"), str):
                errors.append(f"choice answer {q['qid']}")
            if q.get("answer") not in q.get("options", []):
                errors.append(f"choice answer not in options {q['qid']}")
        if q["type"] == "blank":
            if not isinstance(q.get("answer"), list):
                errors.append(f"blank answer {q['qid']}")
print("quiz", q_n, "kps", len(q_kp), "missing", len(kp_ids - q_kp))

# ---- code templates ----
c_n = 0
for f in sorted((PACK / "code-templates").glob("*.json")):
    c_n += 1
    d = json.loads(f.read_text(encoding="utf-8"))
    for key in ["kp_id", "grade_level", "title", "expected_behavior", "scaffold", "expected_output", "hints", "solution"]:
        if key not in d:
            errors.append(f"code missing {key} {f.name}")
    if d["kp_id"] not in kp_ids:
        errors.append(f"code kp unknown {d['kp_id']}")
    if d["kp_id"] != f.stem:
        errors.append(f"code filename mismatch {f.name}")
    if d["scaffold"].count("TODO") < 2:
        errors.append(f"code TODO<2 {f.name}")
    if len(d.get("hints") or []) < 3:
        errors.append(f"code hints<3 {f.name}")
    for h in d.get("hints") or []:
        if h.get("level") not in (1, 2, 3):
            errors.append(f"code hint level {f.name}")
print("code templates", c_n)

# ---- animation templates ----
from app.routes.resources import load_templates, match_templates, pick_template  # noqa: E402

templates = load_templates(PACK / "animations" / "templates")
print("anim templates loaded", len(templates))
covered = set()
for t in templates:
    covered.update(t.kp_ids)
    # script must call Sandbox.play
    if "Sandbox.play(" not in t.script:
        errors.append(f"anim no Sandbox.play {t.id}")
    # placeholders vs params
    ph = set(re.findall(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}", f"{t.body}\n{t.script}"))
    if ph != set(t.params):
        errors.append(f"anim params mismatch {t.id}: ph={ph} params={set(t.params)}")

missing_anim = kp_ids - covered
print("anim kp covered", len(covered & kp_ids), "missing", len(missing_anim))
if missing_anim:
    notes.append(f"anim missing sample {list(missing_anim)[:5]}")

# pick_template for every kp should hit reason=kp
miss_pick = []
for kid in sorted(kp_ids):
    tpl, reason = pick_template(templates, kp_id=kid, grade_level="")
    if reason != "kp":
        miss_pick.append((kid, reason))
print("pick reason!=kp", len(miss_pick))
if miss_pick[:5]:
    notes.append(f"pick miss {miss_pick[:5]}")

# by-kp files
by = list((PACK / "animations" / "by-kp").glob("*.json"))
print("by-kp", len(by))

# try load one template via load_template strict
from app.routes.resources import load_template  # noqa: E402

sample = next((PACK / "animations" / "templates").glob("*.json"))
try:
    load_template(sample)
    notes.append(f"strict load ok: {sample.name}")
except Exception as exc:  # noqa: BLE001
    errors.append(f"strict load fail {sample.name}: {exc}")

print("\n=== NOTES ===")
for n in notes:
    print(n)
print("=== ERRORS ===", len(errors))
for e in errors[:30]:
    print(e)
if not errors:
    print("ALL CHECKS PASSED")
