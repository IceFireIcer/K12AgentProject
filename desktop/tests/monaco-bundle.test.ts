/**
 * Monaco 精简守卫（优化报告 §5.1 的 WP-13）。
 *
 * ---------------------------------------------------------------------------
 * 这一组守的是什么
 * ---------------------------------------------------------------------------
 * 报告 §5.1 的执行计划四条：只加载 Python 语言 / 移除 diff・多光标・minimap /
 * 主题精简（vs-dark）/ chunk < 3MB，外加「异步组件 + 骨架 + 失败重试 ≤3 次」。
 *
 * 判据分两层：
 *  ① **源码层**（`npm test` 永远能跑）：语言注册只有 Python、主题只有 vs-dark、
 *     minimap 与多光标在 options 里关掉、重试上限 = 3、两个调用点都接上
 *     `defineAsyncComponent + CodeEditorSkeleton + onError 重试`、渲染构建开着压缩；
 *  ② **产物层**（`out/renderer/assets` 存在时才量）：`editor.api-*.js` < 3MB。
 *     没有产物就跳过（不假装通过，也不误报 —— 与仓库里其它产物级检查同一口径）。
 *
 * ⚠️ 为什么必须有这条守卫：`electron-vite` 的渲染进程默认 `minify: false`，
 *    同一份 Monaco 代码压不压差别是 **4.87MB → 2.52MB**（2026-09-27 实测）。
 *    一句 `minify: true` 被谁删掉，体积目标立刻破 —— 而跑应用**看不出来**。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')
const R = 'src/renderer/src'

const setup = read(...`${R}/sandbox/monaco-setup.ts`.split('/'))
const skeleton = read(...`${R}/components/CodeEditorSkeleton.vue`.split('/'))
const editor = read(...`${R}/components/CodeEditor.vue`.split('/'))
const card = read(...`${R}/cards/CodingCard.vue`.split('/'))
const page = read(...`${R}/views/Coding.vue`.split('/'))
const viteConfig = read('electron.vite.config.ts')

test('★★ 只注册 Python 语言：不再拉全量 basic-languages 清单', () => {
  assert.match(
    setup,
    /import\('monaco-editor\/languages\/definitions\/python\/register'\)/,
    '必须只注册 Python 一个语言定义（报告 §5.1「配置只加载 Python 语言」）'
  )
  assert.doesNotMatch(
    setup,
    /import\('monaco-editor\/basic-languages\/monaco\.contribution'\)/,
    '不得再 import basic-languages 的全量清单 —— 它会把 ~90 种语言的注册入口全部拉进产物'
  )
  assert.doesNotMatch(
    setup,
    /import\(['"]monaco-editor['"]\)/,
    '不得 import 包根（会连带 5 个语言服务 worker / ~17.4MB）'
  )
})

test('★★ 主题精简为 vs-dark（报告 §5.1 + 计划 D9 的收口口径）', () => {
  assert.match(
    setup,
    /export const DEFAULT_EDITOR_THEME: CodeEditorTheme = 'vs-dark'/,
    "默认（也是唯一入口）的主题必须是 'vs-dark'；`vs` 只作为注释里的未来路径保留"
  )
  // 两个调用点都不许显式传浅色主题
  for (const [label, source] of [['卡片', card], ['编程页', page]] as const) {
    assert.doesNotMatch(source, /theme: 'vs'/, `${label}不得再显式传浅色主题（编辑器固定深色皮肤）`)
    assert.match(source, /var\(--k12-editor-bg\)/, `${label} 的编辑器外框要与 vs-dark 同底（--k12-editor-bg）`)
  }
})

test('★ minimap / 多光标在 options 里关掉（报告 §5.1 的移除项）', () => {
  assert.match(setup, /minimap: \{ enabled: false \}/, 'minimap 关掉')
  assert.match(
    setup,
    /multiCursorLimit: 1/,
    '多光标压到 1（monaco 0.56 的 standalone 入口没有编译期移除开关 —— 这是等价落地）'
  )
  assert.match(setup, /columnSelection: false/, '列选择（鼠标拖出的第二个光标）关掉')
})

test('★★ 失败重试 ≤3 次（内核装配 + 异步 chunk 两层）', () => {
  assert.match(
    setup,
    /export const MONACO_MAX_LOAD_ATTEMPTS = 3/,
    '重试上限是常量 3（报告 §5.1「失败重试 ≤3 次」）'
  )
  assert.match(
    setup,
    /for \(let attempt = 1; attempt <= MONACO_MAX_LOAD_ATTEMPTS; attempt \+= 1\)/,
    'loadMonaco 内部要有真实的循环重试（只写常量不算实现）'
  )
  assert.match(
    setup,
    /if \(monacoReady === pending\) monacoReady = null/,
    '三次都失败要**清掉缓存的 Promise**，否则学生再点一次也永远拿到那个失败的 Promise'
  )
  for (const [label, source] of [['卡片', card], ['编程页', page]] as const) {
    assert.match(source, /defineAsyncComponent\(\{/, `${label}必须用 defineAsyncComponent 装配编辑器`)
    assert.match(source, /loadingComponent: CodeEditorSkeleton/, `${label} 的加载组件必须是骨架屏`)
    assert.match(
      source,
      /if \(attempts <= MONACO_MAX_LOAD_ATTEMPTS\) retry\(\)/,
      `${label} 的 onError 要重试 ≤3 次`
    )
    assert.match(source, /<CodeEditorSkeleton/, `${label} 在 Monaco 内核装配期间要盖骨架（覆盖层）`)
  }
  assert.match(skeleton, /data-testid="code-editor-skeleton"/, '骨架组件要有稳定锚点')
  assert.match(editor, /defineExpose\(\{/, 'CodeEditor.vue 要把最小句柄交给调用方')
})

test('★★ 渲染构建必须开着压缩（electron-vite 默认是 false）', () => {
  assert.match(
    viteConfig,
    /minify: 'esbuild'/,
    'renderer.build.minify 必须是 esbuild —— 不压的话 editor.api chunk 是 4.87MB，目标从结构上做死'
  )
})

test('★ 产物层：editor.api chunk < 3MB（有构建产物时才量）', () => {
  const assets = join(desktopRoot, 'out', 'renderer', 'assets')
  if (!existsSync(assets)) {
    console.log('  [SKIP] out/renderer/assets 不存在（还没跑过 npx electron-vite build）')
    return
  }
  const editorChunks = readdirSync(assets).filter((name) => /^editor\.api-.*\.js$/.test(name))
  assert.equal(editorChunks.length, 1, `editor.api chunk 应该恰好一个（实测 ${editorChunks.length} 个）`)
  const size = readFileSync(join(assets, editorChunks[0] ?? '')).byteLength
  assert.ok(
    size < 3 * 1024 * 1024,
    `editor.api chunk ${(size / 1048576).toFixed(2)}MB ≥ 3MB —— 检查 minify 与语言注册（报告 §5.1 的验收线）`
  )
})
