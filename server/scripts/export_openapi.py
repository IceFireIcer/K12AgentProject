#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导出 OpenAPI schema → `desktop/src/shared/openapi.json`。

（契约防漂移链路的第一段，见 `项目执行文档.md` 第 6.1 节）

链路：
    server/app/models.py（唯一手写处）
      → 本脚本导出 openapi.json
      → `desktop/scripts/gen-api-types.mjs`（openapi-typescript）生成 api-types.ts
      → `npm run typecheck` 报错即代表契约漂移

**不要手改 openapi.json 与 api-types.ts**。

用法：
    cd server
    uv run python scripts/export_openapi.py
    uv run python scripts/export_openapi.py --check   # 只校验是否与磁盘一致（CI/自检用）
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "desktop" / "src" / "shared" / "openapi.json"


def build_schema() -> dict:
    """导出完整契约 schema。

    ⚠️ **关键点**：FastAPI 只会把「路由可达」的模型放进 `components.schemas`。
    而 SSE 的 `payload` / `citation` 事件载荷（`QuizPayload`、`AnimationPayload`、
    `Citation`…）不走 `response_model`，天然不在 schema 里 → 前端拿不到类型 →
    只能手写 → 契约漂移。

    所以这里把 `models.CONTRACT_MODELS` 里**尚未出现**的模型用 pydantic 的
    `models_json_schema()` 补进 components。已有条目以 FastAPI 生成为准
    （那才是真正用于运行期校验的 schema），只增量补齐、不覆盖。
    """
    sys.path.insert(0, str(ROOT))
    from pydantic import BaseModel, TypeAdapter  # noqa: E402
    from pydantic.json_schema import models_json_schema  # noqa: E402

    from app.main import app  # noqa: E402
    from app.models import CONTRACT_MODELS  # noqa: E402

    schema = app.openapi()
    components = schema.setdefault("components", {}).setdefault("schemas", {})

    # 路径按字典序输出：保证多次导出**字节一致**，否则 `--check` 会因顺序抖动误报漂移
    schema["paths"] = {k: schema["paths"][k] for k in sorted(schema["paths"])}

    # 枚举（GradeLevel / Intent / AnswerKind）不是 BaseModel，走 TypeAdapter 单独生成；
    # models_json_schema() 只接受 BaseModel，混进去会 AttributeError。
    models = [m for m in CONTRACT_MODELS if isinstance(m, type) and issubclass(m, BaseModel)]
    enums = [m for m in CONTRACT_MODELS if m not in models]

    # 注意两处 API 形状不同：
    # - `models_json_schema()` 把定义收在顶层 `$defs` 里（按模型名索引）；
    # - `TypeAdapter(...).json_schema()` 直接返回**该类型自己的** schema（无 `$defs` 包装），
    #   所以枚举要用类名手动登记。
    definitions: dict[str, dict] = dict(
        models_json_schema(
            [(model, "validation") for model in models],
            ref_template="#/components/schemas/{model}",
        )[1].get("$defs", {})
    )
    for enum_cls in enums:
        definitions[enum_cls.__name__] = TypeAdapter(enum_cls).json_schema()

    added: list[str] = []
    for name, definition in definitions.items():
        if name not in components:
            components[name] = definition
            added.append(name)

    missing = [m.__name__ for m in CONTRACT_MODELS if m.__name__ not in components]
    if missing:
        raise SystemExit(f"[fail] 以下契约模型未能进入 schema：{missing}")

    # components 同样按名排序（引用是按名解析的，顺序不影响语义），
    # 目的同样是让导出结果**字节稳定**。
    schema["components"]["schemas"] = {
        k: components[k] for k in sorted(components)
    }

    if added:
        print(f"[info] 补入非路由可达模型 {len(added)} 个：{', '.join(sorted(added))}")
    return schema


def main() -> int:
    parser = argparse.ArgumentParser(description="导出 OpenAPI schema")
    parser.add_argument(
        "--check",
        action="store_true",
        help="不写文件，只检查磁盘上的 openapi.json 是否与当前代码一致（不一致退出码 1）",
    )
    args = parser.parse_args()

    schema = build_schema()
    text = json.dumps(schema, ensure_ascii=False, indent=2) + "\n"

    if args.check:
        if not OUT.exists():
            print(f"[fail] {OUT} 不存在，请先运行不带 --check 的导出", file=sys.stderr)
            return 1
        if OUT.read_text(encoding="utf-8") != text:
            print("[fail] openapi.json 与后端契约不一致（契约漂移！）", file=sys.stderr)
            print("       修复：uv run python scripts/export_openapi.py", file=sys.stderr)
            return 1
        print("[ok] openapi.json 与后端契约一致")
        return 0

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8")

    paths = len(schema.get("paths", {}))
    schemas = len(schema.get("components", {}).get("schemas", {}))
    print(f"[ok] OpenAPI -> {OUT}")
    print(f"     路径 {paths} 个 / 数据模型 {schemas} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
