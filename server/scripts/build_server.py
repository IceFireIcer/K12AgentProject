#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""打包后端 sidecar（PyInstaller ``--onedir``）并**立即做产物自检**。

用法::

    cd server
    uv run python scripts/build_server.py            # 建库 + 打包 + 自检
    uv run python scripts/build_server.py --verify   # 只自检已有产物
    uv run python scripts/build_server.py --if-stale # 产物已是当前源码打的就跳过（前端构建链用它）

产物：``server/dist/k12-agent-server/k12-agent-server.exe`` + 同目录 ``build-info.json``

**为什么要包一层脚本**：PyInstaller 打成功不代表**跑得起来**。历史上最常翻车的三件事是
① sqlite_vec 的 ``.dll`` 没进去；② fastembed 模型/onnxruntime 供应库没进去；
③ 打包后中文变 GBK（bootloader 忽略 ``PYTHONUTF8``）。

所以这里打完立刻起一次**真进程**，并且是**在「没有 Python 的环境」下起**：
PATH 只留 ``System32``、清掉 ``PYTHONHOME`` / ``PYTHONPATH``、不带 venv。
终端用户不需要装 Python —— 这条必须由这个脚本证明，而不是靠相信。

 ★ **还有第五件（P-072）：产物本身是过期的。** sidecar 独立打包，不随 ``electron-vite build``
  更新；``npm run build:win`` 只是把磁盘上现成的那份 exe 拷进安装包。所以本脚本现在会
  在产物里写下 ``build-info.json``（``scripts/build_info.py`` 算的源码指纹），
  并在自检里断言「**产物指纹 == 当前源码指纹**」—— 拿旧产物单独跑 ``--verify`` 会**响亮地失败**。
  前端构建链（``desktop/package.json`` 的 ``build`` → ``build:server``）据此跳过无谓的重打。

 ★ **还有第四件翻车的事（关卡 E 复验发现）**：产物**没带 ``kb.sqlite``**。
  ``resources/models`` 带了、``/health`` 的 ``embedderReady=true`` 也正常，
  但新机器 ``userData`` 是空的 → 检索一路降级到 ``outline``（**0 命中**），
  知识库实际上是空的，且**不会报任何错**。所以本脚本现在：
  ① 打包前**先建库**（产物化，不入 git）；
  ② ``--verify`` **断言打包产物里真的有一份可用的 kb**（能只读打开、chunk/kp 计数 > 0、
     写不进、且从空 data-dir 起服务时检索能走通 ``degraded="vector"``）。
  这一步就是当初能拦住该缺陷的检查。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import build_info  # noqa: E402  （同一目录；实现只有这一份，JS 侧也调它）
import smoke_api  # noqa: E402  （复用同一套断言，避免两份实现各改一边）

# ★★ UTF-8 stdio 必须**在任何输出之前**装（`app/console.py`）。
#   不装的后果在 CI 上才暴露（实测）：runner 的默认代码页不是 936 而是西文，
#   于是本脚本的 `sys.exit("[FATAL] --verify 与 --if-stale 互斥：…")` 里的中文
#   被 Python 转义成 `与` 字面量 —— 测试断言「输出里有『互斥』」于是失败，
#   而**本机（中文 Windows）跑同一段代码是通过的**。
#   三个兄弟脚本（check_env / build_kb / fetch_embedding_model）早就装了，
#   只有本文件漏了 —— 典型「少的那个恰好是没被非中文环境跑过的」。
from app.console import install_utf8_stdio  # noqa: E402

install_utf8_stdio()

ROOT = HERE.parent
SPEC = ROOT / "packaging" / "k12-agent-server.spec"
DIST_DIR = ROOT / "dist" / "k12-agent-server"
EXE = DIST_DIR / "k12-agent-server.exe"
BUILD_INFO_PATH = DIST_DIR / build_info.BUILD_INFO_FILENAME

STARTUP_TIMEOUT_S = 60.0

# kb 自检的期望计数下限（**只断言 > 0**：内容会随教材演进增删，写死具体数字必然过几天就红）
MIN_KP = 1
MIN_CHUNK = 1
MIN_VEC = 1


def dir_size_mb(path: Path) -> float:
    total = 0
    for item in path.rglob("*"):
        if item.is_file():
            try:
                total += item.stat().st_size
            except OSError:
                pass
    return total / (1024 * 1024)


def kill_stale_sidecar() -> None:
    """重打包前杀掉残留的 sidecar 进程。

    Windows 上只要有进程映射着产物里的 ``.pyd`` / ``.dll``，PyInstaller 清 ``dist/``
    就会 ``PermissionError: [WinError 5] 拒绝访问``。上一次验证若没退干净，
    下一次打包必然失败 —— 所以在这里主动清一次，而不是让人去猜。
    """
    if sys.platform != "win32":
        return
    result = subprocess.run(
        ["taskkill", "/IM", "k12-agent-server.exe", "/F"],
        capture_output=True,
        check=False,
    )
    if result.returncode == 0:
        print("[build] 已清理残留的 k12-agent-server.exe 进程")
        time.sleep(1.0)  # 等 Windows 真正释放文件句柄


def scrubbed_env() -> dict[str, str]:
    """构造一个**没有 Python** 的环境，用来证明「终端用户零依赖」。

    只保留 Windows 自身运行所需：System32、临时目录、代码页相关。
    显式**不含** PATH 里的任何 python、不含 venv、不含 PYTHONHOME / PYTHONPATH。
    """
    system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
    temp = os.environ.get("TEMP", str(ROOT / "_data_packaged_check"))
    return {
        "SYSTEMROOT": system_root,
        "WINDIR": os.environ.get("WINDIR", system_root),
        "PATH": rf"{system_root}\System32;{system_root}",
        "TEMP": temp,
        "TMP": temp,
        # 这三条是**源码运行态的补充**；打包态真正起作用的是 app/console.py 的 reconfigure
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        # 断网复验：证明模型与依赖都在本地
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
    }


def run_build() -> None:
    if not SPEC.exists():
        sys.exit(f"[FATAL] 找不到 spec 文件：{SPEC}")

    # ★ 指纹必须在**起 PyInstaller 之前**算（P-072）：
    #   若打包期间源码又被改动，产物里盖的是「它真正打出来的那份源码」的指纹，
    #   下一次 --if-stale 会判过期并重打 —— 失败方向是「多重打一次」。
    #   反过来（打完了再算）会把打包途中的改动一起认作新鲜，那正是最危险的失败方向。
    info = build_info.compute_fingerprint(ROOT)
    print(f"[stamp] 源码指纹 {info['fingerprint']}（{info['fileCount']} 个文件）")

    kill_stale_sidecar()
    build_bundled_kb()

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        # 工作目录放到 build/，避免污染仓库
        "--workpath",
        str(ROOT / "build"),
        "--distpath",
        str(ROOT / "dist"),
        str(SPEC),
    ]
    print("[build] " + " ".join(cmd))
    started = time.time()
    proc = subprocess.run(cmd, cwd=ROOT, check=False)
    if proc.returncode != 0:
        sys.exit(f"[FATAL] 打包失败，退出码 {proc.returncode}")
    print(f"[build] 完成，耗时 {time.time() - started:.1f}s")

    write_build_stamp(info)


def write_build_stamp(info: dict[str, object]) -> Path:
    """把「这份 exe 是拿哪份源码打的」写进产物目录的 ``build-info.json``。

    写在 **dist 目录内**（而不是 spec 的 datas 里）：那样它天然随
    ``electron-builder`` 的 ``extraResources`` 一起进安装包，
    前端构建链的「装包后校验」才能对着**包里的那份**做断言 —— 而不是对着构建机上的 ``dist/``。
    """
    payload = build_info.build_info_payload(ROOT, info=info)
    path = build_info.write_build_info(DIST_DIR, payload)
    commit = payload.get("gitCommit") or "?"
    dirty = "（工作区有未提交改动）" if payload.get("gitDirty") else ""
    print(f"[stamp] 已写入 {path.name}：{payload['fingerprint']} @ {commit}{dirty}")
    return path


# --------------------------------------------------------------------------- #
# 随包只读知识库：建库 → 归一化 → 交给 spec
# --------------------------------------------------------------------------- #
def build_bundled_kb() -> Path:
    """建出随包只读 kb 并落到 :data:`BUNDLED_KB_STAGING`（spec 会把它收进产物）。

    **为什么是「构建产出」而不是「提交二进制」**：``.gitignore`` 里有 ``*.sqlite``，
    这条**保持不动** —— 提交一个二进制库既不可评审（diff 是二进制）又会随教材漂移，
    正确做法是打包时**新鲜建一份**。这样「库」永远跟当前 ``knowledge/`` 一致，
    不存在「教材改了但忘了重建库」的静默错配。

    幂等性由 ``build_kb.build`` 内部的 ``clear_knowledge_tables`` 保证（先清再写），
    这里额外把暂存位删掉重建，避免上一次的残留被误当成功产物。

    ★ **归一化到 rollback journal（``journal_mode=delete``）**：
    运行期以 ``mode=ro`` 打开，而安装目录（``Program Files``）对普通用户**不可写**。
    WAL 库在只读打开时需要在同目录建 ``-shm``/``-wal``，建不出来就
    ``unable to open database file`` —— 实测过，**换台机器就是「知识库打不开」**。
    只读资产不需要 WAL，切掉它反而更稳。
    """
    sys.path.insert(0, str(ROOT))
    from app.config import BUNDLED_KB_STAGING  # noqa: PLC0415
    import build_kb  # noqa: PLC0415  （scripts/build_kb.py）

    print(f"[kb] 建库 → {BUNDLED_KB_STAGING}")
    BUNDLED_KB_STAGING.parent.mkdir(parents=True, exist_ok=True)
    # 幂等前提：清掉上一次的产物（含可能的 WAL 边车），避免旧行被当成新结果
    for stale in BUNDLED_KB_STAGING.parent.glob(BUNDLED_KB_STAGING.name + "*"):
        stale.unlink()

    started = time.time()
    # 显式落暂存位：不复制 <data-dir> 的那份，免得把开发期的脏状态带进产物
    result = build_kb.build(kb_path=BUNDLED_KB_STAGING, print_report=True)
    stats = result.stats
    if stats.get("chunk", 0) <= 0 or stats.get("kp", 0) <= 0:
        sys.exit(f"[FATAL] 建库结果为空：{BUNDLED_KB_STAGING}（chunk={stats.get('chunk')} kp={stats.get('kp')}）")
    print(
        f"[kb] 完成：知识点 {stats.get('kp', 0)} / 父块 {stats.get('parent_chunk', 0)} / "
        f"子块 {stats.get('child_chunk', 0)} / 向量 {stats.get('chunk_vec', 0)} "
        f"（耗时 {time.time() - started:.1f}s）"
    )
    normalize_shipped_kb(BUNDLED_KB_STAGING)
    return BUNDLED_KB_STAGING


def normalize_shipped_kb(kb_path: Path) -> None:
    """把待分发的库压成单文件 rollback-journal 形态（见 :func:`build_bundled_kb`）。"""
    conn = sqlite3.connect(str(kb_path))
    try:
        # VACUUM：把 WAL 内容并回主库，顺带紧凑文件（只读资产没必要留膨胀空间）
        conn.execute("VACUUM")
        mode = conn.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
        conn.commit()
    finally:
        conn.close()
    if str(mode).lower() != "delete":
        sys.exit(f"[FATAL] 无法把随包库切成 rollback journal：journal_mode={mode}")
    leftovers = [p.name for p in kb_path.parent.iterdir() if p.name.startswith(kb_path.name + "-")]
    if leftovers:
        sys.exit(f"[FATAL] 随包库目录仍有 WAL 边车文件：{leftovers}（只读资产不允许带边车）")


def packaged_kb_path() -> Path | None:
    """定位**打包产物内**的随包 kb（``_internal/resources/kb/kb.sqlite``）。

    不写死 ``_internal``：PyInstaller 的 onedir 布局换版本可能变，按文件名搜更稳。
    """
    if not DIST_DIR.exists():
        return None
    candidates = [
        p
        for p in DIST_DIR.rglob("kb.sqlite")
        # 排除 _data* 之类的运行期残留（只认产物目录里的那一份）
        if "_data" not in p.parts
    ]
    if not candidates:
        return None
    # 优先选 resources/kb/ 下的那份（与运行期解析一致）
    for p in candidates:
        if p.parent.name == "kb" and p.parent.parent.name == "resources":
            return p
    return candidates[0]


def verify_packaged_kb() -> Path | None:
    """★ **本脚本的核心新断言**：产物里必须真有一份「能用」的 kb。

    「文件存在」是不够的 —— 空库、只有表没数据、维度不对都能通过存在性检查，
    但学生用起来就是 0 命中。所以这里**真的只读打开并数行**：

    1. 文件存在且非空；
    2. 能以 ``mode=ro`` 打开（复用运行期同一条路径 ``connect(readonly=True)``）；
    3. ``kp`` / ``chunk`` / ``chunk_vec`` 计数 **> 0**；
    4. **写不进去**（``DELETE`` 必须抛 ``readonly``）—— 随包资产不允许被就地改写。
    """
    kb = packaged_kb_path()
    if kb is None:
        smoke_api.check(
            "★ 产物内包含随包 kb.sqlite",
            False,
            f"在 {DIST_DIR} 下搜不到 kb.sqlite —— 新机器首跑检索会一路降级到 outline（0 命中）",
        )
        return None

    size_mb = kb.stat().st_size / 1048576
    smoke_api.check("★ 产物内包含随包 kb.sqlite", True, f"{kb}（{size_mb:.1f} MB）")

    sys.path.insert(0, str(ROOT))
    from app.store.connections import connect, load_sqlite_vec, vec_available  # noqa: PLC0415

    try:
        conn = connect(kb, readonly=True)
    except Exception as exc:  # noqa: BLE001
        smoke_api.check("★ 随包 kb 能以只读方式打开", False, f"{type(exc).__name__}: {exc}")
        return kb

    try:
        # ★ 数 ``chunk_vec`` 必须先加载 sqlite-vec：``vec0`` 是虚拟表模块，
        #   不加载的话连 ``SELECT COUNT(*)`` 都会 ``no such module: vec0`` ——
        #   那种「读不出来」很像「表是空的」，会把人往错方向带。
        vec_ok = False
        try:
            load_sqlite_vec(conn)
            vec_ok = vec_available(conn)
        except Exception as exc:  # noqa: BLE001
            print(f"  [warn] 校验进程加载 sqlite-vec 失败：{exc}")

        counts: dict[str, int] = {}
        for table in ("kp", "chunk", "chunk_vec"):
            try:
                counts[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            except sqlite3.Error as exc:
                counts[table] = -1
                print(f"  [warn] 数 {table} 失败：{exc}")

        smoke_api.check("★ 随包 kb 能以只读方式打开", True, f"共 {counts} 行")
        smoke_api.check("★ 随包 kb 带 sqlite-vec 能力", vec_ok, f"vec_available={vec_ok}")
        smoke_api.check(
            f"★ 随包 kb 有内容：kp >= {MIN_KP}", counts.get("kp", 0) >= MIN_KP,
            f"kp={counts.get('kp')}",
        )
        smoke_api.check(
            f"★ 随包 kb 有内容：chunk >= {MIN_CHUNK}", counts.get("chunk", 0) >= MIN_CHUNK,
            f"chunk={counts.get('chunk')}",
        )
        smoke_api.check(
            f"★ 随包 kb 带向量：chunk_vec >= {MIN_VEC}", counts.get("chunk_vec", 0) >= MIN_VEC,
            f"chunk_vec={counts.get('chunk_vec')}",
        )
        # 只读语义：随包资产**绝不允许被就地改写**（写不进去才算合格）
        try:
            conn.execute("DELETE FROM kp")
            smoke_api.check("★ 随包 kb 拒绝写入（只读资产）", False, "DELETE 竟然成功了")
        except sqlite3.Error as exc:
            smoke_api.check(
                "★ 随包 kb 拒绝写入（只读资产）", True, f"{type(exc).__name__}: {exc}"
            )
    finally:
        conn.close()
    return kb


def _check_packaged_rag(base: str, token: str) -> None:
    """对**打包产物**（空 data-dir）打一次真检索，要求落在 ``vector`` 且有命中。

    ★ 这是「关卡 E 缺陷」的**行为级**断言：只看文件存在会漏掉「库是空的 /
    路径没解析到 / 维度不对 / 模型没随包」这几类，只有真检索一次才覆盖得到。
    演示现场的关键句也能由它背书：「断网 + 空用户目录，首跑就能检索到教材」。
    """
    import httpx  # noqa: PLC0415

    query, grade = "什么是循环", "junior"
    try:
        with httpx.Client(base_url=base, timeout=120.0) as client:
            response = client.post(
                "/api/rag/search",
                headers={"X-Auth-Token": token},
                json={"query": query, "gradeLevel": grade, "topK": 3},
            )
    except Exception as exc:  # noqa: BLE001
        smoke_api.check("★ 空 data-dir 下能真检索（随包 kb）", False, f"请求异常：{exc}")
        return

    if response.status_code != 200:
        smoke_api.check(
            "★ 空 data-dir 下能真检索（随包 kb）", False, f"HTTP {response.status_code}: {response.text[:200]}"
        )
        return

    body = response.json()
    hits = body.get("hits") or []
    print(
        f"  [rag] POST /api/rag/search query=\"{query}\" grade={grade} → "
        f"degraded={body.get('degraded')} hits={len(hits)}"
    )
    smoke_api.check(
        "★ 空 data-dir 下检索命中 > 0（知识库随包分发到位）",
        len(hits) > 0,
        f"degraded={body.get('degraded')} hits={len(hits)}",
    )
    smoke_api.check(
        '★ 空 data-dir 下走的是主路径 degraded="vector"',
        body.get("degraded") == "vector",
        f"实际 degraded={body.get('degraded')}",
    )


def verify_build_stamp() -> bool:
    """★ **P-072 的直接拦截点**：产物必须是**当前源码**打出来的。

    这是「改了 server/ 却没重打包」的唯一自动拦路石 —— ``npm test`` 与 ``npm run typecheck``
    全绿也发现不了它（它们测的是源码）。断言两端：

    1. 产物目录里有 ``build-info.json``（本机制上线前的旧产物没有 → 判过期，正好触发重打）；
    2. 指纹与**当前源码**逐字相同（schema 也相同）。
    """
    recorded = build_info.read_build_info(DIST_DIR)
    fresh, current = build_info.is_fresh(DIST_DIR, root=ROOT)

    if recorded is None:
        smoke_api.check(
            "★ 产物带源码指纹（build-info.json）", False,
            f"{BUILD_INFO_PATH} 不存在 —— 这是本机制上线前打出来的旧产物，请重新打包",
        )
        return False

    stamp = str(recorded.get("fingerprint") or "")
    built_at = recorded.get("builtAt") or "?"
    commit = recorded.get("gitCommit") or "?"

    smoke_api.check(
        "★ 产物带源码指纹（build-info.json）", True,
        f"{stamp[:12]}… @ {commit} 构建于 {built_at}",
    )
    smoke_api.check(
        "★★ 产物指纹 == 当前源码指纹（P-072：包里的后端必须是最新的）",
        fresh,
        f"产物与源码均为 {stamp[:16]}…" if fresh else (
            f"产物 {stamp[:16]}… vs 源码 {str(current['fingerprint'])[:16]}… —— "
            "源码改过但 exe 是旧的；重跑 uv run python scripts/build_server.py"
        ),
    )
    return fresh


def verify() -> bool:
    """在「没有 Python 的环境」下起一次打包产物，验证握手 / 接口 / 中文编码。"""
    if not EXE.exists():
        print(f"[FAIL] 产物不存在：{EXE}")
        return False

    # ★ 新鲜度：产物必须是当前源码打的（放在最前 —— 过期产物后面所有断言都无意义）。
    verify_build_stamp()

    # ★ 静态检查：产物里必须真有一份可用的只读 kb（关卡 E 缺陷的直接拦截点）。
    #   放在起进程之前 —— 缺库时应当**立刻**失败，不用等 60s 冷启动。
    packaged_kb = verify_packaged_kb()

    data_dir = ROOT / "_data_packaged_check"
    shutil.rmtree(data_dir, ignore_errors=True)
    token = "verifytoken0123456789abcdef0123456789abcdef0123456789abcdef01234567"

    env = scrubbed_env()
    print(f"[verify] 启动 {EXE.name}")
    print(f"[verify] PATH = {env['PATH']}")
    print("[verify] PYTHONHOME/PYTHONPATH 均已清空（证明不依赖本机 Python）")
    # 空 data-dir + 不带任何 K12_* 覆盖：这就是「新机器首跑」的等价条件
    print(f"[verify] data-dir = {data_dir}（已清空：模拟新机器，没有 per-user kb）")
    if packaged_kb is not None:
        print(f"[verify] 只读 kb 来源 = {packaged_kb}（随包分发，非 userData）")
    env.pop("K12_KB_PATH", None)

    # 以二进制管道启动，自己按 UTF-8 解码 —— 这样才能拿到**原始字节**，
    # 从而严格判断「打包后是否按 GBK 输出了中文」。
    proc = subprocess.Popen(
        [
            str(EXE),
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--token",
            token,
            "--data-dir",
            str(data_dir),
            "--log-level",
            "info",
        ],
        cwd=str(DIST_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    collector = smoke_api.StdoutCollector(proc.stdout)
    collector.start()
    stderr_chunks: list[bytes] = []

    def drain_stderr() -> None:
        try:
            # read1：一有数据就返回。read(n) 会等读满 n 字节或 EOF，
            # 对长期运行的服务进程等于永不返回，抽干线程就形同虚设。
            while True:
                chunk = proc.stderr.read1(4096)  # type: ignore[union-attr]
                if not chunk:
                    break
                stderr_chunks.append(chunk)
        except (ValueError, OSError):
            pass

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    ok = True
    port: int | None = None
    try:
        started = time.monotonic()
        handshake = smoke_api.wait_for_handshake(collector, proc, STARTUP_TIMEOUT_S)
        elapsed = time.monotonic() - started

        if handshake is None:
            smoke_api.check("收到握手 JSON", False, f"{STARTUP_TIMEOUT_S:.0f}s 内未收到")
            print("  stdout：", collector.lines)
            print("  stderr：", b"".join(stderr_chunks).decode("utf-8", "replace")[-800:])
            return False

        smoke_api.check("收到握手 JSON", True, f"冷启动 {elapsed:.2f}s")
        smoke_api.check(
            "★ 握手 event == ready",
            handshake.get("event") == "ready",
            f"port={handshake.get('port')} pid={handshake.get('pid')}",
        )
        smoke_api.check(
            "★ frozen == true（确实跑的是冻结产物，不是源码）",
            handshake.get("frozen") is True,
            str(handshake.get("frozen")),
        )

        port = int(handshake["port"])
        time.sleep(smoke_api.QUIET_WINDOW_S)
        smoke_api.check(
            "★ stdout 恰好一行（握手通道未被污染）",
            len(collector.lines) == 1,
            f"实际 {len(collector.lines)} 行：{collector.lines[1:3]}",
        )

        smoke_api.run_api_checks(f"http://127.0.0.1:{port}", token)

        # ★ 端到端：**空 data-dir** 的后端必须能用随包 kb 真的检索出东西。
        #   这一条比「文件在不在」更接近用户体感 —— 它同时证明
        #   ① 路径解析把 bundled kb 找到了；② 嵌入模型能加载；③ 向量检索通路是通的。
        #   缺 kb 时这里会得到 degraded="outline" + 0 命中，正是修复前的症状。
        _check_packaged_rag(f"http://127.0.0.1:{port}", token)

        owner = smoke_api.pid_owning_port(port)
        smoke_api.check(
            "★ 握手 pid == 真正监听端口的进程",
            owner is not None and owner == handshake.get("pid"),
            f"握手 pid={handshake.get('pid')}；占端口 pid={owner}；Popen 报的 pid={proc.pid}",
        )

        # 编码回归：打包后 stderr 必须是合法 UTF-8（PyInstaller 忽略 env，
        # 全靠 app/console.py 的 reconfigure 兜住）
        time.sleep(0.3)
        raw = b"".join(stderr_chunks)
        if not raw:
            smoke_api.check("stderr 中文编码", False, "未捕获到 stderr，无法判定")
        else:
            try:
                decoded = raw.decode("utf-8")
                smoke_api.check("★ stderr 是合法 UTF-8", True, decoded.strip().splitlines()[0][:80] if decoded.strip() else "")
                smoke_api.check(
                    "★ stderr 中文未乱码（含「已绑定」）",
                    "已绑定" in decoded,
                    "已在日志中找到预期中文",
                )
            except UnicodeDecodeError as exc:
                smoke_api.check("★ stderr 是合法 UTF-8", False, f"解码失败：{exc}")

        if not os.access(DIST_DIR / EXE.name, os.X_OK):
            ok = False
    finally:
        if port is not None:
            print("--- 退出清理 ---")
            smoke_api.kill_tree(proc.pid)
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()
                smoke_api.check("进程在 15s 内退出", False)
            time.sleep(0.5)
            smoke_api.check(
                "★ 退出后端口已释放（无孤儿）",
                not smoke_api.port_is_listening(port),
                f"port={port}",
            )
        collector.join()
        stderr_thread.join(timeout=2)
        if proc.poll() is None:
            smoke_api.kill_tree(proc.pid)
        shutil.rmtree(data_dir, ignore_errors=True)

    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description="打包 sidecar 并自检")
    parser.add_argument("--verify", action="store_true", help="跳过打包，只自检已有产物")
    parser.add_argument("--skip-verify", action="store_true", help="只打包，不自检")
    parser.add_argument(
        "--if-stale",
        action="store_true",
        help="产物已是当前源码打的就跳过（前端构建链用它，避免每次 npm run build 都重打 exe）",
    )
    parser.add_argument(
        "--print-fingerprint",
        action="store_true",
        help="只打印当前源码指纹并退出（给外部脚本用；等价于 build_info.py --fingerprint）",
    )
    args = parser.parse_args()

    if args.print_fingerprint:
        print(build_info.compute_fingerprint(ROOT)["fingerprint"])
        return 0

    if args.verify and args.if_stale:
        sys.exit("[FATAL] --verify 与 --if-stale 互斥：--verify 的语义就是「不管新不新都查一遍」")

    # ★ 新鲜度短路必须在**所有其他开关之前**判断，且不受 --skip-verify 影响：
    #   它的语义就是「不用干活」——曾经写成 `if args.if_stale and not args.skip_verify`，
    #   于是 `--if-stale --skip-verify` 会**每次都重打**（两开关一叠加，短路静默失效）。
    if args.if_stale:
        if not EXE.exists():
            print(f"[stale] 产物不存在（{EXE}），需要打包")
        else:
            fresh, current = build_info.is_fresh(DIST_DIR, root=ROOT)
            if fresh:
                recorded = build_info.read_build_info(DIST_DIR) or {}
                print(
                    "[skip] sidecar 已是当前源码打的，跳过重打（P-072 的构建联动）\n"
                    f"       指纹 {current['fingerprint']}（{current['fileCount']} 个文件）"
                    f" @ {recorded.get('gitCommit') or '?'} "
                    f"构建于 {recorded.get('builtAt') or '?'}\n"
                    "       强制重打：uv run python scripts/build_server.py"
                )
                return 0
            print(f"[stale] 源码指纹 {current['fingerprint'][:16]}… 与产物不符，重新打包")

    if not args.verify:
        run_build()

    if args.skip_verify:
        return 0

    if not DIST_DIR.exists():
        sys.exit(f"[FATAL] 产物目录不存在：{DIST_DIR}")

    size = dir_size_mb(DIST_DIR)
    print(f"[build] 产物体积 {size:.1f} MB（{DIST_DIR}）\n")

    verify()

    print(f"\n{'=' * 60}")
    if smoke_api._failed:
        print(f"✗ {len(smoke_api._failed)} 项失败 / 共 {smoke_api._passed + len(smoke_api._failed)} 项："
              f"{'；'.join(smoke_api._failed)}")
        print(f"  产物体积 {size:.1f} MB")
        return 1
    print(f"✓ 打包产物自检全部通过（{smoke_api._passed} 项，{size:.1f} MB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
