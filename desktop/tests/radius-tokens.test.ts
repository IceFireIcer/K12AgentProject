/**
 * 设计 token 守卫：优化报告 §1.3（圆角系统优化）。
 *
 * 报告要求：五档梯度 4/6/8/12/16（约 1.5 倍率）、控件圆角从 14 降到 8、
 * 卡片 14 降到 12、浮层与模态走 16，并给出嵌套公式 `内 = max(0, 外 − padding)`。
 *
 * 为什么必须机器守：圆角是"抄一份本地皮肤"最容易发生的地方。上一版实测有 33 处
 * 直接写 4px，而当时 `--k12-r-flat` 根本没定义 —— var() 取不到值会退化成 0，
 * 那些元素一直是直角，谁也没发现。
 *
 * 说明：嵌套公式无法用文本断言机械验证（它取决于实际内边距），所以这里只钉
 * "档位与语义映射 + 不许写裸值"；嵌套关系由 `ux:layout` 与人工走查覆盖。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER = 'src/renderer/src'
const BASE_CSS = `${RENDERER}/assets/base.css`
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

function rendererSources(): Array<{ path: string; text: string }> {
  return readdirSync(join(desktopRoot, RENDERER), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(vue|ts|css)$/.test(entry.name))
    .map((entry) => {
      const parent =
        (entry as unknown as { parentPath?: string }).parentPath ??
        (entry as unknown as { path?: string }).path ??
        RENDERER
      const full = join(parent, entry.name)
      return {
        path: full.replace(/\\/g, '/').replace(`${desktopRoot.replace(/\\/g, '/')}/`, ''),
        text: readFileSync(full, 'utf8')
      }
    })
}

function tokenValue(css: string, name: string): string {
  const matched = new RegExp(`--${name}:\\s*([^;]+);`).exec(css)
  assert.ok(matched !== null, `base.css 的 :root 里找不到 --${name}`)
  return (matched[1] ?? '').trim()
}

test('圆角五档梯度与语义映射（报告 §1.3）', () => {
  const css = read(...BASE_CSS.split('/'))
  const ladder: ReadonlyArray<readonly [string, number]> = [
    ['k12-r-xs', 4],
    ['k12-r-sm', 6],
    ['k12-r-md', 8],
    ['k12-r-lg', 12],
    ['k12-r-xl', 16]
  ]
  for (const [name, expected] of ladder) {
    assert.equal(tokenValue(css, name), `${expected}px`, `--${name} 必须是 ${expected}px`)
  }
  assert.equal(tokenValue(css, 'k12-r-pill'), '999px', '胶囊档保持 999px')

  const mapping: ReadonlyArray<readonly [string, string]> = [
    ['k12-r-inset', '--k12-r-md'],
    ['k12-r-card', '--k12-r-lg'],
    ['k12-r-control', '--k12-r-md'],
    ['k12-r-float', '--k12-r-xl'],
    ['k12-r-flat', '--k12-r-xs']
  ]
  for (const [name, target] of mapping) {
    assert.equal(tokenValue(css, name), `var(${target})`, `--${name} 必须映射到 ${target}`)
  }
})

test('控件 8px、卡片 12px、浮层 16px（不再同值）', () => {
  const css = read(...BASE_CSS.split('/'))
  assert.equal(tokenValue(css, 'k12-r-md'), '8px', '标准控件（按钮/输入/分段）必须是 8px')
  assert.equal(tokenValue(css, 'k12-r-lg'), '12px', '卡片/嵌入块必须是 12px')
  assert.equal(tokenValue(css, 'k12-r-xl'), '16px', '浮层/模态必须是 16px')
  assert.match(
    css,
    /\.k12-float\s*\{[\s\S]{0,200}?border-radius:\s*var\(--k12-r-float\)/,
    '浮层容器必须用 r-float（16px）'
  )
})

test('不许写裸 px 圆角（只能走 token；50% 与 0 除外）', () => {
  const offenders: string[] = []
  for (const file of rendererSources()) {
    if (file.path.endsWith('assets/tokens.generated.css')) continue
    if (file.path.endsWith('assets/base.css')) {
      const lines = file.text.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? ''
        if (/^\s*--k12-r-[a-z]+:\s*\d+px;/.test(line)) continue
        if (/border-radius:\s*\d+px/.test(line)) offenders.push(`${file.path}:${index + 1}  ${line.trim()}`)
      }
      continue
    }
    for (const matched of file.text.matchAll(/border-radius:\s*\d+px/g)) {
      offenders.push(`${file.path}: ${matched[0]}`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '这些地方把圆角写死了（应改用 --k12-r-xs/sm/md/lg/xl 或语义名）：\n' + offenders.slice(0, 12).join('\n')
  )
})
