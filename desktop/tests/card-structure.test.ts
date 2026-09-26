/**
 * 卡片结构守卫：优化报告 §2.3（标准卡片结构 header / body / footer）。
 *
 * 报告的执行计划 7.1 是"定义标准卡片结构 → 创建 CardHeader / CardBody / CardFooter 子组件
 * → 更新 SurfacePanel 支持卡片槽位"。本守卫钉住**前两步的产物**：
 *   · 三个子组件存在，且各自只负责一段；
 *   · 它们**不重写样式**（类名直通 base.css 的 `.k12-card-*`，抄一份必然漂移）；
 *   · 槽位分工正确：卡头有 title/meta/actions 三个具名槽（对象级操作进卡头），
 *     卡身只有一个默认槽，卡脚只有一个默认槽（只放状态提交）。
 *   · 三段的类名在 base.css 里真的有定义（否则它们只是三个空壳 div）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'
const css = read(...`${R}/assets/base.css`.split('/'))

test('三个卡片子组件存在，且类名直通 base.css（不重写皮肤）', () => {
  const header = read(...`${R}/components/card/CardHeader.vue`.split('/'))
  const body = read(...`${R}/components/card/CardBody.vue`.split('/'))
  const foot = read(...`${R}/components/card/CardFoot.vue`.split('/'))

  assert.match(header, /class="k12-card-head"/, 'CardHeader 必须用 .k12-card-head')
  assert.match(body, /class="k12-card-body"/, 'CardBody 必须用 .k12-card-body')
  assert.match(foot, /class="k12-card-foot"/, 'CardFoot 必须用 .k12-card-foot')

  // 三段皮肤都在 base.css 里定义（子组件只组合、不重画）
  for (const name of ['.k12-card-head', '.k12-card-body', '.k12-card-foot']) {
    assert.match(css, new RegExp(`\\${name}\\s*\\{`), `base.css 缺少 ${name}（卡片皮肤的唯一来源）`)
  }
  // 子组件的样式块里不许出现背景/边框（那是 base.css 的职责）
  for (const [label, source] of [['CardHeader', header], ['CardBody', body], ['CardFoot', foot]] as const) {
    assert.doesNotMatch(source, /background:\s*(?!transparent)/, `${label} 不许自己写背景（皮肤只在 base.css）`)
    assert.doesNotMatch(source, /border:\s*1px/, `${label} 不许自己写边框`)
  }
})

test('槽位分工正确：卡头 title/meta/actions，卡身与卡脚各一个默认槽', () => {
  const header = read(...`${R}/components/card/CardHeader.vue`.split('/'))
  assert.match(header, /<slot name="title" \/>/, '卡头要有 title 槽')
  assert.match(header, /<slot name="meta" \/>/, '卡头要有 meta 槽（只读口径信息）')
  assert.match(header, /<slot name="actions" \/>/, '卡头要有 actions 槽（对象级操作）')
  assert.match(header, /k12-card-head__actions[\s\S]{0,120}?margin-left:\s*auto/, 'actions 推到卡头右端')

  const body = read(...`${R}/components/card/CardBody.vue`.split('/'))
  assert.match(body, /<slot \/>/, '卡身只有一个默认槽')
  assert.doesNotMatch(body, /<slot name=/, '卡身不设具名槽（避免又变成"什么都能塞"）')

  const foot = read(...`${R}/components/card/CardFoot.vue`.split('/'))
  assert.match(foot, /<slot \/>/, '卡脚只有一个默认槽')
  assert.match(foot, /状态提交/, '卡脚的用途要写在文件里（后来人知道什么能放）')
})

/**
 * 迁移断言（报告 §2.3 执行计划 7.1 的**第三件**：更新到真实卡片）。
 *
 * ★★ 为什么单列一条：三个子组件存在只是「定义了标准」，四张在对话/进度里渲染的卡片
 *   （练习 / 动画 / 编程 / 进度）如果还在自写卡片皮肤（padding + 边框 + 圆角 + 投影），
 *   标准就只是摆设 —— 报告 §2.3 的第一条现状问题正是「卡片头尾规范不明」。
 *   `data-testid` 必须保留（`verify-ui` 与 `ux:*` 探针按它们找卡；迁移时把锚点删掉
 *   会让探针连带失效，那种红是假红）。
 */
test('四张卡片迁移到三段结构：走 card/ 子组件 + k12-card 皮肤，且保留既有锚点', () => {
  // ⚠️ 根类名**逐个钉死**（第一个分支的类名被摘掉时，同文件里别的分支的
  //   `k12-card` 仍会命中宽泛正则 —— 变异 87 实测过，宽泛判据是假绿）。
  const CARDS: ReadonlyArray<readonly [string, string, string, readonly string[]]> = [
    ['QuizCard.vue', '练习卡', 'class="k12-card quiz"', ['quiz-card', 'quiz-question', 'quiz-submit', 'quiz-count']],
    ['AnimationCard.vue', '动画卡', 'class="k12-card anim"', ['animation-card', 'animation-status', 'animation-expand']],
    ['CodingCard.vue', '编程卡', 'class="k12-card coding"', ['coding-card', 'coding-run', 'coding-editor']],
    ['ProgressCard.vue', '进度卡', 'class="k12-card levels"', ['progress-card', 'progress-level']]
  ]
  for (const [file, label, rootClass, anchors] of CARDS) {
    const source = read(...`${R}/cards/${file}`.split('/'))
    assert.match(source, /<CardHeader>/, `${label} 的卡头要走 CardHeader（三段结构第一段）`)
    assert.match(source, /<template #title>/, `${label} 的卡头要填 title 槽（这一块叫什么）`)
    assert.match(source, /<CardBody>/, `${label} 的卡身要走 CardBody（三段结构第二段）`)
    assert.ok(
      source.includes(`${rootClass}\n`) || source.includes(`${rootClass} `),
      `${label} 的根元素要给 \`k12-card\`（皮肤唯一来源是 base.css，不再自写一份）`
    )
    // 不许再自写卡片皮肤：投影/白面/边框/内边距全在 base.css 的三段里
    assert.doesNotMatch(
      source,
      /box-shadow:\s*var\(--k12-shadow-card\)/,
      `${label} 不得自写卡片投影（那是 .k12-card 的职责）`
    )
    for (const anchor of anchors) {
      assert.match(
        source,
        new RegExp(`data-testid="${anchor}"`),
        `${label} 迁移时丢了锚点 ${anchor}（探针会连带失效）`
      )
    }
  }
})
