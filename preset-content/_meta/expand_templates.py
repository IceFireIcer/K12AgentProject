# -*- coding: utf-8 -*-
"""把 57 概念模板 × by-kp 分学段文案展开成「一 KP 一模板」（206 份）。

背景（2026-09-22 用户裁决）：包内 57 份概念模板的 ``kp_ids`` 盖四个学段，但
``title`` / ``fallback_text`` / 注入进 ``script`` 的步骤数据（``STAGES``/``PAIRS``）
**只按初中写**（57 份 fallback_text 全部以「（初中讲法）」开头）。直接导入会让
小学/高中学生看到初中文案 —— 所以要按 ``by-kp/<kp_id>.json``（分学段文案真源）
一 KP 一份展开，文案逐学段取真源。

★ 注入逻辑**复用 gen_animations.py，不另写一套**（两套写法必然漂移）：

  本脚本 import gen_animations，取它的 ``ARCHETYPES``（六原型：
  steps / flow / compare / layers / loop / checklist，每项 = (body_fn, script_tpl, …)），
  然后按 gen_animations.build_template() 第 787 行的**同款两行**重放注入：

      script = script_tpl.replace("__STAGES__", steps_json).replace("__PAIRS__", steps_json)
      body   = body_fn(title)

  只是 steps 数据源换成 by-kp 里该学段的 ``steps``；body / script 骨架、
  占位符（``{{speed}}`` / ``{{rounds}}``）与 params 的配套关系全部与概念模板一致。

★ 跳过既有 8 份手作高保真模板（``server/resources/templates/`` 那 8 份）声明的
  22 个 kp —— 该集合**运行时从那 8 份的 kp_ids 现算**（不写死），避免同一 kp
  双模板：``pick_template()`` 同 kp 多命中时默默返回 ``exact[0]``（按目录字典序），
  不能靠运气。8 份的文件名以 ``templates-premium/`` 备份为准。

产出：``server/resources/templates/<kp_id>.json``（文件名与 ``id`` 都用 kp_id，
``find_template`` 可按 id 精确找回）。字段严格落在加载器封闭集合
``server/app/routes/resources.py::TEMPLATE_KEYS`` 内，多一个键就 TemplateError。
"""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # …/K12Agent
META = Path(__file__).resolve().parent
BY_KP = ROOT / "preset-content" / "animations" / "by-kp"
#: 既有 8 份的备份目录 —— 它的**文件名清单**就是「既有 8 份」的定义（kp_ids 则现算）。
PREMIUM = ROOT / "preset-content" / "animations" / "templates-premium"
OUT = ROOT / "server" / "resources" / "templates"

#: 生成模板允许出现的键（与 resources.py::TEMPLATE_KEYS 减去可选的 fallback_image 一致）。
ALLOWED_KEYS = {
    "id", "label", "title", "concept", "kp_ids", "grade_levels",
    "duration_ms", "params", "body", "script", "fallback_text",
}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
#: 外部引用判据（与 resources.py::EXTERNAL_REFERENCE_RE 同源）—— 沙箱断网，一个链接就白屏。
EXTERNAL_RE = re.compile(r"https?://|//cdn|unpkg|jsdelivr|cdnjs|googleapis|fonts\.gstatic", re.IGNORECASE)
#: 学生可见文案禁用标记（D-076 / P-123：裸插值会把它们原样印上屏）。
MARKS = ("——", "**", "`")
PARAM_TYPES = {"int", "float", "str", "bool"}
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def load_gen_animations():
    """import 同目录的 gen_animations.py（取它的六原型；它 import 时只读输入、不写产物）。"""
    spec = importlib.util.spec_from_file_location("gen_animations", META / "gen_animations.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 gen_animations.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def existing_template_kps() -> set[str]:
    """既有 8 份模板声明的全部 kp_ids（**现算**，以 templates-premium 的文件名单定位那 8 份）。"""
    kps: set[str] = set()
    for backup in sorted(PREMIUM.glob("*.json")):
        path = OUT / backup.name
        if not path.is_file():  # 目标里不在（还没铺过）→ 用备份副本算，结果一致
            path = backup
        data = json.loads(path.read_text(encoding="utf-8"))
        kps.update(str(kp) for kp in data.get("kp_ids") or [])
    return kps


def validate(template: dict, source_name: str) -> None:
    """生成即校验：把加载器/守卫会拒的形态挡在写盘之前（宁可当场炸，不产出坏模板）。"""
    where = f"{source_name} → {template.get('id')}"

    unknown = set(template) - ALLOWED_KEYS
    assert not unknown, f"{where} 出现未知字段：{sorted(unknown)}"

    template_id = template["id"]
    assert ID_RE.match(template_id), f"{where} id 非法：{template_id!r}"
    assert template["kp_ids"] == [template_id], f"{where} kp_ids 应只含本 kp"
    assert len(template["grade_levels"]) == 1, f"{where} 每份只该声明一个学段"
    assert template["duration_ms"] > 0, f"{where} duration_ms 必须为正"

    for key in ("label", "title", "concept", "body", "script", "fallback_text"):
        assert isinstance(template[key], str) and template[key].strip(), f"{where} 缺 {key}"

    params = template["params"]
    assert isinstance(params, dict) and params, f"{where} params 为空"
    for name, spec in params.items():
        assert spec.get("type") in PARAM_TYPES, f"{where} 参数 {name} 类型非法"
        assert spec.get("default") is not None, f"{where} 参数 {name} 缺 default"

    used = set(PLACEHOLDER_RE.findall(template["body"] + "\n" + template["script"]))
    assert used == set(params), f"{where} 占位符 {sorted(used)} ≠ 参数 {sorted(params)}"

    assert "Sandbox.play(" in template["script"], f"{where} script 没注册播放实现"
    assert len(template["fallback_text"].strip()) >= 30, f"{where} 降级文案太短"

    for key in ("body", "script", "fallback_text", "title", "concept", "label"):
        assert not EXTERNAL_RE.search(template[key]), f"{where} {key} 含外部引用"
    # 卫生守卫的扫描面：title/concept/fallback_text/body —— 生成物不许带三种排版标记
    for key in ("title", "concept", "fallback_text", "body", "label"):
        for mark in MARKS:
            assert mark not in template[key], f"{where} {key} 含「{mark}」"


def main() -> int:
    gen = load_gen_animations()
    skip = existing_template_kps()
    by_kp_files = sorted(BY_KP.glob("*.json"))
    assert by_kp_files, f"没找到 by-kp 文案：{BY_KP}"
    assert len(list(PREMIUM.glob("*.json"))) == 8, "templates-premium 应有 8 份"

    written = 0
    skipped: list[str] = []
    for path in by_kp_files:
        item = json.loads(path.read_text(encoding="utf-8"))
        kp_id = item["kp_id"]
        assert path.stem == kp_id, f"{path.name} 文件名与 kp_id 不一致"
        if kp_id in skip:
            skipped.append(kp_id)
            continue

        archetype = item["archetype"]
        assert archetype in gen.ARCHETYPES, f"{kp_id} 概念原型 {archetype!r} 不在六原型里"
        body_fn, script_tpl, _payload_key = gen.ARCHETYPES[archetype]

        steps = item["steps"]
        assert isinstance(steps, list) and steps, f"{kp_id} 没有 steps"
        steps_json = json.dumps(steps, ensure_ascii=False)
        # ★ 与 gen_animations.build_template() 完全同源的注入两行（别改样式，防两套漂移）
        script = script_tpl.replace("__STAGES__", steps_json).replace("__PAIRS__", steps_json)
        title = item["title"]

        template = {
            "id": kp_id,
            "label": item["concept"],
            "title": title,
            "concept": item["concept"],
            "kp_ids": [kp_id],
            "grade_levels": [item["grade_level"]],
            "duration_ms": item["duration_ms"],
            "params": item["params"],
            "body": body_fn(title),
            "script": script,
            "fallback_text": item["fallback_text"],
        }
        validate(template, path.name)

        target = OUT / f"{kp_id}.json"
        text = json.dumps(template, ensure_ascii=False, indent=2) + "\n"
        target.write_bytes(text.encode("utf-8"))  # 字节写入：保证 LF（Windows 下不翻译换行）
        written += 1

    print(f"written: {written}")
    print(f"skipped (covered by existing 8): {len(skipped)} -> {sorted(skipped)}")
    print(f"by-kp total: {len(by_kp_files)}")
    assert written == len(by_kp_files) - len(skipped)
    if written != 206 or len(skipped) != 22:
        print(f"⚠️ 期望 206/22，实际 {written}/{len(skipped)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
