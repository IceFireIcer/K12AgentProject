/**
 * 界面外壳状态（`stores/ui.ts`）与「去练一练」**交接**的断言。
 *
 * 这一组盯住两件容易静默出错的事：
 *
 * 1. ★ **顶栏按钮的文案与它将要去的地方必须一致**：按钮循环顺序与文案分别定义，
 *    两处对不上就会表现成「按钮写着『去设置』，点下去却到了学习档案」。
 *    这里断言的是「文案 → 下一个视图」这条对应关系本身。
 * 2. ★ **「去练一练」只预填、不自动发送**：预填后草稿进 `chat.draft`、
 *    视图切回对话页，而 `send` **没被调用**（否则会替学生消耗一次云端调用，
 *    也剥夺了他补一句「我想练简单的」的机会）。
 *
 * 跑法与 `renderer-quiz.test.ts` 一致（Node 内置类型擦除 + 内置断言）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

/**
 * ★ 渲染进程的相对导入不带扩展名（Vite 口味），Node ESM 要求显式扩展名。
 *   这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`（与 `renderer-quiz.test.ts` 同一手法）。
 *   ⚠️ 被测模块必须用**动态 import**：静态 import 会被提到 hook 注册之前。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.ts', '/index.ts']) {
          const candidate = new URL(specifier + suffix, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
      }
      throw error
    }
  }
})

const { nextView, useUiStore, VIEW_LABELS, VIEW_ORDER, VIEW_TITLES } = await import(
  '../src/renderer/src/stores/ui.ts'
)

setActivePinia(createPinia())

test('视图顺序是三步循环：对话 → 学习档案 → 设置 → 对话', () => {
  assert.deepEqual([...VIEW_ORDER], ['chat', 'study', 'settings'])
  assert.equal(nextView('chat'), 'study')
  assert.equal(nextView('study'), 'settings')
  assert.equal(nextView('settings'), 'chat')
})

test('★ 每个视图的按钮文案指向**下一个**视图（文案与去向不能对不上）', () => {
  for (const view of VIEW_ORDER) {
    const target = nextView(view)
    const label = VIEW_LABELS[view]
    // 文案里应当出现目标视图的中文名，或者是一句明确的「返回对话」
    const targetTitle = VIEW_TITLES[target]
    const ok =
      label === targetTitle ||
      label === `返回${targetTitle}` ||
      (target === 'chat' && label.includes('对话')) ||
      (target === 'settings' && label.includes('设置')) ||
      (target === 'study' && label.includes('学习档案'))
    assert.ok(ok, `视图 ${view} 的按钮写着「${label}」，但点下去会到「${targetTitle}」`)
  }
})

test('每个视图都有中文名（面包屑与断言用）', () => {
  for (const view of VIEW_ORDER) {
    assert.ok(VIEW_TITLES[view], `视图 ${view} 缺中文名`)
    assert.equal(typeof VIEW_TITLES[view], 'string')
  }
  // 三个名字互不相同（否则界面上分不清在哪一页）
  assert.equal(new Set(Object.values(VIEW_TITLES)).size, VIEW_ORDER.length)
})

test('初始视图是**对话**（对话优先，不是打开就进设置）', () => {
  const ui = useUiStore()
  assert.equal(ui.view, 'chat')
  assert.equal(ui.studyTab, 'report')
})

test('show() 能切视图，并可选**同时**指定学习档案的哪一页', () => {
  const ui = useUiStore()
  ui.show('study', 'mistakes')
  assert.equal(ui.view, 'study')
  assert.equal(ui.studyTab, 'mistakes')
  // 不带第二参时不改分页（从设置回到档案时应停在上次那一页）
  ui.show('settings')
  assert.equal(ui.view, 'settings')
  assert.equal(ui.studyTab, 'mistakes')
  ui.show('chat')
  assert.equal(ui.view, 'chat')
})

test('顶栏循环：连续点三次回到起点（不会卡在某一页）', () => {
  const ui = useUiStore()
  ui.show('chat')
  for (let i = 0; i < VIEW_ORDER.length; i += 1) {
    ui.show(nextView(ui.view))
  }
  assert.equal(ui.view, 'chat', '走完整圈应当回到起点')
})

/* ------------------------------------------------------------------ *
 * 「去练一练」交接：预填 + 切视图，但**不发送**
 * ------------------------------------------------------------------ */

test('★★ 去练一练：预填草稿并切回对话页，但**不调用 send**', async () => {
  const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
  const chat = useChatStore()
  const ui = useUiStore()

  // 造一个会记录调用的 window.api（渲染进程只经 preload 白名单）
  const calls: Array<Record<string, unknown>> = []
  const originalWindow = (globalThis as { window?: unknown }).window
  const api = {
    sendChat: (payload: Record<string, unknown>) => {
      calls.push(payload)
      return Promise.resolve({ ok: true, requestId: 'turn-1', message: null })
    },
    onChatEvent: () => () => {},
    onGradeChanged: () => () => {},
    getGrade: () => Promise.resolve({ ok: false, message: '未接线' }),
    getSidecarInfo: () => Promise.resolve({ phase: 'ready' }),
    onSidecarChanged: () => () => {}
  }
  ;(globalThis as { window?: unknown }).window = { api }

  try {
    ui.show('study', 'mistakes')
    chat.prepareQuestion('我在「循环」上错了几次，请再出几道题让我练一练。')
    ui.show('chat')
    // 等一个微任务轮次：若实现里偷着调了 send，这里就能抓到
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(chat.draft, '我在「循环」上错了几次，请再出几道题让我练一练。')
    assert.equal(ui.view, 'chat', '应当切回对话页')
    assert.deepEqual(calls, [], '★ 预填绝不能顺手把消息发出去（会替学生消耗一次云端调用）')
  } finally {
    chat.draft = ''
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window
    else (globalThis as { window?: unknown }).window = originalWindow
  }
})

test('预填可以被覆盖、也可以清空（草稿就是普通输入框内容）', async () => {
  const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')
  const chat = useChatStore()
  chat.prepareQuestion('第一句')
  assert.equal(chat.draft, '第一句')
  chat.prepareQuestion('第二句')
  assert.equal(chat.draft, '第二句', '再次预填应当覆盖而不是拼接')
  chat.draft = ''
  assert.equal(chat.draft, '')
})
