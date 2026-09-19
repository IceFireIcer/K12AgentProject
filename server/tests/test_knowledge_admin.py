# -*- coding: utf-8 -*-
"""教材知识库管理（清单 / 体检 / 导入 / 重建）的后端断言。

``/api/knowledge/*`` 的五条接口里，前三条是**读**，后两条是**本项目里唯一会写 kb 的两处**。
读的三条错了只会显示错数字；写的两条错了会「看起来成功、实际没生效」—— 所以本文件的重心在后两条：

1. ★★ **重建必须写标记文件**。``kb.sqlite`` 的解析顺序原本是「随包只读库优先于用户库」
   （升级后不该被用户目录里的旧库遮蔽），而重建只能写用户那一份。
   不写标记的话，打包态下学生重建完检索到的**还是老教材**：功能看起来成功，实际被遮蔽。
   所以「重建之后 ``default_kb_path`` 必须切到用户库」是这整件事的判据，也是本文件最重的一条断言。
2. ★★ **导入 + 重建是唯一真做 ``Path`` 运算的地方**。``RuntimeConfig.data_dir`` 声明为 ``Path``，
   但 Electron 通过 ``--data-dir`` 直传字符串时它就是 ``str``；``_rebuild_source_dir`` 里那句
   ``data_dir / 'shared' / 'knowledge-staging'`` 会抛
   ``TypeError: unsupported operand type(s) for /: 'str' and 'str'`` ——
   而且**只在「用户目录里已经有导入的教材」时才走到那一步**（纯重建看起来完全正常）。
   所以这里有一条「str data_dir + 真有导入内容」的整链路回归。
3. ★ **拒收与失败都要是可读的回执，不是 4xx/500**：导入被拒是 ``200 + ok=false + 逐条 problems``
   （失败原因是内容问题，界面要在同一张卡片里逐条列出来），重建失败是一句可读中文
   （模型缺失 / 教材格式错），**绝不能 500**。
4. ★ **顺序是教材顺序**：知识点清单按 kb 行序（入库序 = 教材定义序）排，不是字典序 ——
   字典序会让「第 10 章」排在「第 2 章」前面（章节列表那边已经踩过这个坑）。

跑法::

    cd server && uv run python -m unittest discover -s tests

★ 全程**不加载** 90MB 的 ONNX：重建路径用 ``scripts.build_kb`` 自己的两个接缝换成夹具嵌入器
（见 :meth:`KnowledgeAdminCase.fast_rebuild`），与 ``build_fixture_kb`` 同一口径 ——
新机器 clone 下来（没下模型）这些用例照样能跑。
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import RuntimeConfig, build_runtime_config  # noqa: E402
from app.main import create_app  # noqa: E402
from app.rag import retriever  # noqa: E402
from tests.test_kb_bundling import KbPathCase  # noqa: E402
from tests.test_store import FakeEmbedder, build_fixture_kb  # noqa: E402

TOKEN = "test-token-knowledge"

#: 五条接口的**完整**名单（精确集合断言：多一条少一条都要有人来显式改这里）
KNOWLEDGE_ROUTES = (
    "/api/knowledge/chapters/{grade_level}",
    "/api/knowledge/points",
    "/api/knowledge/stats",
    "/api/knowledge/import",
    "/api/knowledge/rebuild",
)

#: 一份**自造**的初中教材。
#:
#: ★ 刻意不抄 ``tests/test_store.py`` 的夹具正文：导入会跑「跨学段逐字搬运」检查，
#:   同一段正文在不同学段出现会被判违规 —— 想复用夹具正文必须先按学段改写。
#: ★ 正文里也不许出现 ``terminology.json`` 里 ``min_grade`` 高于初中的词
#:   （梯度下降 / 过拟合 / 学习率 …），否则它会以「超纲术语」的理由被拒。
JUNIOR_DOC = """---
kp_id: jr-import-probe
grade_level: junior
chapter_title: 第9章 导入验收
knowledge_point: 导入验收探针
content_type: concept
summary: 自造的一份教材，用来验收「导入 → 落盘 → 重建 → 检索得到」这条链路。
---

## 一、蜂巢里的分工

蜂巢里的每一只蜜蜂都有固定的活计：有的守在巢门口，有的搬运花粉，有的留在巢里照看幼虫。
这份分工表不是谁临时想出来的，而是长期试出来的。蜂巢越大的时候，分工表也就越细。
新的蜜蜂进巢之后，先跟着老蜜蜂做同一件事，做熟了再换到别的岗位上去。

## 二、分工表是怎么定下来的

分工表定下来之后，蜂巢里的活计就不再靠临时喊人。哪一格空着，就补谁上去。
"""

#: 检索断言用的查询：**逐字取自上面那份文档的正文**。
#: 夹具嵌入器保留「词面相似度」（共享汉字多的文本向量更接近），所以逐字取句能稳定命中。
JUNIOR_QUERY = "蜂巢里的每一只蜜蜂都有固定的活计"


def _junior_doc(kp_id: str, *, body_replace: tuple[tuple[str, str], ...] = ()) -> str:
    """把 :data:`JUNIOR_DOC` 的 kp_id / 正文换成另一份（用于各种「该被拒」的用例）。"""
    raw = JUNIOR_DOC.replace("kp_id: jr-import-probe", f"kp_id: {kp_id}")
    for old, new in body_replace:
        raw = raw.replace(old, new)
    return raw


class KnowledgeAdminCase(KbPathCase):
    """带「一份真实可用的夹具 kb」+「走真路由的 HTTP 客户端」的基类。

    继承 :class:`tests.test_kb_bundling.KbPathCase` 是为了**复用**它的两件前提：
    临时 data-dir、以及 ``K12_KB_PATH`` 的隔离与 ``retriever.reset_services()`` 收尾
    （那条环境变量若被外部环境设着，所有解析顺序断言都会失真）。
    """

    def setUp(self) -> None:
        super().setUp()
        # 夹具 kb 落在 <tmp>/shared/kb.sqlite —— **与运行期布局一致**，路由按 data-dir 找得到
        self.fixture_kb = build_fixture_kb(self.tmp, embedder=FakeEmbedder())
        self.app = create_app(build_runtime_config(token=TOKEN, data_dir=self.tmp))
        self.client = TestClient(self.app)
        self.client.headers.update({"X-Auth-Token": TOKEN})

    # ------------------------------------------------------------ 小工具 --
    @contextmanager
    def fast_rebuild(self) -> Iterator[None]:
        """让 ``/api/knowledge/rebuild`` 跑在夹具嵌入器上（不加载 90MB 的 ONNX）。

        ★ 必须 patch ``scripts.build_kb`` 这个**模块对象**：路由走的是
          ``from scripts.build_kb import build``，而 ``tests/test_store.py`` 里
          ``import build_kb`` 拿到的是**另一个**模块对象（``scripts/`` 直挂在 ``sys.path`` 上，
          与 ``scripts.build_kb`` 是两个不同的 module，实测确认）—— 补在错的模块上会**静默无效**。

        ``resolve_model_dir`` 一起换成不存在的目录：分词器找不到就退回启发式计数器，
        于是重建结果与「本机有没有下模型」无关（否则同一份断言在不同机器上会走不同分支）。
        """
        import scripts.build_kb as build_kb  # noqa: PLC0415 - 只在需要重建的用例里才 import

        with (
            mock.patch.object(build_kb, "LocalEmbedder", FakeEmbedder),
            mock.patch.object(build_kb, "model_files_present", return_value=True),
            mock.patch.object(build_kb, "resolve_model_dir", return_value=self.tmp / "no-model"),
        ):
            yield

    def import_doc(self, *, file_name: str, markdown: str, rebuild: bool = False, **extra) -> dict:
        response = self.client.post(
            "/api/knowledge/import",
            json={"fileName": file_name, "markdown": markdown, "rebuild": rebuild, **extra},
        )
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()


# --------------------------------------------------------------------------- #
# ① 路由面
# --------------------------------------------------------------------------- #
class TestRouteSurface(KnowledgeAdminCase):
    """五条接口的路径与参数**逐字**钉住（前端与主进程按这些字符串调用）。"""

    def test_五条接口都在且路径与契约一字不差(self) -> None:
        paths = self.app.openapi()["paths"]
        actual = sorted(path for path in paths if path.startswith("/api/knowledge"))
        self.assertEqual(
            actual,
            sorted(KNOWLEDGE_ROUTES),
            "教材知识库的接口清单变了。新增/删除接口必须显式改 KNOWLEDGE_ROUTES，"
            "并重跑 scripts/export_openapi.py + desktop 的 npm run gen:api",
        )

    def test_隐藏的兼容参数不出现在契约里(self) -> None:
        """``gradeLevel`` / ``studentId`` 是**下划线/驼峰并存期**的内部兼容入参。

        它们刻意 ``include_in_schema=False``：对外契约只认 snake_case（导出脚本会转成 camelCase），
        两个名字同时进契约会让前端生成出两份参数。
        """
        paths = self.app.openapi()["paths"]
        for path, expected in (
            ("/api/knowledge/chapters/{grade_level}", {"grade_level", "student_id"}),
            ("/api/knowledge/points", {"grade_level"}),
        ):
            names = {p["name"] for p in paths[path]["get"]["parameters"]}
            self.assertEqual(names, expected, f"{path} 的查询参数与契约不一致：{names}")


# --------------------------------------------------------------------------- #
# ② 知识点清单
# --------------------------------------------------------------------------- #
class TestPoints(KnowledgeAdminCase):
    def test_知识点顺序是教材顺序而不是字典序(self) -> None:
        """★ 顺序按 kb 的**行序**（入库序 = 教材定义序），不是字典序、也不是按名字。

        字典序会把「第 10 章」排到「第 2 章」前面（章节列表那边踩过同一个坑）；
        而这里更强的证据是：夹具三个点的**字典序与教材顺序本来就不同**
        （``fx-junior-a`` < ``fx-low-a`` < ``fx-senior-a``），
        所以只要有人把 ``ORDER BY rowid`` 改成 ``ORDER BY kp_id``，这条断言立刻红。
        """
        body = self.client.get("/api/knowledge/points").json()
        order = [item["kpId"] for item in body["points"]]
        self.assertEqual(order, ["fx-low-a", "fx-junior-a", "fx-senior-a"])
        self.assertNotEqual(
            order,
            sorted(order),
            "夹具三点的字典序与教材顺序必须不同，否则这条断言抓不到「改成按 kp_id 排」",
        )

    def test_每个点都带章节_类型与分块数(self) -> None:
        body = self.client.get("/api/knowledge/points").json()
        for item in body["points"]:
            self.assertTrue(item["name"])
            self.assertTrue(item["chapterTitle"])
            self.assertIn(item["contentType"], ("concept", "principle", "practice", "ethics", "project"))
            self.assertGreater(item["chunkCount"], 0, "有分块才会进清单（0 分块的点无处可检索）")
            self.assertTrue(item["embedded"], "夹具库是带向量建的，每行都该有向量")

    def test_分块数只算子块不把父块算进去(self) -> None:
        """★ ``chunkCount`` 的语义 = **可检索的子块数**，不是父子块总数。

        父块只是「命中之后回填的上下文容器」，KNN 与 FTS 都只吃子块；
        把父块一起算进去，「这一行有多少东西可检索」这个数字就虚高了。

        ⚠️ 契约 ``KnowledgePointItem.chunk_count`` 的注释写的是「父子块都算」（旧措辞）——
        以本实现为准，契约措辞待同步（契约文件冻结，不在本票范围内）。
        """
        from app.store.connections import connect  # noqa: PLC0415

        conn = connect(self.fixture_kb, readonly=True)
        try:
            rows = {
                str(row[0]): int(row[1])
                for row in conn.execute(
                    "SELECT knowledge_point, COUNT(*) FROM chunk WHERE is_parent = 0 "
                    "GROUP BY knowledge_point"
                )
            }
            all_chunks = int(conn.execute("SELECT COUNT(*) FROM chunk").fetchone()[0])
        finally:
            conn.close()

        points = self.client.get("/api/knowledge/points").json()["points"]
        for item in points:
            self.assertEqual(
                item["chunkCount"],
                rows[item["kpId"]],
                f"{item['kpId']} 的分块数与子块数不一致（大概是把父块也算进去了）",
            )
        self.assertGreater(all_chunks, sum(rows.values()), "夹具库本来就该有父块，否则这条断言没意义")

    def test_按学段过滤只回该学段(self) -> None:
        for grade, expected in (
            ("primary_low", ["fx-low-a"]),
            ("junior", ["fx-junior-a"]),
            ("senior", ["fx-senior-a"]),
        ):
            with self.subTest(grade=grade):
                body = self.client.get("/api/knowledge/points", params={"grade_level": grade}).json()
                self.assertEqual(body["gradeLevel"], grade)
                self.assertEqual([item["kpId"] for item in body["points"]], expected)

    def test_不带过滤回全部学段且不声称某个学段(self) -> None:
        body = self.client.get("/api/knowledge/points").json()
        self.assertIsNone(body["gradeLevel"], "没过滤时不该声称某个学段")
        self.assertEqual(len(body["points"]), 3)

    def test_非法学段是422而不是空表(self) -> None:
        """★ 拼错学段必须 422：回一张空表看起来像「这个学段还没编教材」，两者要分得开。"""
        response = self.client.get("/api/knowledge/points", params={"grade_level": "kindergarten"})
        self.assertEqual(response.status_code, 422, response.text)

    def test_缺库是503而不是空表(self) -> None:
        empty = Path(tempfile.mkdtemp(prefix="k12-nokb-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(empty, ignore_errors=True))
        app = create_app(build_runtime_config(token=TOKEN, data_dir=empty))
        client = TestClient(app, headers={"X-Auth-Token": TOKEN})
        response = client.get("/api/knowledge/points")
        self.assertEqual(response.status_code, 503, response.text)
        self.assertIn("build_kb", response.json()["detail"], "503 要给出可照做的中文指引")


# --------------------------------------------------------------------------- #
# ③ 体检数字
# --------------------------------------------------------------------------- #
class TestStats(KnowledgeAdminCase):
    def test_体检数字与真实行数一致且向量可用(self) -> None:
        """★ ``chunk_vec`` 是 ``vec0`` 虚表：**不先加载 sqlite-vec 扩展，``COUNT(*)`` 会静默给 0**。

        这正是修过的真缺陷：随包库有 185 条向量，界面却显示「向量引擎不可用」。
        所以这里断言的不是「有个 chunk_vec 键」，而是「它的行数与子块数相等且 > 0」——
        只有真的把扩展加载起来数过一遍才可能成立。
        """
        body = self.client.get("/api/knowledge/stats").json()
        counts = body["counts"]
        self.assertEqual(counts["kp"], 3)
        self.assertGreater(counts["child_chunk"], 0)
        self.assertEqual(
            counts["chunk_vec"],
            counts["child_chunk"],
            "每个子块都该有一条向量；若为 0，说明读统计时没有加载 sqlite-vec 扩展",
        )
        self.assertTrue(body["vecReady"], "夹具库能数出向量行，就该报可用")
        self.assertEqual(body["embeddingDim"], 512, "维度是契约常量，改了要连带重建 vec0")
        self.assertEqual(body["gradeLevels"], ["primary_low", "junior", "senior"])

    def test_连续两次体检结果一致且不影响其它接口(self) -> None:
        """★ 读 stats 是「临时加载一次扩展」的重活，**不能把连接的后续使用者毒掉**。

        每个请求各自开关连接（``open_kb_readonly`` 里没有共享连接），所以这里断言的是
        最外层能看得见的行为：同样的数据连着读两次结果相同，且紧随其后的另一个接口仍能正常返回。
        """
        first = self.client.get("/api/knowledge/stats").json()
        second = self.client.get("/api/knowledge/stats").json()
        self.assertEqual(first, second, "同一份 kb 两次体检结果不同（说明读统计留下了副作用）")
        points = self.client.get("/api/knowledge/points")
        self.assertEqual(points.status_code, 200, points.text)
        self.assertEqual(len(points.json()["points"]), 3)

    def test_没重建过时指向随包库且userRebuilt为false(self) -> None:
        """没写过重建标记 → 解析顺序停在「随包库优先」，回执也要如实说是哪一份。"""
        bundled = self.bundled_copy()
        # ★ 整个断言都在 patch 之内：出了这个 with，``default_kb_path`` 又会看到真实的
        #   ``app.config.bundled_kb_path()``（源码态没有随包库）—— 那断言就不是它想断言的东西了。
        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            body = self.client.get("/api/knowledge/stats").json()
            resolved = retriever.default_kb_path(self.tmp)
        self.assertFalse(body["userRebuilt"])
        # ★ 一律 ``.resolve()`` 后比：Windows 临时目录的短名（``ICEFIR~1``）与长名是两条字符串，
        #   路由侧的 data_dir 经 ``resolve_data_dir`` 解析过，直接比字符串会假红。
        self.assertEqual(Path(body["kbPath"]).resolve(), bundled.resolve(), "没重建过就该读随包只读库")
        self.assertEqual(resolved.resolve(), bundled.resolve())


# --------------------------------------------------------------------------- #
# ④ 导入（校验即闸门）
# --------------------------------------------------------------------------- #
class TestImport(KnowledgeAdminCase):
    def test_成功导入落盘到用户教材目录(self) -> None:
        """落点必须是 ``<data-dir>/knowledge-user/<学段目录>/<kp_id>.md``。

        ★ 落点错一个字就是「导入成功但检索不到」：随包教材的目录用连字符
          （``primary-low``）而学段值是下划线（``primary_low``），反向映射只有一处实现，
          它错了这里就会红。**不重建时也照样落盘**（正文先存下来，重建可以稍后再跑）。
        """
        body = self.import_doc(file_name="jr-import-probe.md", markdown=JUNIOR_DOC)
        self.assertTrue(body["ok"], body)
        self.assertEqual(body["kpId"], "jr-import-probe")
        self.assertEqual(body["savedAs"], "knowledge-user/junior/jr-import-probe.md")
        self.assertEqual(body["problems"], [])

        landed = self.tmp / "knowledge-user" / "junior" / "jr-import-probe.md"
        self.assertTrue(landed.is_file(), f"导入的教材没落盘：{landed}")
        self.assertIn(JUNIOR_QUERY, landed.read_text(encoding="utf-8"))

    def test_不重建时那份内容还检索不到(self) -> None:
        """★ 导入与重建是两件事：只落盘的话 kb 里没有它 —— 回执必须说清楚（而不是让人以为已经生效）。"""
        body = self.import_doc(file_name="jr-import-probe.md", markdown=JUNIOR_DOC)
        self.assertIn("未重建", body["message"])
        self.assertIsNone(body["stats"])
        listed = self.client.get("/api/knowledge/points", params={"grade_level": "junior"}).json()
        self.assertNotIn("jr-import-probe", [item["kpId"] for item in listed["points"]])

    def test_缺少文件头被拒且不落盘(self) -> None:
        body = self.import_doc(file_name="jr-no-header.md", markdown="## 一、没有文件头\n正文若干。")
        self.assertFalse(body["ok"])
        self.assertTrue(body["problems"])
        self.assertIn("文件头", " ".join(body["problems"]))
        self.assertIsNone(body["kpId"], "被拒的导入不该回一个 kpId（会被误当成成功）")
        self.assertFalse((self.tmp / "knowledge-user").exists(), "被拒的导入不该留下任何文件")

    def test_文件名与kp_id不一致被拒(self) -> None:
        """约定「文件名 = kp_id.md」：不一致会让「按文件名找知识点」的约定整体失效。"""
        body = self.import_doc(
            file_name="jr-other.md", markdown=_junior_doc("jr-mismatch")
        )
        self.assertFalse(body["ok"])
        self.assertIn("与文件名不一致", " ".join(body["problems"]))
        self.assertFalse((self.tmp / "knowledge-user").exists())

    def test_所选学段与文件头不一致被拒(self) -> None:
        """★ 学段错位会让检索隔离完全错位（初中内容挂到高中 = 直接超纲）。"""
        body = self.import_doc(
            file_name="jr-import-probe.md", markdown=JUNIOR_DOC, gradeLevel="senior"
        )
        self.assertFalse(body["ok"])
        self.assertIn("不一致", " ".join(body["problems"]))
        self.assertFalse((self.tmp / "knowledge-user").exists())

    def test_超纲术语被拒(self) -> None:
        """★ 「梯度下降」最早出现在高中：写进初中教材就是超纲 —— 检索层完全看不出来，只能在这里拦。"""
        body = self.import_doc(
            file_name="jr-bad-term.md",
            markdown=_junior_doc("jr-bad-term", body_replace=(("蜂巢", "梯度下降"),)),
        )
        self.assertFalse(body["ok"])
        problems = " ".join(body["problems"])
        self.assertIn("[term]", problems, "违规要带类别前缀，界面按它分类展示")
        self.assertIn("梯度下降", problems)
        self.assertIn("超纲", problems)

    def test_语气错位被拒(self) -> None:
        """★ 把小学低年级的拟人语气搬到初中是最典型的静默质量事故（照样命中、照样回答）。"""
        body = self.import_doc(
            file_name="jr-bad-tone.md",
            markdown=_junior_doc("jr-bad-tone", body_replace=(("蜜蜂", "宝贝"),)),
        )
        self.assertFalse(body["ok"])
        self.assertIn("[tone]", " ".join(body["problems"]))


# --------------------------------------------------------------------------- #
# ⑤ 重建（本项目唯一会写 kb 的地方）
# --------------------------------------------------------------------------- #
class TestRebuild(KnowledgeAdminCase):
    def test_重建写标记并把解析顺序切到用户库(self) -> None:
        """★★ **本文件最重的一条**：重建必须真的生效。

        背景：``default_kb_path`` 原本让随包只读库优先于用户库（升级后不该被旧库遮蔽），
        而重建只能写用户那一份。所以「重建完 ``default_kb_path`` 必须切到用户库」
        是「学生导入的教材立刻能检索到」的**唯一判据** ——
        少了标记文件，功能看起来成功而检索到的还是老教材。

        这里同时钉住三件事：① 标记文件真的被写出来；② 解析顺序真的换了；
        ③ 读到的确实是**新库**（知识点数量从夹具的 3 涨到重建后的几十个，证明确实换了文件）。
        """
        bundled = self.bundled_copy()
        with mock.patch.object(retriever, "bundled_kb_path", return_value=bundled):
            before = self.client.get("/api/knowledge/stats").json()
            self.assertFalse(before["userRebuilt"])
            self.assertEqual(
                Path(before["kbPath"]).resolve(), bundled.resolve(), "前提：没重建过时读的是随包库"
            )

            with self.fast_rebuild():
                response = self.client.post("/api/knowledge/rebuild")
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["ok"], body)
            self.assertGreater(body["documents"], 0)
            self.assertGreater(body["elapsedMs"], 0, "回执要带耗时（界面显示「用时 N.Ns」，否则像卡死）")

            marker = retriever.user_rebuild_marker_path(self.tmp)
            self.assertTrue(marker.is_file(), "重建成功必须写标记文件，否则新库会被随包库遮蔽")
            self.assertEqual(
                retriever.default_kb_path(self.tmp).resolve(),
                retriever.per_user_kb_path(self.tmp).resolve(),
                "有标记之后解析顺序必须切到用户库",
            )

            after = self.client.get("/api/knowledge/stats").json()
            self.assertTrue(after["userRebuilt"])
            # ★ 比路径一律 ``.resolve()``：Windows 短名/长名是两条字符串（见上一条用例的说明）
            self.assertEqual(
                Path(after["kbPath"]).resolve(),
                retriever.per_user_kb_path(self.tmp).resolve(),
            )
            self.assertGreater(
                after["counts"]["kp"], before["counts"]["kp"], "读到的应当是新库，不是随包的那一份"
            )
            self.assertNotEqual(Path(after["kbPath"]).resolve(), bundled.resolve())

    def test_标记写不了时回执必须说失败而不是成功(self) -> None:
        """★★ **重建成功但标记写不进去 = 新库不会生效**，这种情况绝不能报成功。

        这是本项目里最阴的一条失败形态：库建好了、检索却还指着旧的那一份
        （标记文件才是解析顺序的开关，见 ``retriever.user_rebuild_marker_path``）。
        报成功的话，学生看到的是「重建完成」，实际什么都没变 —— 比直接失败更难查。

        触发方式：用一个**同名目录**占住标记文件的位置（``Path.write_text`` 会抛
        ``IsADirectoryError``）—— 比 patch 掉写入函数更接近真实（真的写不进去），
        也不碰任何内部实现。
        """
        marker = retriever.user_rebuild_marker_path(self.tmp)
        marker.mkdir(parents=True, exist_ok=True)

        with self.fast_rebuild():
            with self.assertLogs("app.routes.knowledge", level="ERROR"):
                response = self.client.post("/api/knowledge/rebuild")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"], "标记写不了却报成功：学生会以为新库生效了，实际检索还指着旧的")
        self.assertIn("标记写入失败", body["message"])
        self.assertIn("不会生效", body["message"])
        # 回执仍然带「当前生效的那份库」的数字（装饰性字段，读不到也只是 None）
        self.assertIsNotNone(body["stats"])
        self.assertGreater(body["stats"]["counts"]["kp"], 0)
        self.assertTrue(body["stats"]["vecReady"], "统计里 vector 的可用性要与 /stats 同一判据")

    def test_重建成功回执带统计与向量状态(self) -> None:
        with self.fast_rebuild():
            body = self.client.post("/api/knowledge/rebuild").json()
        self.assertTrue(body["ok"], body)
        stats = body["stats"]
        self.assertGreater(stats["counts"]["kp"], 0)
        self.assertGreater(stats["counts"]["chunk_vec"], 0, "重建必须带向量（没向量检索只能降级）")
        self.assertTrue(stats["userRebuilt"])
        self.assertTrue(stats["vecReady"])
        self.assertEqual(stats["embeddingDim"], 512)
        self.assertIn("重建完成", body["message"])

    def test_重建失败回ok_false与可读中文而不是500(self) -> None:
        """★★ 失败要能被界面直接显示出来，**不能是 500**。

        用「模型文件不在」这个最真实的失败（新机器还没跑 fetch_embedding_model.py）来触发：
        学生此时看到的是操作指引，而不是一个内部错误码。

        ★ 同时钉住「**失败不写标记**」：先写标记再失败的话，之后检索会指向一份
          根本没建起来的库（比不生效更糟 —— 它会让整页检索打空）。
        """
        import scripts.build_kb as build_kb  # noqa: PLC0415

        with mock.patch.object(build_kb, "model_files_present", return_value=False):
            # ★ 顺手断言「失败要留痕」：界面看到的是回执，排障看的是日志。
            #   用 assertLogs 而不是让这行日志直接打到测试输出里（否则每跑一次都要看一遍噪音）。
            with self.assertLogs("app.routes.knowledge", level="WARNING"):
                response = self.client.post("/api/knowledge/rebuild")
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIsNone(body["stats"])
        self.assertIn("重建失败", body["message"])
        self.assertIn("嵌入模型缺失", body["message"], "失败原因要能照着修")
        self.assertIn("fetch_embedding_model", body["message"], "要给出下一步该跑什么")
        self.assertFalse(
            retriever.user_rebuild_marker_path(self.tmp).exists(),
            "重建失败不该写标记（写了会让检索指向一份不存在的库）",
        )


# --------------------------------------------------------------------------- #
# ⑥ 导入 + 重建整链路（Bug 回归：str data_dir 下的 staging 合并）
# --------------------------------------------------------------------------- #
class TestImportRebuildChain(KnowledgeAdminCase):
    """★ 回归用例：``data_dir`` 是**字符串**时，「导入 + 重建」必须走通。

    缺陷现场：``RuntimeConfig.data_dir`` 声明为 ``Path``，Electron 直传字符串时它是 ``str``。
    ``per_user_kb_path()`` / ``user_rebuild_marker_path()`` 内部各自 ``Path(base)`` 一次，
    所以**纯重建**（用户目录里没有任何导入内容）看起来完全正常；
    唯一真做 ``data_dir / 'shared' / 'knowledge-staging'`` 的是 ``_rebuild_source_dir()``
    —— 于是只有「用户已经有导入的教材」时才抛
    ``TypeError: unsupported operand type(s) for /: 'str' and 'str'``。

    所以本用例**刻意**：① 用 ``RuntimeConfig(data_dir=str(...))`` 直构（模拟 Electron），
    ② 先导入再重建（逼出 staging 合并那条路），③ 最后确认那份内容**真的检索得到**
    （重建了但检索不到 = 等于没导入）。
    """

    def _string_data_dir_app(self) -> tuple[TestClient, Path]:
        """给一个「data_dir 是 str」的应用（与 Electron 传参形态一致）。"""
        tmp = self.tmp / "str-data-dir"
        tmp.mkdir()
        cfg = RuntimeConfig(
            host="127.0.0.1",
            port=0,
            token=TOKEN,
            data_dir=str(tmp),  # ★ 就是这个 str：声明为 Path 的字段在运行时并不自动转换
            log_level="warning",
            frozen=False,
        )
        return TestClient(create_app(cfg), headers={"X-Auth-Token": TOKEN}), tmp

    def test_字符串data_dir下导入加重建走通整条链路(self) -> None:
        client, tmp = self._string_data_dir_app()

        # ① 导入 + 立即重建（staging 合并那条路）
        with self.fast_rebuild():
            response = client.post(
                "/api/knowledge/import",
                json={"fileName": "jr-import-probe.md", "markdown": JUNIOR_DOC, "rebuild": True},
            )
            self.assertEqual(response.status_code, 200, response.text)
            body = response.json()
            self.assertTrue(body["ok"], body)
            self.assertNotIn("TypeError", body["message"], "str/Path 的路径运算又漏了一处")
            self.assertGreater(body["stats"]["counts"]["kp"], 0)
            self.assertTrue(body["stats"]["userRebuilt"])

            staging = tmp / "shared" / "knowledge-staging"
            self.assertTrue((staging / "junior" / "jr-import-probe.md").is_file(),
                            "重建前应该把用户导入的教材并进 staging（否则导入的内容根本不参与建库）")
            self.assertTrue((staging / "manifest.json").is_file(), "依赖图清单要一起带进 staging")

            # ② 那份内容必须真的进了库、并且带向量
            listed = client.get("/api/knowledge/points", params={"grade_level": "junior"}).json()
            imported = next(
                (item for item in listed["points"] if item["kpId"] == "jr-import-probe"), None
            )
            self.assertIsNotNone(imported, "导入的知识点没进重建后的库 —— 等于没导入")
            self.assertGreater(imported["chunkCount"], 0)
            self.assertTrue(imported["embedded"], "没向量的点检索时会静默降档")

            # ③ 真检索一次（夹具嵌入器）：重建生效 = 查得到，而不只是行数对得上
            with mock.patch.object(retriever, "get_local_embedder", return_value=FakeEmbedder()):
                retriever.reset_services()
                retriever.get_service(data_dir=tmp, force_new=True)
                hits = client.post(
                    "/api/rag/search",
                    json={"query": JUNIOR_QUERY, "gradeLevel": "junior", "topK": 5},
                ).json()
            self.assertTrue(hits["hits"], "重建完却检索不到，说明标记/解析顺序没生效")
            self.assertIn("jr-import-probe", {hit["kpId"] for hit in hits["hits"]})

            # ④ 再重建一次：staging 每次先清再建，计数不该翻倍（翻倍 = 教材被复制了两遍）
            again = client.post("/api/knowledge/rebuild").json()
            self.assertTrue(again["ok"], again)
            self.assertEqual(
                again["stats"]["counts"]["kp"],
                body["stats"]["counts"]["kp"],
                "连建两次知识点数不同：staging 里的旧文件没被清掉（重复计数）",
            )
            self.assertEqual(
                again["stats"]["counts"]["chunk"],
                body["stats"]["counts"]["chunk"],
                "连建两次分块数不同：staging 里的旧文件没被清掉（重复计数）",
            )


if __name__ == "__main__":
    unittest.main()
