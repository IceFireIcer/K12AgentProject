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
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
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

/* ------------------------------------------------------------------ *
 * 「新会话」的连带清理：工具轨迹面板也要清（任务 ④）
 * ------------------------------------------------------------------ */

function chatViewSource(): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'views', 'Chat.vue'),
    'utf8'
  )
}

test('★★ 新会话必须**真的换一条会话**（而不是只清屏）+ 连带清空工具轨迹面板', () => {
  // 缺陷形态（两条，第二条是这轮才发现的）：
  //   ① `trace.reset()` 早就写好了，却**全仓零调用方**；学生点「新会话」，
  //      对话清空了，右栏「工具调用」页仍列着上一段对话的轮次分组。
  //   ② ★★ 旧实现只调 `chat.resetConversation()` —— **纯本地清屏**，
  //      Pi 那一侧的会话一动不动。于是「新会话」之后说的每一句话都写进
  //      **同一个** JSONL 文件，历史列表里也只有那一条越来越长。
  //      按钮叫「新会话」，做的却是「清屏」—— 这条断言就是为了钉住这个区别。
  const source = chatViewSource()
  const start = source.indexOf('async function newSession(')
  assert.ok(start > 0, '找不到 newSession')
  const body = source.slice(start, start + 1800)

  // ① ★ 必须走 store 的 `startNewSession()`（它经 `session:new` 让主进程开一个新文件）。
  //    只调 `chat.resetConversation()` = 只清屏 —— 那正是上面 ② 的缺陷形态。
  assert.match(
    body,
    /chat\.startNewSession\(\)/,
    '★ newSession 必须调 `chat.startNewSession()`：只清界面不换会话文件 = 「新会话」名不副实'
  )
  // 反向对照：失败了要**什么都不做**（界面清空了却没换会话是最坏的失败形态 ——
  // 学生以为在说新话题，其实接着写进上一条会话）
  assert.match(
    body,
    /if\s*\(!result\.ok\)[\s\S]{0,200}return/,
    '★ 新建失败时必须提前返回（不许先把界面清空）'
  )

  // ② 工具轨迹那一半：必须真的调了 reset（不是只 import 了 store）
  assert.match(source, /trace\.reset\(\)/, 'Chat.vue 的 newSession 必须调 trace.reset()')
  assert.match(body, /trace\.reset\(\)/, '★ 同一段里必须有清轨迹的那半句')
  assert.ok(
    body.indexOf('startNewSession()') < body.indexOf('trace.reset()'),
    '★ 顺序：先确认会话真的换成了，再清轨迹面板 —— 反过来会在失败时留下一块空面板'
  )

  // ③ 用的是**已有的** store 实例（Pinia 单例），不是新引一个造成双实例假象
  assert.match(source, /const trace = useTraceStore\(\)/, '要在本组件里取到 trace store')
})

test('★★ 清屏那一半在 store 里：切会话必须整段替换消息列表，不是追加', async () => {
  // 「先确认会话真的换了，再清界面」这条纪律的落点在 store 的 `applySwitchResult`：
  // 它必须用 `restoreConversation`（**替换**）而不是把恢复出来的消息追加到现有轮次后面。
  // 追加的后果：切会话之后两段对话拼在一起，学生会看到自己没说过的话。
  const storeSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'stores', 'chat.ts'),
    'utf8'
  )
  const at = storeSource.indexOf('function applySwitchResult(')
  assert.ok(at > 0, '找不到 applySwitchResult')
  const body = storeSource.slice(at, at + 2200)
  assert.match(
    body,
    /conversation\.value\s*=\s*restoreConversation\(/,
    '★ 切会话必须**整段替换**消息列表（`conversation.value = restoreConversation(...)`）'
  )
  assert.doesNotMatch(
    body,
    /conversation\.value\.turns\.push|turns:\s*\[\.\.\.conversation/,
    '★ 不许把恢复出来的消息**追加**到当前轮次后面（两段对话会拼在一起）'
  )
  // ★ 开场引导的落点也必须在同一段里（切会话与「AI 先开口」是同一件事的两半：
  //   新会话建立后要显示开场，切到历史会话时不能显示）
  assert.match(body, /opening\.value\s*=\s*result\.opening/, '切会话时要一并落下开场引导')

  // 行为面：`restoreConversation` 是**替换**语义（不是追加）
  const { restoreConversation, emptyConversation } = await import('../src/renderer/src/api/events.ts')
  // ★★ 一问一答要配成**一轮**（不是两条各占一轮）—— 见 P-106：
  //   初版拆成两条各一轮，界面上一轮只有学生气泡、下一轮只有回答，视觉是「一半一半」。
  const restored = restoreConversation([
    { role: 'user', text: '以前问过的', at: 0 },
    { role: 'assistant', text: '以前答过的', at: 0 }
  ])
  assert.equal(restored.turns.length, 1, '★ 一问一答 = 一轮')
  assert.equal(restored.turns[0]?.userText, '以前问过的')
  assert.equal(restored.turns[0]?.text, '以前答过的')
  assert.equal(restored.turns[0]?.status, 'done', '恢复出来的历史消息不该是 streaming')
  // 空会话 → 真的空（不是「保留原来的」）
  assert.deepEqual(restoreConversation([]).turns, [])
  assert.deepEqual(emptyConversation().turns, [])
})

test('★ trace.reset() 不再是没有调用方的死代码（源码级反向对照）', async () => {
  const { useTraceStore } = await import('../src/renderer/src/stores/trace.ts')

  // 行为面：reset 真的把两份状态都归零（清一半会让右栏继续画旧分组）
  setActivePinia(createPinia())
  const trace = useTraceStore()
  trace.entries = [{ turn: 3, toolName: 'rag_search', argsSummary: 'q', ok: true, latencyMs: 5 }]
  trace.turn = 3
  trace.reset()
  assert.deepEqual(trace.entries, [])
  assert.equal(trace.turn, 0)
})
