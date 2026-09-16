#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 FastAPI 的 OpenAPI 导出成 `desktop/src/shared/openapi.json`（**生成物，不手改**）。

用途（执行文档 §6.1 的防漂移链第一段）::

    server/app/contracts.py     ← 唯一手写契约处
      → 本脚本（FastAPI /openapi.json + 补齐 FastAPI 看不到的模型）
      → desktop/src/shared/openapi.json
      → desktop/scripts/gen-api-types.mjs → shared/api-types.ts
      → npm run typecheck 报错 = 契约漂移

用法::

    cd server
    uv run python scripts/export_openapi.py           # 生成 / 覆盖
    uv run python scripts/export_openapi.py --check    # 字节比对，不一致退 1

为什么要「补齐 FastAPI 看不到的模型」
------------------------------------
FastAPI 只会把**路由能到达**的模型写进 `components.schemas`。而本项目的契约里有一批
模型没有 HTTP 路由：§6.5 的 payload（`AnimationPayload` / `CodeEvaluation` / `QuizPayload` …）
由 Pi Extension 产出、经 IPC 送前端，`ChatRequest` 走 IPC，`ProbeResult` 属票 07……
漏掉它们，TS 侧就只剩手写接口（防漂移机制当场作废）。
所以本脚本用 pydantic 的 `models_json_schema()` **增量补**，规则是
**只补不覆盖**：FastAPI 已经生成的 schema 一律原样保留（它才是路由的权威产物）。

三条硬保险
----------
1. **不导出内部模型**：`QuizQuestion`（含 `answer`）绝不出现在生成物里（答案泄漏是硬伤）；
2. **全文件无 `answer` 属性**：任何人把内部题的字段放进对外模型都会被这里挡下；
3. **字节可复现**：paths / schemas 显式排序 + `sort_keys=True` + UTF-8 定长写入，
   同一份 contracts.py 反复导出必须字节相同（否则 `--check` 会误报漂移）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pydantic import BaseModel, TypeAdapter  # noqa: E402
from pydantic.json_schema import models_json_schema  # noqa: E402

from app.config import build_runtime_config  # noqa: E402
from app.contracts import CONTRACT_ENUMS, CONTRACT_MODELS, INTERNAL_MODELS  # noqa: E402
from app.main import create_app  # noqa: E402

#: 生成物路径（desktop 与 server 同级，故上溯一层）
OUTPUT_PATH = ROOT.parent / "desktop" / "src" / "shared" / "openapi.json"

#: 与 OpenAPI 的 `components.schemas` 对齐的引用模板
REF_TEMPLATE = "#/components/schemas/{model}"

#: 内部模型绝不允许出现在生成物里的字段（答案泄漏防护，§6.3）
FORBIDDEN_PROPERTY_NAMES = ("answer",)

#: ★ 允许出现 `answer` 字段的**入参**模型（白名单，必须逐个写理由）。
#:
#: 判分请求里的 `answer` 是**学生提交的作答**，与「标准答案」方向相反 ——
#: 它必须从前端来，否则没法判分。白名单里的模型会被额外断言：
#: **不得被任何 response 引用**（见 `_schemas_referenced_by_responses`），
#: 这样「入参带 answer」不会变成「出参带 answer」的漏洞。
ANSWER_PROPERTY_ALLOWLIST: tuple[str, ...] = ("QuizGradeRequest",)

#: 换行符常量（文件统一 LF；不要在 f-string 里写反斜杠转义）
NEWLINE = b"\n"


# ---------------------------------------------------------------- 生成 --
def build_openapi_document() -> dict[str, Any]:
    """生成 OpenAPI 文档（FastAPI 产物 + 契约模型补齐 + 规范化排序）。

    **纯函数性质**：不写文件、不建目录，供测试与 `--check` 直接复用。
    """
    app = create_app(build_runtime_config())
    document: dict[str, Any] = app.openapi()

    _inject_contract_schemas(document)
    _assert_no_internal_models(document)
    _assert_no_forbidden_properties(document)
    return canonicalize(document)


def canonicalize(document: dict[str, Any]) -> dict[str, Any]:
    """规范化顺序：paths 与 components.schemas（含各 path 的方法）显式排序。

    `json.dumps(sort_keys=True)` 已经能保证字节稳定，这里再显式排一次是**为了让
    内存里的结构也可比**（测试里直接比 dict 时不会因为插入顺序而无谓地不等），
    并且让生成物在代码评审里是「字典序」而不是「路由注册顺序」。
    """
    paths = document.get("paths") or {}
    document["paths"] = {
        path: {method: paths[path][method] for method in sorted(paths[path])}
        for path in sorted(paths)
    }

    components = document.setdefault("components", {})
    schemas = components.get("schemas") or {}
    components["schemas"] = {name: schemas[name] for name in sorted(schemas)}
    return document


def _inject_contract_schemas(document: dict[str, Any]) -> list[str]:
    """把 FastAPI 看不到的契约模型补进 `components.schemas`（**只补不覆盖**）。"""
    schemas: dict[str, Any] = document.setdefault("components", {}).setdefault("schemas", {})
    added: list[str] = []

    missing = [model for model in CONTRACT_MODELS if model.__name__ not in schemas]
    if missing:
        _, definitions = models_json_schema(
            [(model, "validation") for model in missing],
            ref_template=REF_TEMPLATE,
        )
        for name, definition in _iter_definitions(definitions):
            if name in schemas:  # 引用闭包里已由 FastAPI 生成的，**不覆盖**
                continue
            schemas[name] = definition
            added.append(name)

    for name, enum_type in CONTRACT_ENUMS.items():
        if name in schemas:
            continue
        definition = TypeAdapter(enum_type).json_schema(ref_template=REF_TEMPLATE)
        definition["title"] = name
        schemas[name] = definition
        added.append(name)

    return added


def _iter_definitions(definitions: Any) -> list[tuple[str, Any]]:
    """把 `models_json_schema` 的第二个返回值摊平成 ``[(名字, schema), ...]``。

    pydantic 的返回形状换过：2.13 起是 ``{"$defs": {名字: schema}}``，
    更早的版本是 ``{(mode, 模型类): schema}``。这里两种都认，避免升级小版本就炸。
    """
    if isinstance(definitions, dict) and "$defs" in definitions:
        return list(definitions["$defs"].items())

    flattened: list[tuple[str, Any]] = []
    for key, value in definitions.items():
        name = key[-1] if isinstance(key, tuple) else key
        if isinstance(name, type) and issubclass(name, BaseModel):
            name = name.__name__
        flattened.append((str(name), value))
    return flattened


# ---------------------------------------------------------------- 保险 --
def _assert_no_internal_models(document: dict[str, Any]) -> None:
    """★ 内部模型（`QuizQuestion`，含标准答案）绝不允许进入生成物。

    一旦有人把内部题模型接到路由上（FastAPI 会自动生成它的 schema），这里直接报错 ——
    宁可导出失败，也不要把「带答案的类型」送到前端。
    """
    schemas = document.get("components", {}).get("schemas", {})
    leaked = sorted(model.__name__ for model in INTERNAL_MODELS if model.__name__ in schemas)
    if leaked:
        raise SystemExit(
            "拒绝导出：内部模型出现在 OpenAPI 里 —— "
            f"{', '.join(leaked)}（含标准答案，见 contracts.py 的 §6.3 答案泄漏防护）。\n"
            "请检查是否有路由直接使用了内部模型；对外一律用 *Out 形态。"
        )


def _assert_no_forbidden_properties(document: dict[str, Any]) -> None:
    """★ 答案泄漏防护：全文件扫描 + 白名单方向校验。

    两条断言：
    ① 白名单外的 schema，其 ``properties`` 里不许出现 `answer`；
    ② 白名单内的「入参」schema **不得出现在任何 response 里** ——
       判分请求带着学生作答是必须的，但它绝不能顺路变成某个出参的类型。
    """
    response_schemas = _schemas_referenced_by_responses(document)
    hits: list[str] = []

    def walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            properties = node.get("properties")
            if isinstance(properties, dict):
                for forbidden in FORBIDDEN_PROPERTY_NAMES:
                    if forbidden in properties:
                        hits.append(f"{path}.properties.{forbidden}")
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(document, "$")

    allowed = {f"$.components.schemas.{name}.properties.answer" for name in ANSWER_PROPERTY_ALLOWLIST}
    violations = [hit for hit in hits if hit not in allowed]
    if violations:
        raise SystemExit(
            "拒绝导出：生成物里出现答案字段（答案泄漏防护）——\n  "
            + "\n  ".join(violations)
            + "\n判分所需的标准答案只留在 Python 侧（§6.3）。"
        )

    returning_inputs = sorted(name for name in ANSWER_PROPERTY_ALLOWLIST if name in response_schemas)
    if returning_inputs:
        raise SystemExit(
            "拒绝导出：带 answer 的入参模型被 response 引用了 ——\n  "
            + "\n  ".join(returning_inputs)
            + "\n学生提交的作答只在请求方向流动；出参一侧永远不带 answer（§6.3）。"
        )


def _schemas_referenced_by_responses(document: dict[str, Any]) -> set[str]:
    """收集所有被 `responses` 引用到的组件 schema 名（含 `$ref` 闭包不需要 —— 只看直接引用）。"""
    names: set[str] = set()

    def collect(node: Any) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                names.add(ref.rsplit("/", 1)[-1])
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)

    for path_item in (document.get("paths") or {}).values():
        if not isinstance(path_item, dict):
            continue
        for operation in path_item.values():
            if isinstance(operation, dict):
                collect(operation.get("responses") or {})
    return names


# ---------------------------------------------------------------- 渲染 --
def render(document: dict[str, Any]) -> str:
    """渲染成**稳定**文本：UTF-8、LF、两空格缩进、键全排序。"""
    return json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def _first_difference(expected: bytes, actual: bytes) -> str:
    """定位第一处字节差异（给可读的排查线索，别只吐一个「不一致」）。"""
    limit = min(len(expected), len(actual))
    offset = next((i for i in range(limit) if expected[i] != actual[i]), limit)

    line_no = expected[:offset].count(b"\n") + 1

    def line_at(blob: bytes, number: int) -> str:
        lines = blob.split(b"\n")
        if number - 1 >= len(lines):
            return "<文件已结束>"
        return lines[number - 1].decode("utf-8", errors="replace")[:160]

    return (
        f"首个差异在第 {line_no} 行（字节偏移 {offset}）：\n"
        f"  期望（当前 contracts.py 产出）：{line_at(expected, line_no)}\n"
        f"  实际（磁盘上的生成物）：      {line_at(actual, line_no)}\n"
        f"  行数：期望 {expected.count(NEWLINE)} / 实际 {actual.count(NEWLINE)}"
    )


# ---------------------------------------------------------------- 入口 --
def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="export_openapi.py",
        description="导出 OpenAPI → desktop/src/shared/openapi.json（--check 做字节比对）",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="只校验：磁盘上的生成物与当前 contracts.py 是否逐字节一致（不一致退 1）",
    )
    args = parser.parse_args(argv)

    try:
        document = build_openapi_document()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - 入口脚本：任何异常都要变成可读的退出码
        print(f"[export_openapi] 生成失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    rendered = render(document)
    expected = rendered.encode("utf-8")

    if args.check:
        if not OUTPUT_PATH.exists():
            print(
                f"[export_openapi] ✗ 生成物不存在：{OUTPUT_PATH}\n"
                f"  请先跑：cd server && uv run python scripts/export_openapi.py",
                file=sys.stderr,
            )
            return 1

        actual = OUTPUT_PATH.read_bytes()
        if actual == expected:
            schema_count = len(document.get("components", {}).get("schemas", {}))
            print(
                f"[export_openapi] ✓ 契约无漂移：{OUTPUT_PATH.name} 与 contracts.py 逐字节一致"
                f"（{len(document.get('paths', {}))} 条路径 / {schema_count} 个 schema）"
            )
            return 0

        print(
            "[export_openapi] ✗ 契约漂移：生成物与 contracts.py 不一致。\n"
            f"  {_first_difference(expected, actual)}\n"
            "  修复：cd server && uv run python scripts/export_openapi.py"
            " → cd desktop && npm run gen:api",
            file=sys.stderr,
        )
        return 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # write_bytes + LF：避免 Windows 把 \n 翻成 \r\n，那样 --check 永远不绿
    OUTPUT_PATH.write_bytes(expected)
    print(
        f"[export_openapi] ✓ 已写出 {OUTPUT_PATH}"
        f"（{len(document.get('paths', {}))} 条路径 / "
        f"{len(document.get('components', {}).get('schemas', {}))} 个 schema / {len(expected)} 字节）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
