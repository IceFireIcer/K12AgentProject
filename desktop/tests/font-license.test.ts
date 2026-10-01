/**
 * 字体选型与**许可合规**守卫（2026-09-30 换字体时立，同日改成"两套字按用途分"）。
 *
 * 为什么需要它：应用里带的是字体的**字形文件**（woff2），而 SIL OFL 1.1 要求
 * 「随字体一起分发许可副本」。这类东西坏掉时**不会报任何错** —— 字照常显示，
 * 只是法律上少了一份许可；升级字体包时更不会有人想起来同步它。
 *
 * 四条：
 *   ① 两套字**按用途分**：小字号用黑体（笔画均匀、真字重），大字才用圆润的阅读体 ——
 *      这不是审美偏好，是 2026-09-30 实测的结论（楷体在 12–14px 会糊，且只有 400 字重）；
 *   ② 中文大字那一套只引 **GB** 那一支（同一个包里非 GB 是繁体/日式字形）；
 *   ③ 三份 OFL 副本随包发，且与**当前安装的字体包里那份逐字一致**（防升级后过期）；
 *   ④ 字体包只进 `devDependencies`（打包体积纪律，见 tests/bundle-budget.test.ts）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')
/** 换行与首尾空白归一后再比（跨平台 checkout 不该让这条守卫假红）。 */
const norm = (text: string): string => text.replace(/\r\n/g, '\n').trim()

const BASE_CSS = 'src/renderer/src/assets/base.css'
const UI_FONT_PKG = '@fontsource-variable/noto-sans-sc'
const DISPLAY_FONT_PKG = 'lxgw-wenkai-screen-webfont'
const MONO_FONT_PKG = '@fontsource-variable/jetbrains-mono'

test('★★ 两套字按用途分：小字号黑体、大字圆润阅读体', () => {
  const css = read(BASE_CSS)
  assert.match(
    css,
    /--k12-font-ui:\s*'Noto Sans SC Variable'/,
    'ui（正文与所有小字号）必须是黑体：楷体在 12–14px 会糊'
  )
  assert.match(
    css,
    /--k12-font-display:\s*'LXGW WenKai Screen'/,
    'display（大字）用圆润的阅读体，圆润感靠它给'
  )
  // 大字那两处必须真的用上 display 那一套（否则圆润感等于没落地）
  assert.match(
    css,
    /\.k12-identity__main\s*\{[^}]*font-family:\s*var\(--k12-font-display\)/,
    '页面身份行（32px）要走 display'
  )
  const chat = read('src/renderer/src/views/Chat.vue')
  assert.match(
    chat,
    /\.chat__hello-title\s*\{[^}]*font-family:\s*var\(--k12-font-display\)/,
    '首屏问候（40px）要走 display'
  )
})

test('★★ 圆润那套只引 GB 那一支（非 GB 是繁体 / 日式字形）', () => {
  const css = read(BASE_CSS)
  assert.match(
    css,
    /@import 'lxgw-wenkai-screen-webfont\/lxgwwenkaigbscreen\.css'/,
    '要引 GB 那一支（大陆教材字形）'
  )
  for (const wrong of ['lxgwwenkaiscreen.css', 'lxgwwenkaigbscreenr.css', 'lxgwwenkaiscreenr.css']) {
    assert.ok(
      !css.includes(wrong),
      `不要引 ${wrong}：它会用非 GB 字形覆盖同一族名（'LXGW WenKai Screen'）的码位`
    )
  }
})

test('★★ 三份 OFL 许可副本随包发出去，且与当前字体包里那份逐字一致', () => {
  // 应用里带的是字形文件，OFL 要求「许可随字体一起分发」——
  // resources/ 是 vite 的 publicDir（整份拷进 out/renderer，随安装包发出去）。
  const pairs: Array<[string, string, string]> = [
    ['resources/licenses/LXGW-WenKai-Screen-OFL.txt', DISPLAY_FONT_PKG, 'OFL.txt'],
    ['resources/licenses/Noto-Sans-SC-OFL.txt', UI_FONT_PKG, 'LICENSE'],
    ['resources/licenses/JetBrains-Mono-OFL.txt', MONO_FONT_PKG, 'LICENSE']
  ]
  for (const [shippedPath, pkg, licenseFile] of pairs) {
    const shipped = read(shippedPath)
    const fromPackage = readFileSync(join(DESKTOP, 'node_modules', pkg, licenseFile), 'utf8')
    assert.equal(
      norm(shipped),
      norm(fromPackage),
      `升级 ${pkg} 之后要同步 ${shippedPath} 里那份`
    )
    assert.match(
      shipped,
      /SIL Open Font License, Version 1\.1/,
      `${shippedPath} 必须是 OFL 1.1 正文`
    )
  }
})

test('★ 字体包只进 devDependencies（渲染依赖由 vite 打进 out/renderer）', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  for (const name of [UI_FONT_PKG, DISPLAY_FONT_PKG, MONO_FONT_PKG]) {
    assert.ok(pkg.devDependencies[name], `${name} 应在 devDependencies`)
    assert.ok(
      !pkg.dependencies[name],
      `${name} 不许进 dependencies —— electron-builder 只打包 dependencies，多一个包就多打进一次包`
    )
  }
})
