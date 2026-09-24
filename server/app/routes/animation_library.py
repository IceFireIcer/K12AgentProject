# -*- coding: utf-8 -*-
"""学生**动画库**：生成过的动画按学生存下来、按学段隔离、可复用、可删除。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | ``/api/animation/saved/lookup`` | 按**复用键**取一条（命中即返回带 ``html`` 的那条，``uses`` +1） |
| POST | ``/api/animation/saved/{student_id}`` | 保存一条（服务端**再校验一次 HTML**，不合格 422） |
| GET | ``/api/animation/saved/{student_id}`` | 该学生的动画库清单（**不回 html**，按创建时间倒序） |
| GET | ``/api/animation/saved/{student_id}/{saved_id}`` | 取一条（**带 html**） |
| DELETE | ``/api/animation/saved/{student_id}/{saved_id}`` | 删一条（只可能删到自己的） |

## 为什么要有它

**今天每一轮都要重新生成**：同一个学生再问一次「什么是循环」，模型要重新出片段、
Python 要重新校验一遍 —— 同样的东西花钱花时间再来一份。库里存下来之后，
重复请求变成一次查表（**零模型调用**），学生还能自己把不想要的动画删掉。

## ★ 复用键 = ``(student_id, kp_id, grade_level, prompt_hash)``

- ``student_id`` 由**库文件归属**承担：一人一份 ``learning.db``（§8.2），
  所以「查自己的库」这个动作本身就完成了学生隔离 —— 别人的记录根本不在这个文件里；
- ``grade_level`` 是键的一部分（**用户点名要求**）：同一个知识点在小学低与初中
  是**两份不同的产物**（讲法不同），少了这一维就会把初中那份端给小学生；
- ``prompt_hash`` 由调用方（主进程）算好，**十六进制摘要** —— 见下一条。

## ★★ 学生的原话一个字都不进这里（合规硬约束）

请求体里**没有任何**承载正文的字段：只有 ``prompt_hash``（摘要）+ 展示文字
（``concept`` / ``title`` / 降级文案，都是模型侧产出）。这与「SQLite 不存对话正文」
（§8.1）是同一条纪律 —— 原话归 Pi 的 JSONL 会话树，两者靠 ``studentId`` 关联。
契约层把这条纪律做成**类型约束**（``promptHash`` 只允许十六进制字符），
所以它不是「靠人记得别传原话」，而是「原话根本过不了校验」。

## ★ HTML 落盘，不进库；且保存时**再校验一次**

正文写进 ``<data-dir>/students/<id>/animations/saved/<sha1(id)>.html``
（复用既有的 ``animations/`` 目录，与一次性 nonce 托管路径同级），库里只留
``html_path``（**相对学生目录**，见 :func:`_relative_html_path` 的说明）。
保存入口调用 :func:`app.routes.resources.validate_animation_html` **再校验一次**
（**复用**，不重写一套判据）：能进库的东西一定已经过了与渲染/托管同一套校验，
因此库里不会出现「存下来了但播不出来」的产物。

## 路径安全

``student_id`` 一律先过 ``students.validate_student_id``（**在任何拼接之前**），
数据根一律经 ``students.require_data_dir``（没显式 ``--data-dir`` → **503**，
绝不退回共享的 ``server/_data``）；``saved_id`` 只允许 ``[A-Za-z0-9_-]{1,64}``。
读/删之前还会断言解析出来的路径**没跑出**该学生的 ``animations/`` 目录
—— 库文件被人手工改坏时，拒的是那一条请求，而不是让人按 id 读到任意文件。
"""

from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse

from app.contracts import (
    ANIMATION_SAVED_ID_PATTERN,
    AnimationSaveRequest,
    AnimationSavedItem,
    AnimationSavedListResponse,
    AnimationSavedLookupRequest,
    AnimationSavedView,
)
from app.routes.resources import (
    ANIMATIONS_DIRNAME,
    GRADE_LEVELS,
    KP_ID_RE,
    MAX_HTML_BYTES,
    validate_animation_html,
)
from app.routes.students import (
    as_grade_level,
    open_learning_store,
    require_data_dir,
    student_dir,
    to_contract_ms,
    validate_student_id,
)
from app.store.learning import SavedAnimationRecord, new_saved_animation_id

logger = logging.getLogger(__name__)

#: 动画库在 ``animations/`` 下的子目录名（与一次性 nonce 托管的文件分开，
#: 免得「清掉托管的临时产物」这类操作顺手把学生收藏的动画一起扫掉）。
SAVED_DIRNAME = "saved"

router = APIRouter(prefix="/api", tags=["animation"])


# --------------------------------------------------------------------------- #
# 路径与文件
# --------------------------------------------------------------------------- #
def saved_animation_root(data_dir: str | Path, student_id: str) -> Path:
    """``<data-dir>/students/<student_id>/animations/saved``（**按学生分目录**）。"""
    return student_dir(data_dir, student_id) / ANIMATIONS_DIRNAME / SAVED_DIRNAME


def animation_saved_id(said: str) -> str:
    """校验 ``saved_id`` 字符集（它会被拼进文件名，必须挡在拼接之前）。"""
    if not isinstance(said, str) or not re.match(ANIMATION_SAVED_ID_PATTERN, said):
        raise HTTPException(
            status_code=422, detail="savedId 不合法（只允许字母、数字、下划线、连字符，长度 1–64）"
        )
    return said


def _validate_kp_id(kp_id: str) -> str:
    """知识点 id 白名单（与 ``routes/resources.py`` 同一套字符集判据）。"""
    if not KP_ID_RE.match(kp_id or ""):
        raise HTTPException(status_code=422, detail="kpId 不合法（只允许字母、数字、下划线、连字符，长度 1–64）")
    return kp_id


def _validate_grade_filter(grade_level: str) -> str:
    """清单的 ``gradeLevel`` 过滤值：空串 = 不过滤；否则必须是四学段之一。"""
    value = (grade_level or "").strip()
    if not value:
        return ""
    if value not in GRADE_LEVELS:
        raise HTTPException(
            status_code=422,
            detail=f"gradeLevel 非法：{value!r}（只能是 {'、'.join(GRADE_LEVELS)} 之一，或留空表示不过滤）",
        )
    return value


def _relative_html_path(saved_id: str) -> str:
    """条目对应的 HTML **相对学生目录**的路径：``animations/saved/<sha1(id)>.html``。

    ★ 为什么要相对而不是绝对：``<data-dir>`` 是 Electron 的 ``userData``（便携版还会
      跟着 exe 所在的盘符走）。库里写死绝对路径的话，用户把应用搬到别处、
      或换台机器同步数据之后，每一行都指向一个不存在的文件 —— 而学生完全没做错什么。
      相对路径只依赖「这条记录属于哪个学生目录」，那正是库文件自身的归属。
    """
    digest = hashlib.sha1(saved_id.encode("utf-8")).hexdigest()
    return f"{ANIMATIONS_DIRNAME}/{SAVED_DIRNAME}/{digest}.html"


def _resolve_html_path(data_dir: str | Path, student_id: str, relative: str) -> Path:
    """把库里的相对路径解析成绝对路径，**并断言它没跑出该学生的动画目录**。

    ★ 库文件是可写文件：手工改坏 / 被别的工具写坏之后，``html_path`` 可能变成
      ``../../../config.json`` 这类东西。读取前判一次包含关系，拒的是这一条请求
      （404），而不是让「按 id 取动画」变成「按路径读任意文件」。
    """
    root = saved_animation_root(data_dir, student_id).resolve()
    candidate = (student_dir(data_dir, student_id) / str(relative or "")).resolve()
    if candidate == root or root not in candidate.parents:
        raise HTTPException(status_code=404, detail="这条动画的记录路径非法（已拒绝读取）")
    return candidate


def _write_html(path: Path, html: str) -> None:
    """落盘（父目录按需创建）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(html, encoding="utf-8")


def _remove_html(path: Path) -> None:
    """删掉一份 HTML（**幂等**：文件已经不在就当成功）。

    ``unlink`` 的失败只记日志、不改变响应：记录已经从库里删掉了，
    让「文件被别的进程占着」把删除操作整体退回，学生看到的是「删了还在」。
    """
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:  # pragma: no cover - 只有磁盘异常才会到这里
        logger.warning("动画文件删除失败（记录已删）：%s（%s）", path, exc)


# --------------------------------------------------------------------------- #
# 记录 → 契约模型
# --------------------------------------------------------------------------- #
def _item(record: SavedAnimationRecord) -> AnimationSavedItem:
    """库里的记录 → 列表/保存回执形态（**不含 html**）。

    ★ ``grade_level`` 过一遍 ``as_grade_level``：库文件是可写的，手工改坏之后
      一个非法学段会让 pydantic 在序列化时直接 500（学生看到的是「动画库打不开」）。
      与 ``routes/students.py`` 读学生行时同一口径 —— 坏值退到冷启动默认学段并记日志。
    """
    return AnimationSavedItem(
        id=record.id,
        kp_id=record.kp_id,
        grade_level=as_grade_level(record.grade_level),
        concept=record.concept,
        prompt_hash=record.prompt_hash,
        title=record.title,
        duration_ms=record.duration_ms,
        fallback_text=record.fallback_text,
        fallback_image=record.fallback_image,
        created_at=to_contract_ms(record.created_at),
        uses=record.uses,
    )


def _view(record: SavedAnimationRecord, html: str) -> AnimationSavedView:
    """取一条的形态（**带 html**）：沙箱产物本体，直接塞给 iframe / srcdoc。"""
    return AnimationSavedView(**_item(record).model_dump(), html=html)


def _read_html(data_dir: str | Path, student_id: str, record: SavedAnimationRecord) -> str:
    """读回这条记录的 HTML；记录在、文件不在 → **404**（并说清怎么恢复）。"""
    path = _resolve_html_path(data_dir, student_id, record.html_path)
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("动画库条目找不到文件：%s（%s）", path, exc)
        raise HTTPException(
            status_code=404, detail="这条动画的文件已不在磁盘上（重新生成一次即可）"
        ) from exc


# --------------------------------------------------------------------------- #
# 路由
# --------------------------------------------------------------------------- #
# ★★ 注册顺序**有实义**：``POST /api/animation/saved/lookup`` 必须排在
#    ``POST /api/animation/saved/{student_id}`` 之前 —— Starlette 按注册顺序匹配，
#    反过来的话「lookup」会被当成一个学生 id 吃掉（症状是这条接口永远 422）。
@router.post(
    "/animation/saved/lookup",
    response_model=AnimationSavedView,
    summary="按复用键取一条已保存的动画（命中带 html，uses 加一）",
)
def lookup_saved_animation(request: Request, body: AnimationSavedLookupRequest) -> AnimationSavedView:
    """复用键 ``(studentId, kpId, gradeLevel, promptHash)`` 全中的那一条。

    - 命中 → **200** + 带 ``html`` 的那条（``uses`` 自增一次，便于观察复用真的发生了）；
    - 未命中 → **404**（调用方据此走生成路径，而不是拿一份空动画去渲染）;
    - 学生 id 非法 → **422**；没显式 ``--data-dir`` → **503**（见模块头）。

    ★ ``gradeLevel`` 参与命中判定：学生学段变了之后再问同一个知识点，
      这里**必然不命中**（那是要求里的「按学段分开」），走生成 → 保存新的那一份。
    """
    validate_student_id(body.student_id)
    _validate_kp_id(body.kp_id)
    data_dir = require_data_dir(request)

    store = _open_store(data_dir, body.student_id)
    try:
        record = store.find_animation(
            kp_id=body.kp_id, grade_level=body.grade_level, prompt_hash=body.prompt_hash
        )
        if record is None:
            raise HTTPException(
                status_code=404,
                detail=f"动画库里没有这个知识点在本学段的这一份（{body.kp_id} / {body.grade_level}）",
            )
        html = _read_html(data_dir, body.student_id, record)
        store.touch_animation_use(record.id)
        record = store.get_animation(record.id) or record
    finally:
        store.close()
    logger.info(
        "动画库命中：学生=%s 知识点=%s 学段=%s 条目=%s（第 %d 次复用）",
        body.student_id,
        record.kp_id,
        record.grade_level,
        record.id,
        record.uses,
    )
    return _view(record, html)


@router.post(
    "/animation/saved/{student_id}",
    response_model=AnimationSavedItem,
    summary="保存一条动画（校验 HTML 后落盘，复用键冲突则覆盖）",
)
def save_saved_animation(
    request: Request, student_id: str, body: AnimationSaveRequest
) -> AnimationSavedItem:
    """把一份**已生成**的动画存进该学生的动画库（回执**不带 html**）。

    - HTML 过不了 ``validate_animation_html()`` → **422** + 可读中文原因
      （与渲染/托管同一套判据，见模块头）；
    - 体积超过 ``MAX_HTML_BYTES`` → **422**；
    - 同一个复用键再存一次 = **覆盖**那一条（``id`` 与文件都换成新的），而不是追加
      —— 否则「再问一次」会让库里堆满几乎相同的记录。

    ★ 覆盖时**保留** ``uses``：那是「这条复用键被用了几次」的计数，
      重新生成一次不代表以前那些复用的需求没发生过。
    """
    validate_student_id(student_id)
    _validate_kp_id(body.kp_id)
    data_dir = require_data_dir(request)

    validation = validate_animation_html(body.html)
    if not validation.ok:
        # ★ 422 而不是 500：这是**内容不合格**（调用方该重试或降级），不是服务故障
        logger.warning("动画库拒收未通过校验的 HTML：%s", validation.reason)
        raise HTTPException(status_code=422, detail=f"动画 HTML 未通过校验：{validation.reason}")
    size = len(body.html.encode("utf-8"))
    if size > MAX_HTML_BYTES:
        raise HTTPException(
            status_code=422, detail=f"动画 HTML 过大（{size} 字节，上限 {MAX_HTML_BYTES}）"
        )

    concept = body.concept.strip()
    title = body.title.strip() or concept

    store = _open_store(data_dir, student_id)
    try:
        # 先看这个复用键上有没有旧条目：有就记下它的文件，落库之后把旧文件删掉
        # （否则每覆盖一次就在磁盘上留一份**再也没人引用**的孤儿 HTML）。
        previous = store.find_animation(
            kp_id=body.kp_id, grade_level=body.grade_level, prompt_hash=body.prompt_hash
        )
        saved_id = new_saved_animation_id()
        relative = _relative_html_path(saved_id)
        path = _resolve_html_path(data_dir, student_id, relative)
        _write_html(path, body.html)
        record = store.save_animation(
            saved_id=saved_id,
            kp_id=body.kp_id,
            grade_level=body.grade_level,
            concept=concept,
            prompt_hash=body.prompt_hash,
            title=title,
            duration_ms=body.duration_ms,
            html_path=relative,
            fallback_text=body.fallback_text.strip(),
            fallback_image=body.fallback_image,
        )
    finally:
        store.close()

    if previous is not None and previous.html_path != record.html_path:
        _remove_html(_resolve_html_path(data_dir, student_id, previous.html_path))
    logger.info(
        "动画已入库：学生=%s 知识点=%s 学段=%s 条目=%s 字节=%d%s",
        student_id,
        record.kp_id,
        record.grade_level,
        record.id,
        size,
        "（覆盖了旧的一份）" if previous is not None else "",
    )
    return _item(record)


@router.get(
    "/animation/saved/{student_id}",
    response_model=AnimationSavedListResponse,
    summary="该学生的动画库清单（不含 html，按创建时间倒序）",
)
def list_saved_animations(
    request: Request,
    student_id: str,
    gradeLevel: str = Query("", description="只看某个学段（留空 = 全部）"),
    kpId: str = Query("", description="只看某个知识点（留空 = 全部）"),
) -> AnimationSavedListResponse:
    """列该学生保存过的动画。**不回 html**：列表上没人看动画正文，而回整份会让响应变成几 MB。

    过滤条件回显在响应里（``gradeLevel`` / ``kpId`` 为 ``None`` 表示没过滤），
    前端据此显示筛选状态，不用自己记一份。
    """
    validate_student_id(student_id)
    grade_filter = _validate_grade_filter(gradeLevel)
    kp_filter = (kpId or "").strip()
    if kp_filter:
        _validate_kp_id(kp_filter)
    data_dir = require_data_dir(request)

    store = _open_store(data_dir, student_id)
    try:
        records = store.list_animations(kp_id=kp_filter or None, grade_level=grade_filter or None)
    finally:
        store.close()

    items = [_item(record) for record in records]
    return AnimationSavedListResponse(
        student_id=student_id,
        grade_level=grade_filter or None,
        kp_id=kp_filter or None,
        items=items,
        total=len(items),
    )


@router.get(
    "/animation/saved/{student_id}/{saved_id}",
    response_model=AnimationSavedView,
    summary="取一条已保存的动画（带 html）",
)
def get_saved_animation(request: Request, student_id: str, saved_id: str) -> AnimationSavedView:
    """按 id 取一条（**带 html**）。

    ★ 学生维度由**库文件归属**承担：这里开的是 ``{student_id}`` 自己的库，
      所以拿着别人的条目 id 来问，结果是 **404**（那条记录不在这个文件里）。
      另有 ``savedId`` 字符集校验 → **422**（它会被拼进文件名）。
    """
    validate_student_id(student_id)
    animation_saved_id(saved_id)
    data_dir = require_data_dir(request)

    store = _open_store(data_dir, student_id)
    try:
        record = store.get_animation(saved_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"动画库里没有条目 {saved_id!r}")
        html = _read_html(data_dir, student_id, record)
    finally:
        store.close()
    return _view(record, html)


@router.delete("/animation/saved/{student_id}/{saved_id}", summary="删一条已保存的动画（只删自己的）")
def delete_saved_animation(request: Request, student_id: str, saved_id: str) -> JSONResponse:
    """删掉一条记录 + 它落盘的 HTML。**只可能删到自己的**（同 :func:`get_saved_animation`）。

    库里没有这条 id → **404**（不静默当成功：调用方据此知道「这里本来就没有这一条」，
    而不是以为自己删掉了别人看得见的东西）。
    """
    validate_student_id(student_id)
    animation_saved_id(saved_id)
    data_dir = require_data_dir(request)

    store = _open_store(data_dir, student_id)
    try:
        record = store.get_animation(saved_id)
        if record is None:
            raise HTTPException(status_code=404, detail=f"动画库里没有条目 {saved_id!r}")
        removed = store.delete_animation(saved_id)
        if not removed:  # pragma: no cover - 同一请求内先读后删，只剩并发删除这一种可能
            raise HTTPException(status_code=404, detail=f"动画库里没有条目 {saved_id!r}")
    finally:
        store.close()

    _remove_html(_resolve_html_path(data_dir, student_id, record.html_path))
    logger.info("动画库已删除：学生=%s 条目=%s", student_id, saved_id)
    return JSONResponse({"deleted": True, "id": saved_id})


# --------------------------------------------------------------------------- #
# 存储
# --------------------------------------------------------------------------- #
def _open_store(data_dir: str | Path, student_id: str):
    """开这个学生的 ``learning.db``（**一人一连接，用完即关**；调用方负责 ``close()``）。

    ★ 走 ``students.open_learning_store``（**归口**，不在这里拼 ``learning.db`` 的路径）：
      库与目录的建法只有一处实现，动画库不该自带第二套。
    """
    return open_learning_store(data_dir, student_id)


__all__ = [
    "SAVED_DIRNAME",
    "animation_saved_id",
    "delete_saved_animation",
    "get_saved_animation",
    "list_saved_animations",
    "lookup_saved_animation",
    "router",
    "save_saved_animation",
    "saved_animation_root",
]
