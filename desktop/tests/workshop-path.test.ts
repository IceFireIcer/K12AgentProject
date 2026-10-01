/**
 * 智码工坊的**关卡分组规则**（`study/workshop-path.ts`）单测。
 *
 * 这一组断言守护三件「改坏了不会报错、只会静默错位」的事：
 *
 *   1. **分组键是教材章节，不是前端自己编的知识体系** —— 教材加一章要自动多一块，
 *      硬编码 5 个模块那种写法会在教材换代后把关卡分错堆，而界面上不会有任何报错。
 *   2. **顺序听服务端的**（依赖图拓扑序）：组内关卡不重排，模块顺序按首次出现。
 *   3. **没有「未解锁」这一档**：后端播种时每一关都是 `learning`，
 *      所以任何关卡都不许被分组逻辑丢掉（丢了就是学生再也点不到那一关）。
 *
 * 跑法：`cd desktop && node --test tests/workshop-path.test.ts`
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FALLBACK_MODULE_TITLE,
  groupLevelsByChapter,
  isLevelDone,
  moduleTitle,
  nextLevelId,
  pathLevelsOf,
  type WorkshopLevel
} from '../src/renderer/src/study/workshop-path.ts'

/** 造一条路径（stage 默认 `learning` —— 与后端播种的形态一致）。 */
function levels(spec: Array<[string, string?]>): WorkshopLevel[] {
  return spec.map(([kpId, stage]) => ({ kpId, stage: stage ?? 'learning' }))
}

/** 章节查表：`kp → 章节原文`；查不到返回 `null`（与 `knowledge.kpChapterOf` 同形）。 */
function chapterOf(map: Record<string, string>) {
  return (kpId: string): string | null => map[kpId] ?? null
}

/* ------------------------------------------------------------------ *
 * 模块标题
 * ------------------------------------------------------------------ */

test('模块标题洗掉「第一章.」这类排序前缀（那是给排序用的，不是给学生读的）', () => {
  assert.equal(moduleTitle('第一章.人工智能的基础概念'), '人工智能的基础概念')
  assert.equal(moduleTitle('第七章.人工智能伦理与安全'), '人工智能伦理与安全')
  assert.equal(moduleTitle('第2章、核心技术分支'), '核心技术分支')
})

test('认不出前缀时原样返回；空值返回 null（由调用方落进「其他关卡」）', () => {
  assert.equal(moduleTitle('人工智能的基础概念'), '人工智能的基础概念')
  assert.equal(moduleTitle(null), null)
  assert.equal(moduleTitle(undefined), null)
  assert.equal(moduleTitle('   '), null)
})

/* ------------------------------------------------------------------ *
 * 分组
 * ------------------------------------------------------------------ */

test('按教材章节分组：模块顺序 = 各章在服务端顺序里第一次出现的位置', () => {
  const chapters = {
    a: '第一章.AI 基础概念',
    b: '第二章.三大底层支柱',
    c: '第一章.AI 基础概念',
    d: '第三章.核心技术分支'
  }
  const mods = groupLevelsByChapter(levels([['a'], ['b'], ['c'], ['d']]), chapterOf(chapters))

  assert.deepEqual(
    mods.map((m) => m.title),
    ['AI 基础概念', '三大底层支柱', '核心技术分支']
  )
  // 同一章的两关合在一块，且**保持服务端顺序**
  assert.deepEqual(mods[0].levels.map((l) => l.kpId), ['a', 'c'])
  assert.equal(mods[0].total, 2)
})

test('★ 组内关卡顺序 = 服务端给的拓扑序，前端不重排', () => {
  const chapters = { x: '第一章.甲', y: '第一章.甲' }
  // 服务端故意给一个「逆字典序」的顺序（y 在前）
  const mods = groupLevelsByChapter(levels([['y'], ['x']]), chapterOf(chapters))
  assert.deepEqual(mods[0].levels.map((l) => l.kpId), ['y', 'x'])
})

test('★ 查不到章节的关卡落进「其他关卡」，一个都不丢', () => {
  const chapters = { a: '第一章.AI 基础概念' }
  const mods = groupLevelsByChapter(levels([['a'], ['ghost'], ['b']]), chapterOf(chapters))

  assert.equal(mods.length, 2)
  assert.equal(mods[1].title, FALLBACK_MODULE_TITLE)
  assert.deepEqual(mods[1].levels.map((l) => l.kpId), ['ghost', 'b'])
  // 总数守恒：分组只是重新摆放，不许吞掉关卡
  assert.equal(
    mods.reduce((sum, m) => sum + m.total, 0),
    3
  )
})

test('一条关卡都没有时不产出任何模块（空态下不该出现「0 / 0」的读数）', () => {
  assert.deepEqual(groupLevelsByChapter([], chapterOf({})), [])
})

/* ------------------------------------------------------------------ *
 * 计数与「继续闯关」
 * ------------------------------------------------------------------ */

test('已通关计数只认 quizzed / mastered（learning 是「可作答」，不是已通关）', () => {
  assert.equal(isLevelDone('quizzed'), true)
  assert.equal(isLevelDone('mastered'), true)
  assert.equal(isLevelDone('learning'), false)
})

test('模块上的已通关数按块统计', () => {
  const chapters = { a: '第一章.甲', b: '第一章.甲', c: '第二章.乙' }
  const mods = groupLevelsByChapter(
    levels([['a', 'mastered'], ['b'], ['c', 'quizzed']]),
    chapterOf(chapters)
  )
  assert.equal(mods[0].doneCount, 1)
  assert.equal(mods[0].total, 2)
  assert.equal(mods[1].doneCount, 1)
})

test('「继续闯关」跳第一个还没通关的关卡；全通关了回到第一关；没有关卡给空串', () => {
  const path = levels([['a', 'mastered'], ['b'], ['c']])
  assert.equal(nextLevelId(path), 'b')
  assert.equal(nextLevelId(levels([['a', 'mastered'], ['b', 'quizzed']])), 'a')
  assert.equal(nextLevelId([]), '')
})

/* ------------------------------------------------------------------ *
 * 本学段关卡路径（路径视图 ≠ 整张进度表）
 * ------------------------------------------------------------------ */

test("★★ 路径视图只留本学段关卡：更低学段的旧记录（inPath=false）不进路径", () => {
  // 真机症状：学段换过的学生，同一个概念在同一个模块里出现三次（同名、内容按学段不同）
  const rows = [
    { kpId: 'ai-definition-jr', stage: 'learning', inPath: true },
    { kpId: 'ai-definition-ph', stage: 'quizzed', inPath: false },
    { kpId: 'ai-definition-pl', stage: 'quizzed', inPath: false }
  ]
  assert.deepEqual(
    pathLevelsOf(rows).map((row) => row.kpId),
    ['ai-definition-jr']
  )
})

test("⚠️ 字段缺失（老 sidecar / 演示数据）按在路径上处理，不吞关卡", () => {
  const rows = [{ kpId: 'a', stage: 'learning' }, { kpId: 'b', stage: 'learning', inPath: false }]
  assert.deepEqual(
    pathLevelsOf(rows).map((row) => row.kpId),
    ['a']
  )
  assert.deepEqual(pathLevelsOf([]), [])
})

/* ------------------------------------------------------------------ *
 * 反「未解锁」
 * ------------------------------------------------------------------ */

test('★★ 没有锁定态：learning 的关卡照常分组、照常可点（不进任何隐藏/禁用分支）', () => {
  // 后端自 2026-09-25 起把每一关播种为 learning（`routes/quiz.py` 的 seed_progress）
  const all = levels([['a'], ['b'], ['c']])
  const mods = groupLevelsByChapter(all, chapterOf({ a: '第一章.甲', b: '第一章.甲', c: '第二章.乙' }))
  assert.equal(
    mods.reduce((sum, m) => sum + m.levels.length, 0),
    3
  )
  assert.equal(
    mods.every((m) => m.doneCount === 0),
    true
  )
})
