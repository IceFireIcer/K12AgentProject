# -*- coding: utf-8 -*-
"""把 57 概念模板 × by-kp 分学段文案展开成「一 KP 一模板」（206 份）。

背景（2026-09-22 用户裁决）：包内 57 份概念模板的 ``kp_ids`` 盖四个学段，但
``title`` / ``fallback_text`` / 注入进 ``script`` 的相位数据**只按初中写**
（57 份 fallback_text 全部以「（初中讲法）」开头）。直接导入会让小学/高中学生看到
初中文案 —— 所以要按 ``by-kp/<kp_id>.json``（分学段文案真源）一 KP 一份展开，
文案与**原型**都逐学段取真源（同一个概念在小学是场景推进、在高中可能是轨迹曲线）。

★ 注入逻辑**复用 gen_animations.py，不另写一套**（两套写法必然漂移）：

  本脚本 import gen_animations，取它的 ``ARCHETYPES``（十四原型，每项含
  ``core`` 脚本正文、``pace`` 参数名、``phases`` 相位数声明），然后按
  ``gen_animations.build_by_kp()`` 的**同款三步**重放注入：

      body   = body_html(title, hint, aria, chip)
      script = script_for(archetype, pace, phases_expr).replace("__DATA__", data_json)

  只是 ``data`` 换成 by-kp 里该学段那一份（by-kp 里存的就是**成品** body / script，
  这里再算一遍是为了「by-kp 文件被手改坏」时当场发现，而不是把坏数据铺进产品目录）。

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
#: 省略号：节点文案**永不截断**是本票的产品口径，产物里一个都不许留。
ELLIPSIS = ("…", "...")
PARAM_TYPES = {"int", "float", "str", "bool"}
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def load_gen_animations():
    """import 同目录的 gen_animations.py（取它的十四原型；它 import 时只读输入、不写产物）。"""
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
    assert "Sandbox.timeline(" in template["script"], f"{where} script 没走分相位时间线"
    assert len(template["fallback_text"].strip()) >= 30, f"{where} 降级文案太短"

    for key in ("body", "script", "fallback_text", "title", "concept", "label"):
        assert not EXTERNAL_RE.search(template[key]), f"{where} {key} 含外部引用"
        for mark in MARKS:
            assert mark not in template[key], f"{where} {key} 含「{mark}」"
        for mark in ELLIPSIS:
            assert mark not in template[key], f"{where} {key} 含省略号「{mark}」"
    # 颜色只走类名与变量：写死色值 = 学段皮肤当场失效。
    assert not re.search(r"#[0-9a-fA-F]{3,8}\b|rgba?\(", template["body"] + template["script"]), (
        f"{where} 出现裸色值（颜色只许走 CSS 类与变量）"
    )


def main() -> int:
    gen = load_gen_animations()
    skip = existing_template_kps()
    by_kp_files = sorted(BY_KP.glob("*.json"))
    assert by_kp_files, f"没找到 by-kp 文案：{BY_KP}"
    assert len(list(PREMIUM.glob("*.json"))) == 8, "templates-premium 应有 8 份"

    written = 0
    skipped: list[str] = []
    mix: dict[str, int] = {}
    for path in by_kp_files:
        item = json.loads(path.read_text(encoding="utf-8"))
        kp_id = item["kp_id"]
        assert path.stem == kp_id, f"{path.name} 文件名与 kp_id 不一致"
        if kp_id in skip:
            skipped.append(kp_id)
            continue

        archetype = item["archetype"]
        assert archetype in gen.ARCHETYPES, f"{kp_id} 原型 {archetype!r} 不在十四原型里"
        spec = gen.ARCHETYPES[archetype]
        # 皮肤取自**学段**（小学 illustrated / 中学 technical），原型只是叙事骨架：
        # 允许「小学高年级用工程系原型」这种交叉（228 里有 2 例，是有意的过渡设计，
        # 基元本身在两种皮肤下都成立 —— STAGE-API §3.5）。这里只记录，不当错误。
        assert item["skin"] == gen.GRADE_SKIN[item["grade_level"]], f"{kp_id} 的 skin 与学段对不上"

        # ★ 与 gen_animations.build_by_kp() 完全同源的三步（别改样式，防两套漂移）
        #   最后一个参数是**本份模板实际会拿到的皮肤**（学段决定），不是原型的天然皮肤：
        #   头注释里的 skin= 要能与截图复盘对上（小学高年级拿到工程系原型时两者不同）。
        title = item["title"]
        body = gen.body_html(title, spec["hint"], spec["aria"], spec["chip"])
        script = gen.script_for(
            archetype,
            spec["pace"],
            gen.phases_expr(archetype),
            gen.GRADE_SKIN[item["grade_level"]],
            item["data"],
        ).replace("__DATA__", json.dumps(item["data"], ensure_ascii=False))
        # by-kp 里存了成品；成品与现算必须一致（手改坏 by-kp 时当场发现）
        assert body == item["body"], f"{kp_id} by-kp 的 body 与现算不一致（by-kp 被手改了？）"
        assert script == item["script"], f"{kp_id} by-kp 的 script 与现算不一致（by-kp 被手改了？）"

        template = {
            "id": kp_id,
            "label": item["concept"],
            "title": title,
            "concept": item["concept"],
            "kp_ids": [kp_id],
            "grade_levels": [item["grade_level"]],
            "duration_ms": item["duration_ms"],
            "params": item["params"],
            "body": body,
            "script": script,
            "fallback_text": item["fallback_text"],
        }
        validate(template, path.name)

        target = OUT / f"{kp_id}.json"
        text = json.dumps(template, ensure_ascii=False, indent=2) + "\n"
        target.write_bytes(text.encode("utf-8"))  # 字节写入：保证 LF（Windows 下不翻译换行）
        written += 1
        mix[archetype] = mix.get(archetype, 0) + 1

    print(f"written: {written}")
    print(f"skipped (covered by existing 8): {len(skipped)} -> {sorted(skipped)}")
    print(f"by-kp total: {len(by_kp_files)}")
    print(f"archetype mix: {json.dumps(mix, ensure_ascii=False, sort_keys=True)}")
    assert written == len(by_kp_files) - len(skipped)
    if written != 206 or len(skipped) != 22:
        print(f"⚠️ 期望 206/22，实际 {written}/{len(skipped)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
