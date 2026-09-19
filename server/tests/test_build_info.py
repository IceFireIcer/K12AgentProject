# -*- coding: utf-8 -*-
"""构建指纹（``scripts/build_info.py``）的回归 —— P-072 的后端一侧。

**背景**：sidecar 是独立打包的产物，不随 `electron-vite build` 更新，而
`electron-builder` 只是把磁盘上**现成的那份** exe 拷进安装包。于是「改了 ``server/``
却没重打包」的安装包能顺利构建、能过全部单测，只是**包里跑的是几天前的后端**。

本文件钉住这套机制的**判定语义**（不是实现细节）：

1. **稳定**：同一份源码连算两次必须同一个值；换个空目录也不是「随便一个值」；
2. **敏感**：任何会进包的文件变一点，指纹必须变（否则机制形同虚设）；
3. **不误报**：``tests/`` / ``__pycache__`` / ``dist/`` 这些**不进包**的东西变了不该触发重打；
4. **诚实**：缺少 ``build-info.json`` 的旧产物一律判**过期**（失败方向是多重打一次，
   而不是「过期却判新鲜」）；
5. **接线**：``build_server.py`` 真的把指纹写进产物、自检里真的断言新鲜，
   且 ``--verify`` 与 ``--if-stale`` 互斥（两者的语义是对立的）。
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
if str(ROOT / "scripts") not in sys.path:
    sys.path.insert(0, str(ROOT / "scripts"))

import build_info  # noqa: E402

BUILD_SERVER = ROOT / "scripts" / "build_server.py"


class FingerprintStabilityCase(unittest.TestCase):
    """对**真实源码树**的稳定性断言（只读，不改任何文件）。"""

    def test_two_runs_agree(self) -> None:
        first = build_info.compute_fingerprint(ROOT)
        second = build_info.compute_fingerprint(ROOT)
        self.assertEqual(first["fingerprint"], second["fingerprint"])
        self.assertRegex(str(first["fingerprint"]), r"^[0-9a-f]{64}$")

    def test_covers_real_sources(self) -> None:
        """指纹必须覆盖到 app/ 与 scripts/ 下的真实文件（不是空集合）。"""
        info = build_info.compute_fingerprint(ROOT)
        self.assertGreater(info["fileCount"], 50, "指纹覆盖的文件太少，像是把 app/ 漏掉了")

        relative = {rel for rel, _ in build_info.iter_source_files(ROOT)}
        self.assertIn("app/main.py", relative)
        self.assertIn("scripts/build_server.py", relative)
        self.assertIn("packaging/k12-agent-server.spec", relative)
        self.assertIn("pyproject.toml", relative)
        # 教材是「重建能力」的载体，随包分发 → 必须进指纹
        self.assertTrue(
            any(rel.startswith("knowledge/") for rel in relative),
            "knowledge/ 下的教材必须进指纹（它随包分发）",
        )

    def test_excludes_non_shipped_paths(self) -> None:
        """不进包的东西**不得**进指纹 —— 否则改个测试就触发几分钟的重打包。"""
        relative = {rel for rel, _ in build_info.iter_source_files(ROOT)}
        for rel in relative:
            parts = rel.split("/")
            self.assertNotIn("__pycache__", parts, f"{rel} 不该进指纹")
            self.assertNotIn("tests", parts, f"{rel} 是测试，不进包，不该进指纹")
            self.assertFalse(rel.endswith(".pyc"), f"{rel} 是编译缓存，不该进指纹")
            self.assertFalse(rel.startswith("dist/"), f"{rel} 是产物，不该进指纹")
            self.assertFalse(rel.startswith("build/"), f"{rel} 是产物，不该进指纹")
            self.assertFalse(
                rel.startswith("resources/kb/"),
                f"{rel} 是构建产出（build_kb.py 现建），不是源码输入，不该进指纹",
            )

    def test_git_state_does_not_affect_fingerprint(self) -> None:
        """指纹是**内容**的函数，不是 commit 的函数。

        ★ 这条很重要：未提交的改动也必须能让指纹变 —— 否则「改了、没提交、直接打包」
        会被判成「新鲜」（因为 commit 没变），那正是最危险的失败方向。
        """
        info = build_info.compute_fingerprint(ROOT)
        payload = build_info.build_info_payload(ROOT, info=info)
        self.assertEqual(payload["fingerprint"], info["fingerprint"])
        # commit 只作溯源展示
        self.assertIn("gitCommit", payload)


class FingerprintSensitivityCase(unittest.TestCase):
    """在**临时副本**上验证灵敏度与稳定性（不碰真实源码树）。

    刻意只复制会进指纹的那几样：一个 ``app/`` 目录 + ``pyproject.toml``。
    这样单条用例是毫秒级的，不需要复制 91MB 模型。
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "server"
        (self.root / "app").mkdir(parents=True)
        (self.root / "app" / "main.py").write_text("print('hello')\n", encoding="utf-8")
        (self.root / "pyproject.toml").write_text("[project]\nname='x'\n", encoding="utf-8")
        self.addCleanup(self._tmp.cleanup)

    def fingerprint(self) -> str:
        return str(build_info.compute_fingerprint(self.root)["fingerprint"])

    def test_content_change_moves_fingerprint(self) -> None:
        before = self.fingerprint()
        (self.root / "app" / "main.py").write_text("print('changed')\n", encoding="utf-8")
        self.assertNotEqual(before, self.fingerprint(), "改了 app/ 下的源码，指纹必须变")

    def test_new_file_moves_fingerprint(self) -> None:
        before = self.fingerprint()
        (self.root / "app" / "extra.py").write_text("x = 1\n", encoding="utf-8")
        self.assertNotEqual(before, self.fingerprint(), "新增源文件必须让指纹变")

    def test_size_only_subtree_still_moves_on_size_change(self) -> None:
        """``resources/models/`` 只记大小，但**大小变了必须让指纹变**。"""
        model_file = self.root / "resources" / "models" / "fastembed" / "model.onnx"
        model_file.parent.mkdir(parents=True)
        model_file.write_bytes(b"a" * 64)
        before = self.fingerprint()

        # 同尺寸改写内容：按设计**不**触发变化（逐字节哈希 91MB 不值得）
        model_file.write_bytes(b"b" * 64)
        self.assertEqual(before, self.fingerprint(), "同尺寸的模型改写按设计不触发（只记大小）")

        # 尺寸变化：必须触发
        model_file.write_bytes(b"b" * 128)
        self.assertNotEqual(before, self.fingerprint(), "模型体积变了必须让指纹变")

    def test_ignored_paths_do_not_move_fingerprint(self) -> None:
        before = self.fingerprint()

        tests_dir = self.root / "tests"
        tests_dir.mkdir()
        (tests_dir / "test_x.py").write_text("def test_x(): pass\n", encoding="utf-8")
        pycache = self.root / "app" / "__pycache__"
        pycache.mkdir()
        (pycache / "main.cpython-312.pyc").write_bytes(b"\x00\x01")
        dist = self.root / "dist" / "k12-agent-server"
        dist.mkdir(parents=True)
        (dist / "k12-agent-server.exe").write_bytes(b"MZ")
        kb_dir = self.root / "resources" / "kb"
        kb_dir.mkdir(parents=True)
        (kb_dir / "kb.sqlite").write_bytes(b"SQLite format 3\x00")

        self.assertEqual(before, self.fingerprint(), "不进包的东西改了不该让指纹变（否则每次改测试都要重打包）")

    def test_rejects_non_server_root(self) -> None:
        with self.assertRaises(FileNotFoundError):
            build_info.compute_fingerprint(Path(self._tmp.name))


class BuildInfoFileCase(unittest.TestCase):
    """``build-info.json`` 的读写与新鲜度判定。"""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "server"
        (self.root / "app").mkdir(parents=True)
        (self.root / "app" / "main.py").write_text("x = 1\n", encoding="utf-8")
        self.dist = Path(self._tmp.name) / "dist"
        self.dist.mkdir()
        self.addCleanup(self._tmp.cleanup)

    def test_missing_stamp_is_stale(self) -> None:
        """★ 没有 build-info.json 的旧产物必须判**过期**（失败方向是多重打一次）。"""
        fresh, current = build_info.is_fresh(self.dist, root=self.root)
        self.assertFalse(fresh, "缺 build-info.json 必须判过期 —— 宁可多重打一次，也别判新鲜")
        self.assertRegex(str(current["fingerprint"]), r"^[0-9a-f]{64}$")
        self.assertIsNone(build_info.read_build_info(self.dist))

    def test_roundtrip(self) -> None:
        info = build_info.compute_fingerprint(self.root)
        payload = build_info.build_info_payload(self.root, info=info)
        build_info.write_build_info(self.dist, payload)

        recorded = build_info.read_build_info(self.dist)
        assert recorded is not None
        self.assertEqual(recorded["fingerprint"], info["fingerprint"])
        self.assertEqual(recorded["schema"], build_info.FINGERPRINT_SCHEMA)
        # 人看得懂的溯源字段
        for key in ("builtAt", "builtBy", "pythonVersion"):
            self.assertIn(key, recorded, f"build-info.json 缺 {key}（排查时要知道这是谁什么时候打的）")

        fresh, _ = build_info.is_fresh(self.dist, root=self.root)
        self.assertTrue(fresh, "刚写完的指纹必须判新鲜")

    def test_source_change_makes_stamp_stale(self) -> None:
        info = build_info.compute_fingerprint(self.root)
        build_info.write_build_info(self.dist, build_info.build_info_payload(self.root, info=info))
        self.assertTrue(build_info.is_fresh(self.dist, root=self.root)[0])

        (self.root / "app" / "main.py").write_text("x = 2\n", encoding="utf-8")
        fresh, _ = build_info.is_fresh(self.dist, root=self.root)
        self.assertFalse(fresh, "★ 源码改过之后，旧产物的指纹必须判过期（这就是 P-072 的拦截点）")

    def test_schema_bump_invalidates(self) -> None:
        """算法版本变了 → 旧指纹一律作废（宁可多重打，也不要新旧算法凑巧撞上）。"""
        info = build_info.compute_fingerprint(self.root)
        payload = build_info.build_info_payload(self.root, info=info)
        payload["schema"] = int(build_info.FINGERPRINT_SCHEMA) + 1
        build_info.write_build_info(self.dist, payload)
        self.assertFalse(build_info.is_fresh(self.dist, root=self.root)[0])

    def test_broken_stamp_is_stale_not_crash(self) -> None:
        (self.dist / build_info.BUILD_INFO_FILENAME).write_text("{ not json", encoding="utf-8")
        self.assertIsNone(build_info.read_build_info(self.dist))
        self.assertFalse(build_info.is_fresh(self.dist, root=self.root)[0])


class BuildWiringCase(unittest.TestCase):
    """``build_server.py`` 与前端构建链的接线（源码级断言，不起 PyInstaller）。"""

    def setUp(self) -> None:
        self.source = BUILD_SERVER.read_text(encoding="utf-8")

    def test_imports_shared_module(self) -> None:
        """★ 指纹实现**只有一份**：build_server 必须 import build_info，不得自己再算一套。"""
        self.assertIn("import build_info", self.source)
        self.assertNotIn("def compute_fingerprint", self.source, "指纹算法不得在 build_server.py 里再实现一遍")

    def test_stamp_written_after_packaging(self) -> None:
        run_build = self.source[self.source.index("def run_build()") : self.source.index("def write_build_stamp")]
        self.assertIn("write_build_stamp(", run_build, "打完包必须写指纹")
        self.assertLess(
            run_build.index('proc = subprocess.run(cmd'),
            run_build.index("write_build_stamp("),
            "指纹要在 PyInstaller 跑完之后才落盘（写进 dist 目录）",
        )

    def test_verify_asserts_freshness(self) -> None:
        """自检必须断言新鲜度，且放在起进程之前 —— 过期产物后面所有断言都无意义。"""
        verify = self.source[self.source.index("def verify()") : self.source.index("def main()")]
        self.assertIn("verify_build_stamp()", verify, "verify() 必须校验产物新鲜度")
        self.assertLess(
            verify.index("verify_build_stamp()"),
            verify.index("verify_packaged_kb()"),
            "新鲜度检查要排在 kb 检查之前（旧产物连指纹都不对，后面查了也是白的）",
        )

    def test_verify_and_if_stale_are_mutually_exclusive(self) -> None:
        result = subprocess.run(
            [sys.executable, str(BUILD_SERVER), "--verify", "--if-stale"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            check=False,
        )
        self.assertNotEqual(result.returncode, 0, "--verify 与 --if-stale 语义对立，必须拒绝同时用")
        self.assertIn("互斥", result.stdout + result.stderr)

    def test_if_stale_short_circuits_before_other_flags(self) -> None:
        """★ 短路必须**不被别的开关影响**。

        实测踩到过：写成 ``if args.if_stale and not args.skip_verify`` 时，
        ``--if-stale --skip-verify`` 每次都重打（两开关一叠加，短路静默失效）——
        而前端构建链要的恰恰是「新鲜就别干活」。源码级断言：短路判断里不得出现
        ``skip_verify`` 作为附加条件。
        """
        source = BUILD_SERVER.read_text(encoding="utf-8")
        main_body = source[source.index("def main()") :]
        short_circuit = main_body[
            main_body.index("if args.if_stale:") : main_body.index("if not args.verify:")
        ]
        self.assertNotIn(
            "skip_verify",
            short_circuit.split("\n")[0],
            "`--if-stale` 的短路条件里不得再带上 skip_verify（会静默失效、每次都重打）",
        )
        self.assertIn("return 0", short_circuit, "新鲜时必须真的提前返回")

    def test_print_fingerprint_flag(self) -> None:
        """给外部脚本用的轻量出口（不必起 uv 跑两个脚本）。"""
        result = subprocess.run(
            [sys.executable, str(BUILD_SERVER), "--print-fingerprint"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^[0-9a-f]{64}$")

    def test_cli_prints_bare_fingerprint_for_js(self) -> None:
        """``--fingerprint`` 只打印 64 位值：JS 侧要拿它做字符串比对。"""
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_info.py"), "--fingerprint"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout.strip(), r"^[0-9a-f]{64}$")

    def test_json_mode_is_parseable(self) -> None:
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_info.py"), "--json"],
            capture_output=True,
            text=True,
            cwd=str(ROOT),
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        for key in ("schema", "fingerprint", "fileCount", "builtAt", "gitCommit", "pythonVersion", "builtBy"):
            self.assertIn(key, payload)


class DesktopChainCase(unittest.TestCase):
    """前端构建链的接线（跨语言，但也归后端管 —— 它决定 sidecar 什么时候被重打）。"""

    def setUp(self) -> None:
        desktop = ROOT.parent / "desktop"
        if not (desktop / "package.json").exists():
            self.skipTest("desktop/ 不存在（只跑后端仓库）")
        self.desktop = desktop
        self.pkg = json.loads((desktop / "package.json").read_text(encoding="utf-8"))
        self.wrapper = (desktop / "scripts" / "build-server.mjs").read_text(encoding="utf-8")

    def test_build_script_chains_server(self) -> None:
        scripts = self.pkg["scripts"]
        self.assertIn("build:server", scripts)
        self.assertLess(
            scripts["build"].index("npm run build:server"),
            scripts["build"].index("electron-vite build"),
            "sidecar 必须在编前端之前就绪",
        )
        for name in ("build:win", "build:unpack"):
            self.assertLess(
                scripts[name].index("electron-builder"),
                scripts[name].index("check:server:packaged"),
                f"{name} 必须在装包**之后**校验包里的后端",
            )

    def test_wrapper_reuses_python_fingerprint(self) -> None:
        self.assertIn("build_info.py", self.wrapper, "JS 侧必须复用 Python 的指纹实现")
        self.assertNotIn("createHash", self.wrapper, "JS 侧不得自己算哈希（两套算法必然漂移）")

    def test_wrapper_uses_uv_not_bare_python(self) -> None:
        """★ 本机裸 ``python`` 指向已删除的路径，一律用 uv（AGENTS.md §8.1）。"""
        self.assertIn("'uv'", self.wrapper)
        self.assertNotRegex(
            self.wrapper, r"spawnSync\(\s*'python'", "wrapper 不得直接调裸 python（本机那条路是死的）"
        )


if __name__ == "__main__":
    unittest.main()
