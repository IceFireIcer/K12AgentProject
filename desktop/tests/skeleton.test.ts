/**
 * 加载形态守卫：优化报告 §3.2 的「Loading 四形态分工」。
 *
 * 报告把加载态分成四种并规定各自的使用场景：
 *   转圈（不知道结构）· **骨架屏**（知道结构：列表/卡片）· 进度条（已知进度的重活）· 流式（对话）。
 * 本守卫钉住骨架屏这一格：组件存在、只用 token、闪烁在减动效下关掉、
 * 且**至少有一处列表真的用了它**（否则组件就是死代码）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'

test('骨架屏组件：只用 token、aria-hidden、减动效下不闪烁', () => {
  const skeleton = read(...`${R}/components/Skeleton.vue`.split('/'))
  assert.match(skeleton, /data-testid="skeleton"/, '骨架屏要有稳定锚点')
  assert.match(skeleton, /aria-hidden="true"/, '骨架屏是视觉占位，读屏由外层状态文案负责')
  assert.doesNotMatch(skeleton, /#[0-9a-fA-F]{3,6}/, '骨架屏不许写死色值（走 --k12-* token）')
  assert.match(
    skeleton,
    /@media \(prefers-reduced-motion: no-preference\)/,
    '闪烁必须包在 prefers-reduced-motion: no-preference 里（减动效用户看到静态灰块）'
  )
  assert.match(skeleton, /animation:\s*sk-breathe/, '闪烁是骨架屏唯一的动效')
})

test('至少一处长列表真的用了骨架屏（否则组件是死代码）', () => {
  const list = read(...`${R}/components/SessionList.vue`.split('/'))
  assert.match(list, /import Skeleton from '\.\/Skeleton\.vue'/, '会话列表要 import 骨架屏')
  assert.match(
    list,
    /data-testid="session-loading"[\s\S]{0,200}?<Skeleton/,
    '会话列表的加载分支要用骨架屏渲染（保留原 data-testid，探针仍能判"加载态"）'
  )
})
