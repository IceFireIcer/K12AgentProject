# -*- coding: utf-8 -*-
"""审计 M-7 的收口回归：调试模式（未配 token）不再开放明文凭据出口。

**这条路径值得单独一个文件**：它不是「某个业务接口的行为」，而是**启动方式**带来的
一套不同规则 —— 按 `AGENTS.md` §7 / 执行文档 §7.5 的原话跑
``cd server && uv run uvicorn app.main:app --port 8756``（模块级 app，没有握手、没有 token），
修复前**不带任何请求头**就能 ``GET /api/settings/runtime`` 拿到明文 API Key，
还能读任一学生的 ``learning.db``；叠加「为任意 localhost 来源回 CORS 头」，
本机随便一个 ``http://localhost:端口`` 页面用 JS 就能把这个响应读走（实测 200）。

修复的形态是**精准收口**，本文件把这三件事分别钉住：

1. 调试模式下 `/api/settings/runtime`（唯一吐明文 Key 的出口）**被拒且理由可读**；
   其余 `/api/*` 与 `/health` **照旧免鉴权** —— 「不带 token 也能调试」是这条命令存在的意义；
2. **反向对照**：带 token 的生产路径上该端点**仍然可用**（主进程取明文 Key 的唯一通路，
   收口绝不能把它一并关掉）；
3. CORS 的回环来源**收窄到实际的 dev server 端口**（vite 默认 5173），
   不再为任意 ``localhost:任意端口`` 回 CORS 头。

另有两组同批的回归（见各自的类注释说明为什么住在这里）：

- 打包态关掉 `/docs` 与 `/openapi.json`（它们免鉴权，等于暴露完整接口面）；
- ``import_knowledge.py`` 的 ``terminology.json`` notes **幂等**（连跑两次不追加）。

跑法::

    cd server && uv run python -m unittest tests.test_debug_mode_auth
"""

from __future__ import annotations

import json
import logging
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

import scripts.import_knowledge as import_knowledge  # noqa: E402
from app.config import RuntimeConfig, build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.safety import guard  # noqa: E402
from app.security import AUTH_HEADER  # noqa: E402

#: 与 Electron 侧 `randomBytes(32).toString('hex')` 同形（与 test_handshake_and_auth 一致）
TOKEN = "a" * 64

#: 「手工调试」的写法：**不传 token** —— 修复前这条路径对 `/api/*` 一律放行。
DEBUG_MODE = ""


def _client(*, token: str = DEBUG_MODE) -> TestClient:
    return TestClient(create_app(build_runtime_config(token=token)))


class _CapturingHandler(logging.Handler):
    """把格式化后的消息收进列表。

    **走 ``record.getMessage()``**，所以它同时能照出「脱敏把 %-占位符擦没了」这类
    格式化崩溃（与 `tests/test_safety.py` / `tests/test_settings_store.py` 同一手法）。
    """

    def __init__(self, sink: list[str]) -> None:
        super().__init__(level=logging.INFO)
        self.sink = sink

    def emit(self, record: logging.LogRecord) -> None:
        self.sink.append(record.getMessage())


class TestDebugModeClosesTheCredentialEndpoint(unittest.TestCase):
    """★ 调试模式下必须关掉**唯一**会返回明文 API Key 的出口。"""

    def test_runtime_endpoint_is_rejected_with_a_readable_reason(self) -> None:
        response = _client().get("/api/settings/runtime")
        self.assertEqual(
            response.status_code,
            403,
            f"调试模式下明文 Key 出口必须被拒，实际：{response.status_code} {response.text[:200]}",
        )
        detail = response.json()["detail"]
        # 理由要能照着做：说清「为什么被拒」「怎么才能用」，而不是一句 forbidden
        self.assertIn("调试模式", detail)
        self.assertIn("明文", detail)
        self.assertIn("--token", detail)
        self.assertIn(AUTH_HEADER, detail)

    def test_the_hint_names_a_command_that_actually_accepts_a_token(self) -> None:
        """★ 提示里给的命令必须**真能带 token**（否则比不给提示更糟：照着做还是 401）。

        `uvicorn` 的 CLI 只认它自己的选项 —— `--token` 是本应用自己的参数
        （`app/main.py` 的 `parse_args`），交给 uvicorn 只会得到
        `Error: No such option '--token'`（实测）。所以提示必须给**模块入口**形式。
        """
        detail = _client().get("/api/settings/runtime").json()["detail"]
        self.assertIn("python -m app.main", detail)
        self.assertNotIn(
            "uvicorn app.main:app --port 8756 --token",
            detail,
            "这条命令跑不起来：uvicorn 不认 --token",
        )

    def test_rejection_is_not_a_fake_404(self) -> None:
        """刻意不用 404 假装端点不存在 —— 调试的人得知道是**被收口**了，不是路由没挂上。"""
        response = _client().get("/api/settings/runtime")
        self.assertNotEqual(response.status_code, 404)
        self.assertIn("detail", response.json())

    def test_no_credential_field_leaks_through_the_rejection(self) -> None:
        """拒绝的同时一个凭据字段都不能回显。"""
        body = _client().get("/api/settings/runtime").text
        self.assertNotIn("apiKey", body)
        self.assertNotIn("api_key", body)

    def test_the_whole_endpoint_is_closed_not_just_get(self) -> None:
        """按**端点**整体关闭，不是只关 GET —— 否则换个方法就是一条绕行路。"""
        response = _client().post("/api/settings/runtime")
        self.assertEqual(response.status_code, 403)

    def test_trailing_slash_cannot_sneak_past_the_guard(self) -> None:
        """``/api/settings/runtime/`` 会被 Starlette 重定向到无斜杠形式 —— 路径比对必须先归一化。"""
        response = _client().get("/api/settings/runtime/")
        self.assertEqual(response.status_code, 403)

    def test_debug_convenience_is_preserved_for_other_api_endpoints(self) -> None:
        """★ 收口**只针对那一个端点**：其余 `/api/*` 照旧免鉴权（这是调试路径存在的意义）。

        ``/api/settings`` 是这批里的代表：它读的是**掩码**，调试时看得见、也拿不到凭据。
        """
        self.assertEqual(_client().get("/api/settings").status_code, 200)

    def test_health_stays_anonymous_in_debug_mode(self) -> None:
        """`/health` 有意免鉴权（启动期探活还没有凭据概念），收口不许把它一起关掉。"""
        self.assertEqual(_client().get("/health").status_code, 200)


class TestProductionPathStillReadsThePlaintextKey(unittest.TestCase):
    """★★ 反向对照：带 token 时该端点**必须仍然可用**。

    它是「设置页改了配置 → Pi 用新配置」这条链路的唯一载体（Pi 拿不到掩码 Key 就没法发请求），
    收口时最容易犯的错就是把它一并关掉 —— 那样图形界面里改设置就静默失效了。
    """

    def test_runtime_endpoint_still_returns_the_config_with_a_token(self) -> None:
        response = _client(token=TOKEN).get(
            "/api/settings/runtime", headers={AUTH_HEADER: TOKEN}
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("apiKey", response.json())

    def test_runtime_endpoint_still_requires_the_token_header(self) -> None:
        """带的 token 不对/没带 → 401（鉴权口径一点没变，收口也没把它变成免鉴权）。"""
        response = _client(token=TOKEN).get("/api/settings/runtime")
        self.assertEqual(response.status_code, 401, "缺 token 头时应当是 401，而不是收口的 403")

    def test_guard_is_inert_on_the_production_path(self) -> None:
        """有 token 时收口中间件**一次判断都不做**：错误 token 也不会被它拦成 403。"""
        response = _client(token=TOKEN).get(
            "/api/settings/runtime", headers={AUTH_HEADER: "b" * 64}
        )
        self.assertEqual(response.status_code, 401)


class TestCorsIsNarrowedToTheDevServerOrigin(unittest.TestCase):
    """★ 回环来源**不是**可信来源：收窄到实际会用的那个 dev server 端口。

    端口依据：`desktop/electron.vite.config.ts` 的渲染进程段没有配 `server.port`，
    所以走 vite 默认的 **5173**（electron-vite 把它写进 `ELECTRON_RENDERER_URL`，
    主进程用它 loadURL）。sidecar 自己的固定调试端口 8756 是**服务端**端口，
    从它上面加载的页面访问同端口是同源，本来就不经过 CORS。
    """

    def test_random_loopback_port_no_longer_gets_cors_headers(self) -> None:
        for origin in ("http://localhost:9999", "http://127.0.0.1:34567"):
            with self.subTest(origin=origin):
                response = _client().get("/health", headers={"Origin": origin})
                self.assertIsNone(
                    response.headers.get("access-control-allow-origin"),
                    f"{origin} 不该再被放行 —— 任意 localhost 页面都能读走响应",
                )

    def test_dev_server_origin_still_gets_cors_headers(self) -> None:
        for origin in ("http://localhost:5173", "http://127.0.0.1:5173"):
            with self.subTest(origin=origin):
                response = _client().get("/health", headers={"Origin": origin})
                self.assertEqual(
                    response.headers.get("access-control-allow-origin"), origin
                )

    def test_preflight_reflects_the_same_narrowed_policy(self) -> None:
        """预检与实际请求必须同一口径：否则浏览器照样把请求发出去（再被拒一次）。"""
        headers = {
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": AUTH_HEADER,
        }
        allowed = _client().options("/api/whatever", headers=headers)
        self.assertNotEqual(allowed.status_code, 401, "预检不带自定义头，绝不能被鉴权拦掉")
        self.assertEqual(
            allowed.headers.get("access-control-allow-origin"), "http://localhost:5173"
        )

        denied = _client().options(
            "/api/whatever",
            headers={**headers, "Origin": "http://localhost:9999"},
        )
        self.assertIsNone(denied.headers.get("access-control-allow-origin"))

    def test_file_origin_is_still_allowed(self) -> None:
        """`file://` 页面的 Origin 就是字符串 `"null"` —— 打包态它仍有意义，不能被收窄误伤。"""
        response = _client(token=TOKEN).get("/health", headers={"Origin": "null"})
        self.assertEqual(response.headers.get("access-control-allow-origin"), "null")


class TestDebugModeAlsoGetsLogRedaction(unittest.TestCase):
    """★ 调试路径过去**完全没有日志脱敏**（`install_log_redaction()` 只在 `main()` 里调用）。

    这条路径上「明文 Key 不进日志」的硬约束（执行文档 §12）形同虚设：任何一条把配置或
    请求打进日志的代码都会漏出明文，而调试时恰恰是日志看得最多的时候。

    判据必须走**真实子 logger + 真实 root handler**（生产形态）：`assertLogs` 会临时接管
    handler 树，恰好绕开脱敏真正改写的对象（这是 `tests/test_safety.py` 已经写明的教训）。

    顺序也与生产一致：**handler 先建好，create_app 里再装脱敏** —— 这正是本次修复的形式，
    所以这条断言会随「把 `install_log_redaction()` 从 `create_app()` 里挪走」一起变红。
    """

    #: 自建/校内网关形态的 Key：不在任何**形态规则**里，只有登记了才会被擦 ——
    #: 用 `sk-…` 会得到一条恒绿的假测试（见 `tests/test_settings_store.py` 的同类说明）。
    GATEWAY_KEY = "gw-8f3a2c1b9d4e6f70a1b2c3d4"

    def setUp(self) -> None:
        self.root = logging.getLogger()
        self._saved_handlers = list(self.root.handlers)
        self._saved_level = self.root.level
        self.addCleanup(self._restore_root)

        self.captured: list[str] = []
        self.handler = _CapturingHandler(self.captured)
        self.root.handlers = [self.handler]
        self.root.setLevel(logging.INFO)
        self.addCleanup(guard.clear_secrets)

    def _restore_root(self) -> None:
        for target in [*self.root.handlers, self.root]:
            target.filters = [
                f for f in target.filters if not isinstance(f, guard.RedactionFilter)
            ]
        self.root.handlers = self._saved_handlers
        self.root.setLevel(self._saved_level)

    def test_a_registered_key_never_reaches_the_handler(self) -> None:
        _client()  # ← 调试模式（token 为空）：只建 app，不改任何其它条件
        guard.register_secret(self.GATEWAY_KEY)

        # 生产形态：子 logger 经 propagate 把记录交给 root 的 handler
        logging.getLogger("app.routes.settings").warning(
            "保存后的诊断行 key=%s，重试 %d 次", self.GATEWAY_KEY, 2
        )

        self.assertTrue(self.captured, "子 logger 的记录没有到达 root 的 handler")
        self.assertNotIn(self.GATEWAY_KEY, self.captured[0], "调试路径漏出了明文 Key")
        self.assertIn("重试 2 次", self.captured[0], "脱敏不许破坏 %-格式化")


class TestDocsAreClosedInThePackagedBuild(unittest.TestCase):
    """打包态关掉 `/docs` 与 `/openapi.json`（审计 L 项）。

    ⚠️ 这组用例与 M-7 同批但归属**打包态**：两者都是「免鉴权的信息出口」——
    `/openapi.json` 实测暴露 34 条路径 / 85 个 schema（含 `/api/settings/runtime`
    及其明文 `apiKey` 属性说明），`/docs` 还附赠一个可交互控制台。
    生产包不需要它们（契约的 TS 类型是构建期生成的），开发/调试态保留（排查便利）。

    ⚠️ `/health` 不在关闭范围内：它是探活端点，必须一直可达。
    """

    def _frozen_client(self) -> TestClient:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg = RuntimeConfig(
            host="127.0.0.1",
            port=0,
            token=TOKEN,
            data_dir=Path(tmp.name),
            frozen=True,  # ← 等价于 PyInstaller 打包态（build_runtime_config 从这里取 sys.frozen）
        )
        return TestClient(create_app(cfg))

    def test_openapi_is_gone_in_the_packaged_build(self) -> None:
        self.assertEqual(self._frozen_client().get("/openapi.json").status_code, 404)

    def test_docs_console_is_gone_in_the_packaged_build(self) -> None:
        self.assertEqual(self._frozen_client().get("/docs").status_code, 404)

    def test_health_is_unaffected_by_the_packaging_switch(self) -> None:
        self.assertEqual(self._frozen_client().get("/health").status_code, 200)

    def test_development_build_keeps_the_schema_for_troubleshooting(self) -> None:
        """开发态保留（源码运行时的排查便利）—— 关掉它属于「顺手扩大影响面」。"""
        response = _client(token=TOKEN).get("/openapi.json")
        self.assertEqual(response.status_code, 200, "开发态应当保留 /openapi.json")
        self.assertIn("paths", response.json())


class TestTerminologyNotesAreIdempotent(unittest.TestCase):
    """``import_knowledge.py --write`` 的 notes 幂等（审计 L 项）。

    缺陷形态：``data["notes"] = notes_before + " ★ …重建下限：下调 N 条…"`` ——
    每跑一次 ``--write`` 就多一句。实测仓库里那句话**已出现 2 次**
    （连跑两次即复现），而且每次都自称「下调 N 条」，读的人无法判断哪句才是当前状态。

    判据就是「同一份输入跑两次 → 输出逐字节相同」。本组用例**只在临时目录里跑**，
    绝不碰 ``server/knowledge/`` 那份交付物。

    ⚠️ 为什么这组用例住在这个文件里：修复点的天然归属是 ``tests/test_knowledge_admin.py``，
    但那个文件不属于本次改动的可写范围（另一处在改），而 ``import_knowledge.py`` 也没有
    专属测试文件。它与本次安全收口同批修，故先寄居在此 —— 将来有专属文件时整组搬走即可。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name)
        # TARGET 是模块级常量，build_terminology() 直接读它 —— 换成临时目录即可
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(import_knowledge, "TARGET", self.target).start()
        # 不扫真实教材（那要 228 篇）：本组断言的是 notes 的追加/剔除逻辑
        mock.patch.object(import_knowledge, "_load_imported_docs", lambda: []).start()

    def _write_terminology(self, notes: str) -> Path:
        path = self.target / "terminology.json"
        path.write_text(
            json.dumps({"notes": notes, "terms": []}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    def _run_once(self) -> str:
        """跑一次「写盘」：模拟 ``--write`` 对 terminology.json 的那一次写入。"""
        path = self.target / "terminology.json"
        path.write_text(
            json.dumps(import_knowledge.build_terminology(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return path.read_text(encoding="utf-8")

    def test_running_twice_produces_a_byte_identical_file(self) -> None:
        self._write_terminology("学段错位自检用的术语文表：min_grade = 该术语最早可以出现的学段。")
        first = self._run_once()
        second = self._run_once()
        self.assertEqual(first, second, "连跑两次产物必须逐字节相同（notes 不能再长一句）")

    def test_only_one_appended_sentence_ever_exists(self) -> None:
        self._write_terminology("人工写的说明。")
        for round_index in range(3):
            with self.subTest(round=round_index):
                written = self._run_once()
                notes = json.loads(written)["notes"]
                self.assertEqual(
                    notes.count(import_knowledge.TERMINOLOGY_NOTE_MARKER),
                    1,
                    f"第 {round_index + 1} 次运行后说明句出现了多次：{notes}",
                )

    def test_historical_duplicates_are_cleaned_up(self) -> None:
        """★ 修复**已有**的重复：仓库里现在就有 2 句，跑一次就该收成 1 句。

        只删「新追加的那一句」是不够的 —— 那会把幂等降级成「恰好一次时才幂等」，
        而这次的缺陷形态正是**已经攒了多句**。
        """
        dup = (
            "人工写的说明。"
            + import_knowledge.TERMINOLOGY_NOTE_MARKER
            + "下调 7 条、新增 19 条。"
            + import_knowledge.TERMINOLOGY_NOTE_SUFFIX
            + import_knowledge.TERMINOLOGY_NOTE_MARKER
            + "下调 0 条、新增 0 条。"
            + import_knowledge.TERMINOLOGY_NOTE_SUFFIX
        )
        self._write_terminology(dup)
        notes = json.loads(self._run_once())["notes"]
        self.assertEqual(notes.count(import_knowledge.TERMINOLOGY_NOTE_MARKER), 1)
        self.assertIn("人工写的说明。", notes, "人工内容一个字都不许删")

    def test_strip_generated_note_keeps_human_text_untouched(self) -> None:
        human = "人工写的说明，含 markdown **加粗** 与数字 8756。"
        self.assertEqual(import_knowledge._strip_generated_note(human), human)
        self.assertEqual(import_knowledge._strip_generated_note(""), "")
        # 残缺的旧句（有人手工改坏了结尾）：从标记处截断，不留半句
        broken = human + import_knowledge.TERMINOLOGY_NOTE_MARKER + "下调 3 条（结尾被删）"
        self.assertEqual(import_knowledge._strip_generated_note(broken), human)

    def test_log_line_reports_the_counts_actually_written(self) -> None:
        """日志回显的条数必须来自**本次真正写下的**那句。

        旧实现写死「7 条下调 + 24 条新增」—— 那个数字只对第一次导入成立，
        之后每次重跑都是 0 条，日志与文件内容互相矛盾，而这条日志恰恰是排障唯一的线索。
        """
        self._write_terminology("人工写的说明。")
        printed = import_knowledge._generated_note_counts(import_knowledge.build_terminology())
        self.assertEqual(printed, "下调 0 条、新增 0 条")


if __name__ == "__main__":
    unittest.main()
