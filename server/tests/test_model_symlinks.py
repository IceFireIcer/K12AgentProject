# -*- coding: utf-8 -*-
"""模型目录的符号链接处理（CI 打包链的前置条件）。

-------------------------------------------------------------------------------
为什么这是一个**独立的**、值得单独立项的检查
-------------------------------------------------------------------------------
它守护的是「打包能不能走完」这件事，而缺陷形态极其隐蔽（见 pitfalls P-107）：

HuggingFace 的缓存默认用**符号链接**把 ``snapshots/<rev>/x.json`` 指向
``blobs/<hash>``，而**能不能建链接取决于权限**：

| 环境 | 能否建符号链接 | HF 落盘形态 | 打包结果 |
| --- | --- | --- | --- |
| 开发机（非管理员） | ❌ 不能 | 实体文件 | ✅ 正常 |
| GitHub runner（管理员） | ✅ 能 | **符号链接** | ❌ 7-Zip 中止 |

于是「本机永远绿、云端必红」，而报错是
``WARNING: The directory name is invalid.`` 加一串**末尾带反斜杠**的路径
（那是 7-Zip 把链接当成目录的指纹）。

★ 本文件**能**在本机验证「实体化逻辑正确」，但**测不到真正的符号链接路径**
（本机没权限建链接，见下面的 `_can_symlink()`）—— 那种用例会被 skip 并说明原因。
真正跑通那条路径的是 CI 的 nightly（runner 是管理员）。
**这条「跳过」是诚实的**：不假装验证过。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.rag.embedder import find_symlinks, materialize_symlinks  # noqa: E402


def _can_symlink(where: Path) -> bool:
    """本机能否创建符号链接（Windows 上需要管理员或开发者模式）。"""
    probe = where / "_symlink_probe"
    try:
        probe.symlink_to(where, target_is_directory=True)
    except (OSError, NotImplementedError):
        return False
    try:
        probe.unlink()
    except OSError:
        pass
    return True


class SymlinkCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)


class TestFindSymlinks(SymlinkCase):
    """`find_symlinks`：只找链接，且对异常输入不抛。"""

    def test_plain_directory_has_no_symlinks(self) -> None:
        (self.tmp / "snapshots" / "rev1").mkdir(parents=True)
        (self.tmp / "snapshots" / "rev1" / "config.json").write_bytes(b'{"k":1}')
        self.assertEqual(find_symlinks(self.tmp), [], "实体文件不算链接")

    def test_missing_directory_returns_empty(self) -> None:
        """目录不存在 → 空表（**不是异常**）：探活与打包前置检查都要能安心调它。"""
        self.assertEqual(find_symlinks(self.tmp / "nope"), [])

    def test_finds_nested_symlinks(self) -> None:
        if not _can_symlink(self.tmp):
            self.skipTest("本机权限不足，建不了符号链接（需要管理员或开发者模式）")
        real = self.tmp / "blobs" / "abc"
        real.parent.mkdir(parents=True)
        real.write_bytes(b'{"v":1}')
        snap = self.tmp / "snapshots" / "rev1"
        snap.mkdir(parents=True)
        (snap / "config.json").symlink_to(real)

        found = find_symlinks(self.tmp)
        self.assertEqual([p.name for p in found], ["config.json"])
        self.assertEqual(found[0].read_bytes(), b'{"v":1}', "链接要能读出真内容")


class TestMaterializeSymlinks(SymlinkCase):
    """`materialize_symlinks`：把链接换成实体文件，且幂等、无损。"""

    def test_noop_on_plain_directory(self) -> None:
        """本来就是实体文件 → 一个都不动（开发机上的零成本 no-op）。"""
        (self.tmp / "snapshots" / "rev1").mkdir(parents=True)
        target = self.tmp / "snapshots" / "rev1" / "config.json"
        target.write_bytes(b'{"k":1}')
        before = target.stat().st_mtime_ns

        self.assertEqual(materialize_symlinks(self.tmp), 0)
        self.assertEqual(target.read_bytes(), b'{"k":1}')
        self.assertEqual(target.stat().st_mtime_ns, before, "没链接就不该碰文件")

    def test_idempotent(self) -> None:
        """连跑两次：第二次是 0（第一次已经把链接换掉了）。"""
        (self.tmp / "x").mkdir()
        (self.tmp / "x" / "a.json").write_bytes(b'1')
        self.assertEqual(materialize_symlinks(self.tmp), 0)
        self.assertEqual(materialize_symlinks(self.tmp), 0)

    def test_missing_directory_is_safe(self) -> None:
        self.assertEqual(materialize_symlinks(self.tmp / "nope"), 0)

    def test_replaces_symlink_with_real_bytes(self) -> None:
        """★ 核心行为：链接变成**实体文件**，且内容一字不差。"""
        if not _can_symlink(self.tmp):
            self.skipTest(
                "本机权限不足，建不了符号链接（需要管理员或开发者模式）—— "
                "这条用例的真正执行环境是 CI nightly。不假装验证过："
                "另一条 test_rewrites_link_body_... 用替身覆盖了同一段逻辑。"
            )
        payload = b'{"model": "bge-small-zh-v1.5", "dim": 512}'
        real = self.tmp / "blobs" / "deadbeef"
        real.parent.mkdir(parents=True)
        real.write_bytes(payload)
        snap = self.tmp / "snapshots" / "rev1"
        snap.mkdir(parents=True)
        link = snap / "config.json"
        link.symlink_to(real)

        self.assertEqual(len(find_symlinks(self.tmp)), 1, "先确认链接真的建出来了")
        replaced = materialize_symlinks(self.tmp)

        self.assertEqual(replaced, 1)
        self.assertEqual(find_symlinks(self.tmp), [], "★ 实体化之后不该再有链接")
        self.assertFalse(link.is_symlink())
        self.assertEqual(link.read_bytes(), payload, "★ 内容必须一字不差（换链接不能丢字节）")
        # 真文件仍在原处（我们只复制，不搬走）
        self.assertEqual(real.read_bytes(), payload)

    def test_rewrites_link_body_via_stub(self) -> None:
        """★ 用替身覆盖**同一段逻辑**（本机建不了真链接时的补充证据）。

        ★★ 为什么可以这样测、以及它测到了什么：
        `materialize_symlinks` 对每个「链接路径」做四件事 ——
        `resolve(strict=True)`（顺着链接拿真文件）→ `read_bytes` →
        `unlink` → `write_bytes`。把 `find_symlinks` 换成「返回一个普通文件路径」，
        那四步会**原样执行**（对一个实体文件来说，resolve 回自身、unlink 再写回），
        于是这条用例真的在跑那段逻辑，而不是在跑 mock。

        ⚠️ 它证明不了「顺着链接读」这一步（那要有真链接）—— 所以
        `test_replaces_symlink_with_real_bytes` 保留在真正有权限的环境里跑。
        """
        from unittest import mock

        from app.rag import embedder as embedder_mod

        payload = b'{"dim": 512}'
        victim = self.tmp / "snapshots" / "rev1" / "config.json"
        victim.parent.mkdir(parents=True)
        victim.write_bytes(payload)

        with mock.patch.object(embedder_mod, "find_symlinks", return_value=[victim]):
            replaced = embedder_mod.materialize_symlinks(self.tmp)

        self.assertEqual(replaced, 1, "替身指名的那条要被处理")
        self.assertEqual(victim.read_bytes(), payload, "★ 内容一字不差（unlink 后写回不能丢字节）")
        self.assertTrue(victim.is_file())

    def test_broken_link_is_skipped_not_fatal(self) -> None:
        """悬空链接（resolve 抛 OSError）**跳过并继续**，不让整步崩。

        ★ 这正是 CI 上真实出现的形态：PyInstaller 把 HF 的相对链接搬进产物后
        目标失配 → 悬空。实体化那一步遇到它时不该让打包提前死掉
        （真正的失败留给 spec 里那道「仍有残留链接」的断言，那里文案更清楚）。
        """
        from unittest import mock

        from app.rag import embedder as embedder_mod

        missing = self.tmp / "snapshots" / "rev1" / "gone.json"  # 不存在
        good = self.tmp / "snapshots" / "rev1" / "ok.json"
        good.parent.mkdir(parents=True)
        good.write_bytes(b"{}")

        with mock.patch.object(embedder_mod, "find_symlinks", return_value=[missing, good]):
            replaced = embedder_mod.materialize_symlinks(self.tmp)

        self.assertEqual(replaced, 1, "只处理得动的那一条（悬空那条跳过）")
        self.assertEqual(good.read_bytes(), b"{}")

    def test_keeps_directory_layout(self) -> None:
        """目录结构不变（打包器按路径找文件，换了目标就全错）。"""
        (self.tmp / "models--Qdrant--bge" / "snapshots" / "rev1").mkdir(parents=True)
        deep = self.tmp / "models--Qdrant--bge" / "snapshots" / "rev1" / "tokenizer.json"
        deep.write_bytes(b'{}')
        materialize_symlinks(self.tmp)
        self.assertTrue(deep.is_file())
        self.assertEqual(deep.relative_to(self.tmp).as_posix(),
                         "models--Qdrant--bge/snapshots/rev1/tokenizer.json")


class TestPackagingGuardIsWired(unittest.TestCase):
    """spec 里真的接了这道前置检查（源码级断言，因为 spec 只在打包时执行）。"""

    def test_spec_materializes_and_asserts(self) -> None:
        spec = (ROOT / "packaging" / "k12-agent-server.spec").read_text(encoding="utf-8")
        self.assertIn("materialize_symlinks", spec, "spec 必须实体化链接")
        self.assertIn("find_symlinks", spec, "spec 必须**再查一次**（实体化可能仍有残留）")
        # ★ 残留时必须**失败**而不是打个坏包出去
        self.assertIn(
            "符号链接",
            spec,
            "残留链接的报错文案要说明是符号链接问题（否则排查会从「目录名无效」开始找）",
        )
        self.assertIn("raise SystemExit", spec, "有残留就中止打包")

    def test_fetch_script_materializes(self) -> None:
        """取模型那条路也要实体化：CI 缓存恢复走的可能就是 fetch 的幂等分支。"""
        src = (ROOT / "scripts" / "fetch_embedding_model.py").read_text(encoding="utf-8")
        # 幂等短路分支（verify 通过直接 return）里也要调
        skip_block = src[src.index("if not args.force and verify(target):"):]
        skip_block = skip_block[: skip_block.index("return 0")]
        self.assertIn(
            "materialize_symlinks",
            skip_block,
            "★ 幂等短路（已就位就返回）分支里也必须实体化 —— 老目录可能是上一版留下的",
        )
        self.assertIn("materialize_symlinks(target)", src, "下载之后也要实体化")


if __name__ == "__main__":
    unittest.main()
