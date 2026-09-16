/**
 * 票 03 守卫（关卡 B₁）：把「Pi 可加载性」这条链路上**一旦被人改回去就会静默炸掉**的
 * 几个决定钉成静态断言。全部是正向/结构性断言，失败信息里带具体文件路径。
 *
 *   G7  system prompt 模板不得含任何宿主路径（风险 #19 / Pi issue #6308）
 *   G8  `findHostPathLeaks()` 本身有效（否则 G7 会退化成永远通过的空壳）
 *   G9  Pi 的三处目录（agentDir / authPath / modelsPath / sessionDir）必须落在 userData 之内
 *   G10 主进程产物必须是 ESM，且 package.json 的 main 指向 .mjs
 *       （Pi 的 exports 只有 `import` 条件，CJS 产物里 `require()` 必炸：ERR_PACKAGE_PATH_NOT_EXPORTED）
 *   G11 ESM 产物里不得出现 `__dirname` / `__filename`
 *   G12 electron-builder 的 asarUnpack 必须覆盖原生依赖（esbuild + clipboard）
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { findHostPathLeaks } from '../src/main/agent/pi-bootstrap.ts'
import { resolvePiPaths } from '../src/main/agent/pi-paths.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...segments: string[]): string => readFileSync(join(desktopRoot, ...segments), 'utf8')

const baselinePrompt = read('src', 'main', 'agent', 'prompts', 'baseline.ts')
const builderYml = read('electron-builder.yml')
const viteConfig = read('electron.vite.config.ts')
const packageJson = JSON.parse(read('package.json')) as { main?: string; dependencies?: Record<string, string> }
const mainEntry = read('src', 'main', 'index.ts')

/** 从 `baseline.ts` 里取出模板字符串字面量（去掉注释与 export 语法）。 */
function extractPromptTemplate(source: string): string {
  const start = source.indexOf('export const BASELINE_SYSTEM_PROMPT = `')
  assert.ok(start >= 0, 'baseline.ts 里找不到 BASELINE_SYSTEM_PROMPT 模板')
  const body = source.slice(start + 'export const BASELINE_SYSTEM_PROMPT = `'.length)
  const end = body.indexOf('`')
  assert.ok(end > 0, 'baseline.ts 的模板字符串没有闭合反引号')
  return body.slice(0, end)
}

test('G7 system prompt 模板本身不含任何宿主路径', () => {
  const template = extractPromptTemplate(baselinePrompt)
  const leaks = findHostPathLeaks(template)
  assert.deepEqual(leaks, [], `prompts/baseline.ts 的模板泄漏了宿主信息：${leaks.join(' / ')}`)
  // 反面：模板也不该把自己暴露成「可被要求朗读」的对象之外的东西 —— 至少要有长度
  assert.ok(template.length > 200, 'system prompt 模板过短，八成被误删')
})

test('G8 findHostPathLeaks 真能抓到泄漏（否则 G7 是空壳）', () => {
  assert.deepEqual(findHostPathLeaks('你现在运行在 C:/Users/abc/app 目录下'), [
    'Windows 盘符路径: C:/',
    'POSIX 家目录: /Users/abc'
  ])
  assert.deepEqual(findHostPathLeaks('root is E:\\work\\k12'), ['Windows 盘符路径: E:\\'])
  assert.deepEqual(findHostPathLeaks('see file:///tmp/x'), ['file:// URL: file://'])
  assert.deepEqual(findHostPathLeaks('干净的一段中文提示'), [])
  // 当前用户名同样要被抓到（这条断言用的是真实进程环境，不会随机器变化而假通过）
  const user = process.env.USERNAME ?? process.env.USER
  if (user && user.length >= 3) {
    assert.ok(
      findHostPathLeaks(`欢迎你，${user}`).some((leak) => leak.includes(user)),
      `当前用户名 ${user} 出现在文本里时必须被抓到`
    )
  }
  // 额外传入的敏感串（如安装目录）也要能被显式拦截
  assert.deepEqual(findHostPathLeaks('路径是 D:/secret/app', ['D:/secret']), [
    'Windows 盘符路径: D:/',
    '显式传入的敏感串: D:/secret'
  ])
})

test('G9 Pi 的三处目录全部落在 userData 之内（不碰 ~/.pi）', () => {
  const userData = join('D:', 'user-data')
  const paths = resolvePiPaths(userData)
  for (const [name, value] of Object.entries(paths)) {
    assert.ok(
      value.startsWith(paths.root),
      `${name} 落在 Pi 根目录之外：${value}（根=${paths.root}）`
    )
  }
  assert.equal(paths.root, join(userData, 'pi-agent'))
  // 显式挡住「有人图省事退回 ~/.pi/agent」这条路径
  assert.ok(!paths.agentDir.includes('.pi'), `agentDir 不得指向用户全局 Pi 目录：${paths.agentDir}`)
  assert.throws(() => resolvePiPaths(''), /userDataDir 不能为空/)
})

test('G10 主进程产物必须是 ESM，且 package.json main 指向 .mjs', () => {
  assert.equal(
    packageJson.main,
    './out/main/index.mjs',
    'package.json 的 main 必须是 out/main/index.mjs（CJS 会让 Pi 的 require() 直接失败）'
  )
  assert.match(
    viteConfig,
    /main:[\s\S]*?format:\s*'es'/,
    'electron.vite.config.ts 的 main 构建必须是 ESM 输出（Pi 是纯 ESM，exports 只有 import 条件）'
  )
  assert.equal(
    packageJson.dependencies?.['@earendil-works/pi-coding-agent'],
    '^0.85.1',
    'Pi 必须锁 ^0.85.1（0.85.0 在 Electron 里因 esbuild 崩溃）'
  )
})

test('G11 主进程源码里不得出现 __dirname / __filename（ESM 下不存在）', () => {
  // 先剥掉注释：注释里**提到** `__dirname` 是合法的（说明为什么不能用），实际**调用**才是问题
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  for (const file of ['src/main/index.ts', 'src/main/agent/pi-bootstrap.ts', 'src/main/agent/pi-paths.ts']) {
    const source = stripComments(read(...file.split('/')))
    assert.ok(!/\b__dirname\b/.test(source), `${file} 调用了 __dirname，ESM 产物里必须改成 import.meta.dirname`)
    assert.ok(!/\b__filename\b/.test(source), `${file} 调用了 __filename，ESM 产物里必须改成 import.meta.filename`)
  }
  assert.match(mainEntry, /import\.meta\.dirname/, '主进程入口应当用 import.meta.dirname 定位 preload/renderer')
})

test('G12 asarUnpack 覆盖原生依赖（esbuild + clipboard）', () => {
  const asarUnpack = builderYml.slice(builderYml.indexOf('asarUnpack:'), builderYml.indexOf('extraResources:'))
  assert.ok(asarUnpack.includes('esbuild'), 'asarUnpack 必须覆盖 esbuild（原生二进制在 asar 内无法执行）')
  assert.ok(
    asarUnpack.includes('@mariozechner/clipboard'),
    'asarUnpack 必须覆盖 clipboard 的 .node（Pi 包根导入会急切加载它）'
  )
  assert.match(asarUnpack, /@esbuild/, 'asarUnpack 必须覆盖 @esbuild/<platform> 平台包')
})
