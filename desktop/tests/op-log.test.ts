/**
 * 操作日志（stores/opLog.ts）单测：把「面板显示什么」与「环形上限是否真的生效」
 * 钉在一处，逐条对应冻结接口 v1 的行为契约。
 *
 * ★ 为什么这些断言值得写：200 条上限与「时间升序」是两个**会静默漂移**的约定 ——
 *   上限写反只表现为「开久了内存单调上涨」，升序写反只表现为「复制出来的行倒着」，
 *   两者都不会让界面报错。纯函数全是确定性的「输入 → 输出」，最适合逐条钉死；
 *   store 那几条盯的是 id 自增与「2 个 0 值不被逻辑或吞掉」这类只在边界露头的事。
 *
 * 跑法与 renderer-onboarding.test.ts 一致（Node 内置类型擦除 + 内置断言 +
 * 给相对且无扩展名的说明符补 .ts 的解析 hook + 每个用例一份干净的 Pinia）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'
import type { OpLogEntry, OpLogLevel } from '../src/renderer/src/stores/opLog.ts'

/**
 * 渲染进程的模块只按 Vite 的口味写相对导入（from '../labels'，不带扩展名），
 * 而 Node ESM 要求显式扩展名。这个 hook 只给「相对且没写扩展名」的说明符补 '.ts'。
 *
 * ⚠️ 被测模块必须用**动态 import**：ESM 把静态 import 提到模块顶部，
 *    而 hook 是在那之后才注册的（上面的 'import type' 在类型擦除时整行消失，不算）。
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

const {
  OP_LOG_LIMIT,
  LEVEL_LABEL,
  ACTION_LABEL,
  trimEntries,
  filterEntries,
  countLevels,
  formatDuration,
  formatClock,
  formatEntriesForCopy,
  useOpLog
} = await import('../src/renderer/src/stores/opLog.ts')

/** 造一条确定性的 entry：没显式给字段时用可预期的值，用例之间不互相干扰。 */
let seq = 0
function makeEntry(over: Partial<OpLogEntry> = {}): OpLogEntry {
  seq += 1
  return {
    id: seq,
    at: seq,
    level: 'info',
    action: 'read',
    target: '',
    detail: '',
    durationMs: null,
    ...over
  }
}

/**
 * 用**本地**时间字段造时间戳：被测实现按本地时区取值（刻意不用 toLocaleTimeString）。
 * 固定 1 月 15 日避免夏令时边界，断言因此与运行机器的时区无关。
 */
function atLocal(hour: number, minute: number, second: number): number {
  return new Date(2026, 0, 15, hour, minute, second, 0).getTime()
}

/* ================================================================== *
 * ① 标签表
 * ================================================================== */

test('LEVEL_LABEL / ACTION_LABEL：键集合恰好齐全，值都是中文', () => {
  const levelKeys: OpLogLevel[] = ['info', 'success', 'warn', 'error']
  assert.deepEqual(
    Object.keys(LEVEL_LABEL).sort(),
    ['error', 'info', 'success', 'warn'],
    '级别标签必须恰好四个键（少一个会让 formatEntriesForCopy 某级别整行拼不出来）'
  )
  assert.deepEqual(
    Object.keys(ACTION_LABEL).sort(),
    ['import', 'read', 'rebuild'],
    '动作标签必须恰好三个键'
  )
  for (const key of levelKeys) {
    const label = LEVEL_LABEL[key]
    assert.ok(/[\u4e00-\u9fff]/.test(label), '级别 ' + key + ' 的中文标签缺失，实得：' + JSON.stringify(label))
  }
  for (const key of Object.keys(ACTION_LABEL) as Array<keyof typeof ACTION_LABEL>) {
    const label = ACTION_LABEL[key]
    assert.ok(/[\u4e00-\u9fff]/.test(label), '动作 ' + key + ' 的中文标签缺失，实得：' + JSON.stringify(label))
  }
})

/* ================================================================== *
 * ② formatDuration：四个分支
 * ================================================================== */

test('formatDuration：毫秒 / 秒 / 零 / 缺失四条分支', () => {
  assert.equal(formatDuration(820), '820ms', '不足 1s 用毫秒（不带小数）')
  assert.equal(formatDuration(6432), '6.4s', '达到 1s 用一位小数的秒')
  assert.equal(formatDuration(0), '0ms', '0 是合法耗时（秒回），不是「没有耗时」')
  assert.equal(formatDuration(null), '', 'null 表示没有耗时 → 空串，调用方据此整段省略方括号')
  assert.equal(formatDuration(undefined), '', 'undefined 同上')
  assert.equal(formatDuration(-1), '', '负数不是耗时')
  assert.equal(formatDuration(999), '999ms', '999ms 仍走毫秒分支（边界：< 1000）')
  assert.equal(formatDuration(1000), '1.0s', '1000ms 走秒分支（边界：>= 1000）')
})

/* ================================================================== *
 * ③ formatClock：本地时区、24 小时制、两位补零
 * ================================================================== */

test('formatClock：本地时区 24 小时制，时分秒都补零', () => {
  assert.equal(formatClock(atLocal(3, 4, 5)), '03:04:05', '个位数必须补零')
  assert.equal(formatClock(atLocal(15, 0, 0)), '15:00:00', '24 小时制：下午 3 点写成 15 而不是 03')
  assert.equal(formatClock(atLocal(0, 0, 0)), '00:00:00', '午夜是 00，不是 12 也不是 24')
  const clock = formatClock(Date.now())
  assert.match(clock, /^\d{2}:\d{2}:\d{2}$/, '形状恒为 HH:mm:ss，实得：' + clock)
})

/* ================================================================== *
 * ④ trimEntries：环形上限
 * ================================================================== */

test('trimEntries：205 条裁到 200 条，保留的是**最后** 200 条（丢最旧 5 条）', () => {
  const entries = Array.from({ length: 205 }, (_, index) => makeEntry({ id: index + 1, at: index + 1 }))
  const trimmed = trimEntries(entries)
  assert.equal(trimmed.length, 200, '默认上限必须裁到 OP_LOG_LIMIT=200')
  assert.equal(trimmed.length, OP_LOG_LIMIT, '裁到的长度应等于导出的 OP_LOG_LIMIT 常量')
  assert.notEqual(trimmed, entries, '必须返回新数组（调用方靠数组身份判断有没有变）')
  assert.equal(trimmed[0].id, 6, '第一条应是原第 6 条 —— 丢的是最旧 5 条，不是最新 5 条')
  assert.equal(trimmed[trimmed.length - 1].id, 205, '最后一条仍是最新的那条')
  assert.deepEqual(
    trimmed.map((entry) => entry.id),
    entries.slice(5).map((entry) => entry.id),
    '留下的必须逐条等于原数组的末 200 条'
  )
})

test('trimEntries：未超限时也返回新数组，且不修改入参', () => {
  const entries = [makeEntry({ id: 1 }), makeEntry({ id: 2 })]
  const copy = trimEntries(entries)
  assert.notEqual(copy, entries, '未超限也要返回新数组，不能原样把入参递回去')
  assert.deepEqual(copy, entries, '内容逐条相同')
  copy.push(makeEntry({ id: 999 }))
  assert.deepEqual(
    entries.map((entry) => entry.id),
    [1, 2],
    '改返回值不许反过来改到入参（原地 splice 的典型事故）'
  )
  assert.equal(trimEntries([]).length, 0, '空数组裁完还是空数组')
  assert.deepEqual(
    trimEntries(entries, 1).map((entry) => entry.id),
    [2],
    '显式 limit=1 时只留最后一条'
  )
})

/* ================================================================== *
 * ⑤ filterEntries
 * ================================================================== */

test("filterEntries(entries, 'all')：返回全部，且是新数组", () => {
  const entries = [makeEntry({ level: 'info' }), makeEntry({ level: 'error' })]
  const all = filterEntries(entries, 'all')
  assert.equal(all.length, 2, "'all' 不该筛掉任何一条")
  assert.notEqual(all, entries, "'all' 也必须返回新数组（避免调用方误改 store 里那份）")
  assert.deepEqual(all, entries, '内容与入参逐条相同')
})

test('filterEntries：按级别只留相等的那批', () => {
  const entries = [
    makeEntry({ level: 'info', detail: 'i1' }),
    makeEntry({ level: 'error', detail: 'e1' }),
    makeEntry({ level: 'info', detail: 'i2' }),
    makeEntry({ level: 'warn', detail: 'w1' })
  ]
  assert.deepEqual(
    filterEntries(entries, 'info').map((entry) => entry.detail),
    ['i1', 'i2'],
    "筛 'info' 只留 info 的两条，顺序不变"
  )
  assert.deepEqual(filterEntries(entries, 'warn').map((entry) => entry.detail), ['w1'], "筛 'warn' 只留 warn")
  assert.deepEqual(filterEntries(entries, 'success'), [], '没有该级别时是空数组，不是把入参原样返回')
  assert.notEqual(filterEntries(entries, 'info'), entries, '筛选结果必须是新数组')
})

/* ================================================================== *
 * ⑥ countLevels：四个键恒在
 * ================================================================== */

test('countLevels([])：四个键恒在且都是 0（界面的「0 条」格子不许消失）', () => {
  assert.deepEqual(
    countLevels([]),
    { info: 0, success: 0, warn: 0, error: 0 },
    '空输入也要给全四个键，缺键会让界面某格凭空消失'
  )
  assert.deepEqual(
    Object.keys(countLevels([])).sort(),
    ['error', 'info', 'success', 'warn'],
    '键集合恒为四个级别'
  )
})

test('countLevels：按级别计数，未出现的级别是 0 而不是缺键', () => {
  const counts = countLevels([
    makeEntry({ level: 'info' }),
    makeEntry({ level: 'info' }),
    makeEntry({ level: 'error' })
  ])
  assert.deepEqual(
    counts,
    { info: 2, success: 0, warn: 0, error: 1 },
    '计数要落在正确的键上（success/warn 没出现也要在，值为 0）'
  )
})

/* ================================================================== *
 * ⑦ formatEntriesForCopy：行形状 / 字段省略 / 顺序
 * ================================================================== */

test('formatEntriesForCopy([])：空输入给空串', () => {
  assert.equal(formatEntriesForCopy([]), '', '没有日志时复制内容必须是空串，不是空行')
})

test('formatEntriesForCopy：行形状 = HH:mm:ss  级别中文  动作中文  [target]  [detail]  [耗时]', () => {
  const entry = makeEntry({
    at: atLocal(3, 4, 5),
    level: 'success',
    action: 'rebuild',
    target: '七年级上册',
    detail: '重建完成',
    durationMs: 820
  })
  assert.equal(formatClock(entry.at), '03:04:05', '前置：时钟按本地时区取值')
  const line = formatEntriesForCopy([entry])
  const expected = [
    '03:04:05',
    LEVEL_LABEL.success,
    ACTION_LABEL.rebuild,
    '[七年级上册]',
    '[重建完成]',
    '[820ms]'
  ].join('  ')
  assert.equal(line, expected, '字段之间恰好两个空格、非空字段带方括号，实得：' + JSON.stringify(line))
  assert.equal(line.split('  ').length, 6, '整行被两个空格切成恰好 6 段（多/少一段都是分隔符写错了）')
})

test('formatEntriesForCopy：空字段整段省略，既不留 [] 也不留多余空格', () => {
  const bare = makeEntry({
    at: atLocal(0, 0, 0),
    level: 'info',
    action: 'import',
    target: '',
    detail: '',
    durationMs: null
  })
  const line = formatEntriesForCopy([bare])
  const expected = ['00:00:00', LEVEL_LABEL.info, ACTION_LABEL.import].join('  ')
  assert.equal(line, expected, '没有 target/detail/耗时时行尾不该留下空白段，实得：' + JSON.stringify(line))
  assert.ok(!line.includes('['), '空字段不许写成 [] 占位')
  assert.equal(line, line.trimEnd(), '行尾不许留空格（粘到聊天窗口里看不出来）')

  const withTarget = makeEntry({
    at: atLocal(12, 30, 0),
    level: 'warn',
    action: 'read',
    target: '知识点清单',
    detail: '',
    durationMs: 0
  })
  const withTargetLine = formatEntriesForCopy([withTarget])
  const withTargetExpected = [
    '12:30:00',
    LEVEL_LABEL.warn,
    ACTION_LABEL.read,
    '[知识点清单]',
    '[0ms]'
  ].join('  ')
  assert.equal(
    withTargetLine,
    withTargetExpected,
    'durationMs=0 是合法耗时（秒回），必须显示 [0ms] 而不是被整段省略'
  )
})

test("formatEntriesForCopy：按 at 升序、'\\n' 连接，且不原地改入参数组顺序", () => {
  const late = makeEntry({ at: atLocal(9, 0, 0), detail: '后发生的' })
  const early = makeEntry({ at: atLocal(8, 0, 0), detail: '先发生的' })
  const lines = formatEntriesForCopy([late, early]).split('\n')
  assert.equal(lines.length, 2, "两条日志必须两行，用 '\n' 连接（不是空格也不是逗号）")
  assert.ok(lines[0].startsWith('08:00:00'), '第一行应是更早发生的那条（按 at 升序），实得：' + lines[0])
  assert.ok(lines[1].startsWith('09:00:00'), '第二行应是更晚发生的那条')
  assert.ok(lines[0].includes('先发生的'), '排序时要连内容一起搬，不能只对时间戳排序')
  assert.deepEqual(
    [late.at, early.at],
    [atLocal(9, 0, 0), atLocal(8, 0, 0)],
    '排序必须发生在副本上，不许原地改入参数组顺序'
  )
})

/* ================================================================== *
 * ⑧ store：id / 缺省值 / 0 值 / 环形上限 / clear
 * ================================================================== */

test('store：push 三条 → total / counts / 升序 / id 从 1 起自增', () => {
  setActivePinia(createPinia())
  const opLog = useOpLog()
  assert.equal(opLog.total, 0, '前置：store 初始为空')
  assert.equal(opLog.entries.length, 0, '前置：entries 初始为空数组')
  assert.deepEqual(
    opLog.counts,
    { info: 0, success: 0, warn: 0, error: 0 },
    '初始 counts 四键恒在'
  )

  opLog.push({ level: 'info', action: 'import', detail: '开始导入', at: 100 })
  opLog.push({ level: 'success', action: 'import', detail: '已接收', at: 200 })
  opLog.push({ level: 'error', action: 'read', detail: '读取失败', at: 300 })

  assert.equal(opLog.total, 3, 'total 等于 entries.length')
  assert.equal(opLog.entries.length, 3, 'push 三条就该有三条')
  assert.deepEqual(
    opLog.entries.map((entry) => entry.id),
    [1, 2, 3],
    'id 从 1 起单调自增'
  )
  assert.deepEqual(
    opLog.entries.map((entry) => entry.at),
    [100, 200, 300],
    '时间升序：最旧在 [0]、最新在末尾（面板「滚到底 = 最新」的锚点）'
  )
  assert.deepEqual(
    opLog.counts,
    { info: 1, success: 1, warn: 0, error: 1 },
    'counts 随三条 push 更新'
  )
})

test("store.push：target 缺省 ''、durationMs 缺省 null、at 缺省 Date.now()", () => {
  setActivePinia(createPinia())
  const opLog = useOpLog()
  const before = Date.now()
  const entry = opLog.push({ level: 'info', action: 'read', detail: '空字段' })
  const after = Date.now()

  assert.equal(entry.target, '', "没给 target 就是空串（复制时整段省略，不留 '[]'）")
  assert.equal(entry.durationMs, null, '没给耗时就是 null —— 不是 0，0 表示「秒回」')
  assert.ok(
    entry.at >= before && entry.at <= after,
    '缺省 at 应是 Date.now()，实得 ' + entry.at + '（区间 ' + before + '..' + after + '）'
  )
  assert.equal(opLog.entries[0].id, entry.id, 'push 的返回值就是刚存进去的那条')
  assert.equal(opLog.entries[0].detail, '空字段', 'detail 原样落库')
})

test('store.push：0 值不被吞（at=0 / durationMs=0 都是合法值）', () => {
  setActivePinia(createPinia())
  const opLog = useOpLog()
  const entry = opLog.push({ level: 'success', action: 'rebuild', detail: '秒回', at: 0, durationMs: 0 })

  assert.equal(entry.at, 0, 'at=0 必须原样保留（用逻辑或兜底会被悄悄换成 Date.now()）')
  assert.equal(entry.durationMs, 0, 'durationMs=0 必须原样保留（不能被当成缺省换成 null）')
  assert.equal(formatDuration(entry.durationMs), '0ms', '0 耗时显示为 0ms')
})

test('store.push 250 次：恰好 200 条，且留下的是最近那批（id 51..250）', () => {
  setActivePinia(createPinia())
  const opLog = useOpLog()
  for (let index = 1; index <= 250; index += 1) {
    opLog.push({ level: 'info', action: 'read', detail: '#' + index, at: index })
  }

  assert.equal(OP_LOG_LIMIT, 200, '契约常量必须正好是 200')
  assert.equal(opLog.total, 200, '250 次 push 后 total 应是上限 200')
  assert.equal(opLog.entries.length, 200, '250 次 push 后 entries 恰 200 条')
  assert.equal(opLog.entries[0].id, 51, '最旧留下的应是第 51 条（前 50 条被环形丢弃）')
  assert.equal(
    opLog.entries[opLog.entries.length - 1].id,
    250,
    '最后一条是刚 push 进去的那条（保留的是最近那批）'
  )
  assert.deepEqual(
    opLog.entries.map((entry) => entry.id),
    Array.from({ length: 200 }, (_, index) => index + 51),
    '留下的恰好是最近的 200 条，且 id 连续升序'
  )
  assert.equal(opLog.entries[0].detail, '#51', '被丢掉的确实是最旧那批（按内容再核一遍）')
  assert.equal(opLog.counts.info, 200, 'counts 跟着裁剪后的 entries 走')
})

test('store.clear()：归零（entries / total / counts 一起清），且清完还能继续 push', () => {
  setActivePinia(createPinia())
  const opLog = useOpLog()
  opLog.push({ level: 'error', action: 'read', detail: 'x', at: 1 })
  opLog.push({ level: 'warn', action: 'import', detail: 'y', at: 2 })
  assert.equal(opLog.total, 2, '前置：清空前确有两条')

  opLog.clear()
  assert.equal(opLog.entries.length, 0, 'clear() 后 entries 必须为空')
  assert.equal(opLog.total, 0, 'clear() 后 total 归零')
  assert.deepEqual(
    opLog.counts,
    { info: 0, success: 0, warn: 0, error: 0 },
    'clear() 后 counts 四键归零'
  )

  const after = opLog.push({ level: 'info', action: 'read', detail: '清完再来', at: 3 })
  assert.equal(opLog.total, 1, '清空后仍能继续记录')
  assert.equal(after.id, 3, 'clear() 不重置 id 计数器（清的是屏幕，不是重开会话）')
})
