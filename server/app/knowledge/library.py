"""教材源文件（``server/knowledge/``）的解析与校验。

**不做 PDF 解析**（执行文档 §3.3）：教材是人工编写的 Markdown + 元数据。
链路更短更可控，也避开了「PDF 抽取错行 → 分块错乱 → 检索答非所问」这条最贵的排错路径。

文件形态（一人一份文件 + 文件头元数据）::

    ---
    kp_id: jr-py-loop
    grade_level: junior
    chapter_title: 第4章 用 Python 处理数据
    knowledge_point: 循环
    content_type: concept
    summary: 一句话摘要（供大纲兜底与画像展示）
    ---
    ## 一、为什么需要循环
    ……正文……

元数据字段与执行文档 §8.3 的 chunk 列**严格对齐**（``chunk_id`` / ``parent_chunk_id`` /
``token_count`` / ``embedding`` 由建库脚本派生，不写在文件头里）。
**随手改字段名会让建索引直接报错** —— 这是有意为之：宁可建库失败，也不要静默丢元数据。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

# 四学段（与 ``app.contracts.GradeLevel`` 一字不差）
GRADE_LEVELS: tuple[str, ...] = ("primary_low", "primary_high", "junior", "senior")

# 目录名 → 学段值。目录用连字符（`primary-low`），入库用下划线（`primary_low`）。
GRADE_DIRS: dict[str, str] = {
    "primary-low": "primary_low",
    "primary-high": "primary_high",
    "junior": "junior",
    "senior": "senior",
}

# 内容类型：概念 / 原理 / 实践 / 伦理 / 项目。用于大纲兜底与前端徽章。
CONTENT_TYPES: tuple[str, ...] = ("concept", "principle", "practice", "ethics", "project")

REQUIRED_META: tuple[str, ...] = (
    "kp_id",
    "grade_level",
    "chapter_title",
    "knowledge_point",
    "content_type",
)
OPTIONAL_META: tuple[str, ...] = ("summary",)

SECTION_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$", re.MULTILINE)


class KnowledgeFormatError(ValueError):
    """教材源文件格式错误。**必须报错并中止建库**，不允许跳过。"""


@dataclass(frozen=True)
class Section:
    index: int
    title: str
    text: str


@dataclass(frozen=True)
class KnowledgeDoc:
    kp_id: str
    grade_level: str
    chapter_title: str
    knowledge_point: str
    content_type: str
    summary: str
    path: Path
    sections: tuple[Section, ...]

    @property
    def section_title(self) -> str:
        """``kp.section_title``：取首个节标题（一个知识点可能跨多节，取主节）。"""
        return self.sections[0].title if self.sections else ""


@dataclass(frozen=True)
class DependencyEdge:
    """依赖边。★ **``from`` 是前置，``to`` 是后继**（全项目统一语义）。"""

    from_kp_id: str
    to_kp_id: str
    relation: str = "prerequisite"
    weight: float = 1.0


@dataclass(frozen=True)
class Manifest:
    version: int
    dependencies: tuple[DependencyEdge, ...] = ()
    notes: str = ""
    extra: dict = field(default_factory=dict)


# --------------------------------------------------------------------------- #
# 解析
# --------------------------------------------------------------------------- #
def parse_front_matter(raw: str) -> tuple[dict[str, str], str]:
    """解析文件头 ``---`` 之间的 ``key: value``。

    刻意不引入 YAML 依赖：本项目的文件头只有平坦的字符串字段，
    自解析能让错误信息精确到「第几行、哪个字段」，而 PyYAML 的报错对内容作者不友好。
    """
    text = raw.lstrip("\ufeff")
    if not text.startswith("---"):
        raise KnowledgeFormatError("缺少文件头：首行必须是 `---`（见 knowledge/README.md）")
    lines = text.splitlines()
    end = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end is None:
        raise KnowledgeFormatError("文件头没有收尾的 `---`")

    meta: dict[str, str] = {}
    for i in range(1, end):
        line = lines[i]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise KnowledgeFormatError(f"文件头第 {i + 1} 行不是 `key: value`：{line!r}")
        key, _, value = line.partition(":")
        key = key.strip()
        value = value.strip().strip("'\"")
        if key in meta:
            raise KnowledgeFormatError(f"文件头字段重复：{key}")
        meta[key] = value
    return meta, "\n".join(lines[end + 1 :])


def split_sections(body: str) -> tuple[Section, ...]:
    """按 ``## `` 切节。正文里的一级标题（``# ``）归入其后的第一节。"""
    matches = list(SECTION_RE.finditer(body))
    if not matches:
        raise KnowledgeFormatError("正文里没有任何 `## ` 小节标题")
    sections: list[Section] = []
    for idx, m in enumerate(matches):
        start = m.end()
        stop = matches[idx + 1].start() if idx + 1 < len(matches) else len(body)
        text = body[start:stop].strip()
        title = m.group("title").strip()
        if not text:
            raise KnowledgeFormatError(f"小节「{title}」正文为空")
        sections.append(Section(index=idx, title=title, text=text))
    return tuple(sections)


def load_document(path: str | Path) -> KnowledgeDoc:
    """读一个知识点 Markdown 并做**严格校验**。"""
    p = Path(path)
    # 目录名（`junior`）→ 学段值（`junior`）：用于校验「文件头学段与所在目录一致」。
    # ⚠️ 只对**四个学段目录**做这条校验；导入路径（`import_document`）没有目录上下文的
    #    约束（它按学生指定的学段落盘），所以这里把期望值算出来再传下去。
    return parse_document(
        p.read_text(encoding="utf-8"),
        file_name=p.name,
        expected_grade=GRADE_DIRS.get(p.parent.name),
    )


def parse_document(
    raw: str,
    *,
    file_name: str,
    expected_grade: str | None = None,
) -> KnowledgeDoc:
    """从**一段 Markdown 文本**解析并严格校验（`:func:`load_document` 的无文件版本）。

    存在的理由：教材导入（``POST /api/knowledge/import``）拿到的是**已上传的正文**，
    此刻它还没有落盘。如果导入端自己再写一份校验，两份规则必然分叉 ——
    于是「导入时通过、建库时失败」这类最难查的不一致就出现了。
    所以校验**只有这一处**，文件版本只是它的薄包装。

    ``expected_grade`` 给定时校验「文件头学段与目录一致」（见调用点）；
    导入路径传 ``None``（没有目录可依）。
    """
    # 装作一个路径只为拿到 `.name` 与 `.stem`（错误信息与 kp_id==文件名 那条约定要用）
    p = Path(file_name)
    meta, body = parse_front_matter(raw)

    missing = [k for k in REQUIRED_META if not meta.get(k)]
    if missing:
        raise KnowledgeFormatError(f"{p.name}: 缺少必需字段 {missing}")

    unknown = [k for k in meta if k not in REQUIRED_META + OPTIONAL_META]
    if unknown:
        raise KnowledgeFormatError(
            f"{p.name}: 出现契约外字段 {unknown}（允许：{REQUIRED_META + OPTIONAL_META}）"
        )

    grade = meta["grade_level"]
    if grade not in GRADE_LEVELS:
        raise KnowledgeFormatError(f"{p.name}: grade_level={grade!r} 不在 {GRADE_LEVELS}")

    # 目录名与文件头学段必须一致 —— 学段错位是高危错误（检索隔离全按它走）
    if expected_grade is not None and expected_grade != grade:
        raise KnowledgeFormatError(
            f"{p.name}: 文件头 grade_level={grade} 与所在目录（应为 {expected_grade}）不一致"
        )

    if p.stem != meta["kp_id"]:
        raise KnowledgeFormatError(
            f"{p.name}: kp_id={meta['kp_id']!r} 与文件名不一致（约定：文件名 = kp_id.md）"
        )

    if meta["content_type"] not in CONTENT_TYPES:
        raise KnowledgeFormatError(
            f"{p.name}: content_type={meta['content_type']!r} 不在 {CONTENT_TYPES}"
        )

    return KnowledgeDoc(
        kp_id=meta["kp_id"],
        grade_level=grade,
        chapter_title=meta["chapter_title"],
        knowledge_point=meta["knowledge_point"],
        content_type=meta["content_type"],
        summary=meta.get("summary", ""),
        path=p,
        sections=split_sections(body),
    )


def iter_documents(knowledge_dir: str | Path) -> Iterator[KnowledgeDoc]:
    """按「学段 → 文件名」稳定顺序遍历四个学段目录。"""
    root = Path(knowledge_dir)
    if not root.is_dir():
        raise KnowledgeFormatError(f"教材目录不存在：{root}")
    for dirname in GRADE_DIRS:
        sub = root / dirname
        if not sub.is_dir():
            continue
        for path in sorted(sub.glob("*.md")):
            if path.name.startswith("_"):
                continue
            yield load_document(path)


def load_library(knowledge_dir: str | Path) -> list[KnowledgeDoc]:
    return list(iter_documents(knowledge_dir))


# --------------------------------------------------------------------------- #
# manifest.json（依赖关系）
# --------------------------------------------------------------------------- #
MANIFEST_NAME = "manifest.json"


def load_manifest(knowledge_dir: str | Path) -> Manifest:
    """读依赖关系清单。

    ★ 悬空 ``from`` / ``to``（知识点表里查不到）的处理在 ``app/knowledge/deps.py``：
    那里能同时看到 ``kp`` 表，**报错并中止导入，不静默跳过**。
    """
    path = Path(knowledge_dir) / MANIFEST_NAME
    if not path.exists():
        return Manifest(version=1, notes=f"{path} 不存在，无依赖关系")
    data = json.loads(path.read_text(encoding="utf-8"))
    edges: list[DependencyEdge] = []
    for raw in data.get("dependencies", []):
        for key in ("from", "to"):
            if not raw.get(key):
                raise KnowledgeFormatError(f"manifest.json 依赖项缺少 `{key}`：{raw!r}")
        relation = str(raw.get("relation", "prerequisite"))
        if relation not in ("prerequisite", "related"):
            raise KnowledgeFormatError(
                f"manifest.json 依赖项 relation={relation!r} 非法（prerequisite | related）：{raw!r}"
            )
        edges.append(
            DependencyEdge(
                from_kp_id=str(raw["from"]),
                to_kp_id=str(raw["to"]),
                relation=relation,
                weight=float(raw.get("weight", 1.0)),
            )
        )
    return Manifest(
        version=int(data.get("version", 1)),
        dependencies=tuple(edges),
        notes=str(data.get("notes", "")),
    )


def load_terminology(knowledge_dir: str | Path) -> dict:
    """读术语文表（学段错位检查用，见 ``app/knowledge/checker.py``）。"""
    path = Path(knowledge_dir) / "terminology.json"
    if not path.exists():
        return {"terms": [], "tone_markers": []}
    return json.loads(path.read_text(encoding="utf-8"))


def grade_index(grade_level: str) -> int:
    """学段序号（越小越低）。用于「超纲」判断与向上兼容排序。"""
    try:
        return GRADE_LEVELS.index(grade_level)
    except ValueError as exc:
        raise KnowledgeFormatError(f"未知学段：{grade_level!r}") from exc


def compatible_grades(grade_level: str) -> list[str]:
    """**向上兼容**的学段集合 = 学生学段 + 更低学段（按由高到低排序）。

    ★ 语义在这里定死，别处不要再解释一遍：

    - 只允许命中**不高于**学生学段的内容（初中生拿到小学内容 = 复习，合理）；
    - **绝不返回更高学段的内容**（初中生拿到高中内容 = 超纲，关卡 C 的判据）；
    - 命中更低学段时结果标 ``compat=true``，前端要显式标注。

    "向上兼容" 指的是**学生可以往上走时回看下面的内容**，
    不是「自动给他上面的内容」—— 后者是超纲，也是关卡 C 要卡死的东西。
    """
    idx = grade_index(grade_level)
    return list(reversed(GRADE_LEVELS[: idx + 1]))
