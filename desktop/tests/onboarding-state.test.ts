/**
 * 冷启动五问（引导）主进程半的守卫（票 25）。
 *
 * 这一份盯住六件「错了就静默出事」的事：
 *
 *   G-I   **触发条件只有一条**：onboarding_state !== 'done'（票 31：唯一终态是 done），
 *         没答完就续问（含历史 skipped）；只有 done **绝不弹引导**（新建会话也不弹）。
 *   G-J   **概括是 fire-and-forget**：注入一个**永不 resolve** 的桩，断言 UI 不阻塞
 *         （answer() 立刻回执、状态立刻终态），且队列不被它拖死。
 *         票 31 起默认实现是 `createLlmSummarizer`（真调模型），另有自己的断言。
 *   G-PII **脱敏职责收窄**：命中就整条丢弃并回落「同学」，**五年级不遮**（反向对照）。
 *   G-EX  **本地抽取**：Q1 点选直达 -> grade:set；Q3/Q4 映射；Q5 称呼不设标签。
 *   G-PR  **引导模式 prompt**：关掉学段权威段/工具/画像块；**真名绝不进 prompt**；
 *         禁做清单 13/14 的话术一个都不出现。
 *   G-IPC **五问走独立通道**：onboarding:answer 与 chat:send 是两条路；
 *         请求体里**没有 studentId**；只有 onboarding:changed 进 PUSH_CHANNELS。
 *
 * ★ 手法：`bridge/client.ts` 那条链由 service.ts 的**可注入出口**（OnboardingTransport）替掉，
 *   于是测的是「从服务一路到请求体」的真实代码 —— 不是另写一份镜像逻辑、也不发真实网络请求。
 *
 * 跑法：node --test tests/onboarding-state.test.ts
 *
 * ⚠️ node --test 直跑 .ts 用的是 Node 的类型擦除 —— 禁用 TS parameter property（AGENTS §8.1）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { IPC, PUSH_CHANNELS } from '../src/main/ipc/channels.ts'
import {
  buildOnboardingSystemPrompt,
  buildSummaryPayload,
  createLlmSummarizer,
  createOnboardingService,
  extractAnswer,
  fetchProfileTags,
  gradeLevelFromText,
  isFallbackName,
  isFinished,
  isGuidedState,
  nextQuestionId,
  normalizeEmotion,
  normalizeIntensity,
  onboardingGuardNotes,
  ONBOARDING_SUMMARY_ALLOWED_KEYS,
  ONBOARDING_SUMMARY_MAX_TAGS,
  parseSummaryTags,
  readQuestionId,
  recordAnswer,
  retractProfileTag,
  safeDisplayName,
  sanitizeStudentText,
  selectProgress,
  shouldStartOnboarding,
  summaryQuestionText,
  type OnboardingDeps,
  type OnboardingTagWrite
} from '../src/main/agent/onboarding/index.ts'
// ★ 回落值从**共享常量**取（不经过 onboarding 的 barrel）—— 白名单/常量只有那一份。
import {
  EPHEMERAL_TAG_SET,
  isLlmVisibleTag,
  LLM_VISIBLE_TAGS,
  ONBOARDING_QUESTIONS,
  STUDENT_FALLBACK_NAME
} from '../src/shared/profile-tags.ts'

/* ------------------------------------------------------------------ *
 * 替身：唯一 HTTP 出口（默认 bridge/client.ts，这里注入记录器）
 * ------------------------------------------------------------------ */

interface WireCall {
  path: string
  method: string
  body?: string
}

interface Wire {
  calls: WireCall[]
  transport: (path: string, init: RequestInit) => Promise<unknown>
  reply(path: string, body: unknown): void
  reset(): void
}

function makeWire(): Wire {
  const calls: WireCall[] = []
  const replies: Array<{ path: string; body: unknown }> = []
  const transport = async (path: string, init: RequestInit): Promise<unknown> => {
    calls.push({
      path,
      method: typeof init.method === 'string' ? init.method : 'GET',
      body: typeof init.body === 'string' ? init.body : undefined
    })
    for (const rule of replies) {
      if (path === rule.path || path.startsWith(rule.path + '?')) return rule.body
    }
    return {}
  }
  return {
    calls,
    transport,
    reply(path: string, body: unknown): void {
      replies.unshift({ path, body })
    },
    reset(): void {
      calls.length = 0
      replies.length = 0
    }
  }
}

function jsonBody(call: WireCall | undefined): Record<string, unknown> {
  assert.ok(call, '这一步应当真的发出了一次请求')
  return JSON.parse(String(call.body)) as Record<string, unknown>
}

/** 桌面端根目录（测试文件在 desktop/tests/ 下）。 */
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STATE_PATH = '/api/onboarding/student_001/state'
const IDENTITY_PATH = '/api/profile/student_001/identity'

/** 一个带超时的 await（用它证明「某件事**没有**阻塞」，而不是靠机器慢才碰巧通过）。 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超过 ' + String(ms) + 'ms 还没回来')), ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    return await Promise.race([promise, limit])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 建一个「已接线、已读状态」的服务（每个用例一套，互不污染）。 */
async function startedService(extra: Partial<OnboardingDeps> = {}) {
  const wire = makeWire()
  wire.reply(STATE_PATH, { onboardingState: 'not_started', answered: [], displayName: '' })
  wire.reply(IDENTITY_PATH, {
    anonStudentId: 'student_001',
    realName: '某同学',
    displayName: STUDENT_FALLBACK_NAME,
    parentConsent: true,
    memorySwitch: true,
    onboardingState: 'not_started'
  })
  const applied: string[] = []
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    applyGradeBand: async (level) => {
      applied.push(level)
    },
    log: () => {},
    ...extra
  })
  const payload = await service.start()
  return { service, applied, payload, wire }
}

const FIVE_ANSWERS: Array<[string, string]> = [
  ['q1', '小学高年级'],
  ['q2', '数学'],
  ['q3', '一步一步慢慢推'],
  ['q4', '慢一点'],
  // ★ 2026-10-01 换题：q5 不再是称呼，而是兴趣 / 动机（称呼由账号门负责，见 account-identity.test.ts）
  ['q5', '喜欢拼乐高和看星星']
]

/* ------------------------------------------------------------------ *
 * G-I 状态机（四条转移 + 触发条件只有一条）
 * ------------------------------------------------------------------ */

test('G-I 状态机：not_started -> in_progress -> done（done 是唯一终态）', () => {
  // ① not_started：会弹引导（还没答）
  assert.equal(shouldStartOnboarding('not_started'), true)
  assert.equal(isGuidedState('not_started'), true)
  assert.equal(nextQuestionId([]), 'q1')

  // ② 答第一问 -> in_progress（仍然要问，因为还没答完）
  const afterFirst = recordAnswer({ state: 'not_started', answered: [] }, 'q1')
  assert.equal(afterFirst.state, 'in_progress')
  assert.deepEqual(afterFirst.answered, ['q1'])
  assert.equal(nextQuestionId(afterFirst.answered), 'q2')
  assert.equal(shouldStartOnboarding('in_progress'), true, '答了一半也要接着问')

  // ③ 五问收齐 -> done（nextQuestionId = null：不该再弹了）
  let progress = afterFirst
  for (const id of ['q2', 'q3', 'q4', 'q5'] as const) progress = recordAnswer(progress, id)
  assert.equal(progress.state, 'done')
  assert.equal(nextQuestionId(progress.answered), null)
  assert.equal(isFinished('done'), true)

  // ④ ★★ 历史 skipped 收到回答 -> 回到 in_progress（跳过入口已删，skipped 只是没答完的一种）
  const resumed = recordAnswer({ state: 'skipped', answered: ['q1'] }, 'q2')
  assert.equal(resumed.state, 'in_progress', 'skipped 的学生再答一问就该接着问下去')
  assert.equal(resumed.answered.length, 2)
  // 而 done 之后的回答只是兜住，不改变状态
  const afterDone = recordAnswer({ state: 'done', answered: ['q1', 'q2', 'q3', 'q4', 'q5'] }, 'q1')
  assert.equal(afterDone.state, 'done')
})

test('G-I 反向对照：只有 done 不弹引导（skipped 也要续问到答完）', () => {
  for (const state of ['not_started', 'in_progress', 'skipped'] as const) {
    assert.equal(shouldStartOnboarding(state), true, state + ' 属于「没答完」，必须继续问')
    assert.equal(isGuidedState(state), true)
  }
  assert.equal(shouldStartOnboarding('done'), false, 'done 是唯一终态')
  assert.equal(isGuidedState('done'), false)
  assert.equal(isFinished('done'), true)
  // ★ 判据里没有会话维度：函数只吃一个参数（「新会话」不构成再弹的理由）
  assert.equal(shouldStartOnboarding.length, 1, 'shouldStartOnboarding 只该有状态这一个入参')
})

test('G-I 重答是覆盖（不追加）与脏值收敛', () => {
  const once = recordAnswer({ state: 'not_started', answered: [] }, 'q3')
  const twice = recordAnswer(once, 'q3')
  assert.deepEqual(twice.answered, ['q3'], '重答同一问不该出现两条记录')
  const done = recordAnswer({ state: 'done', answered: ['q1', 'q2', 'q3', 'q4', 'q5'] }, 'q1')
  assert.equal(done.state, 'done')
  const dirty = selectProgress({ state: 'weird', answered: ['q1', 'q9', 42, 'q1'] })
  assert.equal(dirty.state, 'not_started')
  assert.deepEqual(dirty.answered, ['q1'])
  assert.equal(readQuestionId('q9'), null)
  assert.equal(readQuestionId('q2'), 'q2')
})

/* ------------------------------------------------------------------ *
 * G-PII 脱敏（5 个真实句子 + 反向对照）
 * ------------------------------------------------------------------ */

test('G-PII 五个真实句子：命中就整条丢弃并回落「同学」', () => {
  const cases: Array<{ sentence: string; pattern: string }> = [
    { sentence: '我叫小明，今年上五年级', pattern: '自我介绍（我叫…）' },
    { sentence: '我在阳光小学读四年级', pattern: '学校名' },
    { sentence: '我是五年级二班的', pattern: '班级（X 班）' },
    { sentence: '我的电话是13800138000，随时找我', pattern: '手机号' },
    { sentence: '我的身份证是110101201001011234', pattern: '身份证样式' }
  ]
  for (const item of cases) {
    const outcome = sanitizeStudentText(item.sentence)
    assert.equal(outcome.hit, true, '这句应当命中：' + item.sentence)
    assert.equal(outcome.pattern, item.pattern, '命中的模式名要对上：' + item.sentence)
    assert.equal(outcome.text, STUDENT_FALLBACK_NAME, '命中就整条丢弃并回落「同学」')
  }
})

test('G-PII 反向对照：五年级不遮（它是抽 grade_band 的原料）', () => {
  const keep = ['我五年级，喜欢恐龙', '我上小学三年级', '我在上小学', '六年级，想学编程']
  for (const sentence of keep) {
    const outcome = sanitizeStudentText(sentence)
    assert.equal(outcome.hit, false, '这句不该被遮：' + sentence)
    assert.equal(outcome.text, sentence)
  }
  assert.deepEqual(sanitizeStudentText(''), { text: '', hit: false, pattern: null })
  assert.deepEqual(sanitizeStudentText(undefined), { text: '', hit: false, pattern: null })
  assert.equal(safeDisplayName(''), STUDENT_FALLBACK_NAME)
  assert.equal(safeDisplayName('我叫小明'), STUDENT_FALLBACK_NAME)
  assert.equal(safeDisplayName('小W'), '小W')
  assert.equal(isFallbackName(STUDENT_FALLBACK_NAME), true)
  assert.equal(isFallbackName('小W'), false)
})

/* ------------------------------------------------------------------ *
 * G-EX 本地抽取（MVP 标签，一个 LLM 调用都不需要）
 * ------------------------------------------------------------------ */

test('G-EX Q1：点选直达映射 + 年级词表（读不出就不猜）', () => {
  assert.equal(extractAnswer('q1', '小学高年级').gradeLevel, 'primary_high')
  assert.equal(extractAnswer('q1', '小学低年级').gradeLevel, 'primary_low')
  assert.equal(extractAnswer('q1', '初中').gradeLevel, 'junior')
  assert.equal(extractAnswer('q1', '高中').gradeLevel, 'senior')
  assert.equal(extractAnswer('q1', '我上五年级').gradeLevel, 'primary_high')
  assert.equal(extractAnswer('q1', '我初一').gradeLevel, 'junior')
  assert.equal(extractAnswer('q1', '我上高一').gradeLevel, 'senior')
  assert.equal(extractAnswer('q1', '我在上小学').gradeLevel, null)
  assert.equal(gradeLevelFromText(''), null)
  assert.deepEqual(extractAnswer('q1', '小学高年级').tags, [])
})

test('G-EX Q2/Q3/Q4：点选与关键词表都映射到白名单标签', () => {
  const study = extractAnswer('q2', '最近在学分数，想搞懂约分')
  assert.equal(study.tags.find((tag) => tag.key === 'subject')?.value, '数学')
  assert.ok(study.tags.some((tag) => tag.key === 'current_topic'), '自由回答应当留下 current_topic')
  assert.equal(extractAnswer('q2', '数学').tags.filter((tag) => tag.key === 'current_topic').length, 0)

  const explain = extractAnswer('q3', '一步一步慢慢推')
  assert.equal(explain.tags.find((tag) => tag.key === 'explain_style')?.value, '逐步推导')
  assert.equal(explain.tags.find((tag) => tag.key === 'pace')?.value, '慢')
  assert.equal(explain.tags.find((tag) => tag.key === 'practice_type')?.value, '分步练习')
  assert.equal(extractAnswer('q3', '先给结论再讲').tags[0]?.source, 'declared')
  const free = extractAnswer('q3', '多讲点生活里的例子，越短越好')
  assert.ok((free.tags[0]?.confidence ?? 1) < 1, '关键词表映射的置信度要低于点选')

  assert.equal(extractAnswer('q4', '快一点').tags[0]?.value, '快')
  assert.equal(extractAnswer('q4', '慢一点').tags[0]?.value, '慢')
  assert.equal(extractAnswer('q4', '正常').tags[0]?.value, '正常')
  assert.deepEqual(extractAnswer('q4', '不知道').tags, [])
})

test('G-EX Q5：抽兴趣标签、**不再产称呼**（称呼归账号门在建号 / 改名时写）', () => {
  const interest = extractAnswer('q5', '喜欢拼乐高和看星星')
  assert.equal(interest.tags[0]?.key, 'interest_topic')
  assert.equal(interest.tags[0]?.value, '喜欢拼乐高和看星星')
  assert.equal(interest.tags[0]?.source, 'declared')
  assert.deepEqual(extractAnswer('q5', '好').tags, [], '太短不成线索（不硬凑）')
  const hit = extractAnswer('q5', '我叫小明')
  assert.equal(hit.piiHit, true, '敏感模式照样整条丢弃')
  assert.deepEqual(hit.tags, [], '命中即不产任何标签（连兴趣也不写）')
})

test('G-EX ★★ 答完五问不写身份：real_name 只由账号门在建号 / 改名时写（q5 不再覆盖它）', async () => {
  const { service, wire } = await startedService()
  for (const [questionId, answerText] of FIVE_ANSWERS) {
    await service.answer(questionId, answerText)
  }
  await service.dispose()
  const identityWrites = wire.calls.filter(
    (call) => call.path === IDENTITY_PATH && call.method !== 'GET'
  )
  assert.equal(
    identityWrites.length,
    0,
    '五问全程不得写 identity（旧实现是 q5 把爱好当称呼覆盖 real_name）'
  )
})

test('G-EX 白名单纵深：所有抽出的 key 都是模型可见的；命中的回答一条标签都不产生', () => {
  const all = [
    extractAnswer('q2', '数学和科学'),
    extractAnswer('q3', '多举生活里的例子'),
    extractAnswer('q3', '亲切一点'),
    extractAnswer('q4', '快一点')
  ].flatMap((item) => item.tags)
  assert.ok(all.length > 0)
  for (const tag of all) assert.equal(isLlmVisibleTag(tag.key), true, tag.key + ' 不在白名单里')
  const dirty = extractAnswer('q2', '我叫小明，在阳光小学二班学数学')
  assert.equal(dirty.piiHit, true)
  assert.deepEqual(dirty.tags, [])
})

test('G-EX 既有数据源的整理：情绪值域是有限枚举，强度夹到 0–3', () => {
  assert.equal(normalizeEmotion('frustrated'), 'frustrated')
  assert.equal(normalizeEmotion('抑郁'), null, '临床词汇一律不准进库（禁做 12）')
  assert.equal(normalizeIntensity(9), 3)
  assert.equal(normalizeIntensity(-2), 0)
  assert.equal(normalizeIntensity('abc'), null)
})

/* ------------------------------------------------------------------ *
 * G-PR 引导模式 prompt
 * ------------------------------------------------------------------ */

test('G-PR 引导 prompt：占位符、进度、四段保留、真名绝不进正文', () => {
  const prompt = buildOnboardingSystemPrompt({ askedCount: 0, displayName: STUDENT_FALLBACK_NAME })
  assert.ok(prompt.includes('{{student_name}}'), '称呼必须走占位符')
  assert.ok(prompt.includes('不许提问'), '输出纪律在（引导期的问题归界面）')
  assert.ok(prompt.includes('情绪'), '闲聊与情绪段在')
  assert.ok(prompt.includes('不硬拽'), '不硬拽段在')
  assert.ok(prompt.includes('隐私挡话'), '隐私挡话段在')

  // ★★ 真名绝不进 prompt：只知道「知不知道称呼」，不知道叫什么
  const named = buildOnboardingSystemPrompt({ askedCount: 5, displayName: '小明' })
  assert.equal(named.includes('小明'), false, '真名绝不许出现在任何 prompt 里')
  assert.ok(named.includes('{{student_name}}'))
  assert.ok(named.includes('五个问题都已经答完了'))
})

test('G-PR ★★ 问句不由模型问：五问文本一条都不许进引导 prompt（界面是唯一提问者）', () => {
  // 票 31 决策④：问句由界面以助手消息展示；模型只负责接住回答。
  // 两边都问 = 学生看到同一个问题被问两次（界面一次、模型一次）。
  for (const asked of [0, 1, 3, 4]) {
    const prompt = buildOnboardingSystemPrompt({ askedCount: asked, displayName: STUDENT_FALLBACK_NAME })
    for (const question of ONBOARDING_QUESTIONS) {
      assert.equal(
        prompt.includes(question.text),
        false,
        '问句「' + question.text + '」不该出现在 prompt 里（askedCount=' + String(asked) + '）'
      )
    }
  }
})

test('G-PR 禁做清单 13/14：情绪操控与依赖诱导的话术一个都不出现', () => {
  for (const asked of [0, 2, 5]) {
    const prompt = buildOnboardingSystemPrompt({ askedCount: asked, displayName: STUDENT_FALLBACK_NAME })
    for (const phrase of ['你要开心一点', '别说难过', '只有我懂你', '别去问老师', '一直陪着你']) {
      assert.equal(prompt.includes(phrase), false, 'prompt 里出现了禁用语：' + phrase)
    }
    for (const grade of ['小学低年级', '小学高年级', '初中', '高中']) {
      assert.equal(prompt.includes(grade), false, '引导 prompt 不该出现学段：' + grade)
    }
  }
})

test('G-PR 引导期答问纪律：先正面回答；不说推后话、不描述系统与呈现方式', () => {
  // 2026-10-01 真机事故：学生问了一个学习问题，模型把回答往后推；同一轮还向学生承诺了
  // 产品并不存在的操作入口，并解释了界面自己的呈现方式。两条纪律都写成正向要求。
  for (const asked of [0, 3, 5]) {
    const prompt = buildOnboardingSystemPrompt({ askedCount: asked, displayName: STUDENT_FALLBACK_NAME })
    assert.ok(
      prompt.includes('先用一两句话正面回答'),
      '必须要求先正面回答学习问题（askedCount=' + String(asked) + '）'
    )
    assert.ok(prompt.includes('他的问题优先于流程'), '必须写明学生的问题优先于流程')
    assert.ok(prompt.includes('你怎么运作'), '必须把「系统怎么运作 / 接下来怎样」划出话题外')
    // 反向：这些措辞一个都不许出现 —— 模型会照着 prompt 里的说法讲给学生
    for (const phrase of ['跳过', '略过', '等会儿再讲', '先把问题答完', '一条条冒出来']) {
      assert.equal(
        prompt.includes(phrase),
        false,
        'prompt 里出现了会被模型照说的推后 / 界面话术：' + phrase
      )
    }
  }
})

test('G-PR 关掉三块的说明可判定（onboardingGuardNotes）', () => {
  const notes = onboardingGuardNotes()
  assert.equal(notes.length, 3)
  assert.ok(notes.some((line) => line.includes('学段权威段')))
  assert.ok(notes.some((line) => line.includes('工具')))
  assert.ok(notes.some((line) => line.includes('画像块')))
})

/* ------------------------------------------------------------------ *
 * G-IPC 通道纪律（五问绝不混进 chat:send）
 * ------------------------------------------------------------------ */

test('G-IPC 五问走独立通道；只有 onboarding:changed 是推送', () => {
  assert.notEqual(IPC.onboardingAnswer, IPC.chatSend)
  assert.equal(PUSH_CHANNELS.includes(IPC.onboardingChanged), true)
  const invokes = [
    IPC.onboardingState,
    IPC.onboardingAnswer,
    IPC.profileTags,
    IPC.profileTagRetract,
    IPC.identityRead,
    IPC.identityFlagsSet
  ]
  for (const channel of invokes) {
    assert.equal(PUSH_CHANNELS.includes(channel), false, channel + ' 是 invoke，不许进 PUSH_CHANNELS')
  }
})

test('G-IPC ChatSendRequest 的字段集合仍然恰好是 [text]（G6c 不许红）', () => {
  const source = readFileSync(join(desktopRoot, 'src', 'main', 'ipc', 'channels.ts'), 'utf8')
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.startsWith('export interface ChatSendRequest {'))
  assert.ok(start >= 0, 'channels.ts 里找不到 ChatSendRequest')
  const fields: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('}')) break
    const matched = /^  ([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
    if (matched) fields.push(matched[1])
  }
  assert.deepEqual(fields, ['text'])
})

/* ------------------------------------------------------------------ *
 * G-J fire-and-forget（永不 resolve 的概括桩 + 真实请求体）
 * ------------------------------------------------------------------ */

test('G-J 概括桩永不 resolve：answer() 立刻回执、状态立刻终态、队列不被拖死', async () => {
  // 用一个对象装回调（而不是裸的 let）：赋值发生在桩的内部，TS 的流程分析看不到它，
  // 裸 let 会在调用点被窄化成 null/never（实测报 TS2349）。
  const gate: { release: (() => void) | null } = { release: null }
  let summarizeCalls = 0
  const { service } = await startedService({
    summarize: () => {
      summarizeCalls += 1
      return new Promise((resolvePromise) => {
        gate.release = () => resolvePromise({ ok: true, degraded: false, reason: '', tags: [] })
      })
    }
  })

  assert.equal(service.snapshot().active, true)
  assert.equal(service.snapshot().nextQuestionId, 'q1')

  for (const [questionId, answerText] of FIVE_ANSWERS) {
    const receipt = await withTimeout(service.answer(questionId, answerText), 300, 'answer(' + questionId + ')')
    assert.equal(receipt.accepted, true)
  }

  // ★★ 界面已经拿到终态：引导结束、不再有下一问 —— 而概括还挂着（这就是 fire-and-forget）
  assert.equal(service.snapshot().state, 'done')
  assert.equal(service.snapshot().active, false)
  assert.equal(service.snapshot().nextQuestionId, null)
  const afterDone = await service.answer('q5', '再答一次')
  assert.equal(afterDone.accepted, false)
  assert.ok(afterDone.message.includes('不在引导流程里'))

  // 等队列跑到概括那一步（它挂着不返回）
  for (let index = 0; index < 200 && service.snapshot().summary !== 'pending'; index += 1) {
    await new Promise((tick) => setTimeout(tick, 5))
  }
  assert.equal(service.snapshot().summary, 'pending', '概括应当已经开跑且挂着')
  assert.equal(summarizeCalls, 1, '永不 resolve 的桩只该被调一次（不是重试风暴）')

  gate.release?.()
  await withTimeout(service.dispose(), 3000, 'dispose()')
  assert.equal(service.snapshot().summary, 'ok')
})

test('G-J 概括失败只自动重试 1 次，仍失败走降级（degraded）且引导照常结束', async () => {
  let attempts = 0
  const { service } = await startedService({
    summarize: async () => {
      attempts += 1
      return { ok: false, degraded: true, reason: '桩：通道不可用', tags: [] }
    }
  })
  for (const [questionId, answerText] of FIVE_ANSWERS) {
    assert.equal((await service.answer(questionId, answerText)).accepted, true)
  }
  await withTimeout(service.dispose(), 3000, 'dispose()')
  assert.equal(attempts, 2, '只允许自动重试 1 次（共 2 次尝试）')
  assert.equal(service.snapshot().summary, 'degraded')
  assert.equal(service.snapshot().state, 'done', '降级不影响引导走完')
})

test('G-J 请求体实况：Q1 走 grade:set 那条链；回答走独立端点；没有 studentId', async () => {
  const { service, applied, wire } = await startedService()
  for (const [questionId, answerText] of FIVE_ANSWERS) {
    await service.answer(questionId, answerText)
  }
  await withTimeout(service.dispose(), 3000, 'dispose()')

  // ① Q1 点选直达 -> applyGradeBand（由 handlers.ts 注入，走既有 grade:set 链）
  assert.deepEqual(applied, ['primary_high'])

  // ② 五问各发一次 answer 请求，问题 id 与答案原样送达；**没有 studentId**
  const answerCalls = wire.calls.filter((call) => call.path.endsWith('/answer'))
  assert.equal(answerCalls.length, 5)
  const firstBody = jsonBody(answerCalls[0])
  assert.equal(firstBody.questionId, 'q1')
  assert.equal(firstBody.answerText, '小学高年级')
  assert.equal('studentId' in firstBody, false, '请求体里绝不能有 studentId')
  assert.equal('student_id' in firstBody, false)

  // ③ 标签逐条 PUT（Q3 的一条：讲法）
  const styleCall = wire.calls.find((call) => call.path.endsWith('/tags/explain_style'))
  assert.ok(styleCall, 'Q3 的讲法应当被写成标签：' + wire.calls.map((call) => call.path).join(','))
  const styleBody = jsonBody(styleCall)
  assert.equal(styleBody.value, '逐步推导')
  assert.equal(styleBody.source, 'declared')
})

test('G-G 两道闸：parentConsent=false 时一个标签都不写（但回答照常落库）', async () => {
  const wire = makeWire()
  wire.reply(STATE_PATH, { onboardingState: 'not_started', answered: [], displayName: '' })
  wire.reply(IDENTITY_PATH, {
    anonStudentId: 'student_001',
    realName: '',
    displayName: STUDENT_FALLBACK_NAME,
    parentConsent: false,
    memorySwitch: true,
    onboardingState: 'not_started'
  })
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    log: () => {}
  })
  await service.start()
  await service.answer('q3', '一步一步慢慢推')
  await withTimeout(service.dispose(), 3000, 'dispose()')
  assert.equal(wire.calls.filter((call) => call.method === 'PUT').length, 0, '不同意就不外发任何画像')
  assert.equal(wire.calls.filter((call) => call.path.endsWith('/answer')).length, 1, '回答本身照常落库')
})

test('G-I start()：只有 done 不续问；in_progress / skipped 都要把没答完的问出来', async () => {
  // ★ 票 31：没答完就续问（跨重启也续）。下一问由服务端状态推导，主进程不猜。
  for (const state of ['in_progress', 'skipped'] as const) {
    const wire = makeWire()
    wire.reply(STATE_PATH, { onboardingState: state, answered: ['q1'], displayName: '小W' })
    wire.reply(IDENTITY_PATH, { parentConsent: true, memorySwitch: true })
    const service = createOnboardingService({
      studentId: () => 'student_001',
      transport: wire.transport,
      log: () => {}
    })
    const payload = await service.start()
    assert.equal(service.snapshot().active, true, state + ' 属于没答完，必须继续问')
    assert.equal(payload.nextQuestionId, 'q2', '下一问按 q1..q5 顺序跳过已答的那一问')
  }

  const wire = makeWire()
  wire.reply(STATE_PATH, { onboardingState: 'done', answered: ['q1'], displayName: '小W' })
  wire.reply(IDENTITY_PATH, { parentConsent: true, memorySwitch: true })
  const done = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    log: () => {}
  })
  const payload = await done.start()
  assert.equal(done.snapshot().active, false, 'done 是唯一终态')
  assert.equal(payload.nextQuestionId, null)
})

/* ------------------------------------------------------------------ *
 * G-J 真概括器（票 31：subagent 概括接上之后的边界）
 *   ★ 这些断言盯的是「出网那条边」：拿不到配置不发请求、displayName 绝不外出、
 *     404 试变体、脏值逐条丢 —— 概括准不准不是守卫能管的事，边界可以。
 * ------------------------------------------------------------------ */

const SUMMARY_ANSWERS: Array<{ questionId: 'q1' | 'q2' | 'q3' | 'q4' | 'q5'; text: string }> = [
  { questionId: 'q2', text: '最近在学分数' },
  { questionId: 'q5', text: '小W' }
]
const SUMMARY_INPUT = {
  answers: SUMMARY_ANSWERS,
  tags: [{ key: 'subject' as const, value: '数学', source: 'declared' as const, confidence: 1 }],
  displayName: '小明'
}

test('G-J 真概括器：拿不到模型配置就走降级，且**一个字节都不外发**', async () => {
  let sent = 0
  const summarize = createLlmSummarizer({
    getConfig: async () => null,
    fetchResponse: async () => {
      sent += 1
      return new Response('{}', { status: 200 })
    }
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.degraded, true)
  assert.match(outcome.reason, /模型配置/, '降级理由要能读')
  assert.equal(sent, 0, '没配置就不该发任何请求')
})

test('G-J 真概括器：没填 Key 也走降级（不外发）', async () => {
  let sent = 0
  const summarize = createLlmSummarizer({
    getConfig: async () => ({ baseUrl: 'https://api.example.com/v1', modelId: 'm1', apiKey: '' }),
    fetchResponse: async () => {
      sent += 1
      return new Response('{}', { status: 200 })
    }
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, false)
  assert.equal(sent, 0)
})

test('G-J ★★ 真概括器：只发脱敏答案与候选标签 —— displayName / Key 都不出网', async () => {
  const seen: Array<{ url: string; body: string }> = []
  const summarize = createLlmSummarizer({
    getConfig: async () => ({ baseUrl: 'https://api.example.com/v1', modelId: 'm1', apiKey: 'sk-test' }),
    fetchResponse: async (url: string, init: RequestInit) => {
      seen.push({ url, body: typeof init.body === 'string' ? init.body : '' })
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"tags":[{"key":"interest_topic","value":"恐龙","confidence":0.8}]}'
              }
            }
          ]
        }),
        { status: 200 }
      )
    }
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.tags.length, 1)
  assert.equal(outcome.tags[0]?.key, 'interest_topic')
  assert.equal(outcome.tags[0]?.source, 'declared', '概括产出的是学生自己说过的，不是 inferred')
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'https://api.example.com/v1/chat/completions')
  const body = String(seen[0]?.body)
  assert.ok(body.includes('分数'), '脱敏后的回答要送过去（否则无从概括）')
  assert.equal(body.includes('小明'), false, 'displayName 绝不出网（真名的替身也不行）')
  assert.equal(body.includes('sk-test'), false, 'Key 只进 header，不进请求体')
})

test('G-J 真概括器：404 时试一次 /v1 变体写法（与 Python 探测同一口径）', async () => {
  const urls: string[] = []
  const summarize = createLlmSummarizer({
    getConfig: async () => ({ baseUrl: 'https://api.example.com', modelId: 'm1', apiKey: 'sk' }),
    fetchResponse: async (url: string) => {
      urls.push(url)
      if (urls.length === 1) return new Response('not found', { status: 404 })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"tags":[]}' } }] }), { status: 200 })
    }
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, true)
  assert.deepEqual(urls, [
    'https://api.example.com/chat/completions',
    'https://api.example.com/v1/chat/completions'
  ])
})

test('G-J 真概括器：非 2xx 走降级，错误里**不带回执正文**（那里面有学生的回答）', async () => {
  const summarize = createLlmSummarizer({
    getConfig: async () => ({ baseUrl: 'https://api.example.com/v1', modelId: 'm1', apiKey: 'sk' }),
    fetchResponse: async () => new Response('{"error":"bad key: sk-xxx 数学"}', { status: 401 })
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.degraded, true)
  assert.match(outcome.reason, /HTTP 401/)
  assert.equal(outcome.reason.includes('sk-xxx'), false, '回执正文不许被带进日志')
})

test('G-J 概括回执：脏值逐条丢弃（key 不在清单 / value 为空 / 置信度越界夹回）', () => {
  const tags = parseSummaryTags(
    '```json\n{"tags":[{"key":"school","value":"阳光小学"},{"key":"subject","value":""},' +
      '{"key":"subject","value":"数学","confidence":9},{"key":"tone","value":"亲切"}]}\n```'
  )
  assert.equal(tags.length, 2, 'school 不在允许清单、value 为空的两条要丢掉')
  assert.equal(tags[0]?.key, 'subject')
  assert.equal(tags[0]?.confidence, 1, '置信度夹到 0–1')
  assert.equal(tags[1]?.key, 'tone')
  assert.deepEqual(parseSummaryTags('不是 JSON'), [])
  assert.deepEqual(parseSummaryTags(''), [])
  assert.deepEqual(parseSummaryTags('{}'), [])
})

/* ------------------------------------------------------------------ *
 * G-J / A2：概括在「判断画像」之前，先把「问—答」配齐（2026-09-29 用户裁决）
 *   ★ 这一组盯的是 A2 的**输入完整性**：只给答案，模型就不知道那句话在答什么；
 *     带上问句原文，它才能把同一句话归到正确的画像维度上。
 *   ★ 同时必须钉住：这不是「让模型更懂学生」——问句是**学生已经看见的公开脚本**，
 *     带它出网不泄露任何新信息；真名（displayName）仍然一个字节都不许出网。
 * ------------------------------------------------------------------ */

test('G-J/A2 问句原文：由 questionId 从唯一脚本查出，查不到给空串（不崩）', () => {
  for (const question of ONBOARDING_QUESTIONS) {
    assert.equal(
      summaryQuestionText(question.id),
      question.text,
      '问句原文必须复用 shared/profile-tags 的唯一脚本：' + question.id
    )
  }
  assert.equal(summaryQuestionText('q404'), '', '查不到的 id 给空串，而不是抛异常')
})

test('G-J/A2 概括载荷：每条答案**配对**带上问句原文（问—答成对，模型才知道在答什么）', () => {
  const { system, user } = buildSummaryPayload(SUMMARY_INPUT)
  // ② 输入侧：每条 answer 的问句原文都随之出现
  const study = summaryQuestionText('q2')
  const name = summaryQuestionText('q5')
  assert.ok(study.length > 0 && name.length > 0, '两条用到的问句都要能查到原文')
  assert.ok(user.includes(study), 'q2 的问句原文要随答案一起发（否则「分数」是在答什么无从判断）')
  assert.ok(user.includes(name), 'q5 的问句原文也要发')
  // 答案本身当然要在
  assert.ok(user.includes('最近在学分数'))
  // ① 出网边界不放松：displayName 仍绝不出现，Key 也不在载荷里
  assert.equal(user.includes('小明'), false, 'displayName 依旧绝不出网')
  assert.equal(system.includes('小明'), false, 'displayName 也不许进 system')
})

test('G-J/A2 概括 system：A2 扩了「判断画像」的维度，但**明令禁止推断心理/性格**', () => {
  const { system } = buildSummaryPayload(SUMMARY_INPUT)
  // A2 覆盖面变大：从「提炼标签」扩到「整理画像维度」
  assert.ok(system.includes('画像'), 'system 要说明任务是整理画像（A2 的职责扩大）')
  // 但禁做清单第 10~14 条的边界必须**写进可执行文本**（不是只写在注释里）
  // ★ 2026-09-30 口径改写（红线最小移动）：性格一维放开（值限词表），
  //   心理状态 / 家庭情况 / 智能水平三条仍禁。
  assert.match(
    system,
    /不要推断学生的心理状态、家庭情况或智能水平/,
    'system 必须显式禁止推断心理状态/家庭/智能水平'
  )
  assert.match(system, /心理/, 'system 必须显式提及并禁止心理判断')
  assert.ok(
    system.includes('学生**自己说过') || system.includes('自己说过'),
    'system 必须把「判断」限定在「学生自己说过的内容」上'
  )
})

test('G-J/A2 概括载荷：问句原文的引入不改变出网纪律（仍只有答案 + 问句，无身份字段）', async () => {
  const seen: Array<{ url: string; body: string }> = []
  const summarize = createLlmSummarizer({
    getConfig: async () => ({ baseUrl: 'https://api.example.com/v1', modelId: 'm1', apiKey: 'sk-test' }),
    fetchResponse: async (url: string, init: RequestInit) => {
      seen.push({ url, body: typeof init.body === 'string' ? init.body : '' })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"tags":[]}' } }] }), { status: 200 })
    }
  })
  const outcome = await summarize(SUMMARY_INPUT)
  assert.equal(outcome.ok, true)
  const body = String(seen[0]?.body)
  // 问句原文进了请求体（A2 的可见效果）……
  assert.ok(body.includes(summaryQuestionText('q2')), '问句原文要真的发出去（否则 A2 只是注释）')
  // ……但身份/密钥一个字都没多
  for (const forbidden of ['小明', 'sk-test', 'real_name', 'school']) {
    assert.equal(body.includes(forbidden), false, '出网载荷不许出现：' + forbidden)
  }
})

/* ------------------------------------------------------------------ *
 * A2+（2026-09-29）：画像更丰富 —— 逐维点名 + 上限提到 12
 * ------------------------------------------------------------------ */

test('G-J/A2+ 概括 system：逐维点名（互动偏好 / 场景目标 / 安全边界都要出现）', () => {
  const { system } = buildSummaryPayload(SUMMARY_INPUT)
  // 原写法只点了学科/兴趣/讲法/节奏/鼓励/练习六类，模型就只往这六类归。
  // A2+ 要求把**每个白名单维度**的名字或键点出来（用键最稳，不怕措辞漂）。
  for (const key of [
    'explain_style',
    'pace',
    'practice_type',
    'interest_topic',
    'tone',
    'encouragement_freq',
    'challenge_level',
    'scene',
    'task_goal',
    'boundary_topics'
  ]) {
    assert.ok(system.includes(key), 'system 要逐维点名，缺了：' + key)
  }
  // 「逐维找」不等于「凑数」：必须留着「没说就跳过」这条反向约束。
  assert.match(system, /跳过|没说|没说过/, 'system 要明说「学生没说就跳过」，防止为填满而编')
})

test('G-J/A2+ 上限：单次最多 12 条（8 会在偏好维上就被截断）', () => {
  // 直接断言可执行常量的值：改小回 8 会让「画像更丰富」这个目标当场落空。
  assert.equal(ONBOARDING_SUMMARY_MAX_TAGS, 12, 'A2+ 把上限提到 12')
  // 上限不得大于「可产出的 key 数」——否则等于没有上限（12 << 21，安全）。
  assert.ok(
    ONBOARDING_SUMMARY_MAX_TAGS <= ONBOARDING_SUMMARY_ALLOWED_KEYS.length,
    '上限不能超过允许输出的 key 数'
  )
})

test('G-J/A2+ 白名单没动：可产出 key 集合与 A2 时逐字相同（只放宽 prompt，不放宽边界）', () => {
  // 这是 A2+ 的**安全断言**：丰富画像靠的是「告诉模型还有哪些维度可归」，
  // 绝不是「把白名单放宽」。key 集合必须仍等于「白名单 - join 钥匙 - 三个情绪键」。
  const expected = LLM_VISIBLE_TAGS.filter(
    (key) => key !== 'anon_student_id' && !EPHEMERAL_TAG_SET.has(key)
  )
  assert.deepEqual(
    [...ONBOARDING_SUMMARY_ALLOWED_KEYS],
    [...expected],
    '可产出 key 集合必须仍由白名单派生（白名单一个字都没动）'
  )
  // 三个短期情绪键仍不许由概括产出（它们由系统观察写、带 TTL）。
  for (const ephemeral of ['emotion', 'intensity', 'trigger']) {
    assert.equal(
      ONBOARDING_SUMMARY_ALLOWED_KEYS.includes(ephemeral),
      false,
      '短期情绪键不许由概括产出：' + ephemeral
    )
  }
})

test('G-J/A2+ 心理禁推断纪律仍在（丰富画像 ≠ 放开推断权限）', () => {
  const { system } = buildSummaryPayload(SUMMARY_INPUT)
  // ★ 2026-09-30 口径改写：性格一维按最小移动原则放开（值限封闭词表），
  //   三禁令（心理状态 / 家庭情况 / 智能水平）必须原样在。
  assert.match(
    system,
    /不要推断学生的心理状态、家庭情况或智能水平/,
    'A2+ 不得删掉三禁令那条（G-M-7 改写后口径）'
  )
  assert.match(system, /心理/, 'A2+ 不得删掉禁心理判断那条')
  assert.match(system, /不要输出真名/, '身份脱敏纪律仍在')
})

/* ------------------------------------------------------------------ *
 * 画像标签的读 / 撤销（白名单纵深）
 * ------------------------------------------------------------------ */

test('标签读回：不在白名单的 key 一个都不返回（出栈再过滤）', async () => {
  const wire = makeWire()
  wire.reply('/api/profile/student_001/tags', {
    tags: [
      { key: 'grade_band', value: 'primary_high', confidence: 0.9, source: 'declared', ts: 1, dimension: 2, label: '学段' },
      { key: 'school', value: '阳光小学', confidence: 1, source: 'declared', ts: 1, dimension: 1, label: '学校' }
    ],
    parentConsent: true,
    memorySwitch: true
  })
  const payload = await fetchProfileTags('student_001', wire.transport)
  // ★ 生成的 ProfileTagsOut 里 tags 是可选字段（契约如此），消费方自己兜空数组
  const tags = payload.tags ?? []
  assert.equal(tags.length, 1)
  assert.equal(tags[0]?.key, 'grade_band')
  assert.equal(tags[0]?.label, '学段')
})

test('标签撤销：不在白名单的 key 连请求都不发', async () => {
  const wire = makeWire()
  await assert.rejects(() => retractProfileTag('student_001', 'school', wire.transport))
  assert.equal(wire.calls.length, 0)
})

/* ------------------------------------------------------------------ *
 * W8 冷启动概括补跑（task-47）
 * ------------------------------------------------------------------ */

test('W8 ★ 补跑：degraded 后补跑一次；成功即幂等，不再打模型', async () => {
  const { service, wire } = await startedService({
    summarize: async () => ({ ok: false, degraded: true, reason: 'no-key', tags: [] })
  })
  wire.reply('/api/profile/student_001/tags', {})
  for (const [questionId, answerText] of FIVE_ANSWERS) {
    await service.answer(questionId, answerText)
  }
  await service.dispose()
  assert.equal(service.snapshot().summary, 'degraded', '没有可用模型时概括应当降级')

  // Key 就绪：换成真概括（同一条缝，调用侧一行不改）
  service.configure({
    summarize: async () => ({
      ok: true,
      degraded: false,
      reason: '',
      tags: [{ key: 'subject', value: '数学', source: 'declared', confidence: 0.6 }]
    })
  })
  const first = await service.retrySummary()
  assert.equal(first.ran, true, 'degraded 时应当补跑')
  assert.equal(service.snapshot().summary, 'ok', '补跑成功置 ok')
  const second = await service.retrySummary()
  assert.equal(second.ran, false, '已经 ok → 幂等，不再打模型')
  assert.match(second.reason, /已经概括过/)
})

test('W8 ★ 补跑：拿不到五问问答时**跳过**（绝不拿空素材打模型）', async () => {
  const wire = makeWire()
  wire.reply(STATE_PATH, {
    onboardingState: 'done',
    answered: ['q1', 'q2', 'q3', 'q4', 'q5'],
    displayName: ''
  })
  wire.reply(IDENTITY_PATH, { parentConsent: true, memorySwitch: true })
  let called = 0
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    summarize: async () => {
      called += 1
      return { ok: true, degraded: false, reason: '', tags: [] }
    },
    log: () => {}
  })
  await service.start()
  const outcome = await service.retrySummary()
  assert.equal(outcome.ran, false)
  assert.match(outcome.reason, /拿不到/)
  assert.equal(called, 0, '拿不到问答就不该调模型')
})

test('W8 ★ 写侧纵深：summarize 注入了白名单外的 key → 一条 PUT 都不发', async () => {
  const wire = makeWire()
  wire.reply(STATE_PATH, {
    onboardingState: 'done',
    answered: ['q1', 'q2', 'q3', 'q4', 'q5'],
    displayName: ''
  })
  wire.reply(IDENTITY_PATH, { parentConsent: true, memorySwitch: true })
  // 绕过解析层直接注入一条脏 key：写入口必须自己兜住（纵深防御，与读侧对称）
  const dirtyTags = [
    { key: 'not_whitelisted', value: 'x', source: 'declared', confidence: 0.9 }
  ] as unknown as OnboardingTagWrite[]
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    loadAnswers: async () => [{ questionId: 'q1', text: '高中' }],
    summarize: async () => ({ ok: true, degraded: false, reason: '', tags: dirtyTags }),
    log: () => {}
  })
  await service.start()
  const outcome = await service.retrySummary()
  assert.equal(outcome.ran, true, '概括本身算成功')
  const writes = wire.calls.filter((call) => call.method === 'PUT')
  assert.equal(writes.length, 0, '白名单外的 key 不该产生任何写入（writeTags 自己复查）')
})

test('W8 ★ 补跑：从服务端回读问答 + 跨重启标记（成功一次后永不再跑）', async () => {
  let marked = false
  const seen: string[] = []
  const wire = makeWire()
  wire.reply(STATE_PATH, {
    onboardingState: 'done',
    answered: ['q1', 'q2', 'q3', 'q4', 'q5'],
    displayName: ''
  })
  wire.reply(IDENTITY_PATH, { parentConsent: true, memorySwitch: true })
  const service = createOnboardingService({
    studentId: () => 'student_001',
    transport: wire.transport,
    loadAnswers: async () => [
      { questionId: 'q1', text: '高中' },
      { questionId: 'q5', text: '喜欢拼乐高' },
      // 认不出的 id 整条丢掉（靠位置不靠解析）
      { questionId: 'q9', text: '脏数据' }
    ],
    summaryDone: () => marked,
    markSummaryDone: () => {
      marked = true
    },
    summarize: async (input) => {
      seen.push(input.answers.map((item) => item.text).join(','))
      return { ok: true, degraded: false, reason: '', tags: [] }
    },
    log: () => {}
  })
  await service.start()
  const first = await service.retrySummary()
  assert.equal(first.ran, true, '状态已 done + 有回读问答 → 应当补跑')
  assert.equal(seen.length, 1)
  assert.match(seen[0] ?? '', /高中/)
  assert.equal(seen[0]?.includes('脏数据'), false, '认不出的 questionId 不许进载荷')
  assert.equal(marked, true, '成功要落跨重启标记')
  const second = await service.retrySummary()
  assert.equal(second.ran, false, '跨重启标记为真 → 不再跑（别每次启动都打模型）')
})
