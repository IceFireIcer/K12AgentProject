# -*- coding: utf-8 -*-
"""动画**自由生成**的合流端点（票 17 的补充路径）：``app/animation/compose.py``。

审计结论：`animation.ts` 的 `generate` 此前**没接**，模板未命中直接降级 —— 文档 §11.2
与票 17 写的「自由生成是模板未命中时的补充路径」在生产里不可达。服务端这一半点名了那条路
**必须与模板路径共用同一套拼装与校验**（否则补充路径会变成「更松的第二套标准」）。

四条断言：

1. ★ **合格片段 → 完整载荷**：库与运行时被内联、``payload_id`` 注入、``source="generated"``；
2. ★ **判据与模板路径一字不差**：同一份 HTML 走 ``validate_animation_html()``，不合格 → 422
   （可读原因，生成器带着它重试）；
3. ★ **片段级预检给出具体原因**：外部引用 / 网络请求 / 宿主访问 / 顶层 throw 都在拼装前拦下
   （整份 HTML 的校验失败时，原因笼统得多，对「重试」没有指导价值）；
4. **降级素材非空**：``fallback_text`` 与静态 SVG 兜底图都在（动画失败时不能空手回）。

跑法::

    cd server && uv run python -m unittest discover -s tests
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.animation.compose import router as compose_router  # noqa: E402
from app.routes.resources import (  # noqa: E402
    INLINE_LIBRARY_MARKER,
    INLINE_RUNTIME_MARKER,
    READY_MARKER,
    validate_animation_html,
)

def build_client() -> TestClient:
    app = FastAPI()
    app.include_router(compose_router)
    return TestClient(app)

def good_body(**overrides: object) -> dict:
    """一份**合格**的片段（模型产出形态：不含库、运行时、payload_id）。"""
    payload = {
        "concept": "循环",
        "kpId": "jr-py-loop",
        "gradeLevel": "junior",
        "payloadId": "evidence123",
        "title": "循环：重复做同一件事",
        "body": (
            '<h1 class="anim-title">循环</h1>'
            '<p class="anim-caption" id="caption">开始</p>'
            '<div class="anim-canvas"><svg viewBox="0 0 100 100" width="100%" height="100%">'
            '<g id="dots"></g></svg></div>'
        ),
        "script": (
            "var dots = document.getElementById('dots');"
            "var caption = document.getElementById('caption');"
            "Sandbox.play(function () {"
            "  caption.textContent = '正在重复';"
            "  return anime({ targets: dots, opacity: [0, 1], duration: 800, loop: true });"
            "});"
            "Sandbox.ready({});"
        ),
        "fallbackText": "循环就是让同一段代码重复执行很多次。",
        "durationMs": 5000,
    }
    payload.update(overrides)
    return payload

class ComposeCase(unittest.TestCase):
    def setUp(self) -> None:
        self.client = build_client()

    def _compose(self, body: dict) -> tuple[int, dict]:
        response = self.client.post("/api/animation/compose", json=body)
        try:
            return response.status_code, response.json()
        except Exception:  # noqa: BLE001 - 非 JSON 回执时把原文交给断言
            return response.status_code, {"raw": response.text}

# --------------------------------------------------------------------------- #
# 1. 合格片段 → 完整载荷
# --------------------------------------------------------------------------- #
class TestSuccessfulCompose(ComposeCase):
    def test_returns_a_complete_generated_payload(self) -> None:
        status, payload = self._compose(good_body())
        self.assertEqual(status, 200, payload)

        self.assertEqual(payload["source"], "generated", "自由生成的产物必须标成 generated")
        self.assertEqual(payload["concept"], "循环")
        self.assertEqual(payload["durationMs"], 5000)
        self.assertTrue(payload["fallbackText"].strip(), "降级文案必须非空")
        self.assertTrue(
            str(payload["fallbackImage"]).startswith("data:image/svg+xml"),
            "静态兜底图必须是自包含的 SVG dataURL",
        )

    def test_html_is_self_contained(self) -> None:
        """★ 库与运行时都被内联、payload_id 被注入 —— 这正是「只有 Python 做得到」的那部分。"""
        _, payload = self._compose(good_body())
        html = payload["html"]
        self.assertIn("<!DOCTYPE html>", html)
        self.assertIn(INLINE_LIBRARY_MARKER, html, "动画库必须内联（断网演示的底线）")
        self.assertIn(INLINE_RUNTIME_MARKER, html, "沙箱运行时必须内联")
        self.assertIn(READY_MARKER, html, "没有 ready 上报，宿主会一直等到超时")
        self.assertIn("evidence123", html, "payload_id 必须注入（串台防线）")
        self.assertNotIn("http://", html.replace("http://www.w3.org", ""), "不许有外部引用")

    def test_output_passes_the_template_path_validator(self) -> None:
        """★ 判据与模板路径一字不差：产物必须过**同一个**校验器。"""
        _, payload = self._compose(good_body())
        validation = validate_animation_html(payload["html"])
        self.assertTrue(validation.ok, f"合流产物没过模板路径的校验器：{validation.reason}")

    def test_title_defaults_to_concept(self) -> None:
        _, payload = self._compose(good_body(title="", concept="变量"))
        self.assertTrue(payload["fallbackImage"], "缺 title 时用 concept 兜底生成静态图")

# --------------------------------------------------------------------------- #
# 2. 不合格 → 422（可重试），且判据覆盖模板路径的全部规则
# --------------------------------------------------------------------------- #
class TestRejections(ComposeCase):
    def test_external_reference_is_rejected(self) -> None:
        status, payload = self._compose(
            good_body(body='<p>看这个 <a href="https://cdn.example.com/x.js">链接</a></p>')
        )
        self.assertEqual(status, 422)
        self.assertIn("外部引用", str(payload.get("detail")), "必须给出可读原因（生成器据此重试）")

    def test_network_request_in_script_is_rejected(self) -> None:
        status, payload = self._compose(
            good_body(script="fetch('/api/x').then(function () {}); Sandbox.play(function () {});")
        )
        self.assertEqual(status, 422)
        self.assertIn("远程加载", str(payload.get("detail")))

    def test_host_document_access_is_rejected(self) -> None:
        status, payload = self._compose(
            good_body(script="var x = parent.document.body; Sandbox.play(function () {});")
        )
        self.assertEqual(status, 422)
        self.assertIn("宿主文档访问", str(payload.get("detail")))

    def test_top_level_throw_is_rejected(self) -> None:
        status, payload = self._compose(
            good_body(script="throw new Error('boom'); Sandbox.play(function () {});")
        )
        self.assertEqual(status, 422)
        self.assertIn("顶层 throw", str(payload.get("detail")))

    def test_full_document_tags_are_rejected(self) -> None:
        """片段不该自带文档骨架（骨架由 ``compose_animation_html`` 拼）。"""
        status, payload = self._compose(good_body(body="<html><body><p>x</p></body></html>"))
        self.assertEqual(status, 422)
        self.assertIn("完整文档标签", str(payload.get("detail")))

    def test_script_tags_are_rejected(self) -> None:
        status, _ = self._compose(good_body(script="<script>Sandbox.ready({});</script>"))
        self.assertEqual(status, 422, "片段里带 script 标签会被拼出嵌套脚本（结构坏了）")

    def test_producing_no_playable_implementation_is_rejected(self) -> None:
        """脚本里没有 ``Sandbox.play`` → 整份校验抓住「模板脚本段是空的」。"""
        status, payload = self._compose(good_body(script="var unused = 1;"))
        self.assertEqual(status, 422)
        self.assertIn("未通过校验", str(payload.get("detail")))

    def test_empty_fallback_text_is_rejected_at_the_contract_layer(self) -> None:
        status, _ = self._compose(good_body(fallbackText=""))
        self.assertEqual(status, 422, "降级文案为空 → 动画失败时无话可说，直接在契约层挡下")

    def test_zero_duration_is_rejected(self) -> None:
        status, _ = self._compose(good_body(durationMs=0))
        self.assertEqual(status, 422)

    def test_extra_field_is_rejected(self) -> None:
        body = good_body()
        body["随便加的"] = 1
        status, _ = self._compose(body)
        self.assertEqual(status, 422, "extra=forbid：临时加松散字段当场挡下")

# --------------------------------------------------------------------------- #
# 3. 路由元数据
# --------------------------------------------------------------------------- #
class TestRouterShape(unittest.TestCase):
    def test_route_is_excluded_from_openapi(self) -> None:
        """内部管道不进生成物 → ``npm run check:api`` 的字节比对防线不受影响。"""
        app = FastAPI()
        app.include_router(compose_router)
        self.assertNotIn("/api/animation/compose", app.openapi().get("paths", {}))

    def test_path(self) -> None:
        self.assertEqual([r.path for r in compose_router.routes], ["/api/animation/compose"])
