/**
 * 安全审查徽章（W4）的单测：两种态的文案**逐字**、显隐判据、以及「没判出学段时学段 chip 不显示」
 * 这条既有纪律没被破坏。
 *
 * ★ 文案是用户真机走查给定的（一个字都不改），所以这里必须**逐字**断言而不是 includes；
 *   显隐判据收口在 labels 的 showsSafetyReviewChip（组件不写第二个条件）。
 *
 * 跑法：node --test tests/safety-badge.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

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

const { SAFETY_REVIEW_PASSED_LABEL, SAFETY_REVIEW_FAILED_LABEL, showsSafetyReviewChip, showsStatusChip } =
  await import('../src/renderer/src/labels.ts')

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRenderer = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, 'src', 'renderer', 'src', ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

test('★ 两句徽章文案逐字（用户已给定，一个字都不能改）', () => {
  assert.equal(SAFETY_REVIEW_PASSED_LABEL, '已通过安全审查')
  assert.equal(SAFETY_REVIEW_FAILED_LABEL, '未通过安全审查')
})

test('★ 显隐判据：只有审查有结论的终态才显示（done / blocked），流式与真失败都不标', () => {
  assert.equal(showsSafetyReviewChip('done'), true, 'done = 终审通过，绿徽章')
  assert.equal(showsSafetyReviewChip('blocked'), true, 'blocked = 内容被撤回，红徽章')
  assert.equal(showsSafetyReviewChip('streaming'), false, '生成中还没终审，先标「已通过」是没发生的承诺')
  assert.equal(showsSafetyReviewChip('error'), false, '真失败没走到终审，没结论就不标')
})

test('★ 既有纪律回归：状态角标的显隐没被这次改动破坏（done 仍不显示）', () => {
  assert.equal(showsStatusChip('done'), false)
  assert.equal(showsStatusChip('streaming'), true)
  assert.equal(showsStatusChip('blocked'), true)
  assert.equal(showsStatusChip('error'), true)
})

test('★ 组件源码：徽章锚点 / 判据收口 / 两种态 / 盾牌只给通过那一态', () => {
  const source = readRenderer('components/ChatMessage.vue')

  assert.match(source, /data-testid="turn-safety"/, '徽章要有稳定锚点')
  assert.match(source, /:data-safety="safetyReview"/, '两种态要能机器读出来（passed / failed）')
  assert.ok(source.includes('showsSafetyReviewChip'), '显隐判据必须来自 labels（组件不写第二个条件）')
  assert.ok(source.includes('SAFETY_REVIEW_PASSED_LABEL'), '文案取自 labels（组件不拼词）')
  assert.ok(source.includes('SAFETY_REVIEW_FAILED_LABEL'), '同上')
  assert.match(
    source,
    /<ShieldCheck v-if="safetyReview === 'passed'"/,
    '盾牌图标只给「通过」那一态（红徽章没有盾牌）'
  )
  // 红/绿两种态的类名成对出现
  assert.match(source, /chip--safety--good/, '通过 = 绿底')
  assert.match(source, /chip--safety--bad/, '撤回 = 红底')
  // 位置：紧挨着学段标签（用户走查要求）
  const gradeAt = source.indexOf('data-testid="turn-grade"')
  const safetyAt = source.indexOf('data-testid="turn-safety"')
  assert.ok(gradeAt > 0 && safetyAt > gradeAt, '安全徽章必须排在学段标签之后（紧挨着它）')
})

test('★ 徽章颜色只走令牌（无硬编码色值），且圆角是矩形档不是胶囊', () => {
  const source = readRenderer('components/ChatMessage.vue')
  const start = source.indexOf('.chip--safety {')
  const end = source.indexOf('/* 回答 = 纸面上的正文', start)
  assert.ok(start > 0 && end > start, '必须能找到 .chip--safety 的样式段')
  const block = source.slice(start, end)
  assert.match(block, /background:\s*var\(--k12-good\)/, '通过态底色用 --k12-good')
  assert.match(block, /background:\s*var\(--k12-bad\)/, '撤回态底色用 --k12-bad')
  assert.match(block, /color:\s*var\(--k12-surface\)/, '白字来自 --k12-surface（与 .k12-cta 同源）')
  assert.match(block, /border-radius:\s*var\(--k12-r-inset\)/, '圆角矩形用 r-inset 档（刻意不是胶囊）')
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(block), '徽章样式里不许出现硬编码色值')
})

test('★ 既有纪律回归：没判出学段时学段 chip 不显示（v-if 绑在 gradeLabel 上）', () => {
  const source = readRenderer('components/ChatMessage.vue')
  assert.match(
    source,
    /v-if="gradeLabel"[\s\S]{0,160}?data-testid="turn-grade"/,
    '学段 chip 必须由 gradeLabel 控制 —— gradeLevel 为空时整块不渲染（不标一个假的）'
  )
  assert.doesNotMatch(
    source,
    /v-if="turn\.gradeLevel"[\s\S]{0,80}?data-testid="turn-grade"/,
    '不许绕过 gradeLabel 直接拿原始字段判显隐'
  )
})
