/**
 * 持续画像迭代（一期地基）的纯函数守卫。
 *
 * 这一份盯住三件「错了就静默出事」的事：
 *
 *   G-M-6  **轮次计数跨重启不归零**：用（假的）后端位标校准，断言重启后不从头来；
 *          且校准**只保证下限**（不被后端虚高的信号条数顶上去）。
 *   G-M-9  **实质内容门槛**：连着「嗯」「哦」不触发概括；有内容才触发。
 *   G-M-10 **窗口有界 + 按学生隔离**：窗口不超过 `PROFILE_REFRESH_WINDOW_TURNS` 轮；
 *          换学生不串味（跨学生数据泄漏在**计数与文本两层**都要挡住）。
 *
 * ★ 手法：这些都是纯函数 / 模块级状态，直接 import 调用即可，不需要注入替身。
 *   每个用例用不同 studentId（并在必要时 reset），避免模块级 Map 串味。
 *
 * 跑法：node --test tests/profile-refresh.test.ts
 *
 * ⚠️ node --test 直跑 .ts 用的是 Node 的类型擦除 —— 禁用 TS parameter property（AGENTS §8.1）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildRefreshPayload,
  calibrateTurn,
  clearTranscriptWindow,
  currentTurn,
  isMeaningful,
  markRefreshed,
  noteTurn,
  parseRefreshTags,
  pushTurn,
  recentTurns,
  resetTurnClock,
  runRefresh,
  shouldRefresh,
  turnWindowSize,
  MIN_MEANINGFUL_TURN_CHARS,
  PROFILE_REFRESH_EVERY_TURNS,
  PROFILE_REFRESH_WINDOW_TURNS,
  REFRESH_MAX_ATTEMPTS,
  REFRESH_MAX_TAGS,
  REFRESH_MSG_MAX_CHARS
} from '../src/main/agent/profile-refresh/index.ts'
import {
  LEARNER_STYLE_VALUES,
  PERSONALITY_VALUES
} from '../src/shared/profile-tags.ts'

/** 每个用例用独立的学生 id，避免模块级 Map 串味。 */
let counter = 0
function freshStudent(): string {
  counter += 1
  return `stu_refresh_${counter}`
}

/* ------------------------------------------------------------------ *
 * 轮次时钟：触发节奏
 * ------------------------------------------------------------------ */
test('G-M-9 攒够 N 轮且有实质内容才触发', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  // 前 N-1 轮不触发
  for (let i = 1; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    assert.equal(noteTurn(sid, `这是第 ${i} 轮的比较长的内容`), i)
    assert.equal(shouldRefresh(sid), false, `第 ${i} 轮不该触发`)
  }
  // 第 N 轮触发
  assert.equal(noteTurn(sid, '这是第 N 轮的内容'), PROFILE_REFRESH_EVERY_TURNS)
  assert.equal(shouldRefresh(sid), true, '攒够 N 轮应当触发')
})

test('G-M-9 全是语气词（无实质内容）不触发', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  for (let i = 0; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    noteTurn(sid, '嗯')
  }
  assert.equal(
    shouldRefresh(sid),
    false,
    '轮次够了但全是语气词 —— 不该为一次空概括付 LLM 的钱'
  )
})

test('G-M-9 markRefreshed 之后重新开始攒，不会连续触发', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  for (let i = 0; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) noteTurn(sid, '有内容的回答')
  assert.equal(shouldRefresh(sid), true)
  markRefreshed(sid)
  assert.equal(shouldRefresh(sid), false, '刚跑过就不该再触发（否则会失败风暴）')
  // 再攒 N 轮才触发
  for (let i = 0; i < PROFILE_REFRESH_EVERY_TURNS - 1; i += 1) noteTurn(sid, '有内容的回答')
  assert.equal(shouldRefresh(sid), false)
  noteTurn(sid, '有内容的回答')
  assert.equal(shouldRefresh(sid), true)
})

test('G-M-9 触发语义是「距上次的差值」而非 `turn % N`（不因某轮无内容而错过触发点）', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  // 第 1 轮有内容，第 2..N-1 轮全是语气词
  noteTurn(sid, '有内容的回答')
  for (let i = 2; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) noteTurn(sid, '嗯')
  // 到第 N 轮时：差值够（N-1>=N-1? 否）—— 先确认第 N-1 轮还不触发
  assert.equal(shouldRefresh(sid), false)
  // 第 N 轮（语气词）→ 差值达到 N（从 0 到 N）→ 触发
  //   ★ 关键：触发看的是「距上次的轮次差」，窗口里第 1 轮的内容仍然算数 ——
  //     不像 `turn % N` 那样要求"恰好第 N 轮"且有内容。
  noteTurn(sid, '嗯')
  assert.equal(shouldRefresh(sid), true, '差值够了、窗口里有内容就触发，不要求当前这轮有内容')
})

test('G-M-9 若整段窗口都没内容，则不触发（哪怕轮次够）', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) noteTurn(sid, '嗯')
  assert.equal(shouldRefresh(sid), false, '整窗口无内容 → 不为空概括付钱')
  // 出现一个有内容的回答后，同样的轮次差值下就触发
  noteTurn(sid, '还是不太懂')
  assert.equal(shouldRefresh(sid), true, '出现真实信号后立刻可触发')
})

test('markRefreshed 清零实质内容计数（下一轮的语气词不足以触发）', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  for (let i = 0; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) noteTurn(sid, '有内容')
  markRefreshed(sid)
  for (let i = 0; i < PROFILE_REFRESH_EVERY_TURNS; i += 1) noteTurn(sid, '哦')
  assert.equal(shouldRefresh(sid), false, 'markRefreshed 顺带清了实质内容计数')
})

/* ------------------------------------------------------------------ *
 * 轮次时钟：跨重启校准（G-M-6）
 * ------------------------------------------------------------------ */
test('G-M-6 重启（本地归零）后用后端位标校准，不从头来', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  // 模拟重启：本地计数为 0，后端说已经走了 42 个信号位标
  assert.equal(currentTurn(sid), 0)
  assert.equal(calibrateTurn(sid, 42), 42, '本地 0 + 后端 42 → 取 42')
  // 校准后再走一轮 = 第 43 轮
  assert.equal(noteTurn(sid, '重启后的第一句话'), 43)
})

test('G-M-6 校准只保证下限，不把本地精确计数顶上去', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  for (let i = 0; i < 50; i += 1) noteTurn(sid, '有内容')
  // 后端信号条数（一轮可能 3 行）比本地轮数小 —— 不许倒退
  assert.equal(calibrateTurn(sid, 12), 50, '校准不倒退：取 max(本地, 后端)')
  // 后端虚高（信号条数比轮数多）也**不**直接赋值 —— 文件头「为什么是取下限」
  // 注意：这里本地 50 已经 >= 后端 51，验证取下限语义
  assert.equal(calibrateTurn(sid, 51), 51)
  assert.equal(calibrateTurn(sid, 10), 51, '再次校准也不许倒退')
})

test('G-M-6 校准对脏输入（NaN / 负数 / 小数）稳健', () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  assert.equal(calibrateTurn(sid, Number.NaN), 0)
  assert.equal(calibrateTurn(sid, -5), 0)
  assert.equal(calibrateTurn(sid, 7.9), 7, '小数向下取整')
})

/* ------------------------------------------------------------------ *
 * 轮次时钟：按学生隔离
 * ------------------------------------------------------------------ */
test('G-M-10 轮次计数按学生隔离', () => {
  const a = freshStudent()
  const b = freshStudent()
  resetTurnClock(a)
  resetTurnClock(b)
  for (let i = 0; i < 3; i += 1) noteTurn(a, 'A 的内容')
  assert.equal(currentTurn(a), 3)
  assert.equal(currentTurn(b), 0, 'B 不该继承 A 的轮次')
  noteTurn(b, 'B 的内容')
  assert.equal(currentTurn(a), 3, 'A 也不受 B 影响')
  assert.equal(currentTurn(b), 1)
})

/* ------------------------------------------------------------------ *
 * 实质内容判断（纯函数）
 * ------------------------------------------------------------------ */
test('G-M-9 isMeaningful 的边界', () => {
  // ★ 下界取 2：两字回答是**真实学习信号**（卡壳），绝不能判成"没内容"
  assert.equal(isMeaningful('不会'), true, '「不会」是最该记下的卡壳信号')
  assert.equal(isMeaningful('不懂'), true)
  assert.equal(isMeaningful('太快'), true)
  // 单字语气词不足以触发
  assert.equal(isMeaningful('嗯'), false)
  assert.equal(isMeaningful('哦'), false)
  assert.equal(isMeaningful('是'), false)
  assert.equal(isMeaningful(' '), false)
  assert.equal(isMeaningful('  \n\t '), false)
  assert.equal(isMeaningful(''), false)
  // 空白被去掉后按长度算
  assert.equal(isMeaningful('  嗯  '), false, '去空白后单字仍不够门槛')
  assert.equal(MIN_MEANINGFUL_TURN_CHARS, 2)
})

/* ------------------------------------------------------------------ *
 * 对话环形缓冲
 * ------------------------------------------------------------------ */
test('G-M-10 窗口有界：超过上限丢最旧的', () => {
  const sid = freshStudent()
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_WINDOW_TURNS + 5; i += 1) {
    pushTurn(sid, `学生第 ${i} 轮`, `助手第 ${i} 轮`, i)
  }
  assert.equal(turnWindowSize(sid), PROFILE_REFRESH_WINDOW_TURNS, '窗口不得超过上限')
  const turns = recentTurns(sid)
  // 最新的在后；最旧的那 5 轮已被丢弃
  assert.equal(turns[turns.length - 1]?.user, `学生第 ${PROFILE_REFRESH_WINDOW_TURNS + 5} 轮`)
  assert.equal(turns[0]?.user, `学生第 6 轮`, '最早保留的是被丢弃边界之后的那一轮')
})

test('G-M-10 recentTurns 返回副本，改动不影响缓冲', () => {
  const sid = freshStudent()
  clearTranscriptWindow(sid)
  pushTurn(sid, '原始学生文本', '原始助手文本', 1)
  const first = recentTurns(sid)
  // TranscriptTurn 的字段是 readonly（编译期不可变）；这一条防的是**运行期**
  // 有人用 `as` 绕过 readonly 去改，而缓冲本身不该被改到。
  const mutableFirst = first as unknown as { user: string }[]
  mutableFirst[0]!.user = '被改过'
  const second = recentTurns(sid)
  assert.equal(second[0]?.user, '原始学生文本', '缓冲是唯一真相，不能被载荷构建顺手改掉')
})

test('recentTurns 的 limit 参数（并会被窗口大小截断）', () => {
  const sid = freshStudent()
  clearTranscriptWindow(sid)
  for (let i = 1; i <= 6; i += 1) pushTurn(sid, `u${i}`, `a${i}`, i)
  assert.equal(recentTurns(sid, 3).length, 3)
  assert.equal(recentTurns(sid, 3)[0]?.user, 'u4', '取最近 3 轮')
  assert.equal(recentTurns(sid, 999).length, 6, '超过窗口的值被截断')
  assert.equal(recentTurns(sid, 0).length, 0)
})

test('G-M-10 对话缓冲按学生隔离（跨学生不串味）', () => {
  const a = freshStudent()
  const b = freshStudent()
  clearTranscriptWindow(a)
  clearTranscriptWindow(b)
  pushTurn(a, 'A 的私密文本', '给 A 的回复', 1)
  assert.equal(turnWindowSize(a), 1)
  assert.equal(turnWindowSize(b), 0, 'B 不该看到 A 的对话')
  assert.deepEqual(recentTurns(b), [])
})

test('clearTranscriptWindow 清掉一个学生的窗口', () => {
  const sid = freshStudent()
  clearTranscriptWindow(sid)
  pushTurn(sid, 'u', 'a', 1)
  assert.equal(turnWindowSize(sid), 1)
  clearTranscriptWindow(sid)
  assert.equal(turnWindowSize(sid), 0, '切换/删除学生必须清窗口（禁做 #9）')
})

test('pushTurn 对脏输入（非字符串 / 非数字轮次）稳健', () => {
  const sid = freshStudent()
  clearTranscriptWindow(sid)
  pushTurn(sid, undefined as unknown as string, null as unknown as string, Number.NaN)
  const turns = recentTurns(sid)
  assert.equal(turns.length, 1)
  assert.equal(turns[0]?.user, '')
  assert.equal(turns[0]?.assistant, '')
  assert.equal(turns[0]?.turn, 0)
})

/* ------------------------------------------------------------------ *
 * 二期：载荷构建（buildRefreshPayload）
 * ------------------------------------------------------------------ */

test('G-M-4b 助手文本也过脱敏：助手复述 PII 时不出网', () => {
  const { system, user } = buildRefreshPayload({
    turns: [
      {
        user: '我想换个例子',
        // ★ 助手复述了学生的话（「你刚才说你在阳光小学……」）—— 这是最典型的侧漏形态。
        //   用「学校名」这类**模式表里真实存在**的 PII（sanitize.ts 的 PII_PATTERNS）——
        //   断言才有意义：助手文本确实走了同一套脱敏，而不是「这句话碰巧不含 PII」。
        assistant: '你刚才说你在阳光小学上五年级，我们换个例子讲。',
        turn: 1
      }
    ],
    knownTags: []
  })
  assert.ok(system.includes('助手的话不是学生的偏好'), 'prompt 必须有「助手只是上下文」这条纪律')
  assert.ok(!user.includes('阳光小学'), '★ 助手复述的学校名必须被脱敏掉（漏了就是侧漏）')
  // 学生自己的文本仍应在（它是证据）
  assert.ok(user.includes('我想换个例子'), '学生的原话要保留（它是证据）')
})

test('G-M-4c 学生文本命中 PII 时落回落值，不整条丢弃', () => {
  const { user } = buildRefreshPayload({
    turns: [{ user: '我叫李小明，在阳光小学上五年级', assistant: '好的', turn: 1 }],
    knownTags: []
  })
  assert.ok(!user.includes('李小明'), '自我介绍句式必须被脱敏')
  assert.ok(!user.includes('阳光小学'), '具名学校必须被脱敏')
})

test('载荷每条消息都截断到 REFRESH_MSG_MAX_CHARS', () => {
  const long = '啊'.repeat(REFRESH_MSG_MAX_CHARS * 3)
  const { user } = buildRefreshPayload({
    turns: [{ user: long, assistant: long, turn: 1 }],
    knownTags: []
  })
  // 学生那一段被截到 REFRESH_MSG_MAX_CHARS + 一个省略号
  const studentSegment = user.split('\n').find((line) => line.includes('学生：')) ?? ''
  assert.ok(
    studentSegment.length <= REFRESH_MSG_MAX_CHARS + 8,
    `学生段应当被截断（实际 ${studentSegment.length}）`
  )
  const assistantSegment = user.split('\n').find((line) => line.includes('助手：')) ?? ''
  assert.ok(
    assistantSegment.length <= REFRESH_MSG_MAX_CHARS + 8,
    `★ 助手段尤其要截断（它通常最长；实际 ${assistantSegment.length}）`
  )
})

test('G-M-5b 载荷里没有 displayName / 真名（白名单标签之外的字段一个都不发）', () => {
  const { system, user } = buildRefreshPayload({
    turns: [{ user: '继续', assistant: '好', turn: 1 }],
    knownTags: [{ key: 'subject', value: '数学' }]
  })
  const all = system + '\n' + user
  assert.ok(!/realName|displayName|student_name/i.test(all), '真名类字段绝不进载荷')
  // 已知标签仍在（它是「别重复输出」的依据）
  assert.ok(user.includes('subject=数学'), '已有画像要告诉模型')
})

test('载荷 prompt 带 source 分辨纪律与 inferred 限键', () => {
  const { system } = buildRefreshPayload({ turns: [{ user: 'x', assistant: 'y', turn: 1 }], knownTags: [] })
  assert.ok(system.includes('observed'), 'prompt 必须教模型用 observed')
  assert.ok(system.includes('inferred'), 'prompt 必须教模型用 inferred')
  assert.ok(system.includes('explain_style'), 'prompt 必须点名 inferred 能写的限键之一')
})

test('载荷对空窗口 / 空标签稳健', () => {
  const { system, user } = buildRefreshPayload({ turns: [], knownTags: [] })
  assert.ok(system.length > 0, '空窗口也要出一份可用的 system')
  assert.ok(user.includes('（无）'), '没有已知标签时给「（无）」而不是空串')
})

/* ------------------------------------------------------------------ *
 * 二期：回执解析（parseRefreshTags）
 * ------------------------------------------------------------------ */

test('G-M-1b 解析器拒绝 declared：概括无权产出学生自述', () => {
  const tags = parseRefreshTags(
    JSON.stringify({ tags: [{ key: 'interest_topic', value: '太空', source: 'declared', confidence: 0.9 }] })
  )
  assert.equal(tags.length, 0, '★ declared 必须被解析器丢掉（那是五问那条路专属的来源）')
})

test('G-M-1c 缺 source 不兜底成 observed（宁缺毋滥）', () => {
  const tags = parseRefreshTags(JSON.stringify({ tags: [{ key: 'interest_topic', value: '太空' }] }))
  assert.equal(tags.length, 0, '★ 没声明 source 就丢 —— 兜底会让「没声明」静默变成「学生说过的」')
})

test('G-H-10b inferred 限键在解析侧生效：inferred 写 interest_topic 被丢', () => {
  const tags = parseRefreshTags(
    JSON.stringify({
      tags: [
        { key: 'interest_topic', value: '太空', source: 'inferred', confidence: 0.8 },
        { key: 'explain_style', value: '喜欢例子', source: 'inferred', confidence: 0.8 },
        { key: 'interest_topic', value: '恐龙', source: 'observed', confidence: 0.8 }
      ]
    })
  )
  // inferred 的 interest_topic 被丢；inferred 的 explain_style 留下；observed 的 interest_topic 留下
  assert.equal(tags.length, 2, 'inferred 越界的那条应当被丢')
  assert.ok(
    tags.some((item) => item.key === 'explain_style' && item.source === 'inferred'),
    'inferred 的白名单键应当保留'
  )
  assert.ok(
    tags.some((item) => item.key === 'interest_topic' && item.source === 'observed'),
    'observed 可以写全白名单'
  )
})

test('G-M-8b 超出 REFRESH_MAX_TAGS 只取前 N 条，不补位', () => {
  const raw = JSON.stringify({
    tags: Array.from({ length: 10 }, (_, index) => ({
      key: 'explain_style',
      value: `值${index}`,
      source: 'observed',
      confidence: 0.5
    }))
  })
  // 同 key 重复只留第一条 —— 所以这里构造不同 key 来测上限
  const distinct = JSON.stringify({
    tags: [
      { key: 'explain_style', value: 'a', source: 'observed' },
      { key: 'output_length', value: 'b', source: 'observed' },
      { key: 'pace', value: 'c', source: 'observed' },
      { key: 'practice_type', value: 'd', source: 'observed' },
      { key: 'tone', value: 'e', source: 'observed' },
      { key: 'scene', value: 'f', source: 'observed' }
    ]
  })
  const tags = parseRefreshTags(distinct)
  assert.equal(tags.length, REFRESH_MAX_TAGS, `最多取 ${REFRESH_MAX_TAGS} 条`)
  // 同 key 重复只留第一条
  const dup = parseRefreshTags(raw)
  assert.equal(dup.length, 1, '同 key 重复只留第一条')
})

/* ------------------------------------------------------------------ *
 * 维度 13（2026-09-30）：学习类型与性格的词表闸
 * ------------------------------------------------------------------ */

test('G-M-7b 性格 / 学习类型的值必须在封闭词表内（越界即丢，不阻塞同批其它条）', () => {
  const tags = parseRefreshTags(
    JSON.stringify({
      tags: [
        { key: 'personality', value: '活泼开朗', source: 'inferred', confidence: 0.7 }, // 词表外
        { key: 'personality', value: '好奇', source: 'inferred', confidence: 0.7 }, // 词表内
        { key: 'learner_style', value: '聪明型', source: 'inferred', confidence: 0.7 }, // 词表外
        { key: 'learner_style', value: '钻研型', source: 'inferred', confidence: 0.7 } // 词表内
      ]
    })
  )
  assert.equal(tags.length, 2, '词表外的两条必须被丢（同 key 的第一条被丢后，第二条仍有机会）')
  assert.ok(
    tags.some((item) => item.key === 'personality' && item.value === '好奇'),
    '词表内的性格值应当保留'
  )
  assert.ok(
    tags.some((item) => item.key === 'learner_style' && item.value === '钻研型'),
    '词表内的学习类型值应当保留'
  )
})

test('G-M-7c 词表闸对 observed 同样生效（不是只管 inferred）', () => {
  const tags = parseRefreshTags(
    JSON.stringify({ tags: [{ key: 'personality', value: '抑郁', source: 'observed' }] })
  )
  assert.equal(tags.length, 0, '★ 临床词汇即便来自 observed 也写不进去（词表是本键唯一的取值域）')
})

test('载荷 prompt 把两个新词表拼给模型（只 import 不拼 = 模型仍会写词表外的词）', () => {
  const { system } = buildRefreshPayload({
    turns: [{ user: 'x', assistant: 'y', turn: 1 }],
    knownTags: []
  })
  for (const word of PERSONALITY_VALUES) {
    assert.ok(system.includes(word), `prompt 必须含性格词表词：${word}`)
  }
  for (const word of LEARNER_STYLE_VALUES) {
    assert.ok(system.includes(word), `prompt 必须含学习类型词表词：${word}`)
  }
  // 新口径：三禁令仍在，且「性格」不再出现在禁令句里
  assert.ok(system.includes('不要推断学生的心理状态、家庭情况或智能水平'), '三禁令必须仍在 prompt 里')
  assert.ok(!system.includes('不要推断学生的性格'), '旧口径（含性格的禁令句）必须已改写')
})

test('解析器对脏回执稳健：非 JSON / 缺 tags / 脏字段一律安全落地', () => {
  assert.deepEqual(parseRefreshTags('不是 JSON'), [])
  assert.deepEqual(parseRefreshTags(''), [])
  assert.deepEqual(parseRefreshTags('{"tags":"不是数组"}'), [])
  assert.deepEqual(parseRefreshTags('{"tags":[null, 42, {"key":"","value":"x","source":"observed"}]}'), [])
  // 代码块包裹也认
  const fenced = parseRefreshTags(
    '```json\n{"tags":[{"key":"tone","value":"轻松","source":"observed","confidence":0.7}]}\n```'
  )
  assert.equal(fenced.length, 1)
  assert.equal(fenced[0]?.key, 'tone')
  // 置信度越界被夹到 [0,1]
  const clamped = parseRefreshTags(
    '{"tags":[{"key":"tone","value":"轻松","source":"observed","confidence":5}]}'
  )
  assert.equal(clamped[0]?.confidence, 1)
})

/* ------------------------------------------------------------------ *
 * 二期：编排（runRefresh）—— 用替身断言「什么时候跑、发什么、写什么」
 * ------------------------------------------------------------------ */

/** 造一套可断言的 deps：模型返回给定 JSON，落库记录收到的标签。 */
function fakeDeps(options: {
  modelReply?: string
  knownTags?: { key: string; value: string }[]
  applyResult?: { applied: string[]; rejected: { key: string; reason: string }[] }
  /** 后端回执里的「应用后的最新投影」（缺省 = 已写入的那几条）。 */
  projectedTags?: { key: string; value: string }[]
  failModel?: boolean
}) {
  const seen = {
    userBody: [] as string[],
    applied: [] as { key: string; value: string; source: string }[],
    calls: 0
  }
  return {
    seen,
    deps: {
      getConfig: async () => ({ baseUrl: 'https://example.test/v1', modelId: 'm', apiKey: 'sk-test' }),
      readKnownTags: async () => options.knownTags ?? [],
      applyTags: async (_sid: string, tags: readonly { key: string; value: string; source: string }[]) => {
        seen.applied = tags.map((item) => ({ key: item.key, value: item.value, source: item.source }))
        const appliedKeys = options.applyResult?.applied ?? tags.map((item) => item.key)
        return {
          applied: appliedKeys,
          rejected: options.applyResult?.rejected ?? [],
          parentConsent: true,
          memorySwitch: true,
          // ★ 后端回执里的「应用后的最新投影」：默认按「已写入的那几条」造一份，
          //   与真实后端（RefreshApplyOut.tags）同形。传 options.projectedTags 可覆盖。
          tags:
            options.projectedTags ??
            tags
              .filter((item) => appliedKeys.includes(item.key))
              .map((item) => ({ key: item.key, value: item.value }))
        }
      },
      fetchResponse: async (_url: string, init: RequestInit) => {
        seen.calls += 1
        const body = JSON.parse(String(init.body)) as { messages: { content: string }[] }
        seen.userBody.push(body.messages[1]?.content ?? '')
        if (options.failModel) throw new Error('网络不可达')
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: options.modelReply ?? '{"tags":[]}' } }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
    }
  }
}

test('runRefresh：未到触发条件时什么都不做', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  noteTurn(sid, '只有一轮')
  const { seen, deps } = fakeDeps({})
  const result = await runRefresh(sid, deps)
  assert.equal(result.ran, false, '没到 N 轮不该跑')
  assert.equal(seen.calls, 0, '不该发起任何模型调用')
})

test('runRefresh：攒够轮次 + 有内容 → 调模型 → 落库，且 markRefreshed 推进计数', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮：我想用生活里的例子学分数`)
    pushTurn(sid, `第 ${i} 轮：我想用生活里的例子学分数`, `好，那我们从分蛋糕讲起`, turn)
  }
  assert.equal(shouldRefresh(sid), true, '前置：该触发')
  const { seen, deps } = fakeDeps({
    modelReply: '{"tags":[{"key":"interest_topic","value":"分蛋糕","source":"observed","confidence":0.7}]}'
  })
  const result = await runRefresh(sid, deps)
  assert.equal(result.ran, true)
  assert.equal(result.ok, true)
  assert.equal(result.proposed, 1)
  assert.equal(result.applied, 1)
  assert.equal(seen.calls, 1, '应当调一次模型')
  assert.equal(seen.applied.length, 1, '应当把解析出的标签落库')
  assert.equal(seen.applied[0]?.source, 'observed')
  assert.equal(shouldRefresh(sid), false, '★ 跑完之后计数应当推进（不会下一轮又立刻触发）')
})

test('runRefresh：载荷里真的有对话内容（窗口 → 出网载荷）', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮我问了什么`)
    pushTurn(sid, `第 ${i} 轮我问了什么`, `第 ${i} 轮我答了什么`, turn)
  }
  const { seen, deps } = fakeDeps({})
  await runRefresh(sid, deps)
  const body = seen.userBody[0] ?? ''
  assert.ok(body.includes('第 1 轮我问了什么'), '最早那一轮的学生话应当在载荷里')
  assert.ok(body.includes('第 1 轮我答了什么'), '助手的话也应当在载荷里（它是上下文）')
  assert.ok(body.includes('[轮 1]'), '轮次要有编号（模型据此理解先后）')
})

test('runRefresh：模型失败 → 重试 1 次 → 仍失败走降级，且计数仍推进（不失败风暴）', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮内容`)
    pushTurn(sid, `第 ${i} 轮内容`, `答 ${i}`, turn)
  }
  const { seen, deps } = fakeDeps({ failModel: true })
  const result = await runRefresh(sid, deps)
  assert.equal(result.ran, true)
  assert.equal(result.ok, false)
  assert.equal(seen.calls, REFRESH_MAX_ATTEMPTS, `应当尝试 ${REFRESH_MAX_ATTEMPTS} 次（自动重试 1 次）`)
  assert.equal(seen.applied.length, 0, '失败时不该落库')
  assert.equal(shouldRefresh(sid), false, '★ 失败也要推进计数 —— 否则下一轮又立刻重试（失败风暴）')
})

test('runRefresh：没有可用配置 → 跳过并推进计数（不每轮空转）', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮内容`)
    pushTurn(sid, `第 ${i} 轮内容`, `答 ${i}`, turn)
  }
  const { seen, deps } = fakeDeps({})
  const noConfig = { ...deps, getConfig: async () => null }
  const result = await runRefresh(sid, noConfig)
  assert.equal(result.ran, false, '没有配置时不跑')
  assert.equal(seen.calls, 0)
  assert.equal(shouldRefresh(sid), false, '★ 没有配置也要推进计数（等配置补上后下一个周期再跑）')
})

test('runRefresh：窗口里只有空轮（学生没说话）→ 跳过', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, '') // 空文本 = 不实质
    pushTurn(sid, '', `系统消息 ${i}`, turn)
  }
  const { seen, deps } = fakeDeps({})
  const result = await runRefresh(sid, deps)
  assert.equal(result.ran, false, '没有学生的话就不概括')
  assert.equal(seen.calls, 0)
})

test('runRefresh：按学生隔离 —— B 同学的触发不吃 A 同学的窗口', async () => {
  const a = freshStudent()
  const b = freshStudent()
  resetTurnClock(a)
  resetTurnClock(b)
  clearTranscriptWindow(a)
  clearTranscriptWindow(b)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(a, `A 的第 ${i} 轮：我对太空很感兴趣`)
    pushTurn(a, `A 的第 ${i} 轮：我对太空很感兴趣`, '好', turn)
  }
  // B 只走了一轮
  noteTurn(b, 'B 的一轮')
  const { seen, deps } = fakeDeps({})
  const result = await runRefresh(b, deps)
  assert.equal(result.ran, false, 'B 没攒够轮次，不该因为 A 攒够了而触发')
  assert.equal(seen.calls, 0)
})

/* ------------------------------------------------------------------ *
 * 三期：画像小结的输入必须是「落库之后」的画像（2026-10-22 修的缺陷）
 * ------------------------------------------------------------------ */

test('runRefresh：小结拿到的是**落库后**的投影（不是落库前的旧快照）', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮：我对太空很感兴趣`)
    pushTurn(sid, `第 ${i} 轮：我对太空很感兴趣`, '好', turn)
  }
  // 落库**之前**的画像只有 subject（旧快照）
  // 落库**之后**的投影多了一条 interest_topic（本轮刚写进去的）
  const { deps } = fakeDeps({
    modelReply: '{"tags":[{"key":"interest_topic","value":"太空","source":"observed","confidence":0.7}]}',
    knownTags: [{ key: 'subject', value: '数学' }],
    projectedTags: [
      { key: 'subject', value: '数学' },
      { key: 'interest_topic', value: '太空' }
    ]
  })

  // 拦下小结的载荷：它必须包含本轮刚写入的 interest_topic
  const bodies: string[] = []
  const originalFetch = deps.fetchResponse
  const withSummary = {
    ...deps,
    userDataDir: mkdtempSync(join(tmpdir(), 'k12-refresh-summary-')),
    fetchResponse: async (url: string, init: RequestInit, span?: unknown) => {
      const parsed = JSON.parse(String(init.body)) as { messages: { content: string }[] }
      bodies.push(parsed.messages[1]?.content ?? '')
      return (originalFetch as (u: string, i: RequestInit, s?: unknown) => Promise<Response>)(url, init, span)
    }
  }

  try {
    const result = await runRefresh(sid, withSummary)
    assert.equal(result.ok, true)
    // 两次模型调用：① 概括 ② 小结
    const summaryBody = bodies.find((body) => body.includes('画像标签'))
    assert.ok(summaryBody !== undefined, '画像落库后应当顺带生成一次小结（fire-and-forget 也会在 await 里跑完）')
    assert.ok(
      summaryBody.includes('interest_topic=太空'),
      '★ 小结的输入必须是**落库之后**的画像：本轮刚写入的 interest_topic 必须在内（此前传的是旧快照，会缺这一条）'
    )
  } finally {
    rmSync(withSummary.userDataDir, { recursive: true, force: true })
  }
})

test('runRefresh：回执没带投影时，用「旧画像 + 本轮实际写入」合并兜底', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮内容`)
    pushTurn(sid, `第 ${i} 轮内容`, '好', turn)
  }
  const { deps } = fakeDeps({
    modelReply: '{"tags":[{"key":"interest_topic","value":"太空","source":"observed"}]}',
    knownTags: [{ key: 'subject', value: '数学' }],
    // ★ 旧版后端不回 tags → 空数组
    projectedTags: [],
    // 后端确认只写入了 interest_topic
    applyResult: { applied: ['interest_topic'], rejected: [] }
  })

  const bodies: string[] = []
  const originalFetch = deps.fetchResponse
  const withSummary = {
    ...deps,
    userDataDir: mkdtempSync(join(tmpdir(), 'k12-refresh-merge-')),
    fetchResponse: async (url: string, init: RequestInit, span?: unknown) => {
      const parsed = JSON.parse(String(init.body)) as { messages: { content: string }[] }
      bodies.push(parsed.messages[1]?.content ?? '')
      return (originalFetch as (u: string, i: RequestInit, s?: unknown) => Promise<Response>)(url, init, span)
    }
  }

  try {
    await runRefresh(sid, withSummary)
    const summaryBody = bodies.find((body) => body.includes('画像标签'))
    assert.ok(summaryBody !== undefined, '应当生成小结')
    assert.ok(summaryBody.includes('subject=数学'), '旧画像里的标签要保留')
    assert.ok(summaryBody.includes('interest_topic=太空'), '本轮实际写入的标签要合并进来')
  } finally {
    rmSync(withSummary.userDataDir, { recursive: true, force: true })
  }
})

test('runRefresh：被分档拒掉的条目**不进**小结（画像里没有的东西不能说）', async () => {
  const sid = freshStudent()
  resetTurnClock(sid)
  clearTranscriptWindow(sid)
  for (let i = 1; i <= PROFILE_REFRESH_EVERY_TURNS; i += 1) {
    const turn = noteTurn(sid, `第 ${i} 轮内容`)
    pushTurn(sid, `第 ${i} 轮内容`, '好', turn)
  }
  const { deps } = fakeDeps({
    modelReply:
      '{"tags":[{"key":"interest_topic","value":"太空","source":"observed"},{"key":"pace","value":"慢","source":"inferred"}]}',
    knownTags: [],
    projectedTags: [],
    // pace 被分档拒（比如现有 declared 保护），只有 interest_topic 真写进去了
    applyResult: { applied: ['interest_topic'], rejected: [{ key: 'pace', reason: 'declared-protected' }] }
  })

  const bodies: string[] = []
  const originalFetch = deps.fetchResponse
  const withSummary = {
    ...deps,
    userDataDir: mkdtempSync(join(tmpdir(), 'k12-refresh-reject-')),
    fetchResponse: async (url: string, init: RequestInit, span?: unknown) => {
      const parsed = JSON.parse(String(init.body)) as { messages: { content: string }[] }
      bodies.push(parsed.messages[1]?.content ?? '')
      return (originalFetch as (u: string, i: RequestInit, s?: unknown) => Promise<Response>)(url, init, span)
    }
  }

  try {
    await runRefresh(sid, withSummary)
    const summaryBody = bodies.find((body) => body.includes('画像标签'))
    assert.ok(summaryBody !== undefined, '应当生成小结')
    assert.ok(summaryBody.includes('interest_topic=太空'), '真写进去的要进小结')
    assert.ok(
      !summaryBody.includes('pace=慢'),
      '★ 被分档拒掉的条目绝不能进小结 —— 否则会说出画像里根本没有的偏好'
    )
  } finally {
    rmSync(withSummary.userDataDir, { recursive: true, force: true })
  }
})
