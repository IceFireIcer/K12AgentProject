#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""导出 OpenAPI schema 到 desktop/src/shared/openapi.json（S02 使用）。

用法：
    uv run python scripts/export_openapi.py
然后由 openapi-typescript 生成 api-types.ts。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "desktop" / "src" / "shared" / "openapi.json"


def main() -> int:
    sys.path.insert(0, str(ROOT))
    from app.main import app  # noqa: E402

    OUT.parent.mkdir(parents=True, exist_ok=True)
    schema = app.openapi()
    OUT.write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[ok] OpenAPI -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
