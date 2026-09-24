/**
 * 动画库 UI 行为的单测（交接文档 §5 的 P2 补测项）。
 *
 * 这一轮新写的「卡片两档来源 / 我的动画页签 / 跨学段预览」此前只过了 typecheck，
 * 没有测试证明它们真的对。`node --test` 里没有 Vue 运行时，组件本身测不了，
 * 所以这里钉住的是**组件行为所依赖的 store 契约与纯函数**：
 *
 *   A 卡片「我的」那条腿（`readSavedAnimation`）：
 *     A1 payload_id 必须从产物 HTML 里取回（沙箱按它校验每条 postMessage），
 *        `source` 一律 `generated`（库里存的都是做出来的，标成模板是对学生撒谎）；
 *     A2 ★ id 取不回来 → 返回 `null` + 学生话（宁可重新生成，不发一张永远等不到 ready 的卡）；
 *     A3 桥失败 / 记录不在 → `null`，绝不抛（它在卡片的点击处理器里被 await）。
 *
 *   B 「我的动画」页签（`loadSaved` 分片 + `setTab`）：
 *     B1 ★★ 清单按查询条件分片存 —— 卡片按**那张卡片的学段**查、页面按**当前（或预览）学段**查，
 *        两个条件各存一份互不覆盖（跨学段预览的 store 侧前提：预览别的年级不许冲掉自己的清单）；
 *     B2 同一条件不重复请求，`force` 才重取；
 *     B3 清单失败不抛：分片落空数组 + 学生话（界面显示「还没有」而不是报错）；
 *     B4 删除：就地从各分片摘除 + 按当前条件重取一次（后端才是权威）；
 *     B5 页签状态机：默认 `builtin`，`setTab` 可切 `mine`（页面 watch 依赖的契约）。
 *
 *   C 「在线生成」两条腿（`requestNewAnimation`）：
 *     C1 ★ 对话优先 —— 开得起来就绝不直连（这件事要留在对话上下文里）；
 *     C2 对话开不起来才直连；两条都不行给学生兜底文案；`startTurn` 抛异常按「没开起来」算。
 *
 * 跑法：`node --test tests/animation-library-ui.test.ts`
 * 手法与 `store-request-keys.test.ts` 一致：假桥方法清单从 `REQUIRED_METHODS` 派生（不手抄）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'

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

import { fileURLToPath } from 'node:url'

/* ------------------------------------------------------------------ *
 * 假桥（手动放行；与 store-request-keys.test.ts 同一配方）
 * ------------------------------------------------------------------ */

const { REQUIRED_METHODS } = await import('../src/renderer/src/api/data.ts')

interface PendingCall {
  method: string
  payload: Record<string, unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

interface Harness {
  calls: Record<string, PendingCall[]>
  release: (method: string, index: number, data: unknown) => void
  fail: (method: string, index: number, message: string) => void
  count: (method: string) => number
}

const DATA_METHODS = REQUIRED_METHODS.filter((method) => method !== 'onTraceChanged')

function installControllableBridge(): Harness {
  const calls: Record<string, PendingCall[]> = {}
  for (const method of DATA_METHODS) calls[method] = []

  const api: Record<string, unknown> = {}
  for (const method of DATA_METHODS) {
    api[method] = (payload: Record<string, unknown> = {}) =>
      new Promise((resolve, reject) => {
        calls[method].push({ method, payload, resolve, reject })
      })
  }
  api.onTraceChanged = () => () => {}
  api.onGradeChanged = () => () => {}
  api.getGrade = async () => ({ ok: false, message: '测试里不提供初始值' })
  api.onChapterChanged = () => () => {}
  api.getChapter = async () => ({ ok: false, message: '测试里不提供初始值' })
  api.onChatEvent = () => () => {}
  api.sendChat = async () => ({ ok: true, requestId: 'turn-1', message: null })
  api.getSidecarInfo = async () => ({ phase: 'ready' })
  api.onSidecarChanged = () => () => {}

  ;(globalThis as unknown as { window: unknown }).window = { api }

  return {
    calls,
    count: (method) => calls[method]?.length ?? 0,
    release: (method, index, data) => {
      const call = calls[method]?.[index]
      assert.ok(call, `${method} 的第 ${index} 次调用不存在（实际 ${calls[method]?.length ?? 0} 次）`)
      call.resolve({ ok: true, data })
    },
    fail: (method, index, message) => {
      const call = calls[method]?.[index]
      assert.ok(call, `${method} 的第 ${index} 次调用不存在（实际 ${calls[method]?.length ?? 0} 次）`)
      call.resolve({ ok: false, message })
    }
  }
}

/** 让已经 resolve 的 promise 链跑完（store 里 await 之后的赋值才会发生）。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
}

async function makeStore(): Promise<{
  anim: Awaited<ReturnType<typeof import('../src/renderer/src/stores/animation.ts')['useAnimationStore']>>
  savedItem: (overrides?: Record<string, unknown>) => Record<string, unknown>
}> {
  const store = await import('../src/renderer/src/stores/animation.ts')
  setActivePinia(createPinia())
  const anim = store.useAnimationStore()
  const savedItem = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'sv-1',
    kpId: 'prog-loop-jr',
    gradeLevel: 'junior',
    concept: '循环',
    title: '循环',
    promptHash: 'a'.repeat(40),
    durationMs: 4800,
    fallbackText: '循环就是把同一件事重复做。',
    fallbackImage: null,
    uses: 0,
    createdAt: 1727200000000,
    ...overrides
  })
  return { anim, savedItem }
}

/** 一段烘焙了 payload_id 的沙箱 HTML（拼装器写下的那一行）。 */
function htmlWithPayloadId(id: string): string {
  return `<html><body><script>window.__K12_PAYLOAD_ID__ = "${id}"</script></body></html>`
}

/* ================================================================== *
 * A 卡片「我的」那条腿：readSavedAnimation
 * ================================================================== */

test('★★ A1 读库一条：payload_id 从产物 HTML 里取回，source 一律 generated，载荷按白名单投影', async () => {
  const bridge = installControllableBridge()
  const { anim, savedItem } = await makeStore()

  const pending = anim.readSavedAnimation('sv-1')
  await flush()
  assert.equal(bridge.calls.readSavedAnimation.length, 1)
  assert.equal(bridge.calls.readSavedAnimation[0]?.payload.savedId, 'sv-1')

  bridge.release('readSavedAnimation', 0, {
    ...savedItem(),
    html: htmlWithPayloadId('payload-abc')
  })
  const playable = await pending
  assert.ok(playable, '命中应当返回可播产物')
  assert.equal(playable.payloadId, 'payload-abc', '★ id 必须是产物里烘焙的那个（新造一个 = 永远等不到 ready）')
  assert.equal(playable.item.id, 'sv-1')
  assert.equal(playable.html, htmlWithPayloadId('payload-abc'))
  assert.equal(playable.payload.source, 'generated', '★ 库里存的都是做出来的：标 template 是对学生撒谎')
  assert.equal(playable.payload.concept, '循环')
  assert.equal(playable.payload.durationMs, 4800)
  assert.equal(playable.payload.payloadId, 'payload-abc')
  assert.equal(playable.payload.gradeLevel, 'junior')
})

test('★ A2 payload_id 取不回来 → 返回 null 并留下学生话（宁可重新生成，不发播不出来的卡片）', async () => {
  const bridge = installControllableBridge()
  const { anim, savedItem } = await makeStore()

  const pending = anim.readSavedAnimation('sv-1')
  await flush()
  bridge.release('readSavedAnimation', 0, {
    ...savedItem(),
    html: '<html><body>没有烘焙 id 的产物</body></html>'
  })
  const playable = await pending
  assert.equal(playable, null, '★ id 取不回来时宁可让调用方重新生成')
  assert.ok(anim.savedError, '要留下能显示给学生的原因')
})

test('★ A3 桥失败 / 记录不在 → 返回 null，绝不抛', async () => {
  const bridge = installControllableBridge()
  const { anim } = await makeStore()

  const pending = anim.readSavedAnimation('sv-404')
  await flush()
  bridge.fail('readSavedAnimation', 0, '库里没有这条动画')
  const playable = await pending
  assert.equal(playable, null)
  assert.ok(anim.savedError, '失败要留下可读原因（界面上学生看得见）')
})

/* ================================================================== *
 * B 「我的动画」页签：loadSaved 分片 / 去重 / 失败 / 删除 + setTab
 * ================================================================== */

test('★★ B1 清单按查询条件分片：卡片学段与页面学段各一份，跨学段预览不许冲掉自己的清单', async () => {
  const bridge = installControllableBridge()
  const { anim, savedItem } = await makeStore()

  // 卡片那条腿：按它自己的学段（初中）查
  const cardQuery = anim.loadSaved({ gradeLevel: 'junior', kpId: 'prog-loop-jr' })
  await flush()
  assert.equal(bridge.calls.readSavedAnimations.length, 1)
  assert.equal(bridge.calls.readSavedAnimations[0]?.payload.gradeLevel, 'junior')
  bridge.release('readSavedAnimations', 0, {
    studentId: 'stu-1',
    total: 1,
    items: [savedItem({ id: 'sv-junior' })]
  })
  await cardQuery

  // 页面那条腿：按当前（或预览）学段（小学高）查 —— 键不同必须发新请求
  const pageQuery = anim.loadSaved({ gradeLevel: 'primary_high' })
  await flush()
  assert.equal(
    bridge.calls.readSavedAnimations.length,
    2,
    '★ 查询条件变了就必须发新请求（共用一份清单会互相顶掉）'
  )
  assert.equal(bridge.calls.readSavedAnimations[1]?.payload.gradeLevel, 'primary_high')
  bridge.release('readSavedAnimations', 1, {
    studentId: 'stu-1',
    total: 0,
    items: []
  })
  await pageQuery

  // 两份分片各自完好：预览/页面查过别的学段后，卡片那份初中清单还在
  assert.equal(anim.savedFor({ gradeLevel: 'junior', kpId: 'prog-loop-jr' }).length, 1)
  assert.equal(anim.savedFor({ gradeLevel: 'junior', kpId: 'prog-loop-jr' })[0]?.id, 'sv-junior')
  assert.deepEqual(anim.savedFor({ gradeLevel: 'primary_high' }), [])
  // 最近一次查询条件 = 页面那份（页面按它显示筛选状态）
  assert.equal(anim.savedQuery.gradeLevel, 'primary_high')
  assert.equal(anim.savedItems.length, 0)
})

test('★ B2 同一条件不重复请求；force 才重取', async () => {
  const bridge = installControllableBridge()
  const { anim, savedItem } = await makeStore()

  const first = anim.loadSaved({ gradeLevel: 'junior' })
  await flush()
  bridge.release('readSavedAnimations', 0, { studentId: 'stu-1', total: 1, items: [savedItem()] })
  await first

  await anim.loadSaved({ gradeLevel: 'junior' })
  assert.equal(bridge.calls.readSavedAnimations.length, 1, '同一条件已有分片：不重取')

  // ★ 顺序纪律（本组假桥是「手动放行」的）：先发起 → 放行 → 再 await。
  //   写成 `await loadSaved(..., true)` 会死锁 —— 请求在 await 里等放行，而放行在 await 之后。
  const forced = anim.loadSaved({ gradeLevel: 'junior' }, true)
  await flush()
  assert.equal(bridge.calls.readSavedAnimations.length, 2, 'force（比如刚生成完一段新动画）必须重取')
  bridge.release('readSavedAnimations', 1, { studentId: 'stu-1', total: 1, items: [savedItem()] })
  await forced
})

test('★ B3 清单失败不抛：分片落空数组 + 学生话，界面显示「还没有」', async () => {
  const bridge = installControllableBridge()
  const { anim } = await makeStore()

  const pending = anim.loadSaved({ gradeLevel: 'junior' })
  await flush()
  bridge.fail('readSavedAnimations', 0, '数据目录还没准备好')
  await pending

  assert.deepEqual(anim.savedItems, [], '失败的分片落空数组（「还没有」而不是报错页）')
  assert.ok(anim.savedError, '要留下学生能看的原因')
  assert.equal(anim.savedLoading, false, '收加载态（没有别的在途请求时）')
})

test('★★ B4 删除：就地从各分片摘除 + 按当前条件重取一次', async () => {
  const bridge = installControllableBridge()
  const { anim, savedItem } = await makeStore()

  // 先备好一份两条记录的分片（当前查询条件 = junior）
  const setup = anim.loadSaved({ gradeLevel: 'junior' })
  await flush()
  bridge.release('readSavedAnimations', 0, {
    studentId: 'stu-1',
    total: 2,
    items: [savedItem({ id: 'sv-a' }), savedItem({ id: 'sv-b' })]
  })
  await setup
  assert.equal(anim.savedItems.length, 2)

  const result = anim.deleteSaved('sv-a')
  await flush()
  assert.equal(bridge.calls.deleteSavedAnimation.length, 1)
  assert.equal(bridge.calls.deleteSavedAnimation[0]?.payload.savedId, 'sv-a')
  bridge.release('deleteSavedAnimation', 0, { savedId: 'sv-a' })
  await flush()
  // 删除成功后自动按当前条件重取（后端才是权威）
  assert.equal(bridge.calls.readSavedAnimations.length, 2, '删除成功后要重取当前条件的清单')
  bridge.release('readSavedAnimations', 1, {
    studentId: 'stu-1',
    total: 1,
    items: [savedItem({ id: 'sv-b' })]
  })
  const done = await result
  assert.deepEqual(done, { ok: true })

  // 就地摘除已发生（不依赖重取）：sv-a 从所有分片里消失
  assert.equal(anim.savedFor({ gradeLevel: 'junior' }).some((item) => item.id === 'sv-a'), false)
  assert.equal(anim.savedTotal, 1)
})

test('★ B5 页签状态机：默认 builtin，setTab 可切 mine（页面 watch 依赖的契约）', async () => {
  installControllableBridge()
  const { anim } = await makeStore()

  assert.equal(anim.activeTab, 'builtin', '默认停在「内置模板」页签')
  anim.setTab('mine')
  assert.equal(anim.activeTab, 'mine', '切到「我的动画」—— 页面的 watch 按它决定取哪份清单')
  anim.setTab('builtin')
  assert.equal(anim.activeTab, 'builtin')
})

/* ================================================================== *
 * C 「在线生成」两条腿：requestNewAnimation
 * ================================================================== */

test('★★ C1 对话优先：这一轮开得起来就绝不直连（产物要留在对话上下文里）', async () => {
  const { requestNewAnimation } = await import('../src/renderer/src/stores/animation.ts')
  let composeCalled = 0
  const outcome = await requestNewAnimation({
    startTurn: async () => true,
    compose: async () => {
      composeCalled += 1
      return {}
    }
  })
  assert.deepEqual(outcome, { kind: 'conversation' })
  assert.equal(composeCalled, 0, '★ 对话开起来了就不该再直连（直连的卡片不进对话历史）')
})

test('★ C2 对话开不起来才直连；直连也失败给学生兜底文案；startTurn 抛异常按「没开起来」算', async () => {
  const { requestNewAnimation, NEW_ANIMATION_FAILED_TEXT } = await import(
    '../src/renderer/src/stores/animation.ts'
  )
  const payload = { concept: '循环', html: '<html></html>' }

  // 对话失败 → 直连顶上
  const composed = await requestNewAnimation({
    startTurn: async () => false,
    compose: async () => payload
  })
  assert.deepEqual(composed, { kind: 'composed', payload })

  // 两条都不行 → 兜底文案（不指向任何技术细节）
  const failed = await requestNewAnimation({
    startTurn: async () => false,
    compose: async () => null
  })
  assert.deepEqual(failed, { kind: 'failed', message: NEW_ANIMATION_FAILED_TEXT })

  // startTurn 抛异常（IPC 断了这类）= 按没开起来处理，照样走直连，且不往外抛
  const thrownTurn = await requestNewAnimation({
    startTurn: async () => {
      throw new Error('ipc down')
    },
    compose: async () => payload
  })
  assert.deepEqual(thrownTurn, { kind: 'composed', payload })
})
