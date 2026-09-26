/**
 * 减少动效「三档开关」守卫：优化报告 §3.3 的第二、三件（用户控制 + 探针/文档）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告 §3.3 的执行计划 10.2 要求设置页给出「自动 / 开启 / 关闭」三档，
 * `localStorage` 持久化、**实时生效**。三档的语义必须是真的：
 *   · 「开启」在系统没开减动效时也要减；
 *   · 「关闭」在系统开了减动效时也要给完整动效（否则第三档是假选项）。
 *
 * 落地是三件事同时成立（缺一件就有一种场景是假的）：
 *   ① 状态在 `stores/reducedMotion.ts`（唯一真相，localStorage 持久化）；
 *   ② CSS 的两块规则：媒体查询带 `:not([data-k12-reduced-motion='off'])` +
 *      `[data-k12-reduced-motion='on']` 属性块（内容必须一致）；
 *   ③ JS 侧：`useReducedMotion()` 返回**有效值**（模式 × 系统），
 *      沙箱内 `_shared/runtime.js` 也读自己的 `prefers-reduced-motion` 并把时长归零。
 *
 * 跑法：`npm test`（纯源码 + 纯函数；真机由 `scripts/ux-probe-reduced-motion.mjs` 量）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'

const store = read(...`${R}/stores/reducedMotion.ts`.split('/'))
const css = read(...`${R}/assets/base.css`.split('/'))
const settings = read(...`${R}/views/Settings.vue`.split('/'))
const composable = read(...`${R}/composables/useReducedMotion.ts`.split('/'))
const quiz = read(...`${R}/views/Quiz.vue`.split('/'))
const inlineCard = read(...`${R}/cards/InlineCard.vue`.split('/'))
const runtime = readFileSync(
  join(repoRoot, 'server', 'resources', 'templates', '_shared', 'runtime.js'),
  'utf8'
)

/* ------------------------------------------------------------------ *
 * 1. ★★ 纯函数：三档的有效值（判错方向的代价不对称）
 * ------------------------------------------------------------------ */

test('★★ 三档语义：「开启」压过系统没开，「关闭」压过系统开了，「自动」跟随系统', async () => {
  const mod = await import('../src/renderer/src/stores/reducedMotion.ts')
  assert.equal(mod.REDUCED_MOTION_DEFAULT, 'auto', '默认必须是「自动」（不改变任何既有行为）')
  assert.equal(mod.REDUCED_MOTION_STORAGE_KEY, 'k12.reducedMotion', 'localStorage 键带应用前缀')

  assert.equal(mod.effectiveReducedMotion('on', false), true, '开启 + 系统没开 → 仍然减动效')
  assert.equal(mod.effectiveReducedMotion('on', true), true, '开启 + 系统开了 → 减动效')
  assert.equal(mod.effectiveReducedMotion('off', true), false, '关闭 + 系统开了 → 完整动效（覆盖系统）')
  assert.equal(mod.effectiveReducedMotion('off', false), false, '关闭 + 系统没开 → 完整动效')
  assert.equal(mod.effectiveReducedMotion('auto', true), true, '自动 + 系统开了 → 减动效')
  assert.equal(mod.effectiveReducedMotion('auto', false), false, '自动 + 系统没开 → 完整动效')
})

test('★ 只认三个字面量：手改的 / 旧版本写的 / 读异常一律回「自动」', async () => {
  const mod = await import('../src/renderer/src/stores/reducedMotion.ts')
  const original = (globalThis as { localStorage?: unknown }).localStorage
  try {
    const stub = (value: string | null): void => {
      ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: () => value }
    }
    stub('on')
    assert.equal(mod.readStoredReducedMotionMode(), 'on', "存过 'on' → 开启")
    stub('off')
    assert.equal(mod.readStoredReducedMotionMode(), 'off', "存过 'off' → 关闭")
    stub('reduced')
    assert.equal(mod.readStoredReducedMotionMode(), mod.REDUCED_MOTION_DEFAULT, '认不出的值 → 自动')
    stub(null)
    assert.equal(mod.readStoredReducedMotionMode(), mod.REDUCED_MOTION_DEFAULT, '没存过 → 自动')

    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      }
    }
    assert.equal(mod.readStoredReducedMotionMode(), mod.REDUCED_MOTION_DEFAULT, '读异常 → 自动（不抛）')
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = original
  }
})

test('★ 写模式：同时写 `<html>` 属性 + 落盘（实时生效的唯一链路）', async () => {
  const mod = await import('../src/renderer/src/stores/reducedMotion.ts')
  const attrs: Record<string, string> = {}
  const stored: Record<string, string> = {}
  const originalDoc = (globalThis as { document?: unknown }).document
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage
  try {
    ;(globalThis as { document?: unknown }).document = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attrs[name] = value
        }
      }
    }
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: (key: string, value: string) => {
        stored[key] = value
      }
    }
    mod.setReducedMotionMode('on')
    assert.equal(attrs[mod.REDUCED_MOTION_ATTR], 'on', "写模式要同步写 html 属性（CSS 的开关）")
    assert.equal(stored[mod.REDUCED_MOTION_STORAGE_KEY], 'on', '写模式要落盘（重启保留）')
    assert.equal(mod.reducedMotionMode.value, 'on', 'store 里的模式跟着变（设置页与探针读它）')
    mod.setReducedMotionMode('auto')
    assert.equal(attrs[mod.REDUCED_MOTION_ATTR], 'auto', '切回自动也要写属性（媒体查询重新接管）')
  } finally {
    ;(globalThis as { document?: unknown }).document = originalDoc
    ;(globalThis as { localStorage?: unknown }).localStorage = originalStorage
    mod.setReducedMotionMode('auto')
  }
})

/* ------------------------------------------------------------------ *
 * 2. ★★ CSS：两块规则都在，且属性块与媒体块内容一致
 * ------------------------------------------------------------------ */

test('★★ CSS 两块减动效规则：媒体块带 `:not(off)`、「开启」有属性块（内容一致）', () => {
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root:not\(\[data-k12-reduced-motion='off'\]\) \*,/,
    '媒体块必须带 `:not([data-k12-reduced-motion=\'off\'])` —— 否则「关闭」档覆盖不了系统偏好'
  )
  const attrBlock = css.match(
    /\[data-k12-reduced-motion='on'\] \*,\s*\[data-k12-reduced-motion='on'\] \*::before,\s*\[data-k12-reduced-motion='on'\] \*::after\s*\{([\s\S]{0,400}?)\}/
  )
  assert.ok(attrBlock, '必须有 `[data-k12-reduced-motion=\'on\']` 的属性块（系统没开也能强制减动效）')
  const body = attrBlock?.[1] ?? ''
  for (const declaration of [
    'animation-duration: 0.01ms !important',
    'animation-iteration-count: 1 !important',
    'transition-duration: 0.01ms !important',
    'scroll-behavior: auto !important'
  ]) {
    assert.ok(body.includes(declaration), `属性块缺 ${declaration}（与媒体块内容必须一致）`)
  }
  // 「开启」时卡片不动位移（hover 抬升的替代表达）
  assert.match(
    css,
    /\[data-k12-reduced-motion='on'\] \.k12-card:hover\s*\{\s*transform:\s*none/,
    '「开启」时卡片 hover 不得位移（替代表达：只换阴影）'
  )
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 设置页：三档 + 报告原文的说明 + 只走 store
 * ------------------------------------------------------------------ */

test('★★ 设置页「外观主题」里有三档（自动 / 开启 / 关闭），文案来自报告原文', () => {
  assert.match(settings, /data-testid="settings-motion-block"/, '这一块要有稳定锚点（探针按它量）')
  assert.match(settings, /v-for="option in REDUCED_MOTION_OPTIONS"/, '三档来自 store 的清单（不各写一份）')
  assert.match(settings, /role="radiogroup" aria-label="减少动效"/, '三档是单选组（读屏能播报）')
  assert.match(settings, /:aria-checked="motionMode === option.value"/, '每一档要有 aria-checked')
  assert.match(
    settings,
    /减少动效可以降低视觉疲劳，适合对运动敏感的用户。开启后会关闭页面切换、滚动动画和装饰性动效。/,
    '说明文字用报告原文（承诺要一字不差）'
  )
  // 页面不另存一份状态：写路径只走 store 的 setReducedMotionMode
  assert.match(settings, /setReducedMotionMode\(next\)/, '写路径只走 store')
  assert.doesNotMatch(settings, /localStorage\.setItem\('k12\.reducedMotion'/, '页面不得自己写 localStorage')
})

/* ------------------------------------------------------------------ *
 * 4. ★★ JS 半边：有效值 / 统一滚动 helper / 沙箱
 * ------------------------------------------------------------------ */

test('★★ useReducedMotion 返回有效值（不再是裸系统偏好）', () => {
  assert.match(
    composable,
    /return computed\(\(\) => reducedMotionEffective\.value\)/,
    'composable 的返回值必须是 store 的有效值（模式 × 系统）—— 只 import 不算数'
  )
  assert.match(
    composable,
    /setSystemReducedMotionMatching/,
    '系统偏好由这一处 matchMedia 订阅写进 store（单例，避免多处各挂监听）'
  )
  assert.match(composable, /export function scrollIntoViewRespectingMotion/, '统一滚动 helper 要对外导出')
})

test('★★ 全站只有一处 scrollIntoView 实现，且 Quiz.vue 已经切过去', () => {
  assert.match(quiz, /scrollIntoViewRespectingMotion/, 'Quiz.vue 的滚动要走统一 helper')
  const bare = quiz.match(/scrollIntoView\(/g) ?? []
  assert.equal(bare.length, 0, 'Quiz.vue 不得再直接调 scrollIntoView（behavior 判断只许有一份）')
})

test('★★ 动画沙箱内也减动效：时长/停顿归零 + anime 默认时长归零', () => {
  assert.match(
    runtime,
    /function prefersReducedMotion\(\)/,
    '沙箱运行时必须自己读 prefers-reduced-motion（独立文档，读不到宿主属性）'
  )
  assert.match(runtime, /function motionPreset\(\)/, '动效参数要有一个统一的取值口')
  assert.match(
    runtime,
    /return \{ duration: 0, easing: 'linear', stagger: 0, holdMs: 0 \}/,
    '减动效 = 瞬间到终态（时长与停顿全零）'
  )
  assert.match(runtime, /anime\.defaults\.duration = 0/, '直接调 anime() 的模板也要归零')
  // 宿主侧：设置一变就重建 iframe（沙箱重新读一次偏好）
  assert.match(
    inlineCard,
    /reducedMotion\.value \? 'reduced' : 'full'/,
    'InlineCard 的 key 要带减动效状态（否则沙箱在模式切换后仍按旧模式播）'
  )
})
