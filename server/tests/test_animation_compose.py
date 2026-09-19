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
from app.routes import resources as R  # noqa: E402
from app.routes.resources import (  # noqa: E402
    INLINE_LIBRARY_MARKER,
    INLINE_RUNTIME_MARKER,
    PLAY_MARKER,
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
        "kpId": "prog-loop-jr",
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
        """脚本里没有 ``Sandbox.play`` → 422（片段预检就拦下，附可读中文原因）。

        修复前这里的期望是「整份校验抓住『模板脚本段是空的』」—— 那条判据**抓不住**
        「有 ready、无 play」这种更隐蔽的坏片段（见下面那组回归用例）。
        """
        status, payload = self._compose(good_body(script="var unused = 1;"))
        self.assertEqual(status, 422)
        detail = str(payload.get("detail"))
        self.assertTrue("播放实现" in detail or "未通过校验" in detail, detail)

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
# ★★ 回归：漏写 Sandbox.play 的片段不得通过（校验器只看标记，读不出「有没有调 play」）
# --------------------------------------------------------------------------- #
class TestMissingPlayIsRejected(ComposeCase):
    """★★ 回归用例（审计发现，修复前**必红**）：校验器只认标记串，漏写 ``Sandbox.play()`` 的片段
    会**一路通过到沙箱里白屏**。

    缺陷形态：``validate_animation_html`` 检查的是 ``INLINE_LIBRARY_MARKER`` /
    ``INLINE_RUNTIME_MARKER`` / ``READY_MARKER`` / ``PAYLOAD_ID_MARKER`` 四个**标记串**，
    而 ``Sandbox.ready(`` 在**注入的 runtime.js 里本来就存在** —— 所以「片段自己有没有调 play」
    从来没被判断过。实测（修复前）：构造「有 ready、无 play」的片段 → 预检问题 ``[]``、
    整份校验 ``ok = True``。

    后果：模型漏写 play 时产物通过全部校验 → 卡片建 iframe → 收到 ready →
    播放指令到达时 ``playImpl`` 为 null → 学生看到一张**永远静止**的动画卡，
    而不是「文字 + 静态图」的降级 ——「校验 + 重试 ≤3 → 降级」这条硬链路被绕过。
    """

    #: 有 ready 上报、有合法页面片段，**唯独没有** Sandbox.play 注册播放实现
    PLAY_LESS_SCRIPT = "var caption = document.getElementById('caption');Sandbox.ready({});"

    def test_ready_without_play_is_rejected_with_readable_reason(self) -> None:
        status, payload = self._compose(good_body(script=self.PLAY_LESS_SCRIPT))
        self.assertEqual(status, 422, "有 ready 无 play 的片段竟然通过了")
        detail = str(payload.get("detail"))
        self.assertIn("播放实现", detail, "拒因必须是可读中文，生成器才能带着它重试")
        self.assertIn("Sandbox.play(", detail)

    def test_full_html_validator_alone_would_pass_it(self) -> None:
        """★ 反向证据：**只看整份 HTML 的四个标记串**会放行这种坏产物（缺陷的根因）。

        逐字说明「为什么必须新增一条脚本段断言」：``Sandbox.ready(`` 是内联运行时自带的，
        光靠它证明不了脚本注册了播放实现。这里拿一份**合格产物**、只把 ``Sandbox.play(``
        抹掉，然后断言四个旧标记一个都没少 —— 这就是「只查标记」抓不住坏片段的原因。
        """
        _, payload = self._compose(good_body())
        bad = payload["html"].replace(PLAY_MARKER, "Sandbox.nothing(")
        for marker in (
            INLINE_LIBRARY_MARKER,
            INLINE_RUNTIME_MARKER,
            READY_MARKER,
            R.PAYLOAD_ID_MARKER,
        ):
            self.assertIn(marker, bad, f"构造坏产物时误删了旧标记「{marker}」")

        verdict = validate_animation_html(bad)
        self.assertFalse(verdict.ok, "抹掉 Sandbox.play 的产物必须被判不合格")
        self.assertTrue(
            any("播放实现" in problem for problem in verdict.problems),
            f"拒因里应当点名缺少播放实现：{verdict.problems}",
        )

    def test_play_marker_in_body_does_not_count(self) -> None:
        """``Sandbox.play(`` 必须出现在**脚本**里；页面片段里写一行同名字符串不算数。"""
        status, _ = self._compose(
            good_body(
                body='<p class="anim-caption">Sandbox.play( 只是显示文字</p>',
                script=self.PLAY_LESS_SCRIPT,
            )
        )
        self.assertEqual(status, 422)

    def test_valid_script_with_play_still_passes(self) -> None:
        """反向：正常带 play 的片段不受影响（收紧不许误伤模板路径）。"""
        status, payload = self._compose(good_body())
        self.assertEqual(status, 200, payload)


class TestPayloadIdFallback(ComposeCase):
    """★★ 回归用例（审计发现）：``payload_id`` 缺省时曾回落成固定串 ``"generated"``。

    实测（修复前）：产物里注入的是 ``window.__K12_PAYLOAD_ID__ = "generated"`` ——
    **同一个固定串被所有自由生成卡片共用**，直接违反
    「``payload_id`` 防多卡片串台」这条硬约束（后开的卡片会把先开那张的消息一起驱动）。

    修法：缺省时生成**随机 id**，字符集与长度符合 ``validate_payload_id`` 的约束。
    """

    def _injected_ids(self, count: int = 5) -> list[str]:
        import re

        ids: list[str] = []
        for index in range(count):
            status, payload = self._compose(good_body(payloadId="", concept=f"循环{index}"))
            self.assertEqual(status, 200, payload)
            found = re.search(r'window\.__K12_PAYLOAD_ID__\s*=\s*"([^"]*)"', payload["html"])
            self.assertIsNotNone(found, "产物里没有注入 payload_id")
            assert found is not None
            ids.append(found.group(1))
        return ids

    def test_missing_payload_id_gets_a_random_one(self) -> None:
        ids = self._injected_ids()
        self.assertNotIn("generated", ids, "不许再回落成固定串")
        self.assertEqual(len(set(ids)), len(ids), f"多张卡片的 payload_id 必须互不相同：{ids}")

    def test_generated_id_matches_the_payload_id_whitelist(self) -> None:
        """随机 id 必须能过 ``validate_payload_id``（它会被拼进文件名与 URL query）。"""
        import re

        from app.routes.resources import validate_payload_id

        for value in self._injected_ids(3):
            with self.subTest(value=value):
                self.assertRegex(value, r"^[A-Za-z0-9_-]{1,64}$")
                self.assertEqual(validate_payload_id(value), value)

    def test_supplied_payload_id_is_used_verbatim(self) -> None:
        """TS 侧真的传来了 payloadId 时必须原样使用（跨代理接口：代理 F 正在接线）。"""
        _, payload = self._compose(good_body(payloadId="card-abc-123"))
        self.assertIn('"card-abc-123"', payload["html"])

    def test_invalid_supplied_payload_id_is_rejected(self) -> None:
        status, _ = self._compose(good_body(payloadId="坏 id/../x"))
        self.assertEqual(status, 422)

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
