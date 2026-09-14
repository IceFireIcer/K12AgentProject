"""后端契约与管道自检（`uv run python -m unittest discover -s tests`）。

覆盖 S02 的三件"错了会很难查"的事：
1. 凭据永不从 API 响应 / 日志里漏出明文（含第三方库日志路径）；
2. `config.json` 往返 + 空值/掩码语义（防"点保存清空 key"）；
3. SSE 分帧严格符合契约（事件名、camelCase、中文单行、6 种事件齐全）。
"""

from __future__ import annotations

import io
import json
import logging
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.api.chat import build_echo_events  # noqa: E402
from app.models import (  # noqa: E402
    CONTRACT_MODELS,
    SSE_DATA_MODELS,
    SSE_EVENT_NAMES,
    ChatRequest,
    GradeLevel,
    LlmConfig,
    SettingsUpdateRequest,
    mask_secret,
)
from app.redact import SecretRedactingFilter, redact_text  # noqa: E402
from app.settings import SettingsStore, looks_masked  # noqa: E402
from app.sse import format_sse  # noqa: E402

FAKE_KEY = "sk-abcdefghijklmnop1234567890"


# --------------------------------------------------------------------------- #
# 契约基础
# --------------------------------------------------------------------------- #


class TestContractModels(unittest.TestCase):
    def test_camel_alias_on_dump(self) -> None:
        cfg = LlmConfig(
            provider_name="DeepSeek", base_url="https://api.deepseek.com/v1", model_id="deepseek-chat"
        )
        dumped = cfg.model_dump(by_alias=True)
        self.assertEqual(
            set(dumped), {"providerName", "baseUrl", "apiKey", "modelId"}, "出参必须是 camelCase"
        )

    def test_accepts_both_camel_and_snake_input(self) -> None:
        camel = LlmConfig.model_validate(
            {"providerName": "P", "baseUrl": "https://a.com", "modelId": "m", "apiKey": "k"}
        )
        snake = LlmConfig.model_validate(
            {"provider_name": "P", "base_url": "https://a.com", "model_id": "m", "api_key": "k"}
        )
        self.assertEqual(camel, snake)

    def test_extra_field_rejected(self) -> None:
        """防契约漂移的第一道闸门：多传字段立刻 422，而不是被静默忽略。"""
        with self.assertRaises(Exception):
            LlmConfig.model_validate(
                {
                    "providerName": "P",
                    "baseUrl": "https://a.com",
                    "modelId": "m",
                    "apiKey": "k",
                    "surprise": 1,
                }
            )

    def test_base_url_must_be_http_and_trailing_slash_trimmed(self) -> None:
        cfg = LlmConfig(base_url="https://api.deepseek.com/v1/")
        self.assertEqual(cfg.base_url, "https://api.deepseek.com/v1")
        with self.assertRaises(Exception):
            LlmConfig(base_url="api.deepseek.com")

    def test_api_key_hidden_from_repr(self) -> None:
        cfg = LlmConfig(api_key=FAKE_KEY)
        self.assertNotIn(FAKE_KEY, repr(cfg), "api_key 不得出现在 repr 中")

    def test_six_sse_events_are_frozen(self) -> None:
        self.assertEqual(
            SSE_EVENT_NAMES, ("delta", "citation", "payload", "blocked", "done", "error")
        )
        self.assertEqual(set(SSE_DATA_MODELS), set(SSE_EVENT_NAMES))

    def test_student_code_whitespace_preserved(self) -> None:
        """全局 strip 会静默改坏学生代码——这条测试就是防止有人"顺手"加回来。"""
        code = "  def f():\n    return 1\n"
        req = ChatRequest.model_validate(
            {"studentId": "s1", "grade": "junior", "message": "看我的代码"}
        )
        self.assertEqual(req.grade, GradeLevel.JUNIOR)
        from app.models import CodeRunRequest

        self.assertEqual(CodeRunRequest(studentId="s1", kpId="kp", code=code).code, code)


class TestMasking(unittest.TestCase):
    def test_mask_keeps_only_tail(self) -> None:
        masked = mask_secret(FAKE_KEY)
        self.assertTrue(masked.endswith(FAKE_KEY[-4:]))
        self.assertNotIn(FAKE_KEY[:-4], masked.replace("…", ""))

    def test_mask_empty(self) -> None:
        self.assertEqual(mask_secret(""), "")
        self.assertEqual(mask_secret(None), "")

    def test_looks_masked(self) -> None:
        self.assertTrue(looks_masked(mask_secret(FAKE_KEY)))
        self.assertFalse(looks_masked(FAKE_KEY))
        self.assertFalse(looks_masked(""))


# --------------------------------------------------------------------------- #
# 脱敏（日志防线）
# --------------------------------------------------------------------------- #


class TestRedaction(unittest.TestCase):
    def test_redact_key_value_forms(self) -> None:
        cases = [
            f"api_key={FAKE_KEY}",
            f'"apiKey": "{FAKE_KEY}"',
            f"api-key: {FAKE_KEY}",
            f"authorization={FAKE_KEY}",
        ]
        for text in cases:
            out = redact_text(text)
            self.assertNotIn(FAKE_KEY, out, f"未脱敏：{text!r} → {out!r}")

    def test_redact_bearer_and_bare_sk(self) -> None:
        self.assertNotIn(FAKE_KEY, redact_text(f"Authorization: Bearer {FAKE_KEY}"))
        self.assertNotIn(FAKE_KEY, redact_text(f"泄露了 {FAKE_KEY} 这串"))

    def test_redact_long_hex_token(self) -> None:
        token = "a" * 64
        self.assertNotIn(token, redact_text(f"token={token}"))

    def test_filter_applies_to_formatted_args(self) -> None:
        record = logging.LogRecord(
            name="t", level=logging.INFO, pathname="", lineno=1,
            msg="key=%s", args=(FAKE_KEY,), exc_info=None,
        )
        SecretRedactingFilter().filter(record)
        self.assertNotIn(FAKE_KEY, record.getMessage())

    def test_filter_applies_to_third_party_logger(self) -> None:
        """httpx/openai 的 DEBUG 日志会打 Authorization 头，必须被兜住。"""
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.addFilter(SecretRedactingFilter())
        noisy = logging.getLogger("httpx._client.selftest")
        noisy.propagate = False
        noisy.handlers = [handler]
        noisy.setLevel(logging.DEBUG)
        noisy.debug('HTTP Request: POST https://api.deepseek.com "Authorization: Bearer %s"', FAKE_KEY)
        self.assertNotIn(FAKE_KEY, stream.getvalue())


class TestRedactionFormatSafety(unittest.TestCase):
    """★ 脱敏过滤器不得破坏 logging 的惰性格式化。

    `logger.info("api_key=%s", key)` 的 `msg` 是模板、真值在 `args` 里。
    若把 `%s` 也擦掉，`record.getMessage()` 会抛
    `TypeError: not all arguments converted during string formatting`
    —— 脱敏过滤器反而把日志系统搞崩。这类 bug 只在特定日志调用下暴露，
    必须由测试钉死。
    """

    def _capture(self, emit) -> str:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.addFilter(SecretRedactingFilter())
        logger = logging.getLogger("redact.format.safety")
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(logging.DEBUG)
        emit(logger)
        return stream.getvalue()

    def test_percent_s_placeholder_survives_and_value_is_redacted(self) -> None:
        out = self._capture(lambda lg: lg.info("api_key=%s", FAKE_KEY))
        self.assertNotIn(FAKE_KEY, out)
        self.assertIn("api_key=***", out)

    def test_dict_formatting_is_supported(self) -> None:
        out = self._capture(lambda lg: lg.info("token=%(tk)s", {"tk": FAKE_KEY}))
        self.assertNotIn(FAKE_KEY, out)
        self.assertIn("token=***", out)

    def test_ordinary_formatting_is_untouched(self) -> None:
        """普通日志（无凭据）必须逐字保留，否则脱敏就成了"日志破坏器"。"""
        out = self._capture(lambda lg: lg.info("nothing sensitive %s %d", "ok", 3))
        self.assertIn("nothing sensitive ok 3", out)

    def test_bearer_keyword_is_not_redacted(self) -> None:
        """`Authorization: Bearer <token>` 里 `Bearer` 是协议关键字，擦掉反而不利排查。"""
        out = self._capture(lambda lg: lg.info("Authorization: Bearer %s", FAKE_KEY))
        self.assertIn("Bearer", out)
        self.assertNotIn(FAKE_KEY, out)

    def test_no_credential_leaks_in_mixed_log_burst(self) -> None:
        """混合一批真实会出现的日志形态，逐行断言零泄漏。"""

        def emit(lg: logging.Logger) -> None:
            lg.info("api_key=%s", FAKE_KEY)
            lg.info("api_key: %s", FAKE_KEY)
            lg.info("token=%(tk)s", {"tk": FAKE_KEY})
            lg.info("Authorization: Bearer %s", FAKE_KEY)
            lg.info("bare value: %s", FAKE_KEY)
            lg.debug("client init: %s", {"apiKey": FAKE_KEY, "model": "m"})
            lg.error("request failed: https://api.deepseek.com?api_key=%s", FAKE_KEY)

        out = self._capture(emit)
        for line in out.splitlines():
            self.assertNotIn(FAKE_KEY, line, f"泄漏：{line}")

    def test_value_that_is_only_a_placeholder_token_is_kept(self) -> None:
        """`%d` 这类占位符也不能被吃掉，否则格式化直接 TypeError。"""
        out = self._capture(lambda lg: lg.info("retry %d of %d", 1, 3))
        self.assertIn("retry 1 of 3", out)


# --------------------------------------------------------------------------- #
# 设置持久化
# --------------------------------------------------------------------------- #


class TestSettingsStore(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.store = SettingsStore(self.data_dir)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _payload(self, api_key: str = FAKE_KEY, **over) -> SettingsUpdateRequest:
        llm = {
            "providerName": "DeepSeek",
            "baseUrl": "https://api.deepseek.com/v1",
            "apiKey": api_key,
            "modelId": "deepseek-chat",
        }
        llm.update(over)
        return SettingsUpdateRequest.model_validate({"llm": llm})

    def test_defaults_when_missing(self) -> None:
        settings = self.store.load()
        self.assertEqual(settings.embedding.mode, "local_fastembed")
        self.assertTrue(settings.llm.api_key == "")

    def test_roundtrip_persists_to_config_json(self) -> None:
        self.store.save(self._payload())
        raw = json.loads((self.data_dir / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["llm"]["api_key"], FAKE_KEY, "落盘必须是 snake_case（内部形态）")

        reloaded = SettingsStore(self.data_dir).load()
        self.assertEqual(reloaded.llm.api_key, FAKE_KEY)
        self.assertEqual(reloaded.llm.base_url, "https://api.deepseek.com/v1")

    def test_empty_key_keeps_existing(self) -> None:
        self.store.save(self._payload())
        self.store.save(self._payload(api_key=""))
        self.assertEqual(self.store.load().llm.api_key, FAKE_KEY, "空值必须视为不修改")

    def test_masked_key_keeps_existing(self) -> None:
        """前端回显会把掩码原样提交回来——绝不能把掩码存成真 key。"""
        self.store.save(self._payload())
        self.store.save(self._payload(api_key=mask_secret(FAKE_KEY)))
        self.assertEqual(self.store.load().llm.api_key, FAKE_KEY)

    def test_explicit_clear(self) -> None:
        self.store.save(self._payload())
        req = SettingsUpdateRequest.model_validate(
            {"llm": {"providerName": "DeepSeek", "baseUrl": "https://a.com", "modelId": "m"},
             "clearApiKey": True}
        )
        self.store.save(req)
        self.assertEqual(self.store.load().llm.api_key, "")

    def test_response_never_contains_plaintext(self) -> None:
        self.store.save(self._payload())
        response = self.store.to_response()
        blob = response.model_dump_json(by_alias=True)
        self.assertNotIn(FAKE_KEY, blob, "GET /api/settings 绝不能回传明文 key")
        self.assertTrue(response.has_key)
        self.assertTrue(response.api_key_masked.endswith(FAKE_KEY[-4:]))

    def test_corrupt_json_falls_back_without_crashing(self) -> None:
        (self.data_dir / "config.json").write_text("{ 这不是 JSON", encoding="utf-8")
        settings = self.store.load()
        self.assertEqual(settings.embedding.mode, "local_fastembed")
        self.assertIsNotNone(self.store.last_error)

    def test_write_is_atomic_no_tmp_left_behind(self) -> None:
        self.store.save(self._payload())
        leftovers = [p.name for p in self.data_dir.iterdir() if p.suffix == ".tmp"]
        self.assertEqual(leftovers, [], "原子写不应留下临时文件")

    def test_unicode_not_escaped_in_file(self) -> None:
        self.store.save(self._payload(providerName="深度求索"))
        text = (self.data_dir / "config.json").read_text(encoding="utf-8")
        self.assertIn("深度求索", text, "config.json 必须是可读中文，不能是 \\uXXXX 转义")


# --------------------------------------------------------------------------- #
# SSE 分帧
# --------------------------------------------------------------------------- #


class TestSseEncoding(unittest.TestCase):
    def test_frame_shape(self) -> None:
        from app.models import SseDeltaData

        frame = format_sse("delta", SseDeltaData(request_id="r1", delta="循"))
        self.assertEqual(frame, 'event: delta\ndata: {"requestId":"r1","delta":"循"}\n\n')

    def test_unknown_event_raises(self) -> None:
        with self.assertRaises(ValueError):
            format_sse("delta_typo", {"a": 1})

    def test_data_is_single_line_json(self) -> None:
        from app.models import SseDeltaData

        frame = format_sse("delta", SseDeltaData(request_id="r", delta="换\n行"))
        # 只有 2 个 \n（event 行尾 + data 行尾），空行为第 3 个
        self.assertEqual(frame.count("\n"), 3)
        data_line = frame.split("\n")[1]
        self.assertTrue(data_line.startswith("data: "))
        json.loads(data_line[len("data: "):])

    def test_raw_dict_with_newline_is_escaped_not_split(self) -> None:
        """裸 dict 里的换行必须被转义，绝不能把 data 行截断成两行。

        （早期版本靠"发现换行就抛异常"来防，但 `json.dumps` 本身就会转义 `\\n`，
        抛异常属于误报；这里断言的是**真正的**安全性质。）
        """
        frame = format_sse("payload", {"text": "裸\n换行"})
        data_line = frame.split("\n")[1]
        self.assertEqual(json.loads(data_line[len("data: "):])["text"], "裸\n换行")
        self.assertEqual(frame.count("\n"), 3, "事件块内必须只有 event/data/空行三个换行")

    def test_camel_case_in_wire_format(self) -> None:
        from app.models import SseDoneData

        frame = format_sse("done", SseDoneData(request_id="r", message_id="m"))
        self.assertIn('"requestId"', frame)
        self.assertIn('"messageId"', frame)
        self.assertNotIn("request_id", frame)

    def test_chinese_is_not_escaped(self) -> None:
        from app.models import SseDeltaData

        self.assertIn("循环", format_sse("delta", SseDeltaData(request_id="r", delta="循环")))


class TestEchoEvents(unittest.TestCase):
    def _payload(self) -> ChatRequest:
        return ChatRequest.model_validate(
            {"studentId": "s1", "grade": "junior", "message": "什么是循环？"}
        )

    def test_default_events_are_valid_and_ordered(self) -> None:
        events = build_echo_events(self._payload())
        names = [name for name, _ in events]
        self.assertEqual(names[0], "delta")
        self.assertEqual(names[-1], "done")
        self.assertEqual(set(names) - {"delta", "citation", "payload", "done"}, set())

    def test_all_events_covers_every_contract_name(self) -> None:
        events = build_echo_events(self._payload(), all_events=True)
        names = {name for name, _ in events}
        self.assertEqual(names, set(SSE_EVENT_NAMES), "6 种事件必须全部覆盖")

    def test_delta_reassembles_to_full_text(self) -> None:
        text = "".join(
            data.delta for name, data in build_echo_events(self._payload()) if name == "delta"
        )
        self.assertIn("循环", text)
        self.assertIn("\n", text, "多行文本必须能完整还原（验证 \\n 转义处理）")

    def test_request_id_consistent_within_stream(self) -> None:
        events = build_echo_events(self._payload(), all_events=True)
        ids = {data.request_id for _, data in events}
        self.assertEqual(len(ids), 1, "同一轮对话的所有事件必须共享 requestId")

    def test_payload_kind_matches_payload_model(self) -> None:
        for name, data in build_echo_events(self._payload()):
            if name != "payload":
                continue
            self.assertEqual(data.kind.value, "quiz")
            self.assertIn("questions", data.payload)
            # 内层 payload 也必须是 camelCase（SsePayloadData.payload 是自由 dict，
            # 容易在转换时漏掉 model_dump(by_alias=True)）
            self.assertIn("kpId", json.dumps(data.payload))
            self.assertNotIn("kp_id", json.dumps(data.payload))

    def test_every_event_serializes(self) -> None:
        for name, data in build_echo_events(self._payload(), all_events=True):
            frame = format_sse(name, data)
            self.assertTrue(frame.startswith(f"event: {name}\n"))


class TestContractCompleteness(unittest.TestCase):
    """防「加了模型忘了登记」——那会让前端静默拿不到类型，是最隐蔽的契约漂移。"""

    def test_every_camel_model_is_registered(self) -> None:
        import app.models as m

        declared = {
            name
            for name, obj in vars(m).items()
            if isinstance(obj, type) and issubclass(obj, m.CamelModel) and obj is not m.CamelModel
        }
        registered = {model.__name__ for model in m.CONTRACT_MODELS}
        missing = sorted(declared - registered)
        self.assertEqual(missing, [], f"以下契约模型未登记进 CONTRACT_MODELS：{missing}")

    def test_enums_are_registered(self) -> None:
        import app.models as m

        for enum_name in ("GradeLevel", "Intent", "AnswerKind"):
            self.assertIn(enum_name, {x.__name__ for x in m.CONTRACT_MODELS})

    def test_sse_data_models_match_event_names(self) -> None:
        self.assertEqual(tuple(SSE_DATA_MODELS), SSE_EVENT_NAMES)
        for name, model in SSE_DATA_MODELS.items():
            registered = {x.__name__ for x in CONTRACT_MODELS}
            self.assertIn(model.__name__, registered, f"{name} 事件载荷未登记")

    def test_models_module_is_import_side_effect_free(self) -> None:
        """契约模块必须能被 Electron 的 codegen 安全 import（不得读写文件）。"""
        import subprocess

        script = "import app.models, sys; sys.stdout.write('ok')"
        out = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", timeout=60,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
