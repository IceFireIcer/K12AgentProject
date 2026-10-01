/**
 * 零轮次时的轮外子代理上屏（V5/V6）的守卫。
 *
 * 场景：学生首次启动、答完五问、**一次还没聊过** —— 五问概括这类旁路模型调用已经发生，
 * 但还没有任何轮次可以挂。主进程为此单开了快照级容器 offTurnSpans（到就推）。
 * 三条不变量：
 *   · 零轮次 + 只有 offTurnSpans：store 保留、时间线/浮窗仍出轮外段；
 *   · 旧信封（没有这个字段 / 字段是脏值）：按空数组，**不炸、也不渲染空段**；
 *   · 有轮次时只读该轮（轮外那些已被迁移进去）—— 同一批 span 不许出现两份。
 *
 * 跑法：node --test tests/runtime-offturn.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import type { DiagnosticsSnapshot, RuntimeSpan, TurnDiagnostics } from '../src/shared/diagnostics.ts'

const SRC_SHARED = new URL('../src/shared/', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@shared/')) {
      return { url: new URL(specifier.slice('@shared/'.length) + '.ts', SRC_SHARED).href, shortCircuit: true }
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

const { useDiagnosticsStore } = await import('../src/renderer/src/stores/diagnostics.ts')
const { emptyDiagnosticsSnapshot } = await import('../src/shared/diagnostics.ts')

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRenderer = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, 'src', 'renderer', 'src', ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

/** 剥注释（手写状态机）：注释里的说明不算实现。 */
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

function spanOf(id: string, offTurn: boolean): RuntimeSpan {
  return {
    id,
    kind: 'subagent',
    purpose: '五问概括',
    label: '五问概括',
    startedAt: 1_700_000_000_000,
    ms: 12,
    model: 'm-1',
    promptChars: 100,
    promptTokEst: 60,
    ok: true,
    note: null,
    offTurn,
    turnIndex: offTurn ? null : 1
  }
}

const ATTACHED = spanOf('span-turn-1', true)
const OFF_TURN = spanOf('span-ot-1', true)
const minimalTurn = { turn: 1, requestId: 'req-1', spans: [ATTACHED] } as unknown as TurnDiagnostics

function freshStore() {
  setActivePinia(createPinia())
  return useDiagnosticsStore()
}

test('★ 零轮次 + 只有 offTurnSpans：store 仍保留它们（主进程即时推来的数据不被吞）', () => {
  const store = freshStore()
  store.applySnapshot({ turns: [], limit: 20, persisted: false, updatedAt: 10, offTurnSpans: [OFF_TURN] })
  assert.deepEqual(store.turns, [], '一次还没聊过')
  assert.equal(store.latest, null)
  assert.equal(store.offTurnSpans.length, 1, '零轮次时只有快照级这一份能拿到数据')
  assert.equal(store.offTurnSpans[0]?.id, 'span-ot-1')
  assert.equal(store.offTurnSpans[0]?.offTurn, true)
})

test('★ 旧信封（没有 offTurnSpans / 字段是脏值）→ 空数组，不炸', () => {
  const store = freshStore()
  // 老形状：连字段都没有
  store.applySnapshot({ turns: [], limit: 20, persisted: false, updatedAt: 10 })
  assert.deepEqual(store.offTurnSpans, [])
  // 脏值：不是数组也不能抛
  store.applySnapshot({
    turns: [],
    limit: 20,
    persisted: false,
    updatedAt: 20,
    offTurnSpans: 'not-array'
  } as unknown as DiagnosticsSnapshot)
  assert.deepEqual(store.offTurnSpans, [])
  // 空快照（桥缺失时界面显示它）
  store.applySnapshot(emptyDiagnosticsSnapshot())
  assert.deepEqual(store.offTurnSpans, [])
  assert.deepEqual(store.turns, [])
})

test('★ 有轮次时按现状：轮外那份已被迁移进该轮，快照级不再重复持有', () => {
  const store = freshStore()
  store.applySnapshot({ turns: [minimalTurn], limit: 20, persisted: false, updatedAt: 10, offTurnSpans: [] })
  assert.equal(store.turns.length, 1)
  assert.equal(store.offTurnSpans.length, 0, '同一批 span 不留两份（迁移后快照级为空）')
  assert.equal(store.turns[0]?.spans?.length, 1, '迁移后的那份挂在轮次信封上')
})

test('★ 时间线：零轮次回落快照级；有轮次只读该轮（同一批不出现两次）', () => {
  const source = readRenderer('components/diag/DiagSequence.vue')
  const code = stripComments(source)
  assert.match(
    code,
    /props\.turn === null\s*\?\s*diagnostics\.offTurnSpans\s*:\s*spansOf\(props\.turn\)\.filter\(\(span\) => span\.offTurn\)/,
    '零轮次必须回落 diagnostics.offTurnSpans；有轮次只读该轮（两处都读会在同一屏出现两份）'
  )

  // 轮外段必须在 v-if="turn" 分支之外，否则零轮次又看不到
  const timelineAt = source.indexOf('data-testid="diag-sequence-timeline"')
  const offAt = source.indexOf('data-testid="diag-sequence-offturn"')
  assert.ok(timelineAt > 0 && offAt > timelineAt, '轮外段要排在主时间轴之后')
  const timelineTag = source.slice(source.lastIndexOf('<div', timelineAt), timelineAt)
  assert.ok(timelineTag.includes('v-if="turn"'), '主时间轴仍只在有轮次时渲染')
  const offTag = source.slice(source.lastIndexOf('<section', offAt), offAt)
  assert.equal(offTag.includes('v-if="turn"'), false, '轮外段不得被 v-if="turn" 挡住')
  assert.ok(offTag.includes('v-if="offTurnBlocks.length > 0"'), '没有轮外 span 时不渲染空段')
  assert.ok(source.includes('轮外（启动补跑）'), '沿用既有可读文案（不新造说法）')
})

test('★ 浮窗计数行：零轮次也反映，且三种情形文案分开', () => {
  const source = readRenderer('components/DiagnosticsPanel.vue')
  const code = stripComments(source)
  assert.match(
    code,
    /shown\.value === null\s*\?\s*diagnostics\.offTurnSpans\s*:\s*spansOf\(shown\.value\)/,
    '零轮次取快照级；有轮次只取该轮（同样不重复）'
  )
  assert.ok(code.includes('轮外子代理调用 '), '全是轮外时用一句话说清（不写成「N 次（其中轮外 N 次）」）')
  assert.ok(code.includes('其中轮外'), '混合时给「其中轮外 M 次」')
  assert.ok(source.includes('data-testid="diag-panel-spans"'), '计数行锚点还在')

  // 计数行的显隐只看 spanLine，不能被「没有轮次」再挡一次
  const lineAt = source.indexOf('data-testid="diag-panel-spans"')
  const lineTag = source.slice(source.lastIndexOf('<p', lineAt), lineAt)
  assert.ok(lineTag.includes('v-if="spanLine"'), '没有 span 时如实不显示（不渲染「0 次」假读数）')
  assert.equal(lineTag.includes('shown'), false, '零轮次时这一行照样在（数据源是快照级 offTurnSpans）')
})

test('★ store 源码：offTurnSpans 缺失/非数组一律空数组（旧信封容忍缺席）', () => {
  const code = stripComments(readRenderer('stores/diagnostics.ts'))
  assert.match(
    code,
    /const offTurnSpans = computed<RuntimeSpan\[\]>\(\(\) => \{[\s\S]{0,160}?Array\.isArray\(raw\) \? raw : \[\]/,
    '快照里没有这个字段（旧信封）或字段是脏值时按空数组处理'
  )
})
