/**
 * P0-2 守卫：动画讲解页的分页导航**必须常驻**，不能被关在 `v-show` 的 pane 里。
 *
 * 真机事故（便携版实测）：点「我的动画」分页后，`智团团准备的 / 我的动画` 这排 tab 整个消失；
 * 离开页面再回来仍停在「我的动画」——学生**再也回不到动画库**，只能重启应用。
 *
 * 根因：`role="tablist"` 那段导航写在 `<div v-show="anim.activeTab === 'builtin'" class="pane">`
 * **内部**，而「我的动画」区在同一个 pane **之外**。切到 `mine` 时整块 pane 被 `v-show`
 * 隐藏，导航随之消失，而它正是唯一的返回入口。
 *
 * 为什么用源码断言而不是渲染后量 DOM：`node --test` 里没有 Vue 运行时；而这条约束
 * **只存在于模板的嵌套关系里**，写错了不会让任何逻辑断言变红 —— 只会让学生在真机上
 * 走进一个回不去的页面（本项目为此白跑过一整轮真机测试）。
 *
 * 跑法：`cd desktop && node --test tests/animation-dead-end.test.ts`（也在 `npm test` 里）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const DESKTOP_ROOT = join(fileURLToPath(import.meta.url), '..', '..')
const ANIMATION_VUE = join(DESKTOP_ROOT, 'src', 'renderer', 'src', 'views', 'Animation.vue')

/** 取模板段（`<template>` … `</template>`），排除脚本里可能出现同名文本。 */
function templateOf(source: string): string {
  const start = source.indexOf('<template>')
  const end = source.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, 'Animation.vue 必须有 <template> 段')
  return source.slice(start, end)
}

/**
 * 从某个 `<div …>` 起点出发，用**配平的 `<div` / `</div>`** 找出它闭合的位置。
 *
 * 只需要认得两种形态：`<div …>` 与 `</div>`（本模板没有自闭合 `<div/>`）。
 * 这是刻意的手写配平 —— 引一个 HTML 解析器只为一条守卫不值得，
 * 而配平逻辑本身很短、可读，错了会当场抛（不会静默放过）。
 */
function matchingDivEnd(template: string, openIndex: number): number {
  const openOrClose = /<div\b|<\/div>/g
  openOrClose.lastIndex = openIndex
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = openOrClose.exec(template)) !== null) {
    if (match[0] === '</div>') {
      depth -= 1
      if (depth === 0) return match.index + match[0].length
    } else {
      depth += 1
    }
  }
  throw new Error('找不到匹配的 </div> —— 模板里的 div 没有配平（守卫本身无法判断）')
}

/**
 * ★★ 判据不能只查「嵌套在已找到的那个 pane 里」——**等价缺陷有两种写法**：
 *   ① 导航写在 pane 内（原始形态）；
 *   ② 另起一个 `v-show="activeTab === 'builtin'"` 的 wrapper 把导航包住
 *      （看起来「导航在 pane 之外」，实际同样会在切到 mine 时消失）。
 *   实测：只查嵌套的那一版守卫对写法 ② **不报红**（这次变异验证抓到的）。
 *
 * 所以这里换成一个更稳的判据：**在模板里，导航的每个字符位置都不能落在
 * 任何「按 activeTab 隐藏」的子树区间内**。先把所有这类 v-show 区间的范围算出来，
 * 再看 tablist 的位置落不落在其中。
 */
function hiddenByActiveTabRanges(template: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  // 任何 `v-show="anim.activeTab === '...'"` 的 div：切到别的页签时它整体不可见。
  const re = /<div\s+v-show="anim\.activeTab === '[a-z]+'"/g
  let match: RegExpExecArray | null
  while ((match = re.exec(template)) !== null) {
    ranges.push([match.index, matchingDivEnd(template, match.index)])
  }
  return ranges
}

test('G-P0-2 分页导航不在任何「按 activeTab 隐藏」的子树里（否则切到「我的动画」后无路可回）', () => {
  const template = templateOf(readFileSync(ANIMATION_VUE, 'utf8'))

  const tablist = template.indexOf('aria-label="动画讲解分页"')
  assert.ok(tablist >= 0, '找不到分页导航（tablist）—— 它是唯一的返回入口，删了就是死胡同')

  const ranges = hiddenByActiveTabRanges(template)
  assert.ok(
    ranges.length >= 2,
    `应当至少有两个按 activeTab 显示/隐藏的分页区（builtin 与 mine），实际 ${ranges.length} 个 —— ` +
      '结构变了要同步更新本条守卫'
  )

  const container = ranges.find(([start, end]) => tablist >= start && tablist < end)
  assert.equal(
    container,
    undefined,
    '分页导航落在某个「按 activeTab 隐藏」的子树里 —— 切到「我的动画」时它会跟着消失，' +
      '学生再也回不到动画库（P0-2）。导航必须始终渲染（它在两个页签下都可见）。'
  )
})

test('G-P0-2b 两个分页各自的区域都在（切走再回来内容不丢）', () => {
  const template = templateOf(readFileSync(ANIMATION_VUE, 'utf8'))
  assert.ok(
    template.includes("anim.activeTab === 'builtin'"),
    '「智团团准备的」分页区域必须在（用 v-show 保持挂载）'
  )
  assert.ok(
    template.includes("anim.activeTab === 'mine'"),
    '「我的动画」分页区域必须在'
  )
  // 两处都用 v-show：v-if 会在切分页时把沙箱宿主整个拆掉（切回来动画从头播、进度清零）。
  assert.ok(
    !/v-if="anim\.activeTab === '(builtin|mine)'"/.test(template),
    '分页区域不得改用 v-if —— 那会把沙箱宿主拆掉，切回来动画从头播一遍'
  )
})
