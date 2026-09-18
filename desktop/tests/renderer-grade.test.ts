/**
 * 「学段手动切换」在**渲染进程**这一层的断言（store + 两个入口组件）。
 *
 * 这一组盯住四件「错了就静默出事」的事：
 *
 * 1. ★ **三态都要认**：`inferred` / `explicit` / 其它 → `default`。
 *    漏掉 `explicit` 不是「显示得不准」，而是学生点完学段后主进程推来的那条被整条丢掉 ——
 *    界面停在上一个状态，表现成「点了没反应」（学生于是反复点）。
 * 2. ★ **失败不撒谎**：桥回 `{ok:false}` 时不改本地状态 ——
 *    否则界面显示「高中」，而库里还是初中，下一轮回答就按初中讲。
 * 3. ★ **手动之后不被冷启动默认值顶掉**：`inferred`（系统后来真的判出来了）该被采纳
 *    （手动只是给系统一个起点，10 轮后回归自动，不是永久锁死），
 *    而 `default`（冷启动默认值）必须被忽略 —— 默认值不许冒充任何人的结论。
 * 4. ★ **两个入口共用同一个 store action**：各自写一份写路径，就会出现
 *    「在设置页改了、顶栏指示器还显示旧值」这种状态不同步（静态源码断言）。
 *
 * 跑法与 `renderer-quiz.test.ts` 一致（Node 内置类型擦除 + 内置断言）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

/**
 * ★ 与 `renderer-quiz.test.ts` 同一个手法：渲染进程的模块只按 Vite 的口味写相对导入
 *   （`from '../labels'`，**不带扩展名**），而 Node ESM 要求显式扩展名。
 *   这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`，
 *   让单测直接跑**渲染进程的真实实现**（而不是另写一份替身）。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 会把静态 `import` 提到模块顶部，
 *   而 hook 是在那之后才注册的 —— 用静态导入的话 `../labels`（不带扩展名）
 *   在 hook 生效前就被解析了，直接 `ERR_MODULE_NOT_FOUND`。
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

const { normalizeGradeState, resolveGradeBridge } = await import('../src/renderer/src/api/grade.ts')
const { GRADE_LABELS, GRADE_UNKNOWN_LABEL, gradeAdaptNotice, gradeManualNotice, gradeOriginLabel } =
  await import('../src/renderer/src/labels.ts')
const { useChatStore } = await import('../src/renderer/src/stores/chat.ts')

/* ------------------------------------------------------------------ *
 * 1. 归一化：三态
 * ------------------------------------------------------------------ */

test('normalizeGradeState：三态都认（inferred / explicit / 其它 → default）', () => {
  assert.deepEqual(normalizeGradeState({ gradeLevel: 'junior', origin: 'inferred' }), {
    gradeLevel: 'junior',
    origin: 'inferred'
  })
  // ★ `explicit` 这条是学生「点了没反应」的根因：漏掉它，手动设定后的推送会被丢掉
  assert.deepEqual(normalizeGradeState({ gradeLevel: 'senior', origin: 'explicit' }), {
    gradeLevel: 'senior',
    origin: 'explicit'
  })
  // 认不出的来源一律按 `default`（宁可显示「待判定」，也不假装系统判过）
  assert.deepEqual(normalizeGradeState({ gradeLevel: 'junior', origin: 'college' }), {
    gradeLevel: 'junior',
    origin: 'default'
  })
  assert.deepEqual(normalizeGradeState({ gradeLevel: 'junior', origin: 'default' }), {
    gradeLevel: 'junior',
    origin: 'default'
  })

  // 缺 `origin` → `default`（老版本载荷 / 半截对象）
  assert.deepEqual(normalizeGradeState({ gradeLevel: 'primary_low' }), {
    gradeLevel: 'primary_low',
    origin: 'default'
  })

  // 学段认不出 / 载荷根本不是对象 → 整条忽略（不映射到最近似的学段）
  assert.equal(normalizeGradeState({ gradeLevel: 'college', origin: 'inferred' }), null)
  assert.equal(normalizeGradeState({ gradeLevel: 42, origin: 'inferred' }), null)
  assert.equal(normalizeGradeState({ origin: 'inferred' }), null)
  assert.equal(normalizeGradeState(null), null)
  assert.equal(normalizeGradeState('junior'), null)
})

/* ------------------------------------------------------------------ *
 * 2. 文案：来源说法与两句话的区别
 * ------------------------------------------------------------------ */

test('gradeOriginLabel：四档都有可读中文，且「学生选的」与「引擎推的」分得清', () => {
  assert.equal(gradeOriginLabel('explicit'), '手动选中')
  assert.equal(gradeOriginLabel('inferred'), 'AI 引擎推算')
  assert.equal(gradeOriginLabel('default'), 'AI 引擎推算')
  // `null` = 还没收到任何推送：那时学段本身显示「待判定」，
  // 来源这一格跟 `default` 同口径（写「待判定」会变成「待判定（待判定）」）。
  assert.equal(gradeOriginLabel(null), 'AI 引擎推算')
  // 与「还没判出来」的说法不撞车（那句只用于学段本身）
  assert.equal(GRADE_UNKNOWN_LABEL, '待判定')
  assert.ok(!Object.values(GRADE_LABELS).includes(gradeOriginLabel(null)))
})

test('两句一次性提示各有主语：系统自己适配 ≠ 学生自己选的', () => {
  assert.equal(gradeAdaptNotice('junior'), '我按初中的说法来讲。')
  assert.equal(gradeManualNotice('junior'), '已按你选的初中来讲。')
  // 两句话必须不一样：手动选完若给「我按…来讲」，等于告诉学生「是系统替你改的」，来源说反了
  assert.notEqual(gradeAdaptNotice('senior'), gradeManualNotice('senior'))
  assert.ok(gradeManualNotice('primary_low').includes(GRADE_LABELS.primary_low))
})

/* ------------------------------------------------------------------ *
 * 3/4/5. store 的 setGrade：成功 / 失败 / 桥缺写入能力
 * ------------------------------------------------------------------ */

interface FakeBridge {
  /** 递出去的手动设定（记的是**学生实际选的值**：前端不改写、不映射）。 */
  gradeSet: string[]
  emitGrade: (state: unknown) => void
  failGradeWith: (message: string | null) => void
}

/** 装一个假的 `window.api`（preload 白名单），返回记录面。 */
function installFakeBridge(options: { withSetGrade?: boolean } = {}): FakeBridge {
  const gradeSet: string[] = []
  const gradeListeners: Array<(state: unknown) => void> = []
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
    // 对话事件流：本组测试只关心学段，但 `connect()` 会一并订上它（白名单里本就该有）
    onChatEvent: () => () => {}
  }
  if (options.withSetGrade !== false) {
    api.setGrade = async (level: string) => {
      gradeSet.push(level)
      if (failure !== null) return { ok: false as const, message: failure }
      return { ok: true as const, data: { changed: true, cooldownRemainingTurns: 10 } }
    }
  }

  ;(globalThis as unknown as { window: unknown }).window = { api }
  return {
    gradeSet,
    failGradeWith: (message) => {
      failure = message
    },
    emitGrade: (state) => {
      for (const listener of [...gradeListeners]) listener(state)
    }
  }
}

test('★ setGrade 成功：经 window.api.setGrade 递出学生选的值，并把回执落实成界面上看得见的状态', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = useChatStore()

  const result = await chat.setGrade('senior')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(bridge.gradeSet, ['senior'], '递出去的必须是学生选的那个学段（前端不推断、不改写）')
  assert.equal(chat.currentGrade, 'senior')
  assert.equal(chat.gradeOrigin, 'explicit', '来源标成 explicit，指示器才会说「手动选中」而不是「AI 算的」')
  assert.equal(chat.currentGradeLabel, '高中')
  // ★ 手动切换必须让学生**当场看到生效**：一次性的手动提示，且它覆盖掉旧的自动提示
  assert.equal(chat.gradeNotice, gradeManualNotice('senior'))
  assert.equal(chat.gradeBridgeError, null)
})

test('★ setGrade 失败：返回可读中文，且**一点都不许改**本地状态（失败不撒谎）', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()

  // 先有一个「系统判出来的」状态作为基线
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'inferred' })
  const noticeBefore = chat.gradeNotice

  bridge.failGradeWith('设定学段失败：本地数据服务没有响应。')
  const result = await chat.setGrade('senior')

  assert.deepEqual(result, { ok: false, message: '设定学段失败：本地数据服务没有响应。' })
  // ★ 状态一动不动：界面若显示「高中」而库里还是初中，下一轮回答就按初中讲 —— 对着界面撒谎
  assert.equal(chat.currentGrade, 'junior')
  assert.equal(chat.gradeOrigin, 'inferred')
  assert.equal(chat.gradeNotice, noticeBefore)
})

test('桥缺 setGrade（分步接线的老产物）：不抛、给可读中文、界面状态不变', async () => {
  installFakeBridge({ withSetGrade: false })
  setActivePinia(createPinia())
  const chat = useChatStore()

  // 只读能力还在：桥本身是就绪的（这条要能建起来，否则下面的断言会掩盖真正的问题）
  const lookup = resolveGradeBridge()
  assert.equal(lookup.ready, true, 'onGradeChanged 在的话桥就该就绪（只是暂时不能手动设定）')
  assert.equal(typeof lookup.bridge.getGrade, 'function')
  assert.equal(
    lookup.bridge.setGrade,
    undefined,
    'window.api 上没有 setGrade 时，桥也不该凭空长出一个'
  )

  const result = await chat.setGrade('junior') // 不许抛

  assert.equal(result.ok, false)
  assert.ok(
    typeof result.message === 'string' && result.message.includes('setGrade'),
    `失败说明要指出缺的是哪个方法（照它就能把线接上）：${String(result.message)}`
  )
  assert.equal(chat.currentGrade, null, '没成功就不许改状态（尤其不许拿默认值顶上）')
  assert.equal(chat.gradeOrigin, null)
})

test('window.api 整个缺失时：setGrade 也回一句可读中文，不抛异常', async () => {
  ;(globalThis as unknown as { window: unknown }).window = {}
  setActivePinia(createPinia())
  const chat = useChatStore()

  const result = await chat.setGrade('junior')
  assert.equal(result.ok, false)
  assert.ok(typeof result.message === 'string' && result.message.length > 0)
  assert.equal(chat.currentGrade, null)
})

/* ------------------------------------------------------------------ *
 * 6. 手动之后：inferred 该被采纳，default 必须被忽略
 * ------------------------------------------------------------------ */

test('★★ 手动设置后：系统后来真的判出来了会被采纳，冷启动默认值不许顶掉学生的手动选择', async () => {
  const bridge = installFakeBridge()
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.connect()

  const set = await chat.setGrade('senior')
  assert.deepEqual(set, { ok: true })
  assert.equal(chat.currentGrade, 'senior')

  // ⓪ 手动设定之后主进程推来的那条 `explicit` 本身就是界面的显示来源（`setGrade` 只是顺手
  //    把本地状态提前落实了）：这条**必须上屏**，否则「点了没反应」。
  //    单独验一次推送路径（而不是只信 setGrade 的本地赋值），因为另一个入口
  //    （设置页）与「另一台窗口 / 重开页面」都只有推送这一条路。
  chat.gradeNotice = null
  bridge.emitGrade({ gradeLevel: 'junior', origin: 'explicit', source: 'explicit' })
  assert.equal(chat.currentGrade, 'junior', '手动设定的推送必须被采纳（只认 inferred 会表现成「点了没反应」）')
  assert.equal(chat.gradeOrigin, 'explicit')

  // ① 冷启动默认值：不许顶掉学生刚做的选择（它连「一次判定」都不算）
  bridge.emitGrade({ gradeLevel: 'primary_low', origin: 'default' })
  assert.equal(chat.currentGrade, 'junior', '默认值不许覆盖学生的手动选择')
  assert.equal(chat.gradeOrigin, 'explicit', '来源也不许被默认值改成「引擎推算」')

  // ② 系统真的判出来了（`inferred`）：**采纳**。
  //    为什么该采纳：手动设定只是给系统一个起点（服务端那条冷却 10 轮），
  //    不是永久锁死 —— 10 轮之后系统照旧按学生的实际水平自动调整，
  //    所以「后来判出来的结论」当然要能上屏，否则学段会永远停在学生当时随手点的那一档。
  bridge.emitGrade({ gradeLevel: 'primary_low', origin: 'inferred' })
  assert.equal(chat.currentGrade, 'primary_low', '系统真判出来的结论该被采纳（手动不是永久锁死）')
  assert.equal(chat.gradeOrigin, 'inferred', '来源要跟着改回「AI 引擎推算」')
  assert.equal(chat.gradeNotice, gradeAdaptNotice('primary_low'), '系统适配了要说一声（主语是系统）')
})

/* ------------------------------------------------------------------ *
 * 7. 手动设定不碰对话请求
 * ------------------------------------------------------------------ */

test('★ setGrade 不碰 sendChat：手动设定之后发一条消息，入参仍然只有 text', async () => {
  const sent: Array<Record<string, unknown>> = []
  installFakeBridge()
  ;(globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api.sendChat = async (
    request: Record<string, unknown>
  ) => {
    sent.push(request)
    return { ok: true, requestId: 'turn_1', message: null }
  }
  ;(globalThis as unknown as { window: { api: Record<string, unknown> } }).window.api.onChatEvent = () => () => {}

  setActivePinia(createPinia())
  const chat = useChatStore()

  await chat.setGrade('junior')
  await chat.send('再讲讲变量')

  assert.equal(sent.length, 1)
  assert.deepEqual(
    Object.keys(sent[0]).sort(),
    ['text'],
    '学段改了也**不该**随对话请求走：`ChatSendRequest` 的字段集合被守卫 G6c 钉死为 [text]'
  )
})

/* ------------------------------------------------------------------ *
 * 8. 静态源码：两个入口共用同一个 store action
 * ------------------------------------------------------------------ */

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDICATOR_FILE = join(desktopRoot, 'src', 'renderer', 'src', 'components', 'GradeIndicator.vue')
const SETTINGS_FILE = join(desktopRoot, 'src', 'renderer', 'src', 'views', 'Settings.vue')

/**
 * 去掉注释再扫代码（与架构守卫同一手法）：
 * 注释里解释「这里为什么调 chat.setGrade」不算调用，注释里写「不要手拼请求」也不算违规。
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
}

test('★ 两个入口（指示器 + 设置页）都走同一个 store action chat.setGrade，不各写一份写路径', () => {
  for (const [name, file] of [
    ['GradeIndicator.vue', INDICATOR_FILE],
    ['Settings.vue', SETTINGS_FILE]
  ] as const) {
    const code = codeOf(file)
    assert.ok(existsSync(file), `${name} 必须存在`)
    assert.ok(
      /chat\.setGrade\s*\(/.test(code),
      `${name} 必须调用 store 的 chat.setGrade —— 两个入口各写一份写路径就会出现「一处改了另一处没改」的状态不同步`
    )
    // 手动设定只走 grade:set 独立通道：这两个视图**不**发对话（学段更不该混进对话请求）
    assert.ok(!/sendChat\s*\(/.test(code), `${name} 不该碰 sendChat（学段与对话请求是两条路径）`)
    // 来源说法只有 labels.ts 那一处实现：视图里不许再写一遍「手动选中 / AI 引擎推算」
    assert.ok(
      !code.includes('手动选中') && !code.includes('AI 引擎推算'),
      `${name} 里又写了一遍来源文案 —— 唯一实现是 labels.ts 的 gradeOriginLabel()`
    )
    assert.ok(
      /gradeOriginLabel\s*\(/.test(code),
      `${name} 必须调 labels.ts 的 gradeOriginLabel()（两处各写一份映射迟早对不上）`
    )
  }
})

test('★ 指示器保留既有 data-* 契约（data-grade / data-origin / data-determined）与当前学段文本', () => {
  const code = codeOf(INDICATOR_FILE)
  // 既有测试与 CDP 冒烟脚本按这些属性取值，改名会让它们静默失效
  for (const attribute of ['data-grade', 'data-origin', 'data-determined', 'grade-current-label']) {
    assert.ok(code.includes(attribute), `GradeIndicator.vue 缺少 ${attribute}`)
  }
  // 选项默认收起：`grade-options` 受 `v-if` 控制（否则「系统自己在判」看起来像每次都让学生填）
  assert.ok(/v-if="pickerOpen"[\s\S]{0,200}grade-options/.test(code), '学段选项必须默认收起（点 grade-set 才展开）')
})
