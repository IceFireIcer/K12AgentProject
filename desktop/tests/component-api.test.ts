/**
 * 组件 API 守卫：优化报告 §4.2（WP-12，组件 API 标准化）。
 *
 * ---------------------------------------------------------------------------
 * 报告点名的三类问题（本文件把它们变成机器判据）
 * ---------------------------------------------------------------------------
 *   ① 命名不统一：`tone` / `variant` / `type` 三种叫法混用；
 *   ② 布尔属性混乱：`flush` / `no-padding` 两种风格；
 *   ③ 缺少 TypeScript 约束：props 写成 `string` 而不是枚举。
 *
 * 判据：
 *   · 每个共享组件的 `defineProps` 必须是**类型化声明**（`defineProps<{…}>()`），
 *     不许用运行期数组（`defineProps(['a','b'])`），props 类型里不许出现 `any`；
 *   · 布尔属性的名字**不许**用 `is` / `no` 这类前后缀（正向命名：flush / disabled / loading）；
 *   · 词表唯一出处是 `types/component-props.ts`（`ComponentProps` + 各轴的联合类型），
 *     颜色变体叫 `variant`、表面叫 `tone`、尺寸叫 `size`；不许出现 `type` / `kind` / `look` 这类轴；
 *   · 报告点名的三处收口：`SurfacePanel.padding` 枚举四选一、`Badge.level` 严格枚举、
 *     `EmptyState` 文案长度校验。
 *
 * 跑法：`npm test`（纯源码扫描 + 纯函数断言）。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const R = 'src/renderer/src'
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

/** 共享组件（含卡片子组件与对话内卡片）。 */
function sharedComponentFiles(): string[] {
  const roots = [`${R}/components`, `${R}/components/card`, `${R}/cards`]
  return roots.flatMap((root) =>
    readdirSync(join(desktopRoot, ...root.split('/')), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.vue'))
      .map((entry) => `${root}/${entry.name}`)
  )
}

/** 取出 `defineProps<{ … }>()` 的泛型体（拿不到就返回 null）。 */
function propsBody(source: string): string | null {
  const start = source.indexOf('defineProps<')
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

/** 从 props 体里取出**属性名**（`foo?: type` / `foo: type` 两种写法）。 */
function propNames(body: string): string[] {
  const names: string[] = []
  for (const line of body.split('\n')) {
    const matched = /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(line)
    if (matched?.[1]) names.push(matched[1])
  }
  return names
}

/* ------------------------------------------------------------------ *
 * 1. ★★ 所有共享组件：props 必须类型化、不许 any、布尔不许 is/no 前缀
 * ------------------------------------------------------------------ */

test('★★ 共享组件的 defineProps 一律类型化，且 props 类型里没有 any', () => {
  const offenders: string[] = []
  for (const file of sharedComponentFiles()) {
    const source = read(...file.split('/'))
    if (!source.includes('defineProps')) continue
    // 运行期数组写法（`defineProps(['title'])`）没有类型约束
    if (/defineProps\(\s*\[/.test(source)) offenders.push(`${file} 用了运行期数组 defineProps([...])`)
    const body = propsBody(source)
    if (body === null) {
      offenders.push(`${file} 的 defineProps 不是泛型声明（拿不到类型体）`)
      continue
    }
    if (/\bany\b/.test(body)) offenders.push(`${file} 的 props 类型里出现 any`)
    // 宽松的 `string` 兜底：props 里 `padding?: string` 这类"任意字符串"是报告点名的缺陷
    if (/padding\??\s*:\s*string/.test(body)) offenders.push(`${file} 的 padding 仍是任意 string`)
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('★★ 布尔属性一律正向命名（不许 is / no / has-no 这类前缀）', () => {
  const offenders: string[] = []
  for (const file of sharedComponentFiles()) {
    const body = propsBody(read(...file.split('/')))
    if (body === null) continue
    for (const name of propNames(body)) {
      if (/^(is[A-Z_]|no[A-Z_]|hasNo|is-|no-)/.test(name)) {
        offenders.push(`${file} 的布尔属性 ${name} 用了负向 / 匈牙利前缀`)
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

test('★ 轴命名统一：颜色变体叫 variant、表面叫 tone、尺寸叫 size（不出现 type / kind / look）', () => {
  const offenders: string[] = []
  for (const file of sharedComponentFiles()) {
    const body = propsBody(read(...file.split('/')))
    if (body === null) continue
    for (const name of propNames(body)) {
      if (/^(type|kind|look|appearance|density|scale)$/.test(name)) {
        offenders.push(`${file} 用了 ${name} 这条轴（应为 variant / tone / size）`)
      }
    }
  }
  assert.deepEqual(offenders, [], offenders.join('\n'))
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 词表单一出处
 * ------------------------------------------------------------------ */

test('★★ 词表 `types/component-props.ts` 存在且导出报告要求的轴与枚举', () => {
  const source = read(...`${R}/types/component-props.ts`.split('/'))
  for (const token of [
    'export interface ComponentProps',
    'export type ControlVariant',
    'export type ControlSize',
    'export type SurfaceTone',
    'export type EmptyStateTone',
    'export type SkeletonVariant',
    'export type { BadgeLevel }',
    'export type SurfacePadding',
    'export type SurfaceRadius'
  ]) {
    assert.ok(source.includes(token), `component-props.ts 缺少 ${token}`)
  }
  // BadgeLevel 的**定义**在 components/badge-level.ts（零 import，便于 node 直接单测）——
  // 这里断言字面量就是报告点名的五个，且顺序是契约。
  const badgeLevel = read(...`${R}/components/badge-level.ts`.split('/'))
  assert.match(
    badgeLevel,
    /export type BadgeLevel = 'starter' \| 'beginner' \| 'skilled' \| 'expert' \| 'master'/,
    'BadgeLevel 必须是报告点名的五个字面量（顺序也是契约）'
  )
  // 组件从词表取类型，而不是各写各的联合类型字面量
  for (const [file, type] of [
    ['SurfacePanel.vue', 'SurfacePadding'],
    ['EmptyState.vue', 'EmptyStateTone'],
    ['Badge.vue', 'BadgeLevel'],
    ['Skeleton.vue', 'SkeletonVariant']
  ] as const) {
    const source = read(...`${R}/components/${file}`.split('/'))
    assert.ok(
      source.includes(type),
      `${file} 要从 component-props.ts 取 ${type}（不要在组件里另写一份联合类型）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 报告点名的三处收口
 * ------------------------------------------------------------------ */

test('★★ SurfacePanel：padding 收成枚举四选一（映射表在组件内）', () => {
  const source = read(...`${R}/components/SurfacePanel.vue`.split('/'))
  assert.match(source, /padding\?: SurfacePadding/, 'padding 必须是 SurfacePadding 枚举')
  assert.doesNotMatch(source, /padding\?: string/, 'padding 不许再是任意字符串')
  assert.match(source, /const PADDING_TOKENS: Record<SurfacePadding, string>/, '枚举要有一张唯一映射表')
  for (const value of ['none', 'sm', 'md', 'lg']) {
    assert.match(source, new RegExp(`\\b${value}:`), `映射表缺 ${value} 档`)
  }
  assert.match(source, /radius\?: SurfaceRadius/, 'radius 也必须是枚举（报告点名的严格类型）')
})

test('★★ Badge：level 是严格枚举，且解析是纯函数（可单测）', () => {
  const badge = read(...`${R}/components/Badge.vue`.split('/'))
  assert.match(badge, /level\?: BadgeLevel/, 'Badge 要有 level?: BadgeLevel（严格枚举）')
  assert.match(badge, /badgeLevelOf\(/, '档位要用纯函数解析（见 badge-level.ts）')
  const logic = read(...`${R}/components/badge-level.ts`.split('/'))
  assert.match(logic, /export function badgeLevelOf\(/, 'badge-level.ts 要导出 badgeLevelOf')
  assert.match(logic, /BADGE_LEVELS/, '枚举顺序来自 component-props.ts 的 BADGE_LEVELS')
})

test('★ badgeLevelOf：中文档位 → 英文枚举（认不出退回第一档，不猜高档）', async () => {
  const mod = await import('../src/renderer/src/components/badge-level.ts')
  assert.equal(mod.badgeLevelOf('起步-0'), 'starter')
  assert.equal(mod.badgeLevelOf('初通-1'), 'beginner')
  assert.equal(mod.badgeLevelOf('熟练-3'), 'skilled')
  assert.equal(mod.badgeLevelOf('精通-5'), 'expert')
  assert.equal(mod.badgeLevelOf('大师-6'), 'master')
  assert.equal(mod.badgeLevelOf(''), 'starter', '空值 → 第一档')
  assert.equal(mod.badgeLevelOf('不认识的档位-2'), 'starter', '认不出 → 第一档（绝不猜高档）')
  assert.equal(mod.badgeLevelOf(null), 'starter', 'null → 第一档（不抛）')
})

test('★★ EmptyState：title/desc 有长度校验（只警告、不改写文案）', () => {
  const source = read(...`${R}/components/EmptyState.vue`.split('/'))
  assert.match(source, /EMPTY_STATE_TITLE_MAX/, '标题要有上限常量')
  assert.match(source, /EMPTY_STATE_DESC_MAX/, '说明要有上限常量')
  assert.match(source, /import\.meta\.env\.DEV/, '校验只在开发期跑（生产环境不打扰）')
  assert.match(source, /console\.warn/, '超长要报警告（而不是偷偷截断文案）')
  const limits = read(...`${R}/components/empty-state.ts`.split('/'))
  assert.match(limits, /export const EMPTY_STATE_TITLE_MAX = \d+/, '上限要可被单测引用')
  assert.match(limits, /export const EMPTY_STATE_DESC_MAX = \d+/, '同上')
})
