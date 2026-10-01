# -*- coding: utf-8 -*-
"""票 04：契约冻结 + 防漂移链 + API Key 掩码语义 + **答案泄漏防护**。

这些断言是「第一道防线」本身：
改了 `contracts.py` 忘了重跑生成 → 这里的字节比对测试先红；
把内部题模型接到路由上 → 导出时直接拒绝；
掩码语义被改成「把掩码写回磁盘」→ 路由级测试红。

跑法::

    cd server
    uv run python -m unittest discover -s tests
"""

from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:  # 允许从任意 cwd 跑（脚本与测试共用同一份导入假设）
    sys.path.insert(0, str(SERVER_ROOT))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from app import contracts  # noqa: E402
from app.config import build_runtime_config  # noqa: E402
from app.contracts import (  # noqa: E402
    CONTRACT_ENUMS,
    CONTRACT_MODELS,
    GradeLevel,
    INTERNAL_MODELS,
    IPC_EVENT_NAMES,
    CamelModel,
    ChatRequest,
    Citation,
    EmbeddingConfigIn,
    LlmConfig,
    LlmConfigIn,
    QuizGradeRequest,
    QuizPayload,
    QuizQuestion,
    QuizQuestionOut,
    QuizResult,
    RagHit,
    Student,
    is_api_key_placeholder,
    mask_api_key,
    resolve_api_key,
)
from app.main import create_app  # noqa: E402
from app.routes.settings import (  # noqa: E402
    SETTINGS_STORE_ATTR,
    InMemorySettingsStore,
    StoredEmbedding,
    StoredLlm,
    StoredSettings,
)
from app.security import AUTH_HEADER  # noqa: E402
from scripts.export_openapi import (  # noqa: E402
    ANSWER_PROPERTY_ALLOWLIST,
    OUTPUT_PATH,
    build_openapi_document,
    render,
)

TOKEN = "c" * 64  # 与 Electron 侧 randomBytes(32).toString('hex') 同形
SECRET_KEY = "sk-9f3c2b7a41d0e8f6a5b4c3d2e1f09876"  # 测试用假 Key，**绝不进仓库任何地方**
ANSWER_SENTINEL = "ANSWER-SENTINEL-请勿泄漏-42"


def authed_client(app: FastAPI) -> TestClient:
    client = TestClient(app)
    client.headers.update({AUTH_HEADER: TOKEN})
    return client


def make_app() -> FastAPI:
    return create_app(build_runtime_config(token=TOKEN))


# ---------------------------------------------------------------- 模型登记 --
class TestContractRegistration(unittest.TestCase):
    """★ 「新增模型忘了登记」必须当场红，而不是静默缺席 OpenAPI。"""

    def test_every_camel_model_in_this_module_is_registered(self) -> None:
        registered = {model.__name__ for model in CONTRACT_MODELS} | {
            model.__name__ for model in INTERNAL_MODELS
        }
        defined = {
            name
            for name, obj in vars(contracts).items()
            if isinstance(obj, type)
            and issubclass(obj, CamelModel)
            and obj is not CamelModel
            and obj.__module__ == contracts.__name__
        }

        missing = sorted(defined - registered)
        self.assertEqual(
            missing,
            [],
            f"以下契约模型既不在 CONTRACT_MODELS 也不在 INTERNAL_MODELS：{missing}；"
            "它们不会进入 OpenAPI/TS 生成物（或会绕过答案泄漏防护），请登记。",
        )

    def test_registration_table_has_no_duplicates_and_no_overlap(self) -> None:
        contract_names = [model.__name__ for model in CONTRACT_MODELS]
        internal_names = [model.__name__ for model in INTERNAL_MODELS]

        self.assertEqual(len(contract_names), len(set(contract_names)), "CONTRACT_MODELS 有重复")
        self.assertEqual(
            sorted(set(contract_names) & set(internal_names)),
            [],
            "同一个模型不能既是对外契约又是内部模型",
        )

    def test_internal_models_are_exactly_the_answer_holders(self) -> None:
        """内部模型=带标准答案的模型；对外契约模型一律不得带 `answer`（白名单除外）。"""
        for model in INTERNAL_MODELS:
            self.assertIn("answer", model.model_fields, f"{model.__name__} 应含 answer")

        offenders = [
            model.__name__
            for model in CONTRACT_MODELS
            if "answer" in model.model_fields and model.__name__ not in ANSWER_PROPERTY_ALLOWLIST
        ]
        self.assertEqual(
            offenders,
            [],
            f"对外契约模型里出现 answer 字段：{offenders}（答案泄漏防护，§6.3）",
        )

    def test_registered_models_are_exportable(self) -> None:
        for model in CONTRACT_MODELS:
            self.assertTrue(model.model_json_schema(), f"{model.__name__} 无法产出 JSON Schema")

    def test_frozen_enums_are_registered(self) -> None:
        for name in ("GradeLevel", "IpcEventName", "PayloadKind", "Degraded"):
            self.assertIn(name, CONTRACT_ENUMS)
        self.assertEqual(
            CONTRACT_ENUMS["IpcEventName"],
            contracts.IpcEventName,
        )

    def test_every_literal_alias_is_registered(self) -> None:
        """★ A7：本模块里每个 ``Literal`` 别名都要登记进 `CONTRACT_ENUMS`。

        漏登记的后果很隐蔽：它的取值会**以内联 enum** 出现在引用它的模型里
        （OpenAPI 里看得见，但 TS 侧没有具名联合类型），于是前端只能手写一份
        「和契约长得差不多的字符串联合」—— 防漂移链在这里断掉，而且没人会发现。
        历史上漏过 `DepRelation` / `DepDirection` / `GradeSignalType` 三个。
        """
        aliases = {
            name: value
            for name, value in vars(contracts).items()
            if not name.startswith("_")
            and getattr(value, "__class__", None).__name__ == "_LiteralGenericAlias"
        }
        missing = sorted(set(aliases) - set(CONTRACT_ENUMS))
        self.assertEqual(
            missing,
            [],
            f"以下 Literal 别名没登记进 CONTRACT_ENUMS：{missing}（TS 侧会缺具名类型）",
        )
        for name, value in aliases.items():
            self.assertIs(CONTRACT_ENUMS[name], value, f"CONTRACT_ENUMS[{name!r}] 与别名不是同一个对象")

    def test_newly_registered_enums_are_exported_as_named_schemas(self) -> None:
        """★ A7 的验收口径：三个漏登记的字面量要在生成物里**有具名 schema**。"""
        schemas = build_openapi_document()["components"]["schemas"]
        for name in ("DepRelation", "DepDirection", "GradeSignalType"):
            self.assertIn(name, schemas, f"{name} 没有进 OpenAPI（TS 侧缺具名类型）")
            self.assertEqual(schemas[name]["title"], name)
            self.assertEqual(schemas[name]["enum"], list(contracts.CONTRACT_ENUMS[name].__args__))


# ---------------------------------------------------------------- 答案泄漏 --
class TestAnswerLeak(unittest.TestCase):
    """★★ 最高优先级断言：发往前端的题目**绝不能**带标准答案。

    这是教育产品的合规/作弊红线（§6.3 答案泄漏防护、业务陷阱清单 §4 #3）：
    前端拿到答案就等于把题做废，且会被人顺手渲染出来。
    """

    def _internal_question(self) -> QuizQuestion:
        return QuizQuestion(
            qid="q_loop_001",
            kp_id="kp_loop",
            type="choice",
            stem="下面哪段代码会让循环执行 3 次？",
            options=["for i in range(3)", "for i in range(4)", "while True"],
            answer=ANSWER_SENTINEL,
            explanation="range(3) 产生 0,1,2 三个值。",
        )

    def test_outward_model_has_no_answer_field(self) -> None:
        self.assertNotIn("answer", QuizQuestionOut.model_fields)
        self.assertFalse(hasattr(QuizQuestionOut, "answer"))

        # 连「名字里带 answer 的字段」都不许有（防改名绕过）
        suspicious = [name for name in QuizQuestionOut.model_fields if "answer" in name.lower()]
        self.assertEqual(suspicious, [], f"对外题模型出现疑似答案字段：{suspicious}")

    def test_outward_model_rejects_answer_kwarg(self) -> None:
        with self.assertRaises(ValidationError):
            QuizQuestionOut(
                qid="q1",
                kp_id="kp1",
                type="blank",
                stem="1+1=?",
                answer="2",  # type: ignore[call-arg]
            )

    def test_outward_model_has_no_explanation(self) -> None:
        """★★ 解析**也不下发**（H-6）：实测 684 道真题里 281 道（41%）的解析直接写着答案。

        界面文案早就写着「答案与解析都不下发到界面」（``views/Quiz.vue``），
        而契约一直带着它走完 HTTP —— 这条用例把承诺与载荷对齐。

        ★ 教学价值没丢：解析仍在 ``feedback_for()`` 里，只在判分**之后**
          经 ``QuizResult.feedback`` 回传（见 :class:`TestAnswerLeak` 的反馈用例）。
        """
        self.assertNotIn("explanation", QuizQuestionOut.model_fields)
        # 塞进来必须当场报错（`extra="forbid"`），而不是静默忽略 ——
        # 静默忽略会让「上游多带一个字段」在今天看起来无事发生。
        with self.assertRaises(ValidationError):
            QuizQuestionOut(
                qid="q1",
                kp_id="kp1",
                type="blank",
                stem="1+1=?",
                explanation="等于 2",  # type: ignore[call-arg]
            )

    def test_internal_model_cannot_be_smuggled_into_outward_payload(self) -> None:
        """类型层面就塞不进来 —— 不依赖任何人记得调 from_internal。"""
        with self.assertRaises(ValidationError):
            QuizPayload(  # type: ignore[list-item]
                kp_id="kp_loop",
                source="bank",
                questions=[self._internal_question()],
            )

    def test_serialised_payload_never_contains_the_answer(self) -> None:
        payload = QuizPayload.from_internal(
            kp_id="kp_loop",
            source="bank",
            questions=[self._internal_question()],
        )

        raw = payload.model_dump_json(by_alias=True, exclude_none=False)
        self.assertNotIn(ANSWER_SENTINEL, raw, "★ 序列化结果里出现了标准答案文本（答案泄漏！）")
        self.assertNotIn("answer", raw, "★ 序列化结果里出现了 answer 字段（答案泄漏！）")

        # 递归看键名，防「藏在嵌套 dict 里」
        dumped = json.loads(raw)
        self.assertEqual(self._find_answer_keys(dumped), [], "序列化结果里出现 answer 键")
        self.assertEqual(sorted(dumped), ["kpId", "questions", "source"])
        # ★ 对外题目**五个字段**：`explanation` 也在不下发之列（见 `QuizQuestionOut` 的说明
        #   与下面那条专门的用例 —— 解析里 41% 直接写着答案）
        self.assertEqual(
            sorted(dumped["questions"][0]),
            ["kpId", "options", "qid", "stem", "type"],
        )

    def test_question_list_response_model_is_the_outward_one(self) -> None:
        """`QuizPayload.questions` 的**注解**必须是对外形态（不是靠运行时侥幸）。"""
        annotation = QuizPayload.model_fields["questions"].annotation
        self.assertEqual(str(annotation), "list[app.contracts.QuizQuestionOut]")

    def test_exported_openapi_has_no_answer_property_outside_allowlist(self) -> None:
        document = build_openapi_document()
        hits: list[str] = []

        def walk(node: object, path: str) -> None:
            if isinstance(node, dict):
                properties = node.get("properties")
                if isinstance(properties, dict) and "answer" in properties:
                    hits.append(path)
                for key, value in node.items():
                    walk(value, f"{path}.{key}")
            elif isinstance(node, list):
                for index, value in enumerate(node):
                    walk(value, f"{path}[{index}]")

        walk(document, "$")
        allowed = [f"$.components.schemas.{name}" for name in ANSWER_PROPERTY_ALLOWLIST]
        self.assertEqual(
            sorted(set(hits) - set(allowed)),
            [],
            f"OpenAPI 里出现答案字段：{sorted(set(hits) - set(allowed))}",
        )
        self.assertNotIn("QuizQuestion", document["components"]["schemas"], "内部模型被导出了")

    def test_generated_ts_types_do_not_define_the_internal_question(self) -> None:
        """生成链末端（api-types.ts）也不许出现内部题模型。

        文件由 `desktop/scripts/gen-api-types.mjs` 产出；这里做**兜底**检查，
        免得有人手改了生成物或改了导出脚本的过滤逻辑。
        """
        ts_path = Path(SERVER_ROOT).parent / "desktop" / "src" / "shared" / "api-types.ts"
        if not ts_path.exists():
            self.skipTest("api-types.ts 尚未生成（先跑 cd desktop && npm run gen:api）")

        source = ts_path.read_text(encoding="utf-8")
        self.assertNotIn("QuizQuestion:", source)
        # ★★ 判据从「以 answer 开头」收窄为「字段名恰好是 answer」（2026-09-28 集成期修正）。
        #
        #   前缀匹配会把三种**方向相反**的东西混为一谈：
        #     · answerText  —— 学生**自己写的**引导回答（学生产出，不是题目自带答案）
        #     · answered    —— 「答过哪几问」的进度字段
        #     · answer_...  —— 路径键（URL 片段，根本不是字段声明）
        #   而 §8.1 禁的是**题目自带的**标准答案。前者是学生产出的内容，后者是题目的答案 ——
        #   方向正好相反。前缀判断一旦把前者误报成后者，维护者的第一反应是「把守卫放宽」，
        #   那才是真正的风险（红线守卫被稀释，比误报本身危险得多）。
        #
        #   所以这里改成**按字段名精确匹配**：只认 `answer:` 这一种声明形态。
        #   （`referenceAnswer` / `solution` 是既有的、经答案属性白名单批准的出参，
        #     由 OpenAPI 侧 ANSWER_PROPERTY_ALLOWLIST 那条守卫负责，不在这里重复判。）
        self.assertEqual(
            [
                line.strip()
                for line in source.splitlines()
                if line.strip().startswith("answer:")
            ],
            ["answer: string | string[];"],
            "生成的 TS 类型里出现了非预期方向的 answer 字段",
        )

    @staticmethod
    def _find_answer_keys(node: object, path: str = "$") -> list[str]:
        found: list[str] = []
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "answer":
                    found.append(f"{path}.{key}")
                found.extend(TestAnswerLeak._find_answer_keys(value, f"{path}.{key}"))
        elif isinstance(node, list):
            for index, value in enumerate(node):
                found.extend(TestAnswerLeak._find_answer_keys(value, f"{path}[{index}]"))
        return found


# ---------------------------------------------------------------- 防漂移链 --
class TestOpenApiExportChain(unittest.TestCase):
    def test_export_is_deterministic(self) -> None:
        first = render(build_openapi_document())
        second = render(build_openapi_document())
        self.assertEqual(first, second, "同一份 contracts.py 两次导出不一致（顺序不稳定）")

    def test_committed_artifact_matches_contracts(self) -> None:
        """★ 第一道防线：改了 contracts.py 没重跑导出 → 这里红（与 `--check` 同义）。"""
        expected = render(build_openapi_document()).encode("utf-8")
        self.assertTrue(
            OUTPUT_PATH.exists(),
            f"缺少生成物 {OUTPUT_PATH}；请跑 cd server && uv run python scripts/export_openapi.py",
        )
        actual = OUTPUT_PATH.read_bytes()
        self.assertEqual(
            actual,
            expected,
            "契约漂移：openapi.json 与 contracts.py 不一致。\n"
            "  修复：cd server && uv run python scripts/export_openapi.py "
            "→ cd desktop && npm run gen:api",
        )

    def test_paths_and_schemas_are_sorted(self) -> None:
        document = build_openapi_document()
        self.assertEqual(list(document["paths"]), sorted(document["paths"]))
        schemas = document["components"]["schemas"]
        self.assertEqual(list(schemas), sorted(schemas))

    def test_fastapi_generated_schemas_are_never_overwritten(self) -> None:
        """导出脚本「只补不覆盖」：路由能到达的 schema 必须与 FastAPI 原产物逐字相同。"""
        raw = create_app(build_runtime_config()).openapi()["components"]["schemas"]
        exported = build_openapi_document()["components"]["schemas"]

        self.assertTrue(raw, "FastAPI 没有生成任何 schema，测试前提不成立")
        for name, definition in raw.items():
            self.assertEqual(
                exported.get(name),
                definition,
                f"{name} 被导出脚本改写了 —— 只允许补，不允许覆盖 FastAPI 的产物",
            )

    def test_inaccessible_models_are_injected(self) -> None:
        """FastAPI 看不到的模型（payload / IPC 请求 / 未实现端点）必须被补齐。"""
        schemas = build_openapi_document()["components"]["schemas"]

        for name in (
            "AnimationPayload",
            "CodeTemplate",
            "CodingHint",
            "CodeError",
            "CodeEvaluation",
            "QuizPayload",
            "QuizResult",
            "ChatRequest",
            "ProbeResult",
        ):
            self.assertIn(name, schemas, f"{name} 没有被注入 OpenAPI（TS 侧会缺类型）")

        for model in CONTRACT_MODELS:
            self.assertIn(model.__name__, schemas)

    def test_event_vocabulary_is_exported_and_frozen(self) -> None:
        enum_values = build_openapi_document()["components"]["schemas"]["IpcEventName"]["enum"]
        self.assertEqual(tuple(enum_values), IPC_EVENT_NAMES)
        self.assertEqual(len(enum_values), 6)

    def test_grade_level_enum_is_exported(self) -> None:
        enum_values = build_openapi_document()["components"]["schemas"]["GradeLevel"]["enum"]
        self.assertEqual(enum_values, list(GradeLevel.__args__))  # type: ignore[attr-defined]


# ---------------------------------------------------------------- 掩码语义 --
class TestApiKeyMasking(unittest.TestCase):
    """API Key 掩码语义（票 07 硬要求）：读只回掩码；占位不覆盖；清除必须显式。"""

    def test_mask_keeps_only_a_short_tail(self) -> None:
        self.assertEqual(mask_api_key(SECRET_KEY), f"…{SECRET_KEY[-4:]}")
        self.assertEqual(mask_api_key(""), "")
        self.assertEqual(mask_api_key(None), "")
        # 短 Key 不保留尾部（否则掩码约等于明文）
        self.assertEqual(mask_api_key("sk-123"), "…")

    def test_placeholder_detection(self) -> None:
        for placeholder in ("", "   ", "…", "…abcd", "******", "••••••"):
            self.assertTrue(is_api_key_placeholder(placeholder), f"{placeholder!r} 应视为占位")
        for real in (SECRET_KEY, "sk-123", "abcd"):
            self.assertFalse(is_api_key_placeholder(real), f"{real!r} 不应视为占位")

    def test_resolve_api_key(self) -> None:
        self.assertEqual(resolve_api_key("", SECRET_KEY), SECRET_KEY)
        self.assertEqual(resolve_api_key("…abcd", SECRET_KEY), SECRET_KEY)
        self.assertEqual(resolve_api_key("******", SECRET_KEY), SECRET_KEY)
        self.assertEqual(resolve_api_key("  sk-new-key-123456  ", SECRET_KEY), "sk-new-key-123456")
        self.assertEqual(resolve_api_key("anything", SECRET_KEY, clear=True), "")
        self.assertEqual(resolve_api_key(SECRET_KEY, SECRET_KEY, clear=True), "")

    def test_response_model_only_holds_a_mask(self) -> None:
        config = LlmConfig.from_plain(api_key=SECRET_KEY)
        self.assertEqual(config.api_key, f"…{SECRET_KEY[-4:]}")
        self.assertTrue(config.has_key)
        self.assertNotIn(SECRET_KEY, config.model_dump_json(by_alias=True))

    def test_plaintext_never_appears_in_repr_or_str(self) -> None:
        """★ Key 不入日志：`repr()` / `str()` 里都不许有明文（`Field(repr=False)`）。"""
        for model in (
            LlmConfigIn(api_key=SECRET_KEY),
            EmbeddingConfigIn(mode="cloud_api", api_key=SECRET_KEY),
            LlmConfig.from_plain(api_key=SECRET_KEY),
        ):
            self.assertNotIn(SECRET_KEY, repr(model), f"{type(model).__name__} 的 repr 泄漏了 Key")
            self.assertNotIn(SECRET_KEY, str(model), f"{type(model).__name__} 的 str 泄漏了 Key")
            self.assertNotIn(SECRET_KEY[-8:], repr(model))

    def test_clearing_and_overriding_at_once_is_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            LlmConfigIn(api_key="sk-new-key-123456", clear_api_key=True)


# ---------------------------------------------------------------- 局部提交 --
class TestPartialSubmitContracts(unittest.TestCase):
    """★ A4：「**省略即保留**」是**契约层**的语义（不是路由层的顺带行为）。

    入参模型一旦给出出厂默认值，`PUT {"llm": {"apiKey": "…"}}` 这种字段级局部提交
    就会被解释成「其余字段按默认值保存」→ 用户自填的校内网关被静默换回 DeepSeek。
    所以这里钉住「省略 = ``None``」，路由侧才有可能区分「没提交」与「提交了默认值」。
    """

    def test_optional_fields_default_to_none_not_to_factory_defaults(self) -> None:
        llm = LlmConfigIn()
        for field in ("provider_id", "provider_name", "base_url", "model_id"):
            self.assertIsNone(
                getattr(llm, field),
                f"LlmConfigIn.{field} 的省略默认值必须是 None（出厂默认值会让局部 PUT 重置配置）",
            )

        embedding = EmbeddingConfigIn()
        for field in ("mode", "base_url", "model_id"):
            self.assertIsNone(
                getattr(embedding, field),
                f"EmbeddingConfigIn.{field} 的省略默认值必须是 None",
            )

    def test_placeholder_key_semantics_are_untouched(self) -> None:
        """`api_key` 的语义**没有**跟着其它字段一起改（缺省仍是空串 = 保留已存值）。"""
        self.assertEqual(LlmConfigIn().api_key, "")
        self.assertEqual(EmbeddingConfigIn().api_key, "")
        self.assertTrue(is_api_key_placeholder(LlmConfigIn().api_key))

    def test_base_url_is_still_normalized_when_submitted(self) -> None:
        self.assertEqual(
            LlmConfigIn(base_url=" https://gw.example.com/v1/ ").base_url,
            "https://gw.example.com/v1",
        )
        self.assertIsNone(LlmConfigIn(base_url=None).base_url, "没提交就保持没提交（不回填默认值）")
        self.assertEqual(EmbeddingConfigIn(base_url=" ").base_url, "")

    def test_exported_schema_marks_them_optional(self) -> None:
        """★ 生成物口径：这些字段在 TS 侧必须是可省略的（`?`），否则前端会照着必填写。"""
        schemas = build_openapi_document()["components"]["schemas"]

        llm_required = schemas["LlmConfigIn"].get("required", [])
        for field in ("providerName", "baseUrl", "modelId"):
            self.assertNotIn(field, llm_required, f"LlmConfigIn.{field} 不该是必填")

        embedding_required = schemas["EmbeddingConfigIn"].get("required", [])
        self.assertEqual(embedding_required, [], "EmbeddingConfigIn 的字段全都可以省略")


# ---------------------------------------------------------------- 对话入参 --
class TestChatRequestContract(unittest.TestCase):
    """★ A5 / L-9：`ChatRequest` 是 IPC 入参形状 —— **只有 `text`**。

    它必须与 ``desktop/src/main/ipc/channels.ts`` 的 ``ChatSendRequest`` **逐字段同形**
    （守卫 G6c 把那一侧钉死为 ``['text']``）。曾经多出的 ``student_id`` / ``session_id``
    是**第二形状**，也是漂移温床：

    - **学生身份只能由主进程决定**（``resolveActiveStudentId()``）—— 契约里放一个
      ``student_id``，等于给「读渲染进程递来的身份」留了一个合法入口，
      而那正是「读别人的画像与学习记录」的那条路；
    - **会话同理**：Pi 会话由主进程持有，渲染进程连会话 id 都不该知道。
    """

    def test_chat_request_has_no_grade_field(self) -> None:
        self.assertNotIn("grade_level", ChatRequest.model_fields)
        # 连「名字里带 grade 的字段」都不许有（防改名绕过）
        suspicious = [name for name in ChatRequest.model_fields if "grade" in name.lower()]
        self.assertEqual(suspicious, [], f"ChatRequest 里出现疑似学段字段：{suspicious}")

    def test_chat_request_has_no_chapter_field(self) -> None:
        """★ D-038：章节走 `chapter:set` 独立通道，**不混进对话请求**（同「不许加回学段」）。"""
        self.assertNotIn("chapter", ChatRequest.model_fields)
        self.assertNotIn("current_chapter", ChatRequest.model_fields)

    def test_field_set_is_exactly_text(self) -> None:
        """★★ 字段集合**恰好**是 ``['text']``（与 G6c 守卫同一口径）。

        身份字段尤其不能进来：它一旦可被指定，就等于把「读谁的画像与学习记录」
        交给了调用方。所以这条断言是**集合相等**，不是「包含」——
        将来任何人想加字段（哪怕是"顺手"的），都必须先来这里改这行并有意识地解释。
        """
        self.assertEqual(sorted(ChatRequest.model_fields), ["text"])

    def test_ipc_shape_matches_what_the_main_process_sends(self) -> None:
        """主进程只发 ``{text}`` —— 契约里也能**只**这么构造。"""
        request = ChatRequest(text="什么是循环？")
        self.assertEqual(request.text, "什么是循环？")
        self.assertEqual(sorted(request.model_dump(by_alias=True)), ["text"])

    def test_unknown_fields_are_rejected(self) -> None:
        """多带一个字段必须报错：静默忽略会让「身份/学段被悄悄塞回来」看起来无事发生。"""
        for extra in ({"studentId": "student_001"}, {"sessionId": "s1"}, {"gradeLevel": "junior"}):
            with self.subTest(extra=extra):
                with self.assertRaises(ValidationError):
                    ChatRequest(text="x", **extra)

    def test_exported_schema_does_not_require_a_grade(self) -> None:
        schema = build_openapi_document()["components"]["schemas"]["ChatRequest"]
        self.assertNotIn("gradeLevel", schema["properties"])
        self.assertEqual(sorted(schema["properties"]), ["text"])
        self.assertEqual(sorted(schema["required"]), ["text"])


# ---------------------------------------------------------------- HTTP 契约 --
class TestSettingsRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.app = make_app()
        self.client = authed_client(self.app)

    def _store(self) -> InMemorySettingsStore:
        store = getattr(self.app.state, SETTINGS_STORE_ATTR)
        assert isinstance(store, InMemorySettingsStore)
        return store

    def test_get_returns_contract_shape_without_plaintext(self) -> None:
        response = self.client.get("/api/settings")
        self.assertEqual(response.status_code, 200)

        body = response.json()
        self.assertEqual(sorted(body), ["embedding", "llm"])
        # ★ `providerId` 是 Pi 的 provider id（决定用哪份 provider 定义）；
        #   `providerName` 只用于显示 —— 两者分工不同，都要在出参里。
        self.assertEqual(
            sorted(body["llm"]),
            ["apiKey", "baseUrl", "hasKey", "modelId", "providerId", "providerName"],
        )
        self.assertFalse(body["llm"]["hasKey"])
        self.assertEqual(body["llm"]["apiKey"], "")
        # ★ 默认值必须与 Pi 内置 deepseek provider 一致（无 /v1），否则首轮对话会「找不到模型」
        self.assertEqual(body["llm"]["providerId"], "deepseek")
        self.assertEqual(body["llm"]["baseUrl"], "https://api.deepseek.com")
        # ★ 默认 ModelID 必须是 Pi 目录里**真实存在**的那个（老默认 `deepseek-chat` 不在目录里）
        self.assertEqual(body["llm"]["modelId"], "deepseek-v4-flash")
        self.assertEqual(body["embedding"]["mode"], "local_fastembed")

    def test_put_stores_key_and_only_returns_the_mask(self) -> None:
        response = self.client.put(
            "/api/settings",
            json={"llm": {"providerName": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1",
                          "apiKey": SECRET_KEY, "modelId": "deepseek-chat"}},
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn(SECRET_KEY, response.text, "★ 响应里出现明文 Key（掩码语义破了）")

        body = response.json()
        self.assertTrue(body["llm"]["hasKey"])
        self.assertEqual(body["llm"]["apiKey"], f"…{SECRET_KEY[-4:]}")
        self.assertEqual(self._store().load().llm.api_key, SECRET_KEY, "明文应落在存储里")

    def test_submitting_the_mask_does_not_erase_the_stored_key(self) -> None:
        """★ 掩码语义的核心：读回来的掩码原样提交，不能把真 Key 抹掉。"""
        with_key = {"providerName": "DeepSeek", "baseUrl": "https://api.deepseek.com/v1",
                    "apiKey": SECRET_KEY, "modelId": "deepseek-chat"}
        self.client.put("/api/settings", json={"llm": with_key})

        read_back = self.client.get("/api/settings").json()["llm"]
        # 设置页的自然写法：把 GET 回来的整个对象改完再 PUT 回去（含 hasKey/apiKey 掩码）
        response = self.client.put("/api/settings", json={"llm": read_back})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["llm"]["hasKey"], "掩码被当成新 Key 写回，真 Key 被抹掉了")
        self.assertEqual(self._store().load().llm.api_key, SECRET_KEY)

    def test_echoing_has_key_false_does_not_delete_the_key(self) -> None:
        """`hasKey` 是出参回显、入参忽略：只有 `clearApiKey` 能删 Key。"""
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        response = self.client.put(
            "/api/settings", json={"llm": {"apiKey": "…abcd", "hasKey": False}}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["llm"]["hasKey"])
        self.assertEqual(self._store().load().llm.api_key, SECRET_KEY)

    def test_submitting_an_empty_key_does_not_erase_the_stored_key(self) -> None:
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        response = self.client.put("/api/settings", json={"llm": {"apiKey": ""}})
        self.assertTrue(response.json()["llm"]["hasKey"])
        self.assertEqual(self._store().load().llm.api_key, SECRET_KEY)

    def test_explicit_clear_flag_is_the_only_way_to_delete(self) -> None:
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        response = self.client.put("/api/settings", json={"llm": {"apiKey": "", "clearApiKey": True}})

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["llm"]["hasKey"])
        self.assertEqual(response.json()["llm"]["apiKey"], "")
        self.assertEqual(self._store().load().llm.api_key, "")

    def test_plaintext_overwrites_the_stored_key(self) -> None:
        self.client.put("/api/settings", json={"llm": {"apiKey": SECRET_KEY}})
        self.client.put("/api/settings", json={"llm": {"apiKey": "sk-brand-new-key-0987"}})
        self.assertEqual(self._store().load().llm.api_key, "sk-brand-new-key-0987")

    def test_base_url_is_normalized(self) -> None:
        response = self.client.put(
            "/api/settings", json={"llm": {"baseUrl": "https://api.deepseek.com/v1/ "}}
        )
        self.assertEqual(response.json()["llm"]["baseUrl"], "https://api.deepseek.com/v1")

    def test_embedding_is_untouched_when_omitted(self) -> None:
        """两栏分栏保存：只改 LLM 时嵌入配置（含 Key）原样保留。"""
        saved = self.client.put(
            "/api/settings",
            json={"embedding": {"mode": "cloud_api", "baseUrl": "https://embed.example.com",
                                "apiKey": "emb-key-123456", "modelId": "bge-m3"}},
        )
        self.assertEqual(saved.status_code, 200, saved.text)

        response = self.client.put("/api/settings", json={"llm": {"modelId": "deepseek-reasoner"}})

        embedding = response.json()["embedding"]
        self.assertEqual(embedding["mode"], "cloud_api")
        self.assertEqual(embedding["modelId"], "bge-m3")
        self.assertTrue(embedding["hasKey"])
        self.assertEqual(embedding["apiKey"], "…3456")
        self.assertEqual(self._store().load().embedding.api_key, "emb-key-123456")

    def test_empty_body_is_rejected(self) -> None:
        """两栏都不给 = 这次请求没有意义（防止静默 no-op 掩盖前端 bug）。"""
        self.assertEqual(self.client.put("/api/settings", json={}).status_code, 422)

    def test_unknown_field_is_rejected(self) -> None:
        response = self.client.put("/api/settings", json={"llm": {"oops": 1}})
        self.assertEqual(response.status_code, 422)

    def test_requires_token(self) -> None:
        anonymous = TestClient(make_app())
        self.assertEqual(anonymous.get("/api/settings").status_code, 401)
        self.assertEqual(anonymous.put("/api/settings", json={"llm": {}}).status_code, 401)

    def test_probe_is_a_real_connectivity_check(self) -> None:
        """★ 探测属票 07，**已落地**：真外呼 + 可读中文原因 + 失败不阻塞保存。

        刻意指向回环上的死端口：不经外网、秒级返回，且必须是**可读原因**
        而不是裸堆栈 —— 用户是老师/学生，不是开发者。

        ⚠️ 已存地址也一起改成这个死端口：已存的明文 Key **只允许**用于保存它的那个
        地址（A1 凭据边界），否则这里拿到的是「换了接口地址，请重新填写 API Key」
        而不是网络层原因 —— 那属于另一条测试（`test_settings_store.py` 的
        `TestProbeCredentialBoundary`）。
        """
        self.client.put(
            "/api/settings",
            json={"llm": {"baseUrl": "http://127.0.0.1:9/v1", "apiKey": SECRET_KEY}},
        )
        started = time.monotonic()
        response = self.client.post(
            "/api/settings/probe",
            json={"llm": {"baseUrl": "http://127.0.0.1:9/v1"}},
        )
        elapsed = time.monotonic() - started

        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["ok"])
        self.assertLess(elapsed, 5.0, "探测不能挂住 UI")
        self.assertTrue(
            any(
                word in response.json()["message"]
                for word in ("连接被拒绝", "网络请求失败", "连接超时")
            ),
            response.json()["message"],
        )
        self.assertNotIn(SECRET_KEY, response.text)

    def test_probe_declares_the_frozen_contract_shape(self) -> None:
        schema = build_openapi_document()["components"]["schemas"]["ProbeResult"]
        self.assertEqual(sorted(schema["properties"]), ["message", "ok"])
        self.assertEqual(sorted(schema["required"]), ["message", "ok"])

    def test_store_can_be_injected(self) -> None:
        """接缝可替换（票 07 换成 config.json 落盘实现时路由代码不用改）。"""

        class FakeStore:
            def __init__(self) -> None:
                self.saved: StoredSettings | None = None
                self._current = StoredSettings(
                    llm=StoredLlm(api_key="fake-key-123456", provider_name="自建供应商"),
                    embedding=StoredEmbedding(mode="none"),
                )

            def load(self) -> StoredSettings:
                return self._current

            def save(self, settings: StoredSettings) -> None:
                self.saved = settings
                self._current = settings

        fake = FakeStore()
        setattr(self.app.state, SETTINGS_STORE_ATTR, fake)

        body = self.client.get("/api/settings").json()
        self.assertEqual(body["llm"]["providerName"], "自建供应商")
        self.assertEqual(body["llm"]["apiKey"], "…3456")
        self.assertEqual(body["embedding"]["mode"], "none")

        self.client.put("/api/settings", json={"llm": {"modelId": "另一个模型"}})
        assert fake.saved is not None
        self.assertEqual(fake.saved.llm.model_id, "另一个模型")
        self.assertEqual(fake.saved.llm.api_key, "fake-key-123456", "掩码/空值不应覆盖已存 Key")


class TestStudentsRoute(unittest.TestCase):
    def setUp(self) -> None:
        self.app = make_app()
        self.client = authed_client(self.app)

    def test_list_is_empty_at_first(self) -> None:
        response = self.client.get("/api/students")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_create_returns_contract_shape(self) -> None:
        response = self.client.post(
            "/api/students", json={"nickname": "小海", "gradeLevel": "primary_high"}
        )
        self.assertEqual(response.status_code, 200, response.text)

        body = response.json()
        self.assertEqual(
            sorted(body),
            [
                "createdAt",
                "currentChapter",
                "gradeLevel",
                "lastActiveAt",
                "nickname",
                "studentId",
            ],
            "学生出参字段必须与契约一致（camelCase）",
        )
        self.assertEqual(body["studentId"], "student_001")
        self.assertEqual(body["gradeLevel"], "primary_high")
        # ★ 新建学生一定「未选择章节」：空串而不是 null（前端只处理一种空值形态）
        self.assertEqual(body["currentChapter"], "")
        self.assertGreater(body["createdAt"], 0)

    def test_created_student_appears_in_list(self) -> None:
        self.client.post("/api/students", json={"nickname": "小海", "gradeLevel": "junior"})
        self.client.post("/api/students", json={"nickname": "小江", "gradeLevel": "senior"})

        students = self.client.get("/api/students").json()
        self.assertEqual([item["studentId"] for item in students], ["student_001", "student_002"])
        self.assertEqual([item["gradeLevel"] for item in students], ["junior", "senior"])

    def test_invalid_grade_level_is_rejected(self) -> None:
        response = self.client.post("/api/students", json={"nickname": "小海", "gradeLevel": "university"})
        self.assertEqual(response.status_code, 422, "学段只允许四个字面量")

    def test_blank_nickname_is_rejected(self) -> None:
        response = self.client.post("/api/students", json={"nickname": "   ", "gradeLevel": "junior"})
        self.assertEqual(response.status_code, 422)

    def test_unknown_field_is_rejected(self) -> None:
        response = self.client.post(
            "/api/students",
            json={"nickname": "小海", "gradeLevel": "junior", "realName": "张三"},
        )
        self.assertEqual(response.status_code, 422, "契约外字段（如真实姓名）必须被拒")

    def test_requires_token(self) -> None:
        anonymous = TestClient(make_app())
        self.assertEqual(anonymous.get("/api/students").status_code, 401)

    def test_app_instances_do_not_share_state(self) -> None:
        """一人一库的前置心智：不同 app 实例（不同学生目录）不共享内存状态。"""
        self.client.post("/api/students", json={"nickname": "小海", "gradeLevel": "junior"})
        other = authed_client(make_app())
        self.assertEqual(other.get("/api/students").json(), [])


# ---------------------------------------------------------------- 其他契约 --
class TestCitationSplit(unittest.TestCase):
    """`Citation`（事件载荷，5 字段冻结）与 `RagHit`（HTTP 层完整命中）的分工。"""

    def test_citation_has_exactly_the_frozen_fields(self) -> None:
        self.assertEqual(
            list(Citation.model_fields),
            ["chunk_id", "chapter_title", "section_title", "grade_level", "compat"],
            "citation 事件载荷必须与 §6.4 一字不差（票 13 的验收口径）",
        )

    def test_rag_hit_adds_internal_fields_without_touching_citation(self) -> None:
        extra = set(RagHit.model_fields) - set(Citation.model_fields)
        self.assertEqual(
            extra,
            {"parent_chunk_id", "text", "knowledge_point", "kp_id", "score", "degraded", "expanded"},
        )
        self.assertNotIn("text", Citation.model_fields, "父块正文不该进事件载荷")

    def test_rag_hit_can_be_projected_to_a_citation(self) -> None:
        hit = RagHit(
            chunk_id="chunk_001",
            chapter_title="第一章",
            section_title="1.1 身边的 AI",
            grade_level="junior",
            compat=True,
            text="父块完整内容",
            kp_id="kp_ai_around",
            score=0.83,
            degraded="fts",
            expanded=True,
        )
        citation = Citation(**hit.model_dump(include=set(Citation.model_fields)))
        self.assertEqual(
            citation.model_dump(by_alias=True),
            {
                "chunkId": "chunk_001",
                "chapterTitle": "第一章",
                "sectionTitle": "1.1 身边的 AI",
                "gradeLevel": "junior",
                "compat": True,
            },
        )
        self.assertEqual(len(citation.model_dump()), 5, "投影后必须只剩 5 个字段")


class TestPayloadContracts(unittest.TestCase):
    def test_student_is_camel_case(self) -> None:
        student = Student(
            student_id="student_001",
            nickname="小海",
            grade_level="junior",
            created_at=1,
            last_active_at=2,
        )
        self.assertEqual(
            sorted(student.model_dump(by_alias=True)),
            [
                "createdAt",
                "currentChapter",
                "gradeLevel",
                "lastActiveAt",
                "nickname",
                "studentId",
            ],
            "学生出参字段必须与契约一致（camelCase）",
        )
        # 章节默认空串（未选择）；不传也不报错 —— 老调用点不必逐个补参数
        self.assertEqual(student.current_chapter, "")

    def test_mastery_delta_is_clamped(self) -> None:
        """掌握度限幅 ±0.2（陷阱：不限幅一次答题就从 0 到 1）。"""
        QuizResult(qid="q1", correct=True, scored_by="rule", feedback="对了", mastery_delta=0.2)
        with self.assertRaises(ValidationError):
            QuizResult(qid="q1", correct=True, scored_by="rule", feedback="对了", mastery_delta=0.9)

    def test_quiz_grade_request_keeps_the_students_answer(self) -> None:
        request = QuizGradeRequest(student_id="student_001", qid="q1", answer=["3"])
        self.assertEqual(request.answer, ["3"])

    def test_extra_fields_are_forbidden_everywhere(self) -> None:
        with self.assertRaises(ValidationError):
            QuizPayload(kp_id="kp1", source="bank", questions=[], oops=1)  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
