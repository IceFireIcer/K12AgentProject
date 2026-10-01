/**
 * 票 26 / 29 / 30 守卫：**画像标签的白名单投影**与它的四个消费点
 * （学段判定注入画像 / 引导模式 / 情绪定向 / 学段内难度微调）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 这一份盯住的是什么
 * ══════════════════════════════════════════════════════════════════════════
 * §0.6 的核心边界是**白名单投影**：模型只能看见 LLM_VISIBLE_TAGS 里的标签值。
 * 这类边界的失效形态全是「不报错、只静默变松」——多接一个字段、多渲染一行，
 * 没有人会立刻发现，直到某天模型冒出一句学生从没同意外传的信息。
 * 所以这里把六件事钉成机器判据：
 *
 *   PI-1  非白名单键（含本地身份列）**一个都进不来**；情绪/强度取值域非法一律丢
 *   PI-2  短期情绪过 TTL 读不到；且**不渲染任何时间/计数**（D-032 前缀缓存）
 *   PI-3  **同输入 → 逐字节相同**的段（输入顺序、ts 都不影响）；顺序按白名单声明序
 *   PI-4  每个标签**带来源与置信度**（铁律 2）；**L3 不许覆盖 L1**（铁律 1）
 *   PI-5  三类「怎么讲」的段：难度档回落、受挫倾向互斥、禁做 13/14 字面量断言
 *   PI-6  接线在**生产路径**上（judge 带 persona、引导分支、退出前 flush 引导）
 *
 * ⚠️ node --test 直跑 .ts 用的是类型擦除 —— **禁 parameter property**（AGENTS §8.1）。
 * ⚠️ 主进程模块里 value-import 了 '@shared/*'，别名只有打包器认；本文件顶部的解析钩子
 *    让裸 Node 也能动态 import 它们（与 tests/demo-seed.test.ts 同一套惯例）。
 *
 * 跑法：cd desktop && node --test tests/persona-injection.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      const file = join(DESKTOP, 'src', 'shared', specifier.slice('@shared/'.length) + '.ts')
      return nextResolve(pathToFileURL(file).href, context)
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return nextResolve(specifier + '.ts', context)
      }
      throw error
    }
  }
})

/** 读主进程源码（断言「源码里长什么样」时用）。 */
const read = (...segments: string[]): string => readFileSync(join(DESKTOP, ...segments), 'utf8')

/** 去掉注释（源码级判据只看**可执行文本**：注释里写纪律不算接线）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*$/gm, '$1')
}

/** 出现次数（needle 里有中文与括号，split 计数比正则直白）。 */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

const loadProfileBlock = () => import('../src/main/agent/prompts/profile-block.ts')
const loadAdaptation = () => import('../src/main/agent/prompts/adaptation.ts')
const loadRules = () => import('../src/main/agent/prompts/rules.ts')
const loadGrade = () => import('../src/main/agent/extensions/grade.ts')
const loadStudentContext = () => import('../src/main/agent/prompts/student-context.ts')
const loadGradeTable = () => import('../src/main/agent/prompts/grade.ts')
const loadShared = () => import('../src/shared/profile-tags.ts')

/** 固定的「现在」（不取 Date.now()：TTL 用例要可重复）。 */
const NOW = 1_800_000_000_000

/** 造一个后端形状的标签（宽松：source / confidence / ts 都可省）。 */
function tag(
  key: string,
  value: unknown,
  source: string | null = null,
  confidence: number | null = null,
  ts: number | null = null,
  label: string | null = null
) {
  return { key, value, source, confidence, ts, label }
}

/* ================================================================== *
 * PI-1 白名单是唯一的门
 * ================================================================== */

test('PI-1a 非白名单键一个都进不来：本地身份列 + 各类敏感字段全被丢掉', async () => {
  const { projectProfileTags } = await loadProfileBlock()
  const shared = await loadShared()

  const forbidden = [
    'real_name',
    'real_grade',
    'school',
    'class',
    'parent_consent',
    'memory_switch',
    'onboarding_state',
    // 禁做清单第 2–8 条：这些 key 连**存在**都不允许
    'family_income',
    'parent_job',
    'consumption',
    'ad_id',
    'precise_location',
    'social_graph'
  ]
  const projection = projectProfileTags({
    parentConsent: true,
    tags: [
      tag('grade_band', 'primary_high', 'declared'),
      tag('subject', '数学', 'declared'),
      ...forbidden.map((key) => tag(key, '不该出现', 'declared'))
    ]
  })

  const keys = projection.tags.map((item) => item.key)
  assert.deepEqual(keys, ['grade_band', 'subject'], '只有白名单里的两个键能留下')
  for (const item of projection.tags) {
    assert.ok(
      shared.LLM_VISIBLE_TAG_SET.has(item.key),
      '投影出来的每个 key 都必须在 LLM_VISIBLE_TAGS 里（这就是白名单本身）'
    )
  }
  // ★ 身份列（除 join 钥匙外）一条都不许出现 —— 与 G-B 同一个口径
  for (const field of shared.IDENTITY_LOCAL_FIELDS) {
    if (field === shared.JOIN_KEY) continue
    assert.ok(!(keys as readonly string[]).includes(field), '本地身份列不许出现在给模型的投影里：' + field)
  }
  // join 钥匙默认也不投影（它是随机串，对教学没有任何价值；需要时显式开 includeJoinKey）
  assert.ok(!keys.includes(shared.JOIN_KEY), 'anon_student_id 默认不投影（可显式开启）')
  const withJoin = projectProfileTags(
    { parentConsent: true, tags: [tag(shared.JOIN_KEY, 'anon-1', 'declared')] },
    { includeJoinKey: true }
  )
  assert.deepEqual(withJoin.tags.map((item) => item.key), [shared.JOIN_KEY], '显式开启时才投影 join 钥匙')
})

test('PI-1b 禁做 12：情绪取值域是有限枚举、强度必须在 0–3，非法值丢整条', async () => {
  const { projectProfileTags } = await loadProfileBlock()
  const shared = await loadShared()

  const projection = projectProfileTags({
    parentConsent: true,
    tags: [
      tag('emotion', '抑郁', 'inferred', 0.9), // 临床词汇 → 丢
      tag('emotion', 'frustrated', 'observed', 0.8),
      tag('intensity', '7', 'observed', 0.9), // 越界 → 丢
      tag('intensity', '2', 'observed', 0.7),
      tag('zpd_level', '1', 'observed', 0.6)
    ]
  })
  const byKey = new Map(projection.tags.map((item) => [item.key, item]))
  assert.equal(byKey.get('emotion')?.value, 'frustrated', '临床词汇被丢掉，合法枚举值保留')
  assert.equal(byKey.get('intensity')?.value, '2', '越界强度被丢掉，0–3 内的整数保留')

  // 反向对照：枚举里的每个取值都必须被接受（否则这条断言是空壳）
  for (const value of shared.EMOTION_VALUES) {
    const one = projectProfileTags({ parentConsent: true, tags: [tag('emotion', value, 'observed')] })
    assert.equal(one.tags.length, 1, '合法情绪值必须被接受：' + value)
  }
  // G-G：不同意就一条都不投影
  const gated = projectProfileTags({
    parentConsent: false,
    tags: [tag('grade_band', 'senior', 'declared')]
  })
  assert.deepEqual(gated.tags, [], 'parent_consent=false 时不外发任何画像（G-G）')
})

/* ================================================================== *
 * PI-2 TTL 与「不放时间」
 * ================================================================== */

test('PI-2 短期情绪过 TTL 读不到（禁做 11），且段里不出现任何时间戳（D-032）', async () => {
  const { projectProfileTags, renderProfileSectionBody } = await loadProfileBlock()
  const shared = await loadShared()

  const expired = projectProfileTags(
    {
      parentConsent: true,
      tags: [
        tag('emotion', 'frustrated', 'observed', 0.8, NOW - shared.EPHEMERAL_TTL_MS - 1),
        tag('intensity', '3', 'observed', 0.8, NOW - shared.EPHEMERAL_TTL_MS - 1),
        tag('grade_band', 'junior', 'declared', null, NOW - 10 * shared.EPHEMERAL_TTL_MS)
      ]
    },
    { now: NOW }
  )
  const keys = expired.tags.map((item) => item.key)
  assert.deepEqual(keys, ['grade_band'], '过期情绪读不到；非时长类标签不受 TTL 影响')

  const fresh = projectProfileTags(
    {
      parentConsent: true,
      tags: [tag('emotion', 'frustrated', 'observed', 0.8, NOW - 1000)]
    },
    { now: NOW }
  )
  assert.equal(fresh.tags.length, 1, '没过期的情绪照常投影')

  // ★ D-032：同一份标签，ts 不同 → 段必须**逐字节相同**（时间不进文本）
  const a = projectProfileTags(
    { parentConsent: true, tags: [tag('emotion', 'calm', 'observed', 0.5, NOW - 1000), tag('intensity', '1', 'observed', 0.5, NOW - 1000)] },
    { now: NOW }
  )
  const b = projectProfileTags(
    { parentConsent: true, tags: [tag('emotion', 'calm', 'observed', 0.5, NOW - 60_000), tag('intensity', '1', 'observed', 0.5, NOW - 60_000)] },
    { now: NOW }
  )
  const bodyA = renderProfileSectionBody(a)
  const bodyB = renderProfileSectionBody(b)
  assert.equal(bodyA, bodyB, 'ts 不同但内容相同 → 段必须逐字节相同（前缀缓存靠这个）')
  assert.ok(!bodyA.includes(String(NOW)), '段里不得出现时间戳数值')
  assert.doesNotMatch(bodyA, /\d{4}-\d{2}-\d{2}/, '段里不得出现日期形态的字节')
})

/* ================================================================== *
 * PI-3 字节稳定 + 顺序 = 白名单声明序
 * ================================================================== */

test('PI-3 同样的标签 → 逐字节相同的段；顺序按 LLM_VISIBLE_TAGS 声明序（不是输入序）', async () => {
  const { projectProfileTags, renderProfileSectionBody } = await loadProfileBlock()
  const shared = await loadShared()

  const items = [
    tag('zpd_level', '1', 'observed', 0.6),
    tag('pace', '慢一点', 'declared'),
    tag('grade_band', 'primary_high', 'declared'),
    tag('subject', '数学', 'declared')
  ]
  const forward = renderProfileSectionBody(projectProfileTags({ parentConsent: true, tags: items }))
  const reversed = renderProfileSectionBody(
    projectProfileTags({ parentConsent: true, tags: [...items].reverse() })
  )
  assert.equal(forward, reversed, '输入顺序不影响输出（同键冲突与排序都必须是全序）')

  const projection = projectProfileTags({ parentConsent: true, tags: items })
  const expectedOrder = shared.LLM_VISIBLE_TAGS.filter((key: string) =>
    projection.tags.some((item: { key: string }) => item.key === key)
  )
  assert.deepEqual(
    projection.tags.map((item: { key: string }) => item.key),
    [...expectedOrder],
    '段内顺序必须等于白名单的**声明序**（固定 → 字节稳定）'
  )
})

/* ================================================================== *
 * PI-4 来源与置信度 / L3 不许覆盖 L1
 * ================================================================== */

test('PI-4a 每个标签都带来源与置信度（铁律 2）', async () => {
  const { projectProfileTags, renderProfileSectionBody } = await loadProfileBlock()
  const body = renderProfileSectionBody(
    projectProfileTags({
      parentConsent: true,
      tags: [
        tag('grade_band', '小学高年级', 'declared', null, null, '学段档位'),
        tag('zpd_level', '1', 'observed', 0.6, null, '难度档'),
        tag('error_type', '概念混淆', 'inferred', 0.7, null, '错误模式')
      ]
    })
  )
  assert.match(body, /学生自述/, '学生自己说的要标成「学生自述」')
  assert.match(body, /系统观察/, '观测到的要标成「系统观察」')
  assert.match(body, /系统推断/, '猜的要标成「系统推断」')
  assert.match(body, /60%/, '置信度要显示出来（界面与模型看到的是同一份）')
  assert.match(body, /70%/, '置信度要显示出来')
})

test('PI-4b L3 推断永远不能覆盖 L1 声明值（铁律 1）', async () => {
  const { projectProfileTags } = await loadProfileBlock()
  const declaredFirst = projectProfileTags({
    parentConsent: true,
    tags: [
      tag('pace', '慢一点', 'declared'),
      tag('pace', '快一点', 'inferred', 0.9)
    ]
  })
  assert.equal(declaredFirst.tags.length, 1, '同一个键只保留一条')
  assert.equal(declaredFirst.tags[0].value, '慢一点', '声明值赢（推断再高置信度也压不过学生自己说的）')
  assert.equal(declaredFirst.tags[0].source, 'declared')

  const inferredFirst = projectProfileTags({
    parentConsent: true,
    tags: [
      tag('pace', '快一点', 'inferred', 0.95),
      tag('pace', '慢一点', 'declared', null)
    ]
  })
  assert.equal(inferredFirst.tags[0].value, '慢一点', '换顺序结论不变（全序，不是「先到先得」）')

  // observed 也压过 inferred（L1 观察 > L3 推断）
  const observedWins = projectProfileTags({
    parentConsent: true,
    tags: [
      tag('error_type', '猜的', 'inferred', 0.99),
      tag('error_type', '算错', 'observed', 0.4)
    ]
  })
  assert.equal(observedWins.tags[0].value, '算错')
})

test('PI-4c 投影是**只读**的：不原地改输入，模块里也没有任何写路径（源码级）', async () => {
  const { projectProfileTags, buildJudgePersona } = await loadProfileBlock()
  const payload = {
    parentConsent: true,
    tags: [tag('grade_band', 'junior', 'declared'), tag('subject', '数学', 'declared')]
  }
  const before = JSON.stringify(payload)
  const projection = projectProfileTags(payload)
  buildJudgePersona(projection)
  assert.equal(JSON.stringify(payload), before, '投影与渲染都不得改动调用方的入参')

  // profile-block.ts 只允许**一条读路径**（GET 标签）；adaptation.ts 一条都没有（纯函数）
  const profileCode = stripComments(read('src', 'main', 'agent', 'prompts', 'profile-block.ts'))
  const adaptationCode = stripComments(read('src', 'main', 'agent', 'prompts', 'adaptation.ts'))
  for (const [name, code] of [
    ['prompts/profile-block.ts', profileCode],
    ['prompts/adaptation.ts', adaptationCode]
  ] as const) {
    assert.doesNotMatch(code, /method:\s*'(PUT|POST|DELETE|PATCH)'/i, name + ' 不得有任何写标签/写偏好的 HTTP 调用')
  }
  assert.match(profileCode, /method:\s*'GET'/, 'profile-block 的读出口必须是 GET（只读）')
  assert.ok(!adaptationCode.includes('apiFetch'), 'adaptation.ts 是纯函数模块，不许发请求')

  // ★ G-C 的另一半：prompt 拼装路径里不存在读本地身份列的代码
  const promptSources: Array<{ name: string; code: string }> = [
    ...readdirSync(join(DESKTOP, 'src', 'main', 'agent', 'prompts'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({
        name: 'prompts/' + name,
        code: stripComments(read('src', 'main', 'agent', 'prompts', name))
      })),
    { name: 'extensions/grade.ts', code: stripComments(read('src', 'main', 'agent', 'extensions', 'grade.ts')) },
    { name: 'extensions/profile.ts', code: stripComments(read('src', 'main', 'agent', 'extensions', 'profile.ts')) }
  ]
  for (const source of promptSources) {
    for (const needle of ['identity_local', 'real_name', 'real_grade', 'parent_consent', 'memory_switch']) {
      assert.ok(
        !source.code.includes(needle),
        source.name + ' 里出现了本地身份层的字段名：' + needle + '（G-C：prompt 拼装器不得读它）'
      )
    }
  }
})

/* ================================================================== *
 * PI-5 三类「怎么讲」的段：难度微调 / 受挫倾向 / 禁做 13、14
 * ================================================================== */

test('PI-5a 难度微调（票 30）：zpd_level → 偏易/偏难；数据不足一律回「正常」（不许猜）', async () => {
  const adapt = await loadAdaptation()
  const pb = await loadProfileBlock()
  const grade = await loadGrade()

  const make = (value: string, confidence: number | null = null) => ({
    key: 'zpd_level' as const,
    label: '难度档',
    value,
    source: 'observed' as const,
    confidence
  })

  assert.equal(adapt.resolveDifficultyTier(null), 'normal', '没有标签 → 正常')
  assert.equal(adapt.resolveDifficultyTier(undefined), 'normal')
  assert.equal(adapt.resolveDifficultyTier(make('1', 0.6)), 'easier')
  assert.equal(adapt.resolveDifficultyTier(make('3', 0.6)), 'harder')
  assert.equal(adapt.resolveDifficultyTier(make('2', 0.6)), 'normal')
  for (const value of ['0', '4', '9', '50', '1.5', '偏😀', '高难', '']) {
    assert.equal(
      adapt.resolveDifficultyTier(make(value, 0.6)),
      'normal',
      '认不出 / 越界的值必须回正常，不许猜：' + JSON.stringify(value)
    )
  }
  assert.equal(adapt.resolveDifficultyTier(make('1', 0.4)), 'normal', '置信度太低 → 回正常')
  assert.equal(adapt.resolveDifficultyTier(make('偏难', 0.6)), 'harder', '中文字面档位也认')

  assert.equal(adapt.renderDifficultySectionBody('normal'), '', '正常档不注入任何文字（回落 = 什么都不说）')
  const easier = adapt.renderDifficultySectionBody('easier')
  assert.match(easier, /不变/, '必须写明「学段与知识范围不变」—— 否则微调会变成学段迁移')
  assert.ok(!easier.includes(grade.GRADE_OVERRIDE_HEADING), '微调段不得顶替学段权威段')

  // 走一遍组装：zpd=2 时不出现难度段；zpd=1 时出现
  const normalSections = adapt.buildTurnSections({
    projection: pb.projectProfileTags({
      parentConsent: true,
      tags: [tag('zpd_level', '2', 'observed', 0.8, null, '难度档')]
    })
  })
  assert.ok(
    !normalSections.some((section: { heading: string }) => section.heading === pb.DIFFICULTY_SECTION_HEADING),
    '正常档不出现难度段'
  )
  const easierSections = adapt.buildTurnSections({
    projection: pb.projectProfileTags({
      parentConsent: true,
      tags: [tag('zpd_level', '1', 'observed', 0.8, null, '难度档')]
    })
  })
  assert.ok(
    easierSections.some((section: { heading: string }) => section.heading === pb.DIFFICULTY_SECTION_HEADING),
    '偏易档必须出现难度段'
  )
})

test('PI-5b 受挫敏感度（票 29）：三种意思互斥，证据不足先问一句，不押', async () => {
  const adapt = await loadAdaptation()
  const rules = await loadRules()
  const pb = await loadProfileBlock()

  const general = rules.frustrationGuidance('unknown').join('\n')
  for (const word of ['求助型', '放弃型', '试探型', '先问一句']) {
    assert.ok(general.includes(word), '证据不足时三种都要摆出来 + 先问一句，缺了：' + word)
  }

  const projection = (tags: Array<Record<string, unknown>>) =>
    pb.projectProfileTags({ parentConsent: true, tags })

  assert.equal(adapt.resolveFrustrationTendency({ projection: null }), 'unknown', '没有任何信号 → 不判')
  assert.equal(
    adapt.resolveFrustrationTendency({ projection: projection([tag('emotion', 'frustrated', 'observed', 0.8)]) }),
    'unknown',
    '只有「沮丧」一个信号时不押（三选一会押错两次）'
  )
  assert.equal(
    adapt.resolveFrustrationTendency({
      projection: projection([
        tag('emotion', 'frustrated', 'observed', 0.8),
        tag('challenge_level', '高', 'observed', 0.6)
      ])
    }),
    'help_seeking',
    '愿意挑战 → 求助型（他要的是解法，不是安慰）'
  )
  assert.equal(
    adapt.resolveFrustrationTendency({
      projection: projection([
        tag('emotion', 'frustrated', 'observed', 0.8),
        tag('encouragement_freq', '高', 'observed', 0.6)
      ])
    }),
    'giving_up',
    '需要被肯定 → 放弃型（先肯定再降一级）'
  )
  assert.equal(
    adapt.resolveFrustrationTendency({
      projection: projection([
        tag('emotion', 'confused', 'observed', 0.8),
        tag('intensity', '1', 'observed', 0.8)
      ])
    }),
    'unknown',
    '1 级困惑是正常的思考停顿，不值得一套特殊处置'
  )
  assert.equal(
    adapt.resolveFrustrationTendency({ projection: null, observed: 'testing' }),
    'testing',
    '行为观察优先，而且试探型只能由行为观察给出（没有标签信号）'
  )

  assert.equal(adapt.renderFrustrationSectionBody('unknown'), '', '不判就不注入（静态那一节已经讲清三种）')
  const help = adapt.renderFrustrationSectionBody('help_seeking')
  assert.match(help, /求助型/)
  assert.match(help, /解法/, '求助型的策略是「直接给解法」，不是「先安慰」')
  assert.match(help, /问问老师/, '反依赖诱导的正面表述必须在（禁做 14）')
})

test('PI-5c 禁做 13、14（价值观红线）：prompt 源文件里不得出现情绪操控 / 依赖诱导的字面量', async () => {
  /**
   * ★ 这两条防的不是数据泄露，是**产品价值观滑坡** —— 而且这种滑坡往往是**模型自己写出来的**，
   *   靠 code review 抓不住。所以扫的是**去掉注释后的可执行文本**（字符串字面量会进 prompt）。
   */
  const banned = [
    '你要开心一点',
    '开心一点',
    '别说难过',
    '别难过',
    '只有我懂你',
    '只有我理解你',
    '别去问老师',
    '别问老师',
    '不要问老师',
    '不许告诉老师'
  ]
  const files = readdirSync(join(DESKTOP, 'src', 'main', 'agent', 'prompts'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name: 'prompts/' + name,
      code: stripComments(read('src', 'main', 'agent', 'prompts', name))
    }))
    .concat([
      {
        name: 'extensions/grade.ts',
        code: stripComments(read('src', 'main', 'agent', 'extensions', 'grade.ts'))
      },
      {
        name: 'extensions/profile.ts',
        code: stripComments(read('src', 'main', 'agent', 'extensions', 'profile.ts'))
      }
    ])
  for (const file of files) {
    for (const phrase of banned) {
      assert.ok(
        !file.code.includes(phrase),
        file.name + ' 里出现了禁做第 13/14 条的字面量「' + phrase + '」（情绪操控 / 依赖诱导）'
      )
    }
  }

  // ★ 正向：静态模板里必须有「他也可以去问老师」这一半（不是靠「不提老师」来规避 14）
  const rules = await loadRules()
  const mood = rules.moodSection('智团团')
  assert.match(mood, /问问老师/, '受挫处置必须明确鼓励他也能去问老师（禁做 14 的正面表述）')
  assert.match(mood, /先把情绪接住/, '既有口径保留（student-view-discipline 的守卫也钉着它）')
  assert.match(mood, /不要硬拽/, '跑题时的口径保留')
  assert.match(mood, /这是正常的问题/, '「你是谁」这类问题的口径保留')
  assert.ok(
    !/禁止(跑题|闲聊)/.test(mood),
    '这一节不能写成「禁止跑题 / 拒绝闲聊」'
  )
})

/* ================================================================== *
 * PI-6 接线：判定注入 / 引导模式 / 段拼装 / 唯一出口
 * ================================================================== */

test('PI-6a AI 判定注入画像（票 26 / D-073）：persona 追加在末尾，且只带判学段用得上的那几项', async () => {
  const grade = await loadGrade()
  const pb = await loadProfileBlock()
  const turns = [
    { turn: 1, text: '什么是集合' },
    { turn: 2, text: '函数有什么用' }
  ]
  const without = grade.buildJudgePrompt(turns, 'junior')
  const persona = pb.buildJudgePersona(
    pb.projectProfileTags({
      parentConsent: true,
      tags: [
        tag('grade_band', '高中', 'declared', null, null, '学段档位'),
        tag('subject', '数学', 'declared', null, null, '学科'),
        tag('zpd_level', '3', 'observed', 0.7, null, '难度档'),
        // 下面两条都在白名单里，但**不该**进判定摘要（掌握度明细会稀释 prompt）
        tag('mastery', '0.00', 'observed', 0.9, null, '掌握程度'),
        tag('emotion', 'frustrated', 'observed', 0.9, null, '这一轮的情绪')
      ]
    })
  )
  assert.ok(persona.includes('grade_band'), '摘要里要带键名，模型才知道那是「档位」不是精确年级')
  assert.ok(persona.includes('学生自述'), '来源要标出来')
  assert.ok(!persona.includes('mastery'), '掌握度明细不进判定（对判学段没帮助）')
  assert.ok(!persona.includes('emotion'), '情绪也不进判定摘要（它属于受挫处置那一段）')

  const withPersona = grade.buildJudgePrompt(turns, 'junior', persona)
  assert.ok(withPersona.startsWith(without), '画像追加在末尾：前面的判定口径一字不动')
  assert.ok(withPersona.includes(persona), '判定提示词里必须真的有这段摘要')
  assert.ok(
    withPersona.indexOf(persona) > without.length,
    '摘要必须排在原有口径**之后**（追加，不是插在中间）'
  )
  assert.ok(
    withPersona.lastIndexOf('只输出一行 JSON') > withPersona.indexOf(persona),
    '追加之后必须重申输出契约（否则会白丢一次判定）'
  )
  assert.ok(!without.includes('画像'), '没有标签时不多说一句（老口径逐字不变）')
})

test('PI-6b 引导模式（票 25 §1.3）：接线后整份换成引导 prompt，未接线/失败则干净退回常规', async () => {
  const grade = await loadGrade()
  const table = await loadGradeTable()

  const logs: string[] = []
  let active = false
  const port = {
    isOnboardingActive: () => active,
    buildOnboardingSystemPrompt: (params: { askedCount: number; displayName: string }) =>
      '【引导模式】第 ' + params.askedCount + ' 问，称呼 ' + params.displayName,
    onboardingGuardNotes: () =>
      ['本轮不注入学段权威段', '本轮不提供任何工具'] as readonly string[],
    promptParams: () => ({ askedCount: 2, displayName: '小明' })
  }

  const extension = grade.createGradeExtension({ judge: null, log: (line: string) => logs.push(line) })
  assert.equal(extension.isOnboarding(), false, '未接线 = 非引导（干净降级，不是半成品）')
  const normal = extension.systemPromptFor(undefined)
  assert.ok(normal.includes(grade.GRADE_OVERRIDE_HEADING), '常规模式必须带学段权威段')
  assert.ok(normal.includes(table.GRADE_PROMPTS[table.DEFAULT_GRADE_LEVEL]), '常规模式必须带学段模板')

  extension.useOnboarding(port)
  assert.equal(extension.isOnboarding(), false, '端口接上但状态为假 → 仍是非引导')

  active = true
  const onboarding = extension.systemPromptFor(undefined)
  assert.ok(onboarding.includes('【引导模式】'), '引导期整份换成引导 prompt')
  assert.ok(onboarding.includes('第 2 问'), 'askedCount 来自 promptParams（就是引导服务本身的状态）')
  assert.ok(onboarding.includes('小明'), 'displayName 来自 promptParams')
  assert.ok(!onboarding.includes(grade.GRADE_OVERRIDE_HEADING), '引导期不得出现学段权威段（学段还没问出来）')
  assert.ok(!onboarding.includes(table.GRADE_PROMPTS.junior), '引导期不得注入常规学段模板')
  // ★ C **原样**返回 B 的引导 prompt：一个字都不加（guard notes 是给人看的，不进 prompt）
  assert.equal(
    onboarding,
    '【引导模式】第 2 问，称呼 小明',
    '引导 prompt 必须原样交给模型（C 不得改写 B 的产出口径）'
  )
  assert.ok(
    !onboarding.includes('本轮不提供任何工具'),
    'B 的 onboardingGuardNotes 是给人看的（日志/诊断），绝不许拼进 prompt'
  )
  assert.ok(
    logs.some((line) => line.includes('引导模式生效') && line.includes('本轮不提供任何工具')),
    '换成引导模式要在日志里说清「关掉了哪三块」（否则「这轮为什么没工具」无从查起）'
  )
  assert.equal(
    logs.filter((line) => line.includes('引导模式生效')).length,
    1,
    '这条日志只记一次（每轮都记会刷屏）'
  )
  assert.equal(extension.systemPromptFor(undefined), onboarding, '每轮重拼必须逐字相等（幂等）')

  // 失败降级：拼不出引导 prompt 时退回常规模板，且留痕
  const broken = {
    isOnboardingActive: () => true,
    buildOnboardingSystemPrompt: () => {
      throw new Error('引导服务没起来')
    },
    onboardingGuardNotes: () => [] as readonly string[],
    promptParams: () => ({ askedCount: 0, displayName: '' })
  }
  const fallback = grade.createGradeExtension({ judge: null, log: (line: string) => logs.push(line) })
  fallback.useOnboarding(broken)
  assert.ok(
    fallback.systemPromptFor(undefined).includes(grade.GRADE_OVERRIDE_HEADING),
    '拼不出来 → 退回常规模板（绝不把学生扔进空 prompt）'
  )
  assert.ok(logs.some((line) => line.includes('引导 prompt 组装失败')), '降级必须留痕')
  fallback.useOnboarding({ ...broken, buildOnboardingSystemPrompt: () => '   ' })
  assert.ok(
    fallback.systemPromptFor(undefined).includes(grade.GRADE_OVERRIDE_HEADING),
    '空串同样退回常规模板'
  )
  fallback.useOnboarding({
    ...broken,
    isOnboardingActive: () => {
      throw new Error('状态读不到')
    }
  })
  fallback.systemPromptFor(undefined)
  fallback.systemPromptFor(undefined)
  assert.equal(
    logs.filter((line) => line.includes('引导状态读取失败')).length,
    1,
    '状态读取失败只记一次日志（每轮都记会刷屏）'
  )
})

test('PI-6c 段拼装：幂等、位置固定在学段权威段与学生情况块之前，且清得干净', async () => {
  const pb = await loadProfileBlock()
  const adapt = await loadAdaptation()
  const grade = await loadGrade()
  const table = await loadGradeTable()
  const context = await loadStudentContext()

  const base = grade.buildGradeSystemPrompt({ incoming: undefined, inferredGrade: 'junior' })
  const sections = adapt.buildTurnSections({
    projection: pb.projectProfileTags({
      parentConsent: true,
      tags: [
        tag('grade_band', 'primary_high', 'declared', null, null, '学段档位'),
        tag('zpd_level', '1', 'observed', 0.6, null, '难度档'),
        tag('emotion', 'frustrated', 'observed', 0.8, NOW, null),
        tag('challenge_level', '高', 'observed', 0.6, null, '挑战偏好'),
        // ★ 风格标签（§5.2 #4）：夹具必须**带上它**，否则风格段是条件性的、
        //   这一段不会出现，而下面那条「每段恰好一次」的遍历会数到 0。
        //   （集成期实测踩到：加了段却没给夹具加标签，守卫红得让人以为是段没登记。）
        tag('practice_type', '动手', 'declared', null, null, '练习偏好')
      ]
    })
  })
  assert.deepEqual(
    sections.map((section: { heading: string }) => section.heading),
    [
      pb.PROFILE_SECTION_HEADING,
      pb.DIFFICULTY_SECTION_HEADING,
      pb.STYLE_TOOL_SECTION_HEADING,
      pb.FRUSTRATION_SECTION_HEADING
    ],
    '顺序固定：画像 → 难度 → 工具先后 → 情绪'
  )

  const once = pb.withPromptSections(base, sections)
  const twice = pb.withPromptSections(once, sections)
  assert.equal(twice, once, '重复拼装必须逐字相等（否则每轮叠一层）')
  for (const heading of pb.TURN_SECTION_HEADINGS) {
    assert.equal(countOccurrences(once, heading), 1, '每段恰好一个：' + heading)
  }
  assert.ok(
    once.indexOf(pb.PROFILE_SECTION_HEADING) < once.indexOf(grade.GRADE_OVERRIDE_HEADING),
    '三段必须排在学段权威段之前（权威段永远是最后一句）'
  )
  assert.ok(
    once.includes(table.GRADE_PROMPTS[table.DEFAULT_GRADE_LEVEL]),
    '学段模板仍在（学段内微调不改学段）'
  )

  // 与学生情况块共存：连续 3 轮重拼，各段恰好一个、顺序稳定
  const studentBlock = context.renderStudentContextBlock({
    student: { studentId: 'student_001', gradeLevel: 'junior' },
    mastery: []
  } as never)
  let prompt = base
  for (let round = 0; round < 3; round += 1) {
    prompt = context.withStudentContext(pb.withPromptSections(prompt, sections), studentBlock)
    const headings = [
      ...pb.TURN_SECTION_HEADINGS,
      context.STUDENT_CONTEXT_HEADING,
      grade.GRADE_OVERRIDE_HEADING
    ]
    for (const heading of headings) {
      assert.equal(countOccurrences(prompt, heading), 1, '第 ' + round + ' 轮的段不是恰好一个：' + heading)
    }
  }
  assert.ok(
    prompt.indexOf(pb.PROFILE_SECTION_HEADING) < prompt.indexOf(context.STUDENT_CONTEXT_HEADING),
    '画像段排在学生情况块之前'
  )
  assert.ok(
    prompt.indexOf(context.STUDENT_CONTEXT_HEADING) < prompt.indexOf(grade.GRADE_OVERRIDE_HEADING),
    '学生情况块排在学段权威段之前'
  )

  // 标签没了（TTL 过期 / 没接线）→ 三段全部清掉，且与不含段的基座逐字相等
  const cleaned = pb.withPromptSections(once, [])
  assert.ok(!cleaned.includes(pb.PROFILE_SECTION_HEADING))
  assert.ok(!cleaned.includes(pb.DIFFICULTY_SECTION_HEADING))
  assert.ok(!cleaned.includes(pb.FRUSTRATION_SECTION_HEADING))
  assert.equal(cleaned, base, '清空后必须与不含段的基座逐字相等（清理不留痕）')
})

test('PI-6d 接线守卫（源码级）：persona 真的进了判定，段落真的走了唯一出口', async () => {
  const runtime = stripComments(read('src', 'main', 'agent', 'runtime.ts'))
  assert.ok(
    runtime.includes('buildJudgePrompt(turns, currentGrade, judgePersona)'),
    '判定必须带上本轮画像摘要（票 26）'
  )
  assert.ok(
    runtime.includes('fetchPersonaSnapshot(paths.studentId)'),
    '画像标签必须每轮预取一次'
  )
  assert.ok(runtime.includes('buildJudgePersona(personaProjection)'), '摘要文本由投影函数生成')
  assert.ok(
    runtime.includes('buildTurnSections({ projection: personaProjection })'),
    '每轮要拼出「画像 / 难度 / 情绪」三段'
  )
  assert.ok(
    runtime.includes('withPromptSections(grade, turnSections)'),
    '三段必须走唯一的 prompt 出口（buildSystemPrompt）'
  )
  assert.ok(runtime.includes('gradeExtension.isOnboarding()'), '引导期必须跳过画像块注入（§1.3）')
  assert.ok(
    runtime.includes('gradeExtension.useOnboarding('),
    '引导模式必须接线（否则 systemPromptFor 永远走常规分支）'
  )
  assert.ok(
    runtime.includes('onboardingService.dispose()'),
    '退出前必须 flush 引导服务（§1.6 第 3 条硬约束；位置紧随 gradeExtension.flush）'
  )
  assert.ok(
    runtime.includes('ONBOARDING_EXTRA_EXTENSION'),
    '引导扩展要进注册报告（启动时可查「引导已就位」）'
  )

  const personaAt = runtime.indexOf('const personaPrefetch = fetchPersonaSnapshot(paths.studentId)')
  const contextAt = runtime.indexOf('studentContextBlock = await fetchStudentContext(')
  assert.ok(personaAt > 0, '找不到画像标签预取')
  assert.ok(contextAt > 0, '找不到画像预取')
  assert.ok(personaAt < contextAt, '标签预取必须与画像预取**并行**发出（排在同一个 await 之前）')

  // 受挫策略只有一份实现：rules.ts 提供正文，adaptation.ts 引用它
  const rulesCode = stripComments(read('src', 'main', 'agent', 'prompts', 'rules.ts'))
  const adaptationCode = stripComments(read('src', 'main', 'agent', 'prompts', 'adaptation.ts'))
  assert.ok(rulesCode.includes('export function frustrationGuidance('), '策略正文必须定义在 rules.ts')
  assert.ok(adaptationCode.includes('frustrationGuidance('), '定向段必须复用同一份策略正文')
  assert.ok(
    !/求助型[\s\S]{0,40}直接/.test(adaptationCode),
    'adaptation.ts 不得自己再写一份策略正文（两份必然漂移）'
  )
})


