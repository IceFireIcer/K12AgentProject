import json
from collections import Counter
from pathlib import Path

# ★ 相对本文件：仓库根 = 往上三层（_meta → preset-content → 仓库根），不写死盘符
ROOT = Path(__file__).resolve().parents[2]
meta = json.loads((ROOT / "preset-content/_meta/generation-input.json").read_text(encoding="utf-8"))
byk = ROOT / "preset-content/animations/by-kp"
arch = Counter()
mapping = []
for c in meta["concepts"]:
    g = c["by_grade"].get("junior") or next(iter(c["by_grade"].values()))
    d = json.loads((byk / f"{g['kp_id']}.json").read_text(encoding="utf-8"))
    arch[d["archetype"]] += 1
    mapping.append((c["base"], d["archetype"], (c["chapter_title"] or "")[:8], c["name"][:14]))

print("archetype dist", dict(arch))
print("--- ch2 ---")
for m in mapping:
    if m[2].startswith("第2章"):
        print(m)
print("--- one per archetype ---")
seen = set()
for m in mapping:
    if m[1] not in seen:
        print(m)
        seen.add(m[1])
print("--- ch1 ---")
for m in mapping:
    if m[2].startswith("第1章"):
        print(m)
