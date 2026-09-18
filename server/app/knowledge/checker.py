"""教材内容自检：**学段错位（超纲/语气）检查**。

为什么值得单独一个模块（执行文档 §10.5、票 10 的验收项）：
教材是人工写的，最容易犯的错不是「写错」，而是「写窜」——
小学低年级里冒出「特征向量」，初中课文里冒出「小朋友」。
这类错误在检索层**完全看不出来**（照样命中、照样回答），
只会在演示现场被验收方一句「小学生看得懂这个？」戳破。

三个检查项：

1. **超纲术语**：术语文表里 ``min_grade`` 高于文档学段 → 违规；
2. **语气错位**：``tone_markers`` 里禁止出现的学段出现了该词 → 违规；
3. **跨学段搬运**：同一段正文在**不同学段**里逐字出现 → 违规
   （跨学段复用必须**改写**，不能复制粘贴；否则「学段自适应」是假的）。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from app.knowledge.library import GRADE_LEVELS, KnowledgeDoc, grade_index

VIOLATION_TERM = "term"
VIOLATION_TONE = "tone"
VIOLATION_DUPLICATE = "duplicate"

_WORD = re.compile(r"[\u4e00-\u9fffA-Za-z0-9_]+")


@dataclass(frozen=True)
class Violation:
    kind: str
    kp_id: str
    grade_level: str
    detail: str
    snippet: str = ""


@dataclass
class AuditReport:
    violations: list[Violation] = field(default_factory=list)
    checked_docs: int = 0
    checked_terms: int = 0

    @property
    def ok(self) -> bool:
        return not self.violations

    def by_kind(self, kind: str) -> list[Violation]:
        return [v for v in self.violations if v.kind == kind]


def _terms(terminology: dict) -> list[dict]:
    raw = terminology.get("terms") or []
    return [t for t in raw if isinstance(t, dict) and t.get("term")]


def _tone_markers(terminology: dict) -> list[dict]:
    raw = terminology.get("tone_markers") or []
    return [t for t in raw if isinstance(t, dict) and t.get("pattern")]


def _snippet(text: str, term: str, width: int = 18) -> str:
    idx = text.find(term)
    if idx < 0:
        return ""
    start = max(0, idx - width)
    return ("…" if start else "") + text[start : idx + len(term) + width].replace("\n", " ")


def audit_library(docs: Iterable[KnowledgeDoc], terminology: dict) -> AuditReport:
    """跑三项检查，返回报告（不抛异常 —— 由调用方决定警告还是中止）。"""
    doc_list = list(docs)
    terms = _terms(terminology)
    tones = _tone_markers(terminology)
    report = AuditReport(checked_docs=len(doc_list), checked_terms=len(terms))

    for doc in doc_list:
        body = "\n".join(section.text for section in doc.sections)
        doc_rank = grade_index(doc.grade_level)

        for entry in terms:
            term = str(entry["term"])
            min_grade = str(entry.get("min_grade") or "primary_low")
            if min_grade not in GRADE_LEVELS:
                raise ValueError(f"术语文表 min_grade 非法：{min_grade!r}（term={term}）")
            if doc_rank < grade_index(min_grade) and term in body:
                report.violations.append(
                    Violation(
                        kind=VIOLATION_TERM,
                        kp_id=doc.kp_id,
                        grade_level=doc.grade_level,
                        detail=f"术语「{term}」最早出现在 {min_grade}，本文档是 {doc.grade_level}（超纲）",
                        snippet=_snippet(body, term),
                    )
                )

        for entry in tones:
            pattern = str(entry["pattern"])
            forbidden = [str(g) for g in entry.get("forbidden_in") or []]
            if doc.grade_level in forbidden and pattern in body:
                report.violations.append(
                    Violation(
                        kind=VIOLATION_TONE,
                        kp_id=doc.kp_id,
                        grade_level=doc.grade_level,
                        detail=f"语气词「{pattern}」不适合 {doc.grade_level} 学段（{entry.get('note', '')}）",
                        snippet=_snippet(body, pattern),
                    )
                )

    report.violations.extend(_duplicate_violations(doc_list))
    return report


def _duplicate_violations(docs: Sequence[KnowledgeDoc]) -> list[Violation]:
    """跨学段逐字搬运检测（按去标点后的正文比对）。"""
    seen: dict[str, tuple[str, str]] = {}
    out: list[Violation] = []
    for doc in docs:
        for section in doc.sections:
            normalized = re.sub(r"[\s，。、；：！？,.;:!?（）()「」“”\"']+", "", section.text)
            if len(normalized) < 60:  # 太短的不算（例如「小结」这种短节）
                continue
            key = normalized
            prev = seen.get(key)
            if prev is None:
                seen[key] = (doc.grade_level, doc.kp_id)
                continue
            prev_grade, prev_kp = prev
            if prev_grade != doc.grade_level:
                out.append(
                    Violation(
                        kind=VIOLATION_DUPLICATE,
                        kp_id=doc.kp_id,
                        grade_level=doc.grade_level,
                        detail=(
                            f"本节正文与 {prev_kp}（{prev_grade}）逐字重复；"
                            "跨学段复用必须按学段改写（语气与深度都要变）"
                        ),
                        snippet=section.title,
                    )
                )
    return out


def format_report(report: AuditReport) -> str:
    """人读版报告（build_kb 直接打印）。"""
    lines = [
        f"学段错位自检：检查 {report.checked_docs} 篇文档 / {report.checked_terms} 条术语，"
        f"发现 {len(report.violations)} 处问题"
    ]
    for kind, title in (
        (VIOLATION_TERM, "超纲术语"),
        (VIOLATION_TONE, "语气错位"),
        (VIOLATION_DUPLICATE, "跨学段搬运"),
    ):
        items = report.by_kind(kind)
        if not items:
            continue
        lines.append(f"  ── {title}（{len(items)}）")
        for v in items:
            lines.append(f"     [{v.grade_level}] {v.kp_id}: {v.detail}")
            if v.snippet:
                lines.append(f"         … {v.snippet}")
    if report.ok:
        lines.append("  ✓ 四学段术语与语气均在位（无超纲、无错位语气、无逐字搬运）")
    return "\n".join(lines)


def load_terminology_file(path: str | Path) -> dict:
    p = Path(path)
    if not p.exists():
        return {"terms": [], "tone_markers": []}
    return json.loads(p.read_text(encoding="utf-8"))


__all__ = [
    "AuditReport",
    "VIOLATION_DUPLICATE",
    "VIOLATION_TERM",
    "VIOLATION_TONE",
    "Violation",
    "audit_library",
    "format_report",
    "load_terminology_file",
]
