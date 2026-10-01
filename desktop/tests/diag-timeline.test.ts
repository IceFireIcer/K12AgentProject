/**
 * 运行透视「调用顺序」时间线（V2）的源码级守卫。
 *
 * 三条不变量：
 *   · **既有锚点一个不少** —— diag-sequence / -legend / -steps 等被 demo-mode.test.ts 与
 *     CDP 探针按 testid 找；改版不许把它们弄丢；
 *   · **子代理泳道由 spans 驱动**（V1 的信封字段，kind='subagent'），offTurn 的另起一段；
 *   · **颜色不硬编码** —— 分类色只允许取既有分类令牌（本页是证据页，不新造色系）。
 *
 * 跑法：node --test tests/diag-timeline.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(
  join(DESKTOP_ROOT, 'src', 'renderer', 'src', 'components', 'diag', 'DiagSequence.vue'),
  'utf8'
).replace(/\r\n/g, '\n')

/** 剥注释（手写状态机）：注释里引用的旧写法不算实现。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += source[i]
    i += 1
  }
  return out
}
const CODE = stripComments(SOURCE)

test('★ 既有锚点一个不少（demo-mode 守卫与 CDP 探针按它们找）', () => {
  for (const testid of [
    'diag-sequence',
    'diag-sequence-legend',
    'diag-sequence-timeline',
    'diag-sequence-offturn',
    'diag-sequence-detail',
    'diag-sequence-steps'
  ]) {
    assert.ok(
      SOURCE.includes('data-testid="' + testid + '"'),
      '改造时间线时弄丢了锚点：' + testid + '（demo-mode.test.ts 与探针按它找）'
    )
  }
  assert.ok(CODE.includes('diag-sequence-lane-'), '每条泳道要有稳定的动态锚点')
  assert.ok(CODE.includes('lane.category'), '动态锚点要按分类名拼')
  assert.ok(CODE.includes(":data-cat=\"lane.category\""), '泳道要带 data-cat（分类色按它选）')
})

test('★ 子代理泳道由信封 spans 驱动（kind=subagent 的旁路模型调用）', () => {
  assert.ok(CODE.includes("from '@shared/diagnostics'"), 'span 类型必须来自 shared（跨进程唯一一份）')
  assert.ok(CODE.includes('RuntimeSpan'), '必须 import RuntimeSpan')
  assert.equal(CODE.includes('interface RuntimeSpan'), false, '不许手写第二份 span 形状')
  assert.ok(CODE.includes('turn.spans') || CODE.includes('.spans'), '子代理泳道必须读信封新增的 spans 字段')
  assert.ok(CODE.includes("'subagent'"), '分类里必须有 subagent 这一泳道')
  assert.ok(CODE.includes('spanBlock('), 'span → 时间轴块 的映射必须存在')
  assert.ok(CODE.includes('span.startedAt'), '子代理块用真实发生时刻定位（不按累加猜）')
  assert.ok(CODE.includes('span.ms'), '块宽用 span 的实际耗时')
  assert.ok(CODE.includes('span.promptChars'), '详情里给体量（字符数），正文从来不进这里')

  // 可选字段容忍缺席：旧信封 / 落盘回放那份没有 spans 时按空数组，而不是渲染空泳道
  const spansFnAt = CODE.indexOf('function spansOf(')
  assert.ok(spansFnAt > 0, '必须有一个统一的 spans 读取函数')
  const spansFn = CODE.slice(spansFnAt, spansFnAt + 420)
  assert.ok(spansFn.includes('Array.isArray'), 'spans 缺失 / 不是数组时退回空数组')
})

test('★ offTurn（轮外，如启动补跑）走独立分段，不混进本轮时间轴', () => {
  assert.ok(CODE.includes('offTurnSpans'), '轮外的 span 要单独成段')
  assert.ok(CODE.includes('offTurn'), '要按 offTurn 过滤')
  assert.ok(CODE.includes('轮外'), '要有「轮外」这个可读标识')
  assert.ok(SOURCE.includes('data-testid="diag-sequence-offturn"'), '轮外那一段要有自己的锚点')
})

test('★ 颜色只取既有分类令牌，不硬编码色值', () => {
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(SOURCE), false, '时间线里不许出现硬编码色值')
  assert.equal(/rgba?\(/.test(SOURCE), false, '不许出现 rgba() 字面量')
  assert.equal(/hsla?\(/.test(SOURCE), false, '不许出现 hsl() 字面量')
  assert.match(SOURCE, /--cat-ink:\s*var\(--k12-/, '分类色走 --cat-ink → 既有 --k12-* 令牌')
  assert.match(SOURCE, /--cat-soft:\s*var\(--k12-/, '分类底色同理')
  for (const cat of ['user', 'safety', 'grade', 'prompt', 'retrieval', 'tool', 'model', 'subagent', 'wrap']) {
    assert.ok(
      SOURCE.includes("[data-cat='" + cat + "']"),
      '分类 ' + cat + ' 缺少自己的颜色规则（泳道/图例会退回默认色）'
    )
  }
})

test('★ 横向时间轴：块宽 ∝ 耗时、有最短可见宽度、点击展开详情', () => {
  assert.ok(CODE.includes('widthOf(block)'), '块宽必须由耗时算出来')
  assert.ok(CODE.includes('leftOf(block)'), '块位置必须由轴上的时间算出来')
  assert.ok(CODE.includes('MIN_BLOCK_PX'), '0 耗时的块也要有最短可见宽度（看得见、点得到）')
  assert.match(CODE, /:style="\{ left:[^}]*width:[^}]*\}"/, '位置与宽度是内联比例样式（泳道之间才对得齐）')
  assert.ok(CODE.includes('@click="toggleBlock('), '点块要看详情')
  assert.ok(SOURCE.includes('data-testid="diag-sequence-detail"'), '详情区要有锚点')
})
