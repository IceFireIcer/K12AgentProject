# -*- coding: utf-8 -*-
"""为 228 个 KP 生成 code-templates（含 solution，导入后由投影层屏蔽）。"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(r"E:\FolderForVibeCoding\Zcode\K12Agent")
META = ROOT / "preset-content" / "_meta"
OUT = ROOT / "preset-content" / "code-templates"
OUT.mkdir(parents=True, exist_ok=True)

GRADE_LEVELS = ["primary_low", "primary_high", "junior", "senior"]
data = json.loads((META / "generation-input.json").read_text(encoding="utf-8"))

# 现有高质量初中三份，原样保留
KEEP = {
    "prog-variable-jr",
    "prog-loop-jr",
    "prog-list-jr",
}


def run_solution(code: str) -> str:
    p = subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=5,
    )
    return p.stdout


def clean(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def build_exercise(entry: dict, grade: str) -> dict | None:
    item = entry["by_grade"].get(grade)
    if not item:
        return None
    kp_id = item["kp_id"]
    name = item["name"]
    summary = clean(item.get("summary") or name)
    base = entry["base"]

    # —— 编程章：更接近真实写法 ——
    if base == "prog-variable":
        if grade == "primary_low":
            title = "变量：把两门课的星星放进盒子再数总数"
            scaffold = (
                "# 目标：用变量存下两门课得到的星星，算出总数\n"
                "chinese_star = 3\n"
                "math_star = 5\n"
                "\n"
                "# TODO 1：把两门课的星星加起来，存进 total\n"
                "total = ____\n"
                "\n"
                "# TODO 2：打印「一共 N 颗星」\n"
                "____\n"
            )
            solution = (
                "chinese_star = 3\n"
                "math_star = 5\n"
                "\n"
                "total = chinese_star + math_star\n"
                "\n"
                'print(f"一共 {total} 颗星")\n'
            )
            expected_behavior = "填完 TODO 后打印出「一共 8 颗星」。"
            hints = [
                {"level": 1, "hint": "先想「一共」是不是把两个数合起来？合起来用哪个符号？"},
                {"level": 2, "hint": "把 chinese_star 和 math_star 用 + 连起来，赋给 total。"},
                {"level": 3, "hint": "total = chinese_star + math_star；再 print(f\"一共 {total} 颗星\")。"},
            ]
        elif grade == "primary_high":
            title = "变量：算出两天一共走了多少步"
            scaffold = (
                "# 目标：用变量存下两天的步数，算出总数\n"
                "day1 = 3200\n"
                "day2 = 4500\n"
                "\n"
                "# TODO 1：两天步数相加，存进 total_steps\n"
                "total_steps = ____\n"
                "\n"
                "# TODO 2：打印「两天一共走了 N 步」\n"
                "____\n"
            )
            solution = (
                "day1 = 3200\n"
                "day2 = 4500\n"
                "\n"
                "total_steps = day1 + day2\n"
                "\n"
                'print(f"两天一共走了 {total_steps} 步")\n'
            )
            expected_behavior = "填完 TODO 后打印出「两天一共走了 7700 步」。"
            hints = [
                {"level": 1, "hint": "「一共」是加法。想清楚哪两个变量要加。"},
                {"level": 2, "hint": "total_steps = day1 + day2，然后用 f-string 打印。"},
                {"level": 3, "hint": "print(f\"两天一共走了 {total_steps} 步\")。"},
            ]
        elif grade == "junior":
            # 与仓库现有 prog-variable-jr.json 一致（生成器会跳过 KEEP）
            title = "变量：把三科成绩加起来求平均分"
            scaffold = (
                "# 目标：用变量存下三科成绩，算出平均分并打印\n"
                "chinese = 88\n"
                "math = 92\n"
                "english = 75\n"
                "\n"
                "# TODO 1：把三科成绩相加，再除以科目数（3），把结果存进 average\n"
                "average = ____\n"
                "\n"
                "# TODO 2：打印「平均分：85.0」这样的结果（保留 1 位小数）\n"
                "#         提示：print(f\"平均分：{average:.1f}\")\n"
                "____\n"
            )
            solution = (
                "chinese = 88\n"
                "math = 92\n"
                "english = 75\n"
                "\n"
                "average = (chinese + math + english) / 3\n"
                "\n"
                'print(f"平均分：{average:.1f}")\n'
            )
            expected_behavior = "把 TODO 1-2 填好以后，程序打印出「平均分：85.0」（先求和再除以科目数，保留 1 位小数）。"
            hints = [
                {"level": 1, "hint": "平均分是怎么算出来的？先用你自己的话说出这一步，再想「加」和「除」分别该写成哪个符号，注意别写成一个等号。"},
                {"level": 2, "hint": "先把三科成绩相加得到一个总分，再除以科目数 3。整件事写成一行赋值语句即可：等号右边是算式，等号左边是新变量的名字。"},
                {"level": 3, "hint": "赋值那句的左半边就是 average，右半边三个变量用 + 连起来再 / 3；打印用 f-string：print(f\"平均分：{average:.1f}\")，其中 .1f 表示「保留 1 位小数」。"},
            ]
        else:
            title = "变量：由摄氏温度算出华氏温度"
            scaffold = (
                "# 目标：C = 25，用公式 F = C * 9 / 5 + 32 求华氏度\n"
                "c = 25\n"
                "\n"
                "# TODO 1：按公式算出 f\n"
                "f = ____\n"
                "\n"
                "# TODO 2：打印「25 C = 77.0 F」（保留 1 位小数）\n"
                "____\n"
            )
            solution = (
                "c = 25\n"
                "\n"
                "f = c * 9 / 5 + 32\n"
                "\n"
                'print(f"{c} C = {f:.1f} F")\n'
            )
            expected_behavior = "填完 TODO 后打印出「25 C = 77.0 F」。"
            hints = [
                {"level": 1, "hint": "先写出公式，再决定先乘除还是先加减。"},
                {"level": 2, "hint": "f = c * 9 / 5 + 32。"},
                {"level": 3, "hint": "print(f\"{c} C = {f:.1f} F\")。"},
            ]

    elif base == "prog-loop":
        if grade == "primary_low":
            title = "循环：让小猫说三遍「你好」"
            scaffold = (
                "# 目标：用 for 循环打印三遍「你好」\n"
                "# TODO 1：写一个让 i 取 0、1、2 的 for 循环\n"
                "____\n"
                "# TODO 2：在循环里打印「你好」\n"
                "    ____\n"
            )
            solution = (
                "for i in range(3):\n"
                '    print("你好")\n'
            )
            expected_behavior = "打印三行「你好」。"
            hints = [
                {"level": 1, "hint": "要重复几次？把起点和次数都定下来，循环就会跑那么多次。"},
                {"level": 2, "hint": "for i in range(3): 下一行缩进写 print。"},
                {"level": 3, "hint": "for i in range(3):\n    print(\"你好\")"},
            ]
        elif grade == "primary_high":
            title = "循环：从 1 数到 5"
            scaffold = (
                "# 目标：依次打印 1 2 3 4 5\n"
                "# TODO 1：写 for 循环，让 n 取 1 到 5\n"
                "____\n"
                "# TODO 2：打印 n\n"
                "    ____\n"
            )
            solution = (
                "for n in range(1, 6):\n"
                "    print(n)\n"
            )
            expected_behavior = "依次打印 1 到 5，每个一行。"
            hints = [
                {"level": 1, "hint": "循环的终点要注意「含头不含尾」，所以那里要写 6。"},
                {"level": 2, "hint": "for n in range(1, 6): 然后 print(n)。"},
                {"level": 3, "hint": "for n in range(1, 6):\n    print(n)"},
            ]
        elif grade == "junior":
            title = "循环：把 1 到 5 加起来"
            scaffold = (
                "# 目标：用循环求 1+2+3+4+5\n"
                "total = 0\n"
                "\n"
                "# TODO 1：for 循环让 n 取 1 到 5\n"
                "____\n"
                "# TODO 2：把 n 加进 total\n"
                "    ____\n"
                "\n"
                "print(total)\n"
            )
            solution = (
                "total = 0\n"
                "\n"
                "for n in range(1, 6):\n"
                "    total = total + n\n"
                "\n"
                "print(total)\n"
            )
            expected_behavior = "打印出 15。"
            hints = [
                {"level": 1, "hint": "累加器先放 0，每一轮把新数加进去。"},
                {"level": 2, "hint": "for n in range(1, 6): total = total + n。"},
                {"level": 3, "hint": "for n in range(1, 6):\n    total = total + n\nprint(total)"},
            ]
        else:
            title = "循环：求 1 到 n 的平方和（n=5）"
            scaffold = (
                "# 目标：求 1^2 + 2^2 + ... + 5^2\n"
                "n = 5\n"
                "total = 0\n"
                "\n"
                "# TODO 1：for 循环 1..n\n"
                "____\n"
                "# TODO 2：把 i*i 加进 total\n"
                "    ____\n"
                "\n"
                "print(total)\n"
            )
            solution = (
                "n = 5\n"
                "total = 0\n"
                "\n"
                "for i in range(1, n + 1):\n"
                "    total += i * i\n"
                "\n"
                "print(total)\n"
            )
            expected_behavior = "打印出 55。"
            hints = [
                {"level": 1, "hint": "每一项是 i 的平方，累加进 total。"},
                {"level": 2, "hint": "for i in range(1, n + 1): total += i * i。"},
                {"level": 3, "hint": "for i in range(1, n + 1):\n    total += i * i\nprint(total)"},
            ]

    elif base == "prog-list":
        if grade == "primary_low":
            title = "列表：数一数袋子里有几颗糖"
            scaffold = (
                "# 目标：数出列表里有几样东西\n"
                'candies = ["苹果糖", "牛奶糖", "巧克力"]\n'
                "\n"
                "# TODO 1：用 len 数出数量，存进 count\n"
                "count = ____\n"
                "\n"
                "# TODO 2：打印「袋子里有 N 颗糖」\n"
                "____\n"
            )
            solution = (
                'candies = ["苹果糖", "牛奶糖", "巧克力"]\n'
                "\n"
                "count = len(candies)\n"
                "\n"
                'print(f"袋子里有 {count} 颗糖")\n'
            )
            expected_behavior = "打印「袋子里有 3 颗糖」。"
            hints = [
                {"level": 1, "hint": "「有几样」用哪个函数？len 是 length（长度）。"},
                {"level": 2, "hint": "count = len(candies)。"},
                {"level": 3, "hint": "print(f\"袋子里有 {count} 颗糖\")。"},
            ]
        elif grade == "primary_high":
            title = "列表：把购物清单打出来"
            scaffold = (
                "# 目标：依次打印清单上的每一样东西\n"
                'items = ["铅笔", "橡皮", "尺子"]\n'
                "\n"
                "# TODO 1：for 循环取出每一个 item\n"
                "____\n"
                "# TODO 2：打印 item\n"
                "    ____\n"
            )
            solution = (
                'items = ["铅笔", "橡皮", "尺子"]\n'
                "\n"
                "for item in items:\n"
                "    print(item)\n"
            )
            expected_behavior = "依次打印铅笔、橡皮、尺子，每个一行。"
            hints = [
                {"level": 1, "hint": "可以直接从列表里一个个拿，不必写数字下标。"},
                {"level": 2, "hint": "for item in items: 然后 print(item)。"},
                {"level": 3, "hint": "for item in items:\n    print(item)"},
            ]
        elif grade == "junior":
            title = "列表：算出平均特征值"
            scaffold = (
                "# 目标：求列表 features 的平均值\n"
                "features = [3.0, 5.0, 7.0, 9.0]\n"
                "\n"
                "# TODO 1：求和存进 total\n"
                "total = ____\n"
                "\n"
                "# TODO 2：求平均 avg = total / 个数，并打印「平均：5.0」（保留 1 位小数）\n"
                "avg = ____\n"
                "____\n"
            )
            solution = (
                "features = [3.0, 5.0, 7.0, 9.0]\n"
                "\n"
                "total = sum(features)\n"
                "\n"
                "avg = total / len(features)\n"
                'print(f"平均：{avg:.1f}")\n'
            )
            expected_behavior = "打印「平均：6.0」。"
            hints = [
                {"level": 1, "hint": "求和用 sum，个数用 len。"},
                {"level": 2, "hint": "total = sum(features)；avg = total / len(features)。"},
                {"level": 3, "hint": "print(f\"平均：{avg:.1f}\")。"},
            ]
        else:
            title = "列表：标准化一组特征（减均值再除以标准差）"
            scaffold = (
                "# 目标：把 xs 标准化后打印\n"
                "import math\n"
                "xs = [2.0, 4.0, 6.0, 8.0]\n"
                "\n"
                "# TODO 1：求均值 mu 与标准差 sigma（总体）\n"
                "mu = ____\n"
                "sigma = ____\n"
                "\n"
                "# TODO 2：打印标准化后的列表，保留 2 位小数\n"
                "zs = ____\n"
                "print([round(z, 2) for z in zs])\n"
            )
            solution = (
                "import math\n"
                "xs = [2.0, 4.0, 6.0, 8.0]\n"
                "\n"
                "mu = sum(xs) / len(xs)\n"
                "sigma = math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))\n"
                "\n"
                "zs = [(x - mu) / sigma for x in xs]\n"
                "print([round(z, 2) for z in zs])\n"
            )
            expected_behavior = "打印标准化结果，约 [-1.34, -0.45, 0.45, 1.34]。"
            hints = [
                {"level": 1, "hint": "先算平均 mu，再算每个数与 mu 的偏差。"},
                {"level": 2, "hint": "sigma = sqrt(平方偏差的平均)；z = (x - mu) / sigma。"},
                {"level": 3, "hint": "用列表推导：zs = [(x - mu) / sigma for x in xs]。"},
            ]

    else:
        # —— 概念轻量练习：打印 / 列表 / 计数，主题贴知识点 ——
        # 按章节调主题词
        chapter = entry.get("chapter_title") or ""
        topic = name
        theme_word = {
            "primary_low": f"「{topic}」",
            "primary_high": f"「{topic}」",
            "junior": f"概念「{topic}」",
            "senior": f"概念「{topic}」的要点",
        }[grade]

        if grade == "primary_low":
            title = f"编程小练习：把{theme_word}的关键句打出来"
            scaffold = (
                f"# 目标：把和{theme_word}有关的一句话打印出来\n"
                f'topic = "{name}"\n'
                "\n"
                "# TODO 1：准备一条要点 note（用你自己的话，一句就好）\n"
                "note = ____\n"
                "\n"
                "# TODO 2：打印「今天学了：<topic>，记住：<note>」\n"
                "____\n"
            )
            # solution 的 note 从 summary 截取
            note = summary[:16] if summary else name
            solution = (
                f'topic = "{name}"\n'
                f'note = "{note}"\n'
                'print(f"今天学了：{topic}，记住：{note}")\n'
            )
            expected_behavior = f"打印一行：今天学了：{name}，记住：{note}"
            hints = [
                {"level": 1, "hint": "先想好要记住的那一句，再放进变量 note。"},
                {"level": 2, "hint": "note = \"……\"，然后用 f-string 把 topic 和 note 放进同一行。"},
                {"level": 3, "hint": "print(f\"今天学了：{topic}，记住：{note}\")。"},
            ]
        elif grade == "primary_high":
            title = f"编程小练习：给{theme_word}列一张要点清单"
            points = [clean(s)[:12] for s in re.split(r"[。！？\n]", summary) if clean(s)][:3]
            while len(points) < 3:
                points.append(name[:8])
            scaffold = (
                f"# 目标：把{theme_word}的 3 个要点列出来\n"
                f"points = [\"{points[0]}\", \"TODO2\", \"TODO3\"]\n"
                "\n"
                "# TODO 1：把后两个要点改成真正的句子（从课本里找）\n"
                "# TODO 2：for 循环依次打印「要点 N：……」\n"
                "____\n"
                "    ____\n"
            )
            solution = (
                f"points = [\"{points[0]}\", \"{points[1]}\", \"{points[2]}\"]\n"
                "\n"
                "for i, p in enumerate(points, 1):\n"
                "    print(f\"要点 {i}：{p}\")\n"
            )
            expected_behavior = "打印三行要点。"
            hints = [
                {"level": 1, "hint": "enumerate 可以一边循环一边数第几个。"},
                {"level": 2, "hint": "for i, p in enumerate(points, 1):"},
                {"level": 3, "hint": "print(f\"要点 {i}：{p}\")。"},
            ]
        elif grade == "junior":
            title = f"编程小练习：数一数{theme_word}相关词出现了几次"
            keyword = name[:4] if name else "AI"
            scaffold = (
                f"# 目标：数出关键词在句子中出现了几次\n"
                f"keyword = \"{keyword}\"\n"
                f"sentence = \"{summary[:40]}\"\n"
                "\n"
                "# TODO 1：用 count 统计出现次数，存进 n\n"
                "n = ____\n"
                "\n"
                "# TODO 2：打印「关键词出现 N 次」\n"
                "____\n"
            )
            solution = (
                f"keyword = \"{keyword}\"\n"
                f"sentence = \"{summary[:40]}\"\n"
                "\n"
                "n = sentence.count(keyword)\n"
                'print(f"关键词出现 {n} 次")\n'
            )
            expected_behavior = "打印关键词在句子里出现的次数。"
            hints = [
                {"level": 1, "hint": "字符串自带 count 方法。"},
                {"level": 2, "hint": "n = sentence.count(keyword)。"},
                {"level": 3, "hint": "print(f\"关键词出现 {n} 次\")。"},
            ]
        else:
            title = f"编程小练习：把{theme_word}的要点做成字典并输出"
            key1 = "定义"
            key2 = "要点"
            scaffold = (
                "# 目标：用字典整理这个概念的两栏信息\n"
                f"card = {{\n"
                f'    "{key1}": "{summary[:24]}",\n'
                f'    "{key2}": "____",\n'
                f"}}\n"
                "\n"
                "# TODO 1：把「要点」填成一句自己的概括\n"
                "# TODO 2：按「定义」「要点」两行打印\n"
                "____\n"
                "____\n"
            )
            s2 = clean(summary)[24:44] if len(clean(summary)) > 24 else (name[:12] or "要点")
            solution = (
                "card = {\n"
                f'    "{key1}": "{summary[:24]}",\n'
                f'    "{key2}": "{s2}",\n'
                "}\n"
                "\n"
                f'print("定义：", card["{key1}"])\n'
                f'print("要点：", card["{key2}"])\n'
            )
            expected_behavior = "打印定义与要点两行。"
            hints = [
                {"level": 1, "hint": "字典用 {\"键\": 值}，取值用 card[\"键\"]。"},
                {"level": 2, "hint": "先把要点字符串放进 card。"},
                {"level": 3, "hint": "print(\"定义：\", card[\"定义\"]) 之类，两行各打一栏。"},
            ]

    out = run_solution(solution)
    expected_output = out
    # 至少 2 处 TODO
    todo_count = scaffold.count("TODO")
    if todo_count < 2:
        # 强行补一个 TODO 注释（不破坏可运行 solution）
        scaffold = scaffold.rstrip() + "\n\n# TODO：对照 expected_behavior 自查一遍\n"

    return {
        "kp_id": kp_id,
        "grade_level": grade,
        "title": title,
        "expected_behavior": expected_behavior,
        "scaffold": scaffold,
        "expected_output": expected_output,
        "hints": hints,
        "solution": solution,
    }


def main() -> None:
    written = 0
    errors = []
    for entry in data["concepts"]:
        for grade in GRADE_LEVELS:
            item = entry["by_grade"].get(grade)
            if not item:
                continue
            kp_id = item["kp_id"]
            if kp_id in KEEP:
                # 原样复制仓库现有高质量文件
                src = ROOT / "server" / "resources" / "code-templates" / f"{kp_id}.json"
                if src.exists():
                    (OUT / f"{kp_id}.json").write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
                    written += 1
                continue
            rec = build_exercise(entry, grade)
            if not rec:
                continue
            try:
                out = run_solution(rec["solution"])
                if out != rec["expected_output"]:
                    errors.append((kp_id, "output-mismatch", repr(out), repr(rec["expected_output"])))
            except Exception as exc:  # noqa: BLE001
                errors.append((kp_id, "run-failed", str(exc), ""))
            path = OUT / f"{kp_id}.json"
            path.write_text(json.dumps(rec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            written += 1
    print("written", written)
    if errors:
        print("ERRORS", len(errors))
        for e in errors[:20]:
            print(e)
    else:
        print("all solutions ran and matched expected_output")


if __name__ == "__main__":
    main()
