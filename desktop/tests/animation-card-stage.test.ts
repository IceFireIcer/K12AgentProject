/**
 * P2-3 守卫：对话内动画卡片的**舞台几何**不许缩回「肉眼 7–8px」那一档。
 *
 * 真机实测（便携版走查）：卡片把 720×420 的舞台压进约 630×310 的区域，节点字在屏上
 * 只有 7–8px（同一模板在动画页是清楚的）。量化后的因果链是：
 *
 *   iframe 高度 → 舞台缩放（`preserveAspectRatio` 的 `meet`）→ 学生的有效字号
 *   354px → 0.548× → 8.8px（节点标签，标称 16px）   ← 真机报的那一档
 *   420px → 0.705× → 11.3px
 *   480px → 0.831× → 13.3px（触到宽度上限，再加高不再变大）
 *
 * ★ 量的是 **`.k12-node-label`**（SVG 里的文字），不是 `.k12-node-body`
 *   —— 后者是节点的**底板矩形**（`base.css` 线 254 与 280 是两个类，取错元素会量出
 *   一个偏小的数，本项目踩过：第一次量成 11.6px，实际是 13.3px）。
 *
 * 所以这里钉住三件事：
 *   G-P2-3a `min-height` 必须 ≥ 480（旧值 300 正是 7.7px 的成因）
 *   G-P2-3b 比例必须是**舞台自己的** 720 / 420（`16 / 9` 比舞台更扁，等于又缩一刀）
 *   G-P2-3c 卡片必须给出**全屏入口**（卡片形态数学上到不了 18px，要逐帧看清只能全屏）
 *
 * 为什么用源码断言：`node --test` 里没有浏览器，而这几个数**只在 CSS 里** ——
 * 改错了不会让任何逻辑断言变红，只会让学生眼前的字又变小。
 *
 * 跑法：`cd desktop && node --test tests/animation-card-stage.test.ts`（也在 `npm test` 里）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const CARD_RAW = readFileSync(
  join(DESKTOP_ROOT, 'src', 'renderer', 'src', 'cards', 'AnimationCard.vue'),
  'utf8'
)

/**
 * ★★ 先把注释剥掉再接变量：这几条说明**故意引用了旧值**讲清楚为什么改
 *   （`16 / 9`、`300px` 都出现过），而且注释里那行没有分号 —— 不剥注释的话
 *   正则会被自己的说明书绊倒（实测：匹配吞掉整段注释、断言报出的是注释文本）。
 *   这是本仓库守卫的标准手法（见 `build-pipeline.test.ts`）。
 */
const CARD = CARD_RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

/** 取卡片样式里的刻度变量（`--k12-anim-min: 480px` 之类）。 */
function scaleVar(name: string): number {
  const match = new RegExp(`--k12-anim-${name}:\\s*([\\d.]+)px`).exec(CARD)
  assert.ok(match, `找不到 --k12-anim-${name} 的字面量（结构变了要同步更新这条守卫）`)
  return Number(match[1])
}

test('G-P2-3a 卡片舞台下限 ≥ 480px（低于它是「肉眼 7–8px」那一档）', () => {
  const min = scaleVar('min')
  assert.ok(
    min >= 480,
    `--k12-anim-min 是 ${min}px —— 实测 480px 才让缩放触到宽度上限（0.83×、节点字 11.6px）；` +
      '旧值 300px 在 630px 宽的卡片里只给 0.548× ⇒ 学生读到 7.7px'
  )
})

test('G-P2-3b 比例用舞台自己的 720 / 420，不是更扁的 16 / 9', () => {
  // ★ 取**最后一条**声明：注释里会引用旧值讲清楚为什么改（`16 / 9` 出现过），
  //   只取第一条会被自己的说明书绊倒 —— 这是本项目反复踩到的守卫陷阱。
  const all = [...CARD.matchAll(/--k12-anim-ratio:\s*([^;]+);/g)]
  assert.ok(all.length > 0, '找不到 --k12-anim-ratio 的声明')
  const value = all[all.length - 1][1].trim()
  assert.ok(
    /^720\s*\/\s*420$/.test(value),
    `生效的比例是 \`${value}\` —— 必须等于舞台坐标系比例（720×420）。` +
      '更扁的比例在同样宽度下给的高度更少，等于替舞台又缩一刀'
  )
})

test('G-P2-3c 上限 ≥ 下限（否则 min-height 会被 max-height 压掉）', () => {
  const min = scaleVar('min')
  const max = scaleVar('max')
  assert.ok(max >= min, `max(${max}px) 小于 min(${min}px)：CSS 里 max-height 会赢，下限形同虚设`)
})

test('G-P2-3d 卡片必须留着全屏入口（卡片是缩略形态的唯一出路）', () => {
  // 舞台按 `meet` 等比缩放，卡片宽度（约 600px）封死了缩放上限 0.83× ⇒ 节点字 ≤ 11.6px。
  // 要「盯住每一步」只能全屏，所以这个按钮不是装饰。
  assert.ok(
    CARD.includes('data-testid="animation-expand"'),
    '卡片必须有全屏入口（`data-testid="animation-expand"`）—— 删了它，学生就没有看清字的办法了'
  )
  assert.ok(
    CARD.includes('toggleExpand'),
    '全屏按钮必须真的接上 toggleExpand（一个不接线的按钮比没有更糟）'
  )
})
