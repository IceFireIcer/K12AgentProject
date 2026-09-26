/**
 * P1-3 / P1-4 守卫：学习记录页的**历史会话**必须与对话页同长相。
 *
 * 两个真机发现（便携版实测）：
 *   P1-3 标题出现英文占位 `(no messages)` —— 对话页左栏有兜底，学习记录页直接插值 `item.title`；
 *   P1-4 只读回看把 Markdown 原样显示（`**粗体**`、``` ```python ``` 围栏直接露出）——
 *         对话页走 `parseMarkdown` 渲染，档案页插值纯文本。
 *
 * 两处的根因是同一类：**同一件事有两份实现**。所以守卫不只断言「修好了」，
 * 还断言「没有第二份实现」——判据放在这里，两个消费方都必须 import 它。
 *
 * 跑法：`cd desktop && node --test tests/session-transcript-shared.test.ts`（也在 `npm test` 里）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { displaySessionTitle } from '../src/renderer/src/study/session-title.ts'

const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const read = (...segments: string[]): string =>
  readFileSync(join(DESKTOP_ROOT, ...segments), 'utf8')

const SESSIONS_TAB = read('src', 'renderer', 'src', 'study', 'SessionsTab.vue')
const SESSION_LIST = read('src', 'renderer', 'src', 'components', 'SessionList.vue')
const ANIMATION_CARD = read('src', 'renderer', 'src', 'components', 'ChatMessage.vue')

/* ------------------------------------------------------------------ *
 * P1-3 标题兜底：一份实现，两处共用
 * ------------------------------------------------------------------ */

test('G-P1-3a 标题兜底是纯函数且认得出英文占位', () => {
  assert.equal(displaySessionTitle('(no messages)'), '新的对话')
  assert.equal(displaySessionTitle('(NO MESSAGES)'), '新的对话', '比对要大小写不敏感')
  assert.equal(displaySessionTitle('(untitled)'), '新的对话')
  assert.equal(displaySessionTitle(''), '新的对话')
  assert.equal(displaySessionTitle('   '), '新的对话')
  assert.equal(displaySessionTitle(null), '新的对话')
  assert.equal(displaySessionTitle(undefined), '新的对话')
  // 正常标题一字不改（不截断、不改写）
  assert.equal(displaySessionTitle('为什么天空是蓝色的'), '为什么天空是蓝色的')
  assert.equal(displaySessionTitle('  带空白的标题  '), '带空白的标题')
})

test('G-P1-3b 两个会话列表都用共享兜底，不得再自己插值 title', () => {
  assert.ok(
    SESSIONS_TAB.includes('displaySessionTitle(item.title)'),
    '学习记录页必须走共享兜底 —— 直接渲染 item.title 就是 P1-3 那个英文占位'
  )
  assert.ok(
    SESSION_LIST.includes('displaySessionTitle'),
    '对话页左栏也要用同一份实现（两处判据分叉正是这个缺陷的成因）'
  )
  // 反面对照：`{{ item.title }}` / `{{ session.title }}` 这类裸插值不许再出现
  for (const [label, source] of [
    ['SessionsTab.vue', SESSIONS_TAB],
    ['SessionList.vue', SESSION_LIST]
  ] as const) {
    const bare = /\{\{\s*(item|session)\.title\s*\}\}/.exec(source)
    assert.equal(
      bare,
      null,
      `${label} 出现裸插值 ${bare?.[0]} —— 英文占位会原样露给学生（P1-3）`
    )
  }
})

test('G-P1-3c 占位词表只有一份（不得各自抄一份）', () => {
  const offenders = [SESSIONS_TAB, SESSION_LIST, ANIMATION_CARD].filter((source) =>
    /'(no messages)'|"\(no messages\)"/.test(source)
  )
  assert.deepEqual(
    offenders,
    [],
    '占位词表必须只住在 study/session-title.ts —— 抄第二份必然又漂移'
  )
})

/* ------------------------------------------------------------------ *
 * P1-4 正文渲染：一份实现，两处共用
 * ------------------------------------------------------------------ */

test('G-P1-4 只读回看与对话气泡共用同一个 Markdown 渲染组件', () => {
  assert.ok(
    SESSIONS_TAB.includes('MarkdownProse'),
    '历史会话的正文必须走共享渲染组件 —— 插值纯文本会把 `**粗体**` 与代码围栏露给学生（P1-4）'
  )
  assert.ok(
    ANIMATION_CARD.includes('MarkdownProse'),
    '对话气泡也应复用同一个组件（否则又是两份实现）'
  )
  // ★ 反面对照：`{{ message.text }}` 这种裸插值不许在回看里出现。
  //   先去掉注释 —— 修好之后注释里**正好引用**了那个旧写法讲清楚原来坏在哪，
  //   不去注释的话守卫会被自己的说明书绊倒（本项目反复踩到这一点）。
  const tabCode = SESSIONS_TAB.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\/[^\n]*/g, '')
  assert.equal(
    /\{\{\s*message\.text\s*\}\}/.test(tabCode),
    false,
    '回看正文出现裸插值 —— Markdown 会原样露出来（P1-4）'
  )
})

test('G-P1-4b 渲染组件不用 v-html（XSS 面为零的既定口径）', () => {
  const prose = read('src', 'renderer', 'src', 'components', 'MarkdownProse.vue')
  // ★ 先去掉注释再匹配：组件头部的说明**故意写着**「不用 `v-html`」讲清为什么，
  //   不去注释的话守卫会被自己的说明书绊倒（手法与 `build-pipeline.test.ts` 一致）。
  const code = prose
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\/[^\n]*/g, '')
  assert.equal(
    /v-html/.test(code),
    false,
    '正文是模型生成的文本，渲染不得用 v-html（`markdown.ts` 的模块头写着这条纪律）'
  )
})
