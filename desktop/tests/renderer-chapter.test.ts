/**
 * 「教材章节选择」在**渲染进程**这一层的断言（桥 + store + 两个入口组件）。
 *
 * 这一组盯住四件「错了就静默出事」的事：
 *
 * 1. ★ **两处入口共用同一个 store action**：指示器与设置页各写一份写路径，
 *    就会出现「在设置页改了、顶栏指示器还显示旧章」（静态源码断言）。
 * 2. ★ **失败不撒谎**：桥回 `{ok:false}` 时不改本地状态 ——
 *    否则界面显示「正在学：第 4 章」，而 Prompt 里还是旧章。
 * 3. ★ **学段变化必须真去读一次**：服务端在学段变更时会**清空**章节，
 *    而「清空」这条副作用只有服务端知道 —— 渲染进程不许自己猜（猜错的表现是
 *    「学生选回同一个学段，已选章节被界面凭空抹掉」）。
 * 4. ★ **桥缺方法给可读中文**：缺 `onChapterChanged`（整块没接线）与缺
 *    `setChapter`（只有只读那半）要给**两句不同**的说明。
 *
 * 跑法与 `renderer-grade.test.ts` 一致（Node 内置类型擦除 + 内置断言）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

/**
 * ★ 与 `renderer-grade.test.ts` 同一个手法：渲染进程的模块只按 Vite 的口味写相对导入
 *   （`from '../labels'`，**不带扩展名**），而 Node ESM 要求显式扩展名。
 *   这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`，
 *   让单测直接跑**渲染进程的真实实现**（而不是另写一份替身）。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 会把静态 `import` 提到模块顶部，
 *   而 hook 是在那之后才注册的。
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

const { normalizeChapterState, resolveChapterBridge, CHAPTER_SET_MISSING_HINT } = await import(
  '../src/renderer/src/api/chapter.ts'
)
const { resetWiringNotices } = await import('../src/renderer/src/api/wiring-notice.ts')
const { CHAPTER_NONE_LABEL, chapterLineLabel } = await import('../src/renderer/src/labels.ts')
const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')

/**
 * 跑一段会 `resolveChapterBridge()` 的代码，**同时**收下它打出的接线诊断与返回值。
 *
 * ★ 每次都要先 `resetWiringNotices()`：warn 按 key 去重（同一个渲染进程里每个 key 只打一次），
 *   不清的话「本文件里先跑过的用例」会把这条 warn 吃掉，断言就变成看谁先跑 —— 典型的假绿。
 * ★ 返回值由闭包给出（而不是让外部 `let x` 再赋值）：那样写 TS 会把变量收窄成 `null`，
 *   于是 `lookup.ready` 报「Property 'ready' does not exist on type 'never'」（typecheck 会红）。
 */
function captureWiring<T>(start: () => T): { value: T; warnings: string[] } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    resetWiringNotices()
    return { value: start(), warnings }
  } finally {
    console.warn = original
  }
}

/**
 * 学生面文案里**不许**出现的东西：方法名 / 通道名 / preload / `window.api` / markdown 标记。
 *
 * ★ 为什么把这条清单写死在这里（而不是只断言「等于某个常量」）：断言等于常量只证明
 *   「实现与常量一致」，常量里塞满方法名它也照样绿。清单钉的是**给学生看到的那串字**。
 */
const STUDENT_FACING_FORBIDDEN = [
  'onChapterChanged',
  'getChapter',
  'setChapter',
  'chapter:',
  'preload',
  'window.api',
  '`',
  '**'
]

/** 仓库里定位源码用（与 `renderer-grade.test.ts` 同一写法）。 */
const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 章节被清空时那句一次性提示（唯一实现内联在 store 的 `applyChapterState` 里）。
 *
 * ★★ 写成字面量是刻意的：这条守卫要钉住**学生读到的那句话**。
 * ★★ 2026-09-22 改句（设计评审报告 C16 / 第 3 章「破折号专项」）：原来那句用
 *   `——` 把两个短句串起来（「…已清空 —— 可以重新选一章…」）。破折号长句是这个
 *   产品学生文案的 LLM 指纹，报告要求全文替换成两句短句，所以现在是一个句号。
 *   ⚠️ 这类「删除连接符」的改句由 `tests/student-view-discipline.test.ts` 里那条
 *   「学生可见文本不得含 `——`」的源码级守卫兜底 —— 谁把破折号加回来，那边会先红。
 */
const CLEARED_NOTICE = '学段变了，之前选的教材章节已清空。可以重新选一章，或直接自由问答。'

/** 让被 `void` 掉的 promise 链跑完（`refreshChapter` 是 fire-and-forget）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/* ------------------------------------------------------------------ *
 * 1. 归一化：学段白名单 + 章标题非字符串一律折成空串
 * ------------------------------------------------------------------ */

test('normalizeChapterState：学段必须在白名单里，章标题非 string 一律折成空串（= 未选择）', () => {
  assert.deepEqual(normalizeChapterState({ gradeLevel: 'junior', chapterTitle: '第4章 用 Python 处理数据' }), {
    gradeLevel: 'junior',
    chapterTitle: '第4章 用 Python 处理数据'
  })
  // ★ 空串是契约里唯一的「未选择」形态（不是 null）：界面只处理一种空值
  assert.deepEqual(normalizeChapterState({ gradeLevel: 'senior', chapterTitle: '' }), {
    gradeLevel: 'senior',
    chapterTitle: ''
  })
  // 章标题缺失 / 类型不对 / 是 null → 空串，**不是 undefined**（否则界面会渲染出 undefined）
  assert.deepEqual(normalizeChapterState({ gradeLevel: 'junior' }), {
    gradeLevel: 'junior',
    chapterTitle: ''
  })
  assert.deepEqual(normalizeChapterState({ gradeLevel: 'junior', chapterTitle: null }), {
    gradeLevel: 'junior',
    chapterTitle: ''
  })
  assert.deepEqual(normalizeChapterState({ gradeLevel: 'junior', chapterTitle: 42 }), {
    gradeLevel: 'junior',
    chapterTitle: ''
  })

  // 学段认不出（不在四学段里）/ 载荷根本不是对象 → 整条忽略（不映射到最近似的学段）
  assert.equal(normalizeChapterState({ gradeLevel: 'college', chapterTitle: '第1章' }), null)
  assert.equal(normalizeChapterState({ chapterTitle: '第1章' }), null)
  assert.equal(normalizeChapterState(null), null)
  assert.equal(normalizeChapterState('junior'), null)
})

/* ------------------------------------------------------------------ *
 * 2. 文案：一行字只有一处实现
 * ------------------------------------------------------------------ */

test('chapterLineLabel：有章写「正在学：…」、没章写「未选择章节（自由问答）」', () => {
  assert.equal(chapterLineLabel('第4章 用 Python 处理数据'), '正在学：第4章 用 Python 处理数据')
  assert.equal(chapterLineLabel(''), CHAPTER_NONE_LABEL)
  // 只有空白也算没选（服务端会 strip，这里对脏值也保持一致）
  assert.equal(chapterLineLabel('   '), CHAPTER_NONE_LABEL)
  // ★ 章标题已含学段语境，不在后面重复学段标签
  assert.equal(chapterLineLabel('第4章 用 Python 处理数据').includes('小学'), false)
})

/* ------------------------------------------------------------------ *
 * 3. 桥探测：缺哪半说哪半
 * ------------------------------------------------------------------ */

test('resolveChapterBridge：缺 onChapterChanged（整块没接线）时给可读中文、细节进控制台、不抛异常', () => {
  ;(globalThis as unknown as { window: unknown }).window = { api: { getGrade: async () => ({ ok: true, data: null }) } }
  const { value: lookup, warnings } = captureWiring(() => resolveChapterBridge())
  assert.equal(lookup.ready, false)
  assert.ok(
    'message' in lookup && typeof lookup.message === 'string' && lookup.message.length > 0,
    `整块没接线时也要有一句可读中文：${JSON.stringify(lookup)}`
  )
  // ★ 屏幕上是学生话（旧口径是「指出缺的是哪个方法」，那属于控制台 —— 见下面那条）
  const message = 'message' in lookup ? String(lookup.message) : ''
  for (const forbidden of STUDENT_FACING_FORBIDDEN) {
    assert.ok(!message.includes(forbidden), `学生面那句话里出现了「${forbidden}」：${message}`)
  }
  assert.ok(/[\u4e00-\u9fff]/.test(message), '学生面必须是中文人话')
  // ★ 接线细节没丢，只是换了通路
  assert.ok(
    warnings.some((line) => line.includes('onChapterChanged')),
    `接线细节必须进控制台（照它就能把线接上）：实际 warn = ${JSON.stringify(warnings)}`
  )
})

test('resolveChapterBridge：window.api 整个缺失时给可读中文，不抛异常', () => {
  ;(globalThis as unknown as { window: unknown }).window = {}
  const lookup = resolveChapterBridge()
  assert.equal(lookup.ready, false)
  assert.ok('message' in lookup && lookup.message.length > 0)
})

test('resolveChapterBridge：只有只读那半时桥仍然就绪，但不凭空长出 setChapter', () => {
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      onChapterChanged: () => () => {},
      getChapter: async () => ({ ok: false, message: '测试里不给初始值' })
    }
  }
  const lookup = resolveChapterBridge()
  assert.equal(lookup.ready, true, 'onChapterChanged 在的话桥就该就绪（只是暂时不能选章）')
  assert.equal(typeof lookup.bridge.getChapter, 'function')
  assert.equal(lookup.bridge.setChapter, undefined, '白名单里没有 setChapter，桥也不该凭空长出一个')
})

/* ------------------------------------------------------------------ *
 * 4/5. store 的 setChapter：成功 / 失败 / 桥缺写入能力
 * ------------------------------------------------------------------ */

interface FakeBridge {
  /** 递出去的选章（记的是**学生实际选的那一下**：前端不改写、不映射）。 */
  chapterSet: string[]
  /** `getChapter` 被调了几次（「学段变化触发重取」靠它断言）。 */
  chapterGets: { count: number }
  /** 服务端**当前**会回什么章标题（模拟「学段一变就清空」）。 */
  setServedTitle: (title: string) => void
  emitGrade: (state: unknown) => void
  emitChapter: (state: unknown) => void
  failChapterWith: (message: string | null) => void
}

/** 装一个假的 `window.api`（preload 白名单），返回记录面。 */
function installFakeBridge(
  options: { withSetChapter?: boolean; withGetChapter?: boolean } = {}
): FakeBridge {
  const chapterSet: string[] = []
  const chapterGets = { count: 0 }
  const gradeListeners: Array<(state: unknown) => void> = []
  const chapterListeners: Array<(state: unknown) => void> = []
  let servedTitle = ''
  let failure: string | null = null

  const api: Record<string, unknown> = {
    onGradeChanged: (listener: (state: unknown) => void) => {
      gradeListeners.push(listener)
      return () => {
        const index = gradeListeners.indexOf(listener)
        if (index >= 0) gradeListeners.splice(index, 1)
      }
    },
    getGrade: async () => ({ ok: false as const, message: '测试里不提供初始值' }),
    onChapterChanged: (listener: (state: unknown) => void) => {
      chapterListeners.push(listener)
      return () => {
        const index = chapterListeners.indexOf(listener)
        if (index >= 0) chapterListeners.splice(index, 1)
      }
    },
    // 对话事件流：本组测试只关心章节，但 `connect()` 会一并订上它（白名单里本就该有）
    onChatEvent: () => () => {}
  }
  if (options.withGetChapter !== false) {
    api.getChapter = async () => {
      chapterGets.count += 1
      return { ok: true as const, data: { gradeLevel: 'junior', chapterTitle: servedTitle } }
    }
  }
  if (options.withSetChapter !== false) {
    api.setChapter = async (title: string) => {
      chapterSet.push(title)
      if (failure !== null) return { ok: false as const, message: failure }
      servedTitle = title
      return { ok: true as const, data: { chapterTitle: title } }
    }
  }

  ;(globalThis as unknown as { window: unknown }).window = { api }
  return {
    chapterSet,
    chapterGets,
    setServedTitle: (title) => {
      servedTitle = title
    },
    failChapterWith: (message) => {
      failure = message
    },
    emitGrade: (state) => {
      for (const listener of [...gradeListeners]) listener(state)
    },
    emitChapter: (state) => {
      for (const listener of [...chapterListeners]) listener(state)
    }
  }
}

test('★ setChapter 成功：经 window.api.setChapter 递出学生选的章，并把回执落实成界面状态', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = useChatStore()

  const result = await chat.setChapter('第4章 用 Python 处理数据')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(
    bridge.chapterSet,
    ['第4章 用 Python 处理数据'],
    '递出去的必须是学生选的那一章（前端不推断、不改写）'
  )
  assert.equal(chat.currentChapter, '第4章 用 Python 处理数据')
  assert.equal(chat.chapterBridgeError, null)
})

test('★ setChapter 传空串 = 清除：回到「不限章节，自由问答」', async () => {
  const bridge = installFakeBridge()
  bridge.setServedTitle('第2章 数据从哪里来')
  setActivePinia(createPinia())
  const chat = useChatStore()

  await chat.setChapter('第2章 数据从哪里来')
  assert.equal(chat.currentChapter, '第2章 数据从哪里来')

  const cleared = await chat.setChapter('')
  assert.deepEqual(cleared, { ok: true })
  assert.equal(bridge.chapterSet[1], '', '清除走的是同一条写路径（空串），不是另一条通道')
  assert.equal(chat.currentChapter, '')
  assert.equal(chat.chapterNotice, null, '学生自己选的「不限章节」不该报「被清空了」')
})

test('★ setChapter 失败：返回可读中文，且**一点都不许改**本地状态（失败不撒谎）', async () => {
  const bridge = installFakeBridge()
  bridge.setServedTitle('第2章 数据从哪里来')
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()
  await flush()

  assert.equal(chat.currentChapter, '第2章 数据从哪里来', '初始值该从 getChapter 读到')

  bridge.failChapterWith('设定章节失败：章节不在当前学段的教材清单里。')
  const result = await chat.setChapter('第9章 不存在的章')

  assert.deepEqual(result, { ok: false, message: '设定章节失败：章节不在当前学段的教材清单里。' })
  // ★ 状态一动不动：界面若显示「正在学：第9章…」而服务端还是第 2 章，就是对着界面撒谎
  assert.equal(chat.currentChapter, '第2章 数据从哪里来')
})

test('★★ 桥缺 setChapter（只有只读那半）：屏幕上是学生话、接线细节进控制台、界面状态不变', async () => {
  installFakeBridge({ withSetChapter: false })
  setActivePinia(createPinia())
  const chat = useChatStore()

  // ★★ 这条断言 2026-09-22 改口径（设计评审报告 0.2 + 双视角 D-063），**不是放宽**：
  //   原来它要 `result.message` **包含 `setChapter`**（「失败说明要指出缺的是哪个方法」）——
  //   而那句话是渲染在界面上的（章节那一栏的提示），于是学生读到的是
  //   「……preload 白名单缺少 setChapter……接线后刷新页面即可生效。」：他既看不懂，
  //   也做不到（他没有线要接，刷新也确实不会生效 —— 那是假承诺）。
  //   现在同一件事**分两条通路**，这条用例把两边都钉住：
  //     ① 屏幕上（message）必须是**干净的学生话**：说清用不了什么、还能做什么、找谁；
  //     ② 控制台上必须仍有**接线细节**（缺哪个方法、要注册哪条通道）——
  //        「照它就能把线接上」这个意图一个字都没丢，只是从屏幕挪到了 DevTools。
  const { value: lookup, warnings } = captureWiring(() => resolveChapterBridge())
  assert.equal(lookup.ready, true, '只读那半在的话桥就该就绪')

  const result = await chat.setChapter('第4章 用 Python 处理数据') // 不许抛

  assert.equal(result.ok, false)
  assert.equal(result.message, CHAPTER_SET_MISSING_HINT)
  // ① 学生面：不许出现方法名 / 通道名 / preload / window.api / markdown 标记
  for (const forbidden of STUDENT_FACING_FORBIDDEN) {
    assert.ok(
      !String(result.message).includes(forbidden),
      `学生面那句话里出现了「${forbidden}」：${String(result.message)}`
    )
  }
  assert.ok(/[\u4e00-\u9fff]/.test(String(result.message)), '学生面必须是中文人话')
  // ② 控制台面：缺的是哪个方法要点名（运行时真的 warn 出来，不是只写在源码里）
  assert.ok(
    warnings.some((line) => line.includes('setChapter')),
    `接线细节必须进控制台（照它就能把线接上）：实际 warn = ${JSON.stringify(warnings)}`
  )

  // ②' 源码级对照：`api/chapter.ts` 里必须有一处接线诊断**点名 setChapter**。
  //     为什么源码这条也要留：运行时那条只在「这次真的缺 setChapter」时才触发，
  //     而源码这条钉住的是**文案本身**（谁把细节删干净，这里立刻红）。
  const chapterSource = readFileSync(join(DESKTOP, 'src/renderer/src/api/chapter.ts'), 'utf8')
  assert.match(
    chapterSource,
    /warnWiring\([\s\S]{0,200}?setChapter/,
    '接线诊断里必须点名 setChapter（它是「照它就能把线接上」的唯一落点）'
  )
  assert.equal(chat.currentChapter, '', '没成功就不许改状态')
})

test('window.api 整个缺失时：setChapter 也回一句可读中文，不抛异常', async () => {
  ;(globalThis as unknown as { window: unknown }).window = {}
  setActivePinia(createPinia())
  const chat = useChatStore()

  const result = await chat.setChapter('第1章')
  assert.equal(result.ok, false)
  assert.ok(typeof result.message === 'string' && result.message.length > 0)
  assert.equal(chat.currentChapter, '')
})

/* ------------------------------------------------------------------ *
 * 6. 学段变化 → 真去读一次章节（不许自己猜「空的了」）
 * ------------------------------------------------------------------ */

test('★★ 显示出来的学段真的变了 → 重新读一次章节（服务端在学段变更时清空它）', async () => {
  const bridge = installFakeBridge()
  bridge.setServedTitle('第4章 用 Python 处理数据')
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()
  await flush()

  assert.equal(chat.currentChapter, '第4章 用 Python 处理数据')
  const getsAfterMount = bridge.chapterGets.count

  // 学段变了，服务端同时把章节清空（那条规则在服务端，界面只负责重取）
  bridge.setServedTitle('')
  bridge.emitGrade({ gradeLevel: 'senior', origin: 'inferred' })
  await flush()

  assert.equal(
    bridge.chapterGets.count,
    getsAfterMount + 1,
    '学段变化必须**真去读一次**章节：猜出来的值会让界面与 Prompt 各说一套'
  )
  assert.equal(chat.currentChapter, '', '读回来的是服务端的真值（这里是清空后的空串）')
  assert.equal(chat.chapterNotice, CLEARED_NOTICE, '「东西自己没了」必须说一声')
})

test('学段没变就不重复读：同一学段再推一条不触发重取（含学生重复确认同一学段）', async () => {
  const bridge = installFakeBridge()
  bridge.setServedTitle('第4章 用 Python 处理数据')
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()
  await flush()

  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  await flush()
  const afterFirstChange = bridge.chapterGets.count

  // 同一条学段再来一次（服务端「重复确认同一学段」不清章节）→ 界面也不该重读
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'explicit' })
  await flush()
  assert.equal(bridge.chapterGets.count, afterFirstChange, '学段没变就不该重复取章节')
  assert.equal(
    chat.currentChapter,
    '第4章 用 Python 处理数据',
    '★ 学生把学段确认回同一档时，已选章节**不许**被界面凭空抹掉（服务端本来就不清）'
  )
})

test('冷启动默认值（origin=default）：整条丢掉，不触发章节重取（它连一次判定都不算）', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()
  await flush()
  const before = bridge.chapterGets.count

  bridge.emitGrade({ gradeLevel: 'primary_low', origin: 'default' })
  await flush()

  assert.equal(chat.currentGrade, null, '默认值不许上屏（也不许把它当「变化」去重取章节）')
  assert.equal(bridge.chapterGets.count, before)
})

/* ------------------------------------------------------------------ *
 * 7. 推送路径：主进程推什么就显示什么；「被清空」的提示只在从有到无时给
 * ------------------------------------------------------------------ */

test('★ 推送来的章节照单显示；从有到无给一次性提示，且下一个问题发出时清掉', async () => {
  const bridge = installFakeBridge()
  const sent: Array<Record<string, unknown>> = []
  ;(globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api.sendChat = async (
    request: Record<string, unknown>
  ) => {
    sent.push(request)
    return { ok: true, requestId: 'turn_1', message: null }
  }
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()
  await flush()

  bridge.emitChapter({ gradeLevel: 'junior', chapterTitle: '第5章 让电脑自己学' })
  assert.equal(chat.currentChapter, '第5章 让电脑自己学')

  // 服务端清空（学段变更那条副作用）→ 提示
  bridge.emitChapter({ gradeLevel: 'junior', chapterTitle: '' })
  assert.equal(chat.currentChapter, '')
  assert.equal(chat.chapterNotice, CLEARED_NOTICE)

  // 一次性提示：下一个问题发出时清掉（与 gradeNotice 同一口径）
  await chat.send('再讲讲变量')
  assert.equal(chat.chapterNotice, null)

  // ★ 章节**绝不混进对话请求**：`ChatSendRequest` 的字段集合被守卫 G6c 钉死为 ['text']
  assert.equal(sent.length, 1)
  assert.deepEqual(Object.keys(sent[0]).sort(), ['text'])
})

/* ------------------------------------------------------------------ *
 * 8. 静态源码：两个入口共用同一个 store action
 * ------------------------------------------------------------------ */

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = join(desktopRoot, 'src', 'renderer', 'src')
const INDICATOR_FILE = join(RENDERER, 'components', 'ChapterIndicator.vue')
const SETTINGS_FILE = join(RENDERER, 'views', 'Settings.vue')
const CHAT_STORE_FILE = join(RENDERER, 'stores', 'chat.ts')

/**
 * 去掉注释再扫代码（与架构守卫同一手法）：
 * 注释里解释「这里为什么调 chat.setChapter」不算调用，注释里写「不要自己拼请求」也不算违规。
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('★ 两个入口（指示器 + 设置页）都走同一个 store action chat.setChapter，不各写一份写路径', () => {
  for (const [name, file] of [
    ['ChapterIndicator.vue', INDICATOR_FILE],
    ['Settings.vue', SETTINGS_FILE]
  ] as const) {
    assert.ok(existsSync(file), `${name} 必须存在`)
    const code = codeOf(file)
    assert.ok(
      /chat\.setChapter\s*\(/.test(code),
      `${name} 必须调用 store 的 chat.setChapter —— 两个入口各写一份写路径就会出现「一处改了另一处没改」的状态不同步`
    )
    // ★ 组件**不碰 preload 白名单**、也不写死通道名：写路径只有 store 那一条
    for (const forbidden of ['window.api', 'setChapter:', 'chapter:set', 'resolveChapterBridge']) {
      assert.ok(!code.includes(forbidden), `${name} 不该出现 ${forbidden}（章节的写路径只在 stores/chat.ts）`)
    }
    // 章节与对话请求是两条路径（章节是软偏好，不是每轮请求的参数）
    assert.ok(!/sendChat\s*\(/.test(code), `${name} 不该碰 sendChat`)
    // 那一行字的唯一实现在 labels.ts（两处各拼一份迟早对不上）
    assert.ok(
      /chapterLineLabel\s*\(/.test(code),
      `${name} 必须调 labels.ts 的 chapterLineLabel()（「正在学：…」只有一处拼装）`
    )
    assert.ok(
      !code.includes(CHAPTER_NONE_LABEL),
      `${name} 里又写了一遍「未选择章节」的文案 —— 唯一实现是 labels.ts 的 chapterLineLabel()`
    )
  }

  // 设置页要说清「选章节不改学段」（两件事各自独立）
  assert.ok(
    codeOf(SETTINGS_FILE).includes('选择章节不会改变学段'),
    'Settings.vue 的章节区块要写明「选择章节不会改变学段」'
  )
})

test('★ 章节的写路径在 store 里只有一处调用（唯一写 action）', () => {
  const code = codeOf(CHAT_STORE_FILE)
  const callSites = [...code.matchAll(/bridge\.setChapter\s*\(/g)]
  assert.equal(
    callSites.length,
    1,
    `stores/chat.ts 里对桥的 setChapter 调用必须恰好一处（实际 ${callSites.length} 处）`
  )
  // 供两个入口共用
  assert.ok(/return\s*\{[\s\S]*?\bsetChapter,/.test(code), 'store 必须把 setChapter 暴露出去')
})

test('★ 指示器保留可取值的 data-* 契约，且选项默认收起', () => {
  const code = codeOf(INDICATOR_FILE)
  for (const attribute of [
    'data-testid="chapter-indicator"',
    'data-chapter',
    'chapter-current-label',
    'chapter-set',
    'chapter-options',
    'chapter-option-none'
  ]) {
    assert.ok(code.includes(attribute), `ChapterIndicator.vue 缺少 ${attribute}`)
  }
  // 选项默认收起：`chapter-options` 受 `v-if` 控制（顶栏摊着几十个章按钮会把对话挤没）
  assert.ok(
    /v-if="pickerOpen"[\s\S]{0,200}chapter-options/.test(code),
    '章节选项必须默认收起（点 chapter-set 才展开）'
  )
  // ★ 学段未判定时给一句可读提示，而不是列一个空列表
  assert.ok(code.includes('chapter-no-grade'), '学段未判定时要有可读提示（不是空列表）')
})

test('★ 章节清单复用既有取数路径（study.loadChapters），不新增第二条', () => {
  const indicator = codeOf(INDICATOR_FILE)
  const settings = codeOf(SETTINGS_FILE)
  assert.ok(
    /study\.loadChapters\s*\(/.test(indicator),
    'ChapterIndicator.vue 必须复用 stores/study.ts 的 loadChapters（不新增取数路径）'
  )
  assert.ok(
    /study\.loadChapters\s*\(/.test(settings),
    'Settings.vue 的章节区块同样复用 loadChapters'
  )
})
