#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
K12KnowledgeBase 自检脚本

校验《写作规范》第六节的全部条目：
  1. 四学段标题存在、按序、无重复
  2. frontmatter 字段齐全，id 全局唯一
  3. source 指向的 docx 真实存在
  4. 各学段字数落在规范区间
  5. 小学低年级段不出现英文缩写 / 公式
  6. 全文无残留 U+200C
  7. 第七章文档含红线表述
  8. related 引用的 id 存在（允许引用尚未生成的章节，仅告警）

用法：python _meta/check.py [--strict]
"""
import os
import re
import sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_ROOT = os.path.dirname(BASE)          # 工作区根，源 docx 所在处
META = os.path.join(BASE, "_meta")
ZWNJ = "\u200c"

STAGES = ["小学低年级", "小学高年级", "初中", "高中"]
# 《写作规范》第一节字数区间（下限, 上限）；上限放宽 15% 容忍
LIMITS = {
    "小学低年级": (80, 150),
    "小学高年级": (150, 250),
    "初中": (250, 400),
    "高中": (350, 600),
}
TOLERANCE = 1.15
# 小学低年级禁止出现的英文缩写 / 公式
BANNED_L1 = re.compile(r"[A-Za-z]{2,}|\$|\\frac|\\sum")
# 第七章红线关键词（任一命中即可，按文档主题匹配）
REDLINES = {
    "7.1": ["核验", "查证", "权威"],
    "7.2": ["隐私", "敏感", "加密"],
    "7.3": ["不直接", "思路", "引导", "独立思考"],
    "7.4": ["公平", "适配", "分层"],
}
REQUIRED_FM = ["id", "name", "chapter", "source", "stages", "difficulty"]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def parse_frontmatter(text):
    """返回 (frontmatter 字典, 正文)。不依赖 pyyaml，手写轻量解析。"""
    if not text.startswith("---"):
        return None, text
    end = text.find("\n---", 3)
    if end == -1:
        return None, text
    raw = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    fm = {}
    for line in raw.split("\n"):
        if ":" not in line or line.startswith((" ", "\t", "#", "-")):
            continue
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip()
    return fm, body


def split_stages(body):
    """按 ## 学段标题切分，返回 {学段: 文本} 与出现顺序列表。"""
    order, blocks, cur = [], {}, None
    for line in body.split("\n"):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            cur = m.group(1)
            order.append(cur)
            blocks[cur] = []
        elif cur:
            blocks[cur].append(line)
    return order, {k: "\n".join(v).strip() for k, v in blocks.items()}


def strip_md(text):
    """去掉 Markdown 标记与空白，用于字数统计和禁用词检查。"""
    t = re.sub(r"`[^`]*`", "", text)
    t = re.sub(r"^>.*$", "", t, flags=re.M)
    t = re.sub(r"[*_#>|\-]", "", t)
    return re.sub(r"\s+", "", t)


def check_file(path):
    errs, warns = [], []
    text = read(path)
    rel = os.path.relpath(path, BASE)
    fm, body = parse_frontmatter(text)

    if ZWNJ in text:
        errs.append(f"残留 U+200C 零宽字符 x{text.count(ZWNJ)}")

    if fm is None:
        errs.append("缺少 frontmatter")
        return errs, warns, None

    for f in REQUIRED_FM:
        if f not in fm:
            errs.append(f"frontmatter 缺字段 {f}")

    # source 真实存在
    src = fm.get("source", "").strip()
    if src and src != "null":
        found = False
        for root, _dirs, files in os.walk(SRC_ROOT):
            if src in files and os.path.relpath(root, SRC_ROOT).split(os.sep)[0].startswith("第"):
                found = True
                break
        if not found:
            errs.append(f"source 不存在于源目录: {src}")

    order, blocks = split_stages(body)
    if order != STAGES:
        errs.append(f"学段标题异常: {order}（应为 {STAGES}）")

    for st in STAGES:
        if st not in blocks:
            continue
        plain = strip_md(blocks[st])
        n = len(plain)
        lo, hi = LIMITS[st]
        if n < lo:
            warns.append(f"{st} 仅 {n} 字（下限 {lo}）")
        elif n > hi * TOLERANCE:
            warns.append(f"{st} 共 {n} 字（上限 {hi}）")
        if st == "小学低年级":
            bad = BANNED_L1.findall(blocks[st])
            bad = [b for b in bad if b]
            if bad:
                errs.append(f"小学低年级含英文/公式: {sorted(set(bad))[:6]}")

    # 第七章红线
    for pid, kws in REDLINES.items():
        if fm.get("id", "").startswith(pid):
            if not any(k in body for k in kws):
                errs.append(f"缺少红线表述，需含 {kws} 之一")

    return errs, warns, (fm.get("id"), fm.get("related", ""))


def main():
    files = []
    for root, dirs, fs in os.walk(BASE):
        if os.path.basename(root) == "_meta":
            continue
        for f in fs:
            if f.endswith(".md"):
                files.append(os.path.join(root, f))
    files.sort()

    ids, related_refs = {}, []
    total_err = total_warn = 0

    for p in files:
        errs, warns, ident = check_file(p)
        rel = os.path.relpath(p, BASE)
        if errs:
            print(f"\n[FAIL] {rel}")
            for e in errs:
                print(f"   ✗ {e}")
            total_err += len(errs)
        if warns:
            print(f"\n[WARN] {rel}")
            for w in warns:
                print(f"   ! {w}")
            total_warn += len(warns)
        if ident and ident[0]:
            ids.setdefault(ident[0], []).append(rel)
            if ident[1] and ident[1] != "[]":
                related_refs.append((rel, ident[1]))

    print(f"\n{'='*60}")
    dups = {k: v for k, v in ids.items() if len(v) > 1}
    if dups:
        print("[FAIL] id 重复:")
        for k, v in dups.items():
            print(f"   {k}: {v}")
        total_err += len(dups)

    # related 引用检查（缺目标仅告警，允许跨章未生成）
    for rel, raw in related_refs:
        refs = re.findall(r"\b\d+\.\d+(?:\.\d+)?\b", raw)
        missing = [r for r in refs if r not in ids]
        if missing:
            print(f"[WARN] {rel} 的 related 未找到: {missing}")
            total_warn += len(missing)

    print(f"文件数: {len(files)}   id 数: {len(ids)}")
    print(f"错误: {total_err}   告警: {total_warn}")
    print("=" * 60)
    return 1 if (total_err and "--strict" in sys.argv) else 0


if __name__ == "__main__":
    sys.exit(main())
