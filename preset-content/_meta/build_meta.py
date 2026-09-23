import json
import sqlite3
from pathlib import Path
from collections import defaultdict

ROOT = Path(r"E:\FolderForVibeCoding\Zcode\K12Agent")
DB = ROOT / "server" / "_data" / "shared" / "kb.sqlite"
OUT = ROOT / "preset-content"
META = OUT / "_meta"
META.mkdir(parents=True, exist_ok=True)

r = sqlite3.connect(DB)
r.row_factory = sqlite3.Row

kps = [dict(x) for x in r.execute(
    "SELECT * FROM kp ORDER BY grade_level, chapter_title, name"
)]

# full parent texts per kp
texts = defaultdict(list)
for row in r.execute(
    "SELECT knowledge_point, content_type, text FROM chunk "
    "WHERE is_parent=1 OR parent_chunk_id IS NULL "
    "ORDER BY knowledge_point, rowid"
):
    texts[row["knowledge_point"]].append(
        {"content_type": row["content_type"], "text": row["text"]}
    )

# concept base grouping (slug without grade suffix)
by_base = defaultdict(list)
for k in kps:
    base = k["kp_id"].rsplit("-", 1)[0]
    by_base[base].append(k)

GRADE_SUFFIX = {
    "primary_low": "pl",
    "primary_high": "ph",
    "junior": "jr",
    "senior": "sr",
}

pack = {
    "grade_order": ["primary_low", "primary_high", "junior", "senior"],
    "concepts": [],
}

for base in sorted(by_base.keys()):
    members = {k["grade_level"]: k for k in by_base[base]}
    entry = {
        "base": base,
        "name": members[list(members)[0]]["name"],
        "chapter_title": members[list(members)[0]]["chapter_title"],
        "section_by_grade": {
            g: members[g]["section_title"] for g in members if members.get(g)
        },
        "by_grade": {},
    }
    for g in ["primary_low", "primary_high", "junior", "senior"]:
        k = members.get(g)
        if not k:
            continue
        entry["by_grade"][g] = {
            "kp_id": k["kp_id"],
            "name": k["name"],
            "summary": k["summary"],
            "section_title": k["section_title"],
            "chunks": texts.get(k["kp_id"], []),
        }
    pack["concepts"].append(entry)

(META / "generation-input.json").write_text(
    json.dumps(pack, ensure_ascii=False, indent=2), encoding="utf-8"
)
print("concepts", len(pack["concepts"]))
print("kps", sum(len(c["by_grade"]) for c in pack["concepts"]))
print("with chunks", sum(1 for c in pack["concepts"] for g in c["by_grade"].values() if g["chunks"]))
print("wrote", META / "generation-input.json")

# also write a slim index for humans
lines = ["# KP 总表（57 概念 × 4 学段）\n"]
for c in pack["concepts"]:
    lines.append(f"\n## {c['base']} — {c['name']}\n")
    lines.append(f"章节：{c['chapter_title']}\n")
    for g in ["primary_low", "primary_high", "junior", "senior"]:
        item = c["by_grade"].get(g)
        if not item:
            continue
        lines.append(f"- **{g}** `{item['kp_id']}`：{item['summary'] or ''}")
(META / "kp-catalog.md").write_text("\n".join(lines), encoding="utf-8")
print("wrote catalog")
