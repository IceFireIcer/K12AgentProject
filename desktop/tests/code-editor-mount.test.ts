/**
 * 代码编辑器「尺寸盒子」守卫（2026-09-27 真机事故的回归钉）。
 *
 * ---------------------------------------------------------------------------
 * 事故现象与根因
 * ---------------------------------------------------------------------------
 * 进「智码工坊」（编程页）只看到一条黑边（实测宿主高度 5px），而 Monaco **其实装配成功了**
 * （DOM 里 `.monaco-editor` 有三个子节点）。根因不在 Monaco，而在**样式归属**：
 *
 *   · 调用方把 `class="code__editor"`（`height: 420px`）挂在 `<AsyncCodeEditor>` 上；
 *   · 异步加载的 `CodeEditor.vue` 自己的根样式是 `.code-editor{width:100%;height:100%}`；
 *   · 两者权重相同（class + scope 属性），而 chunk 的 CSS **后加载** → `100%` 生效；
 *   · 外层 `.code__editor-wrap` 高度是 auto → 100% 解析成内容高度 = 5px。
 *
 * 修法：尺寸挂在**调用方自己的普通盒子**上（`.code__editor` / `.coding__editor`），
 * 异步组件的 `100%` 永远有确定的父高度可依；装配失败时整个盒子收起，
 * 说明文案不会被 `overflow: hidden` 裁掉。
 *
 * ⚠️ 这条守卫是**源码层**的（单测里没有 DOM）：它钉的是那个 class 别再回到异步组件上。
 *    `npm run ux:pages` / `ux:layout` 量的是「有没有横向裁切」，量不出这个塌陷。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'

const page = read(...`${R}/views/Coding.vue`.split('/'))
const card = read(...`${R}/cards/CodingCard.vue`.split('/'))
const editor = read(...`${R}/components/CodeEditor.vue`.split('/'))

/**
 * 取真正的 `<AsyncCodeEditor … />` 标签。
 *
 * ⚠️ 必须按「标签名后有空白」来找：调用点的**注释里**也会写 `<AsyncCodeEditor>`
 *   （说明这条规矩本身），直接 `indexOf` 会命中注释，把后面的 `<div class="…">` 一起切进来。
 */
function asyncEditorTag(source: string): string {
  const match = /<AsyncCodeEditor\s[\s\S]*?\/>/.exec(source)
  assert.ok(match, '找不到自闭合的 `<AsyncCodeEditor … />`（编辑器必须还是异步组件）')
  return match[0]
}

test('★★ 编辑器的尺寸挂在调用方自己的盒子，不挂在异步组件上', () => {
  const CALLERS = [
    {
      label: '编程页 Coding.vue',
      source: page,
      boxClass: 'code__editor',
      boxHeight: 420
    },
    {
      label: '对话内编程卡 CodingCard.vue',
      source: card,
      boxClass: 'coding__editor',
      boxHeight: 300
    }
  ] as const

  for (const { label, source, boxClass, boxHeight } of CALLERS) {
    assert.doesNotMatch(
      asyncEditorTag(source),
      /class=/,
      `${label}：不许把尺寸 class 挂在 <AsyncCodeEditor> 上 —— 它会与 CodeEditor.vue 自己的 .code-editor{height:100%} 同权重，而那份 CSS 随 chunk 后加载，外层高度 auto 时编辑器塌成几像素`
    )
    assert.match(
      source,
      new RegExp(`<div[^>]*class="${boxClass}"`),
      `${label}：尺寸盒子要是这个文件自己的普通 <div class="${boxClass}">`
    )
    assert.match(
      source,
      new RegExp(`class="${boxClass}"[\\s\\S]{0,1200}?<AsyncCodeEditor`),
      `${label}：<AsyncCodeEditor> 必须放在尺寸盒子里（中间可以只有注释）`
    )
    assert.match(
      source,
      new RegExp(`\\.${boxClass}\\s*\\{[^}]*height:\\s*${boxHeight}px`),
      `${label}：.${boxClass} 要给确定高度 ${boxHeight}px（Monaco 的 100% 靠它解析）`
    )
  }
})

test('★ 编辑器根只负责撑满父盒，不自己写死高度', () => {
  assert.match(
    editor,
    /\.code-editor\s*\{[^}]*height:\s*100%/,
    'CodeEditor.vue 的根只负责 100% 撑满（尺寸归调用方）'
  )
  assert.doesNotMatch(
    editor,
    /\.code-editor\s*\{[^}]*height:\s*\d+px/,
    'CodeEditor.vue 不许自己写死像素高度'
  )
})
