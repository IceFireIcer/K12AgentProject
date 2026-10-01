/**
 * 票 25 的**渲染层**验收（引导 UI + 名字占位符 + 画像标签卡 + 两道闸）。
 *
 * 这一组盯住五件「错了会静默出事」的事：
 *
 * 1. ★ **弹不弹只有一个判据**：没到 done（票 31：done 是唯一终态）。多一条判据
 *    （画像空不空 / 是不是新会话 / 本机装多久）就会多一处真相，而它的表现是
 *    「答完又问一遍」—— 最烦人也最难查的一种失败。
 * 2. ★ **回答归属靠位置，不靠解析**：展示第 N 问时记下它的 id，下一条消息配它。
 *    从学生的话里认「他答的是第几问」需要一个会答错的判据，而答错的代价是**记错**。
 * 3. ★ **降级也要走完**（执行报告 §1.7）：没桥 / 回执失败 / 状态读不到，引导都不能
 *    卡住。它是新用户的前 30 秒，卡在这里代价最大。
 * 4. ★ **不做乐观更新**（标签撤销 / 两道闸）：等后端回执才改界面 —— 先改界面会在
 *    失败时让界面说谎（学生以为关掉了，而标签照写）。
 * 5. ★ **名字占位符**（执行报告 §0.6.4）：替换后**不许有残留的花括号**；模型全程
 *    不知道学生叫什么，真名只在渲染层内存里。
 *
 * 跑法与 `renderer-grade.test.ts` 一致（Node 内置类型擦除 + 内置断言 + 补 `.ts` 的
 * 解析 hook + 补 `@shared` 别名）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

/**
 * 渲染进程的模块只按 Vite 的口味写相对导入（from '../labels'，不带扩展名），
 * 而 Node ESM 要求显式扩展名。这个 hook 只给「相对且没写扩展名」的说明符补 `.ts`。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 把静态 import 提到模块顶部，
 *    而 hook 是在那之后才注册的。
 */
const SRC_SHARED = new URL('../src/shared/', import.meta.url)
registerHooks({
  resolve(specifier, context, nextResolve) {
    // @shared/* 是 vite/tsc 的路径别名（见 electron.vite.config.ts 的 sharedAlias）。
    // Node 不认它，所以在这里补上 —— 被测模块用的是**产品里的真写法**，
    // 为了跑测试去改产品源码的导入路径才是本末倒置。
    if (specifier.startsWith('@shared/')) {
      const rest = specifier.slice('@shared/'.length)
      return { url: new URL(rest + '.ts', SRC_SHARED).href, shortCircuit: true }
    }
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

const TOKEN = '{{' + 'student_name' + '}}'
const { STUDENT_NAME_TOKEN, substituteStudentName, hasUnsubstitutedPlaceholder, renderStudentName, resolveStudentName } =
  await import('../src/renderer/src/student-name.ts')
const api = await import('../src/renderer/src/api/onboarding.ts')
const profileApi = await import('../src/renderer/src/api/profile-card.ts')
const { useOnboardingStore } = await import('../src/renderer/src/stores/onboarding.ts')
// ★ 五问脚本的**唯一一份**（chips 有没有、问几问都从这里读，测试不另抄一遍）
const profileTags = await import('../src/shared/profile-tags.ts')
const { useProfileCardStore, SOURCE_LABELS, canRetract, confidencePercent } =
  await import('../src/renderer/src/stores/profileCard.ts')

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRenderer = (...segments: string[]): string =>
  readFileSync(join(desktopRoot, 'src', 'renderer', 'src', ...segments), 'utf8')
/** 去掉注释再扫代码（注释里引用的机制说明不算实现）。 */
const codeOf = (source: string): string =>
  source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\s)\/\/.*$/gm, '$1')

/* ================================================================== *
 * ① 名字占位符
 * ================================================================== */

test('占位符替换：模型写的花括号换成真实称呼，学生的名字不上网', () => {
  assert.equal(STUDENT_NAME_TOKEN, TOKEN, '规范占位符就是提示词里给模型的那一串')
  const spoken = STUDENT_NAME_TOKEN + '，我们先把这道题拆成三步'
  assert.equal(substituteStudentName(spoken, '小明'), '小明，我们先把这道题拆成三步')
  // ★ 宽容一点：模型可能多写空格 —— 那不是「没照做」，不该让学生看到花括号
  assert.equal(substituteStudentName('{{ student_name }} 你好', '小明'), '小明 你好')
  // 名字拿不到 → 中性的「同学」（**绝不**回落成空串，那会渲染出「，我们…」）
  assert.equal(resolveStudentName(''), '同学')
  assert.equal(resolveStudentName('   '), '同学')
  assert.equal(resolveStudentName(null), '同学')
  assert.equal(substituteStudentName(spoken, ''), '同学，我们先把这道题拆成三步')
})

test('★★ 替换后仍有花括号残留 ⇒ 判得出来（守卫 G-D 的判据），且渲染出口会兜掉', () => {
  // 模型没照做：自己造了一个不认识的占位符 —— 窄匹配会漏掉它，宽判据不会
  const stray = '{{studentName}}，我们来聊聊'
  assert.equal(hasUnsubstitutedPlaceholder(stray), true, '不认识的花括号也是残留')
  assert.equal(hasUnsubstitutedPlaceholder('{{名称}}'), true, '中文占位符同样是残留')
  // 反向对照：正常句子不该被误判（否则兜底会把正文抹掉）
  assert.equal(hasUnsubstitutedPlaceholder('小数写成 0.5，不用加花括号'), false)
  assert.equal(hasUnsubstitutedPlaceholder('小明，我们开始吧'), false)
  // 渲染出口：残留被抹掉，并且**明确报告**发生过（只给教师视角看）
  const result = renderStudentName(stray, '小明')
  assert.equal(result.residual, true)
  assert.ok(!result.text.includes('{{'), '上屏的正文里不许再出现两支花括号')
  assert.ok(result.text.includes('我们来聊聊'), '抹掉的只是占位符，正文其余部分一个字都不许动')
  // 正常路径不触发兜底
  const clean = renderStudentName('小明，我们开始吧', '小明')
  assert.equal(clean.residual, false)
  assert.equal(clean.text, '小明，我们开始吧')
})

/* ================================================================== *
 * ② 状态归一化 + 「弹不弹」的唯一判据
 * ================================================================== */

test('★★ 该不该弹：只有「未到 done」这一条判据（G-I；票 31：done 是唯一终态）', () => {
  // ★ 显式收窄两个字面量字段：对象字面量里的 'q1' 会被推断成 string，
  //   而载荷类型要的是 'q1'..'q5' 联合 —— 不收窄这里就不是在测真实契约了。
  const base = {
    answered: [] as ('q1' | 'q2' | 'q3' | 'q4' | 'q5')[],
    nextQuestionId: 'q1' as 'q1' | null,
    displayName: '同学'
  }
  // ★★ 没答完 = 要问：not_started / in_progress / 历史 skipped 一律继续问
  for (const state of ['not_started', 'in_progress', 'skipped'] as const) {
    assert.equal(
      api.shouldOfferOnboarding({ ...base, onboardingState: state }),
      true,
      '状态是 ' + state + ' 属于「没答完」，必须继续问（跳过入口已删）'
    )
  }
  assert.equal(api.shouldOfferOnboarding({ ...base, onboardingState: 'done' }), false, 'done 是唯一终态')
  // 读不到状态时也不弹：宁可不引导，也不要拿一个不知道的状态去问
  assert.equal(api.shouldOfferOnboarding(null), false)
})

test('载荷归一化：脏数据整条丢掉，绝不猜一个最近的问次', () => {
  const ok = api.normalizeOnboardingState({
    onboardingState: 'in_progress',
    answered: ['q1', 'q1', 'nope'],
    nextQuestionId: 'q2',
    displayName: '  小明  '
  })
  assert.deepEqual(ok, {
    onboardingState: 'in_progress',
    answered: ['q1'],
    nextQuestionId: 'q2',
    displayName: '小明'
  })
  // 状态认不出 / 不是对象 → 整条忽略（不映射到最近似的状态）
  assert.equal(api.normalizeOnboardingState({ onboardingState: 'weird' }), null)
  assert.equal(api.normalizeOnboardingState({}), null)
  assert.equal(api.normalizeOnboardingState(null), null)
  assert.equal(api.normalizeOnboardingState('not_started'), null)
  // nextQuestionId 认不出 → null（= 不该再弹），而不是硬塞一个 q1
  const done = api.normalizeOnboardingState({ onboardingState: 'done', nextQuestionId: 'q9' })
  assert.equal(done?.nextQuestionId, null)
})

/* ================================================================== *
 * ③ store：待答问次按位置记、回答交回去、降级照常走完
 * ================================================================== */

/**
 * 一个可控的假桥（window.api 上的**三条**引导方法：读 / 答 / 订阅）。
 *
 * @param options.autoAdvance 答一问就把后端状态往前推（与真服务端一致）。
 *   默认 `false`：夹具保持原样不动 —— 只有「一路答到 done」的用例需要它，
 *   别的用例自己用 `setState` 摆状态（改动默认行为会波及既有断言）。
 */
function installOnboardingBridge(options: { autoAdvance?: boolean } = {}) {
  const answers: Array<{ questionId: string; answerText: string }> = []
  let stateCalls = 0
  let failure: string | null = null
  /** 后端状态（每个用例自己摆；默认「还没问过」）。 */
  let next: Record<string, unknown> = {
    onboardingState: 'not_started',
    answered: [],
    nextQuestionId: 'q1',
    displayName: '小明'
  }

  const fake = {
    readOnboardingState: async () => {
      stateCalls += 1
      return { ok: true as const, data: next }
    },
    answerOnboarding: async (payload: { questionId: string; answerText: string }) => {
      answers.push({ questionId: payload.questionId, answerText: payload.answerText })
      if (failure !== null) return { ok: false as const, message: failure }
      if (options.autoAdvance === true) {
        // 真服务端答完一问就推进：已答集合 +1、下一问顺延、收齐了就是 done
        const answeredIds = [
          ...((next.answered as string[] | undefined) ?? []),
          payload.questionId
        ]
        const rest = profileTags.ONBOARDING_QUESTIONS.filter(
          (question) => !answeredIds.includes(question.id)
        )
        next = {
          onboardingState: rest.length === 0 ? 'done' : 'in_progress',
          answered: answeredIds,
          nextQuestionId: rest[0]?.id ?? null,
          displayName: next.displayName
        }
      }
      return { ok: true as const, data: { accepted: true } }
    },
    onOnboardingChanged: () => () => {}
  }
  ;(globalThis as unknown as { window: unknown }).window = { api: fake }
  return {
    answers,
    get stateCalls() {
      return stateCalls
    },
    setState: (value: Record<string, unknown>) => {
      next = value
    },
    failAnswerWith: (message: string | null) => {
      failure = message
    }
  }
}

test('store：读到 not_started 就把第一问挂出来（按位置记待答问次）', async () => {
  installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  assert.equal(onboarding.active, false, '还没读状态之前不显示问句')
  await onboarding.load()
  assert.equal(onboarding.active, true)
  assert.equal(onboarding.pendingQuestionId, 'q1')
  assert.equal(onboarding.currentQuestion?.text, '你现在上几年级呀？')
  assert.deepEqual(onboarding.currentQuestion?.chips, ['小学低年级', '小学高年级', '初中', '高中'])
})

test('★★ 只有第 1 问带选项（2026-09-30 用户裁决）：其余四问学生自己写', () => {
  const withChips = profileTags.ONBOARDING_QUESTIONS.filter((question) => question.chips.length > 0)
  assert.deepEqual(
    withChips.map((question) => question.id),
    ['q1'],
    '带选项的只该有第 1 问（年级是闭集）；给别的问答选项等于替他说话'
  )
  for (const question of profileTags.ONBOARDING_QUESTIONS.slice(1)) {
    assert.deepEqual(question.chips, [], question.id + ' 不许再带选项')
  }
})

test('★★ 引导期：问答记进 transcript（界面自己渲染），答完第 5 问清空', async () => {
  installOnboardingBridge({ autoAdvance: true })
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  // ⚠️ 断言写在 `.length` / `.map()` 上，不写 `deepEqual(transcript, [])`：
  //    `assert.deepEqual` 是**断言签名**（`asserts actual is T`），拿 `[]` 当期望值会把
  //    `transcript` 收窄成 `never[]`，后面再读 `row.questionId` 就编译不过（typecheck 抓到了）。
  assert.equal(onboarding.transcript.length, 0, '还没答之前没有问答记录')
  await onboarding.submitAnswer('我上初中了')
  assert.deepEqual(
    onboarding.transcript.map((row) => [row.questionId, row.answerText]),
    [['q1', '我上初中了']],
    '引导期不写会话 —— 「问次 + 学生原话」只有这一份显示来源'
  )
  await onboarding.submitAnswer('最近在学函数')
  await onboarding.submitAnswer('多举生活里的例子')
  await onboarding.submitAnswer('慢一点')
  assert.deepEqual(
    onboarding.transcript.map((row) => row.questionId),
    ['q1', 'q2', 'q3', 'q4'],
    '按问次顺序累积'
  )
  assert.equal(onboarding.pendingQuestionId, 'q5', '前置：此时轮到第 5 问')
  await onboarding.submitAnswer('叫我小明')
  assert.equal(onboarding.active, false, '五问答完不再有问句')
  assert.equal(
    onboarding.transcript.length,
    0,
    'done 之后清空：引导区整块消失，页面回到正常新对话页（引导不留会话历史）'
  )
})

test('★★ 竞态：后端这次读还停在上一问时，界面**不许往回退**（真机实测）', async () => {
  // 时序（回答是 fire-and-forget 落库的，而这次读是重新读服务端）：
  //   学生答了 q1 → 界面还没等到写库 → 读回来的 `nextQuestionId` 仍是 q1。
  //   照单全收的后果实测过：界面退回去重问 q1，学生下一条话被记到 q1 头上，
  //   把他刚说的那句**覆盖**掉（五问走完只剩三条回答）。
  const bridge = installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  // ① 答 q1，但读回来的还是「下一问 q1」（旧快照）
  bridge.setState({ onboardingState: 'in_progress', answered: [], nextQuestionId: 'q1', displayName: '小明' })
  await onboarding.submitAnswer('我上初中了')
  assert.equal(
    onboarding.pendingQuestionId,
    'q2',
    '已经答过 q1 —— 绝不能被一份更旧的快照拽回去重问（否则下一句会被记到 q1 头上）'
  )
  // ② 再答 q2，旧快照又来一次（answered 只到 q1）
  bridge.setState({ onboardingState: 'in_progress', answered: ['q1'], nextQuestionId: 'q2', displayName: '小明' })
  await onboarding.submitAnswer('最近在学函数')
  assert.equal(onboarding.pendingQuestionId, 'q3')
  assert.deepEqual(
    onboarding.transcript.map((row) => row.questionId),
    ['q1', 'q2'],
    '两条回答各归各的问（旧实现里第二条会把第一条覆盖掉）'
  )
})

test('★ 回答交回去时带的是**展示那一问**的 id（位置，不解析学生的话）', async () => {
  const bridge = installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  // 后端下一问已经是 q2 —— 界面照它走
  bridge.setState({ onboardingState: 'in_progress', answered: ['q1'], nextQuestionId: 'q2', displayName: '小明' })
  await onboarding.load()
  await onboarding.submitAnswer('我五年级')
  assert.deepEqual(bridge.answers, [{ questionId: 'q2', answerText: '我五年级' }])
})

test('★★ 连点两下 chip 只交回一条（重入闸是同步设置的）', async () => {
  const bridge = installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  bridge.setState({ onboardingState: 'in_progress', answered: ['q1'], nextQuestionId: 'q2', displayName: '小明' })
  await onboarding.load()
  // ★ 两次调用之间不 await：第二次进来时重入闸已经拉上了
  const first = onboarding.submitAnswer('数学')
  const second = onboarding.submitAnswer('数学')
  await Promise.all([first, second])
  assert.equal(bridge.answers.length, 1, '同一条回答不许交回两次（学生连点是最常见的触发）')
})

test('★★ 降级：回答交不回去也照样推进到下一问（引导一定要走完）', async () => {
  const bridge = installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  bridge.failAnswerWith('回答没收到。')

  await onboarding.submitAnswer('我上初中了')
  assert.equal(onboarding.pendingQuestionId, 'q2', '收不到回信就按顺序发下一问（绝不回头重问）')
  assert.deepEqual(onboarding.answered, ['q1'])

  // 一路答到第五问之后：不该再弹（本地也知道问完了）
  for (const id of ['q2', 'q3', 'q4', 'q5'] as const) {
    assert.equal(onboarding.pendingQuestionId, id)
    await onboarding.submitAnswer('好的')
  }
  assert.equal(onboarding.pendingQuestionId, null, '五问答完就不再弹')
  assert.equal(onboarding.active, false)
})

test('★★ 降级：桥整块不可用时**整段引导不出现**，学生照常提问', async () => {
  // 老 preload（没有那三条方法）—— 不许抛异常，也不许显示一段点了没反应的引导
  ;(globalThis as unknown as { window: unknown }).window = { api: {} }
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  assert.equal(onboarding.active, false)
  assert.equal(onboarding.state, null)
  assert.ok(/[\u4e00-\u9fff]/.test(onboarding.bridgeError ?? ''), '桥不可用时给学生一句中文人话')
  for (const bad of ['readOnboardingState', 'onboarding:', 'preload', 'window.api']) {
    assert.ok(!String(onboarding.bridgeError).includes(bad), '学生面出现了「' + bad + '」')
  }
})

test('★★ 降级：状态读不到时不显示引导，也不给学生一句他解决不了的话', async () => {
  const fake = {
    readOnboardingState: async () => ({ ok: false as const, message: '读取失败（HTTP 503）：服务不可用' }),
    answerOnboarding: async () => ({ ok: true as const, data: { accepted: true } }),
    onOnboardingChanged: () => () => {}
  }
  ;(globalThis as unknown as { window: unknown }).window = { api: fake }
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  assert.equal(onboarding.active, false)
  assert.equal(onboarding.state, null)
  assert.equal(onboarding.bridgeError, null, '读不到状态 ≠ 桥坏了：不给学生一句技术话')
})

test('★★ 没有跳过入口：store 不暴露 skip，源码里也不许再出现（票 31：全链路删）', async () => {
  installOnboardingBridge()
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  assert.equal(onboarding.active, true, '前置：此时引导是挂着的')
  // ★ 运行时：store 上根本没有这个动作（漏一个方法比留一个能调的方法更安全）
  assert.equal('skip' in onboarding, false, 'store 不许再暴露 skip —— 五问必须答完')
  // ★ 源码：无论是 store 还是桥，都不许再有跳过语义
  const store = readRenderer('stores', 'onboarding.ts')
  const bridgeSource = readRenderer('api', 'onboarding.ts')
  for (const [name, source] of [
    ['stores/onboarding.ts', store],
    ['api/onboarding.ts', bridgeSource]
  ] as const) {
    assert.ok(
      !/skipOnboarding|onboardingSkip|onboarding:skip|skip\(\)/.test(codeOf(source)),
      name + ' 里还有跳过相关的实现 —— 全链路删除没删干净'
    )
  }
})

test('★ 推送：onboarding:changed 到达时用后端给的状态对齐（不自己推）', async () => {
  const listeners: Array<(payload: unknown) => void> = []
  const fake = {
    readOnboardingState: async () => ({
      ok: true as const,
      data: { onboardingState: 'not_started', answered: [], nextQuestionId: 'q1', displayName: '同学' }
    }),
    answerOnboarding: async () => ({ ok: true as const, data: { accepted: true } }),
    onOnboardingChanged: (listener: (payload: unknown) => void) => {
      listeners.push(listener)
      return () => {}
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = { api: fake }
  setActivePinia(createPinia())
  const onboarding = useOnboardingStore()
  await onboarding.load()
  assert.equal(onboarding.pendingQuestionId, 'q1')
  for (const listener of listeners) {
    listener({
      onboardingState: 'done',
      answered: ['q1', 'q2', 'q3', 'q4', 'q5'],
      nextQuestionId: null,
      displayName: '小明'
    })
  }
  assert.equal(onboarding.pendingQuestionId, null, '问完了就不许再挂着问句')
  assert.equal(onboarding.active, false)
})

/* ================================================================== *
 * ④ 画像标签卡：来源看得见、只有猜的能撤、不乐观更新
 * ================================================================== */

test('★ 三档来源都有学生话，且只有猜出来的能撤', () => {
  assert.deepEqual(Object.keys(SOURCE_LABELS).sort(), ['declared', 'inferred', 'observed'])
  for (const label of Object.values(SOURCE_LABELS)) {
    assert.ok(/[\u4e00-\u9fff]/.test(label), '来源说明必须是中文人话：' + label)
  }
  const tag = (source: string) => ({
    key: 'k',
    value: 'v',
    confidence: 0.75,
    source,
    ts: 1,
    dimension: 7,
    label: '讲解方式'
  })
  assert.equal(canRetract(tag('inferred') as never), true, '猜的必须能一键撤销')
  assert.equal(canRetract(tag('declared') as never), false, '学生自己说过的不给撤（撤了就是删证据）')
  assert.equal(canRetract(tag('observed') as never), false, '系统量到的也不给撤')
  assert.equal(confidencePercent(tag('inferred') as never), 75, '猜的要看得见把握多大')
  assert.equal(
    confidencePercent({ ...tag('inferred'), confidence: null } as never),
    null,
    '后端没给置信度就不编一个数字出来'
  )
})

test('标签投影：中文名必须来自后端，拿不到就整条不渲染', () => {
  const ok = profileApi.normalizeProfileTag({
    key: 'explain_style',
    value: '生活例子',
    confidence: 0.7,
    source: 'declared',
    ts: 5,
    dimension: 7,
    label: '讲解方式'
  })
  assert.equal(ok?.label, '讲解方式')
  // ★ 没有 label → 整条丢掉（绝不回落成 key：那会把一个英文标识摆到学生眼前）
  assert.equal(profileApi.normalizeProfileTag({ key: 'explain_style', value: 'x', source: 'declared' }), null)
  assert.equal(profileApi.normalizeProfileTag({ key: 'x', value: 'y', source: 'guessed', label: '讲解方式' }), null)
  assert.equal(profileApi.normalizeProfileTag({ ...ok, confidence: 7 })?.confidence, null)
  assert.equal(profileApi.normalizeProfileTag(null), null)
})

/** 一个可控的假桥（画像四条）。 */
function installProfileBridge() {
  const retracted: string[] = []
  const flags: Array<Record<string, unknown>> = []
  let tags: Record<string, unknown> = {
    tags: [
      {
        key: 'explain_style',
        value: '生活例子',
        confidence: 0.75,
        source: 'inferred',
        ts: 1,
        dimension: 7,
        label: '讲解方式'
      },
      {
        key: 'subject',
        value: '数学',
        confidence: null,
        source: 'declared',
        ts: 2,
        dimension: 2,
        label: '科目'
      }
    ],
    parentConsent: true,
    memorySwitch: true,
    // ★ 维度小标题由后端给（A2+）：界面按 dimension 查它，一个字都不自己拼。
    dimensionLabels: { '2': '在学什么', '7': '怎么讲更好' }
  }
  let failure: string | null = null
  const fake = {
    readProfileTags: async () => ({ ok: true as const, data: tags }),
    retractProfileTag: async (key: string) => {
      retracted.push(key)
      if (failure !== null) return { ok: false as const, message: failure }
      return { ok: true as const, data: { ...tags, tags: [] } }
    },
    readIdentity: async () => ({
      ok: true as const,
      data: {
        anonStudentId: 'anon-1',
        realName: '小明',
        displayName: '小明',
        parentConsent: true,
        memorySwitch: true,
        onboardingState: 'done'
      }
    }),
    setIdentityFlags: async (payload: Record<string, unknown>) => {
      flags.push(payload)
      if (failure !== null) return { ok: false as const, message: failure }
      tags = {
        ...tags,
        parentConsent: payload.parentConsent === undefined ? tags.parentConsent : payload.parentConsent,
        memorySwitch: payload.memorySwitch === undefined ? tags.memorySwitch : payload.memorySwitch
      }
      return {
        ok: true as const,
        data: {
          anonStudentId: 'anon-1',
          realName: '小明',
          displayName: '小明',
          parentConsent: Boolean(tags.parentConsent),
          memorySwitch: Boolean(tags.memorySwitch),
          onboardingState: 'done'
        }
      }
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = { api: fake }
  return {
    retracted,
    flags,
    setTags: (value: Record<string, unknown>) => {
      tags = value
    },
    failWith: (message: string | null) => {
      failure = message
    }
  }
}

test('标签卡：按维度分组，来源与把握都显示出来', async () => {
  installProfileBridge()
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  assert.equal(card.hasTags, true)
  assert.deepEqual(
    card.groups.map((group) => group.dimension),
    [2, 7],
    '分组顺序按维度序号（后端给的那个数字）'
  )
  assert.equal(card.tags[0]?.label, '讲解方式')
  assert.equal(confidencePercent(card.tags[0]!), 75)
})

test('A2+ 组标题：由后端给的 dimensionLabels 提供，渲染层不拼字面量', async () => {
  installProfileBridge()
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  // 每一组的 title 必须**逐字等于**后端下发的那个名字（不是界面上某处写死的）。
  assert.deepEqual(
    card.groups.map((group) => [group.dimension, group.title]),
    [
      [2, '在学什么'],
      [7, '怎么讲更好']
    ],
    '组标题取自 dimensionLabels[维度序号]'
  )
})

test('A2+ 组标题缺失时回空串（不渲染标题行），标签本身照常显示', async () => {
  const bridge = installProfileBridge()
  // 老后端：载荷里没有 dimensionLabels（桥照收，只是没有组标题）。
  bridge.setTags({
    tags: [
      { key: 'subject', value: '数学', confidence: null, source: 'declared', ts: 1, dimension: 2, label: '科目' }
    ],
    parentConsent: true,
    memorySwitch: true
  })
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  assert.equal(card.hasTags, true, '标签本身照常显示（新能力缺失不许拖垮既有能力）')
  assert.deepEqual(card.groups.map((group) => group.title), [''], '取不到标题就是空串')
})

test('★★ 撤销：等回执再改界面；失败时界面一个像素都不动（不乐观更新）', async () => {
  const bridge = installProfileBridge()
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  const before = card.tags.map((tag) => tag.key)

  // 失败：列表不变、给一句可读中文
  bridge.failWith('撤销失败：本地数据服务没有响应。')
  const failed = await card.retract(card.tags[0]!)
  assert.equal(failed, '撤销失败：本地数据服务没有响应。')
  assert.deepEqual(card.tags.map((tag) => tag.key), before, '失败时界面必须一动不动')
  assert.ok(card.notice !== null)

  // 成功：用回执整份替换（回执说空了就空）
  bridge.failWith(null)
  const ok = await card.retract(card.tags[0]!)
  assert.equal(ok, null)
  assert.deepEqual(bridge.retracted, ['explain_style', 'explain_style'])
  assert.deepEqual(card.tags, [], '回执是撤销之后的完整清单，整份替换')
})

test('★ 只有猜出来的能撤：其余两档直接拒（不去打后端）', async () => {
  const bridge = installProfileBridge()
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  const declared = card.tags.find((tag) => tag.source === 'declared')!
  const message = await card.retract(declared)
  assert.ok(message !== null && /[\u4e00-\u9fff]/.test(message))
  assert.deepEqual(bridge.retracted, [], '撤不了就不该发请求')
})

test('★★ 两道闸：一次只提交变动的那个字段，且等回执才改界面', async () => {
  const bridge = installProfileBridge()
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()

  bridge.failWith('开关没保存上，可以再试一次。')
  const failed = await card.setFlags({ memorySwitch: false })
  assert.ok(failed !== null)
  assert.deepEqual(bridge.flags, [{ memorySwitch: false }], '只发改动的字段')
  assert.equal(card.memorySwitch, true, '失败时开关不许跟着跳（否则界面在说谎）')

  bridge.failWith(null)
  const ok = await card.setFlags({ memorySwitch: false })
  assert.equal(ok, null)
  assert.equal(card.memorySwitch, false, '回执说关了就关')
  assert.equal(card.parentConsent, true, '另一道闸不许被顺手改掉')
})

test('降级：画像桥不可用时不给技术话、卡片整块不显示', async () => {
  ;(globalThis as unknown as { window: unknown }).window = { api: {} }
  setActivePinia(createPinia())
  const card = useProfileCardStore()
  await card.load()
  assert.equal(card.hasTags, false)
  assert.ok(/[\u4e00-\u9fff]/.test(card.bridgeError ?? ''))
  for (const bad of ['readProfileTags', 'profile:', 'preload', 'window.api']) {
    assert.ok(!String(card.bridgeError).includes(bad), '学生面出现了「' + bad + '」')
  }
})

/* ================================================================== *
 * ⑤ 视图接线（静态源码）：一条提交路径、替换点只有一个、没有第二处真相
 * ================================================================== */

const CHAT = readRenderer('views', 'Chat.vue')
const RAIL = readRenderer('components', 'ContextRail.vue')
/**
 * 标签卡的实际渲染实现。
 *
 * ★ 它**原先长在 `ContextRail.vue`** 里，学习档案页开出右栏后抽成了
 *   `components/card/ProfileTags.vue`（两处共用一份口径）。所以本文件的标签卡
 *   断言必须打在**抽取后的那个文件**上 —— 继续打 `RAIL` 会永远失败，
 *   而那是「测试挂掉了」而不是「功能坏了」，最容易被顺手跳过或删掉。
 */
const PROFILE_TAGS = readRenderer('components', 'card', 'ProfileTags.vue')
/** 学习档案右栏（复用标签卡的只读视图 + 头像 / 名字 / 学段）。 */
const PORTRAIT = readRenderer('components', 'StudyPortrait.vue')
const SETTINGS = readRenderer('views', 'Settings.vue')
const MARKDOWN = readRenderer('components', 'MarkdownProse.vue')
const CHAT_MESSAGE = readRenderer('components', 'ChatMessage.vue')
const SESSIONS = readRenderer('study', 'SessionsTab.vue')
const ONBOARDING_STORE = readRenderer('stores', 'onboarding.ts')

test('★★ 引导期不进对话、不调模型；chip 与打字共用同一个出口（2026-09-30 用户裁决）', () => {
  // ① 引导期：交给 onSend 的那句话是**对当前那一问的回答** —— 只交回引导并 return，
  //    不许顺手 chat.send（那会换来一条模型回复，还把五问堆成一条越来越长的会话）。
  assert.match(CHAT, /@send="onSend"/, '输入框仍然必须把文字交给 onSend')
  assert.match(
    CHAT,
    /if \(onboarding\.active\) \{\s*void onboarding\.submitAnswer\(text\)\s*return\s*\}/,
    '引导期必须先交回引导、再 return —— 五问期间不调模型（用户裁决）'
  )
  assert.match(CHAT, /void chat\.send\(text\)/, '非引导期的正常对话通道必须还在')
  // ② chip（只有第 1 问有）：点一下直接提交，但仍走同一个 store 出口 ——
  //    问次记录、防连点、降级推进全在 submitAnswer 那一处。
  assert.match(CHAT, /@click="pickOnboardingOption/, 'chip 必须接在 pickOnboardingOption 上')
  assert.match(CHAT, /function pickOnboardingOption/, '必须真的有这个函数（只写模板不算）')
  const pickAt = CHAT.indexOf('function pickOnboardingOption')
  assert.match(
    CHAT.slice(pickAt, pickAt + 400),
    /onboarding\.submitAnswer\(option\)/,
    'chip 也要走 submitAnswer —— 不许自己记问次 / 自己调桥（那就是第二条路径）'
  )
  assert.ok(
    !/readOnboardingState|answerOnboarding/.test(codeOf(CHAT)),
    'Chat.vue 不许直接碰引导通道：绕开 store 就绕开了问次记录与防连点'
  )
})

test('★★ 五问期间不显示「新对话页」，答完回到正常新对话页', () => {
  // 用户裁决：一进应用先看到「开场白 + 四张能力入口 + 建议问题」的一屏、问题挤在下面，
  // 读起来像问卷而不是聊天。所以引导期把空态让开，第一屏就是团团的问题。
  assert.match(
    CHAT,
    /v-if="isEmpty && !onboarding\.active"/,
    '引导期必须让开空态（新对话页），答完再回来'
  )
  assert.match(CHAT, /data-testid="onboarding-flow"/, '引导区要有一个容器锚点')
  assert.match(CHAT, /onboarding\.transcript/, '已经答过的问答要从 transcript 渲染出来')
  assert.match(CHAT, /data-testid="onboarding-answer"/, '学生答的那句要有自己的锚点')
})

test('★★ 弹不弹只读那一条状态，渲染层不加第二份标记位', () => {
  for (const [name, source] of [
    ['views/Chat.vue', CHAT],
    ['stores/onboarding.ts', ONBOARDING_STORE]
  ] as const) {
    assert.ok(
      !codeOf(source).includes('localStorage'),
      name + ' 的代码里用了 localStorage —— 「该不该弹」的权威状态在库里，加第二份就会出现两处真相'
    )
  }
})

test('★★ 名字替换点只有一个（多一处就多一处「忘了替换」）', () => {
  // 替换实现只有一处：student-name.ts
  const impl = readRenderer('student-name.ts')
  assert.match(impl, /export function substituteStudentName/)
  assert.match(impl, /export function hasUnsubstitutedPlaceholder/)
  // 上屏那条路在 MarkdownProse（对话页与历史会话回看共用它）
  assert.match(MARKDOWN, /renderStudentName\(props\.text, props\.nameOf\)/)
  // 对话页与档案页都要把称呼喂进去（漏一处 = 那一路的学生读到花括号）
  assert.match(CHAT, /:name-of="studentName"/)
  assert.match(CHAT, /:name-of="studentName"[\s\S]{0,80}?@branch/, 'ChatMessage 那条要带 nameOf')
  assert.match(SESSIONS, /:name-of="studentName"/)
  // 组件自身不许再抄一份替换逻辑
  assert.ok(!/replace\(.*student_name/.test(CHAT_MESSAGE), 'ChatMessage 不许自己再写一份替换')
  assert.ok(!/replace\(.*student_name/.test(CHAT), '页面也不许写一份替换')
})

test('★★ 标签卡看得见来源、撤销入口只对猜的那一档出现', () => {
  assert.match(PROFILE_TAGS, /SOURCE_LABELS\[tag\.source\]/, '每条标签都要渲染来源说明')
  assert.match(PROFILE_TAGS, /canRetract\(tag\)/, '撤销入口必须受「只有猜的能撤」约束')
  assert.match(PROFILE_TAGS, /confidencePercent\(tag\)/, '猜的那一档要显示把握多大')
  // ★ 界面上不许写死任何标签名 / 维度名（中文名由后端给）
  assert.match(PROFILE_TAGS, /tag\.label/, '标签名必须来自后端给的 label')
  // ★★ A2+：组标题也必须来自后端（group.title），**不是**在模板里拼一段中文
  assert.match(PROFILE_TAGS, /group\.title/, '组标题必须取自后端给的 group.title（store 从 dimensionLabels 取）')
  assert.match(PROFILE_TAGS, /profileCard\.retract\(tag\)/, '撤销要走 store 的写入口（等回执）')
  // ★★ `retractable` 是模式开关：判据必须是「后端说能撤」**且**「本视图允许撤」
  //    —— 只写 `canRetract` 的话档案页右栏会长出按钮（那是只读视图）。
  assert.match(
    PROFILE_TAGS,
    /props\.retractable\s*&&\s*canRetract\(tag\)/,
    '能不能撤要同时看视图模式与后端判据（缺一个就会在只读视图里长出撤回入口）'
  )
})

test('★★ 画像标签卡只有一份实现（抽取后 ContextRail 不许留孤儿副本）', () => {
  // ★ 对话页右栏改为**引用**共享组件，而不是自己再渲染一遍标签 ——
  //   两份近似实现的真实代价不是重复代码，而是两条会各自漂移的口径
  //   （来源那三句话改一处忘另一处 → 学生在两个页面被两种说法对待）。
  assert.match(RAIL, /<ProfileTags\b/, 'ContextRail 必须引用共享的 ProfileTags 组件')
  assert.ok(
    !/SOURCE_LABELS\[tag\.source\]/.test(RAIL),
    'ContextRail 里还留着标签渲染实现 —— 抽取没抽干净，两份会漂移'
  )
  assert.ok(
    !/canRetract\(tag\)/.test(RAIL),
    'ContextRail 里还留着「能不能撤」的判据 —— 它只该在共享组件里有一份'
  )
})

test('★★ 学习档案右栏：五行结构（PortraitFacts）+ 只读、且一个技术词都不写死', () => {
  // ★★ 2026-09-30 改版：右栏从「共享标签卡（只读）」改成**五行结构** ——
  //   同一份画像换一种读法（类型 / 性格 / 偏好 / 兴趣 / 小结）。
  assert.match(
    PORTRAIT,
    /<PortraitFacts :summary="summaryText" \/>/,
    '档案页右栏必须用 PortraitFacts 渲染五行结构（行标题与文案由后端给）'
  )
  // ★ 这一栏是**只读视图**：不许再挂 ProfileTags —— 那会带出撤回入口，
  //   同一件事有两个能改的入口，学生就搞不清刚才点的是哪个（既有裁决，未变）。
  assert.ok(
    !/<ProfileTags/.test(PORTRAIT),
    '档案右栏不该再挂 ProfileTags：撤回等维护动作只在对话页右栏发生'
  )
  // ★ 需求「不内置画像变动信息」：这一栏不渲染时间线（对话页右栏仍保留那份）。
  assert.ok(
    !/profile-timeline/.test(PORTRAIT),
    '档案右栏不显示画像变动时间线（时间线仍在对话页右栏）'
  )
  // ★ 头像 / 名字 / 学段：名字与学段都从 store 取，不许在渲染层拼内部标识。
  assert.match(PORTRAIT, /displayName/, '名字要来自 identity.displayName')
  assert.match(PORTRAIT, /GRADE_LABELS/, '学段中文名走 labels.ts 的共用口径')
  // ★ 拿不到名字时的回落必须是共享的中性称呼，**不许回落 realName**。
  assert.ok(
    !/realName/.test(PORTRAIT),
    '右栏里出现了 realName —— 它只给渲染层做占位符替换，混进显示层就是把它推上台面'
  )
  // ★ 知识点名走共用口径（取不到名的处理只在一处）。
  assert.match(PORTRAIT, /kpLabel\(/, '知识点显示名要走 study/kp-label.ts 的共用口径')
  // ★ 小结是**只读缓存**（三期）：右栏不许出现任何「生成小结」的动作入口。
  assert.match(PORTRAIT, /profileCard\.summary/, '小结正文要从画像 store 取（只读缓存）')
})

test('★★ 设置页两道闸：走 store 的写入口，且文案说清关掉之后会发生什么', () => {
  assert.match(SETTINGS, /data-testid="settings-memory-switch"/)
  assert.match(SETTINGS, /data-testid="settings-consent-switch"/)
  assert.match(SETTINGS, /profileCard\.setFlags\(/, '必须走 store（等回执才改界面）')
  // 两段说明各要说清「关掉之后」的后果（不许恐吓也不许敷衍）
  assert.match(SETTINGS, /关掉之后不再记新的/, '记忆开关要说清关掉之后不写新标签')
  assert.match(SETTINGS, /关掉之后一条都不再参考/, '同意开关要说清关掉之后画像不外发')
  assert.match(SETTINGS, /问答照常用/, '还要说清「问答照常」，否则学生会以为整个软件不能用了')
})

test('★ 引导那块的锚点还在（模板别被改坏）', () => {
  assert.match(CHAT, /data-testid="onboarding-question-text"/)
  assert.match(CHAT, /data-testid="onboarding-chip"/)
  assert.match(CHAT, /data-testid="onboarding-chips"/)
  assert.match(CHAT, /data-testid="onboarding-question"/)
})

test('★★ 五问不再是「卡片」，也不再有流程进度（2026-09-29 用户裁决）', () => {
  // ★★ 为什么去掉：它此前是 `border` + `border-radius` + `box-shadow` 的**独立卡片**，
  //    还带一条「第 N 个问题，共 5 个」—— 与上面每一条助手消息并排时，
  //    学生读成「界面弹了个问卷」而不是「团团在跟我说话」。
  //    现在它长得和 `.turn__ai`（ChatMessage 的助手消息）一样：头像 + 名字 + 纸面。
  assert.ok(
    !/data-testid="onboarding-progress"/.test(CHAT),
    '进度条锚点还在 —— 「像普通聊天」就不该有流程提示（学生仍能从上下文看出问到哪）'
  )
  assert.ok(
    !/questionOrdinal/.test(codeOf(CHAT)),
    'Chat.vue 里还在读 questionOrdinal —— 它是进度条的绑定，随进度条一起删'
  )
  const storeSource = readRenderer('stores', 'onboarding.ts')
  assert.ok(
    !/questionOrdinal/.test(codeOf(storeSource)),
    'store 里还导出着 questionOrdinal —— 没有消费者了，留着就是死代码'
  )
  // ★ 形态断言：问句块必须在消息列之内，且**不带卡片壳**。
  const template = CHAT.slice(0, CHAT.indexOf('<style'))
  const innerAt = template.indexOf('class="chat__inner"')
  const askAt = template.indexOf('class="chat__ask"')
  const footAt = template.indexOf('class="chat__foot"')
  assert.ok(askAt > innerAt, '问句必须在消息列之内 —— 读作「团团接着问了一句」')
  assert.ok(askAt < footAt, '问句不许再回到底部区（底部只剩输入框 / 排队 / 跳转）')
  // ★ 纸面（.chat__ask-paper）是与助手消息同款的一层，但**外壳本身不许再有 padding + 圆角 + 投影**
  //   —— 那是「卡片」的定义。加了它就等于把这次裁决改回去了。
  const askBlock = CHAT.slice(CHAT.indexOf('.chat__ask {'), CHAT.indexOf('.chat__ask-avatar'))
  assert.ok(!/border-radius/.test(askBlock), '问句外壳不许再有圆角（那是卡片壳）')
  assert.ok(!/box-shadow/.test(askBlock), '问句外壳不许再有投影（那是卡片壳）')
  assert.ok(!/position:\s*(fixed|absolute)/.test(askBlock), '问句块不许绝对/固定定位')
  assert.ok(!/order:\s*-1/.test(askBlock), '问句块不许再用 order 抢位置')
})

test('★★ 界面上没有跳过入口（票 31：移除跳过选项）', () => {
  assert.ok(
    !/data-testid="onboarding-skip"/.test(CHAT),
    'Chat.vue 里还有跳过的锚点 —— 五问必须答完，没有出口'
  )
  assert.ok(!/onboarding\.skip\(/.test(codeOf(CHAT)), '模板里不许再调 skip')
  const storeSource = readRenderer('stores', 'onboarding.ts')
  assert.ok(!/\bskip\b|skipOnboarding/.test(codeOf(storeSource)), 'store 的代码里不许再有 skip 动作')
})
