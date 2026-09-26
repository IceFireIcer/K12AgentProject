/**
 * 打包体积守卫（D-068）—— 盯住「什么会进安装包」这一类**跑应用时看不出来**的约定。
 *
 * 为什么需要这组断言：一个包进不进包，本地跑应用、跑单测**都发现不了** ——
 * 它只是让安装包悄悄胖一倍。实测：渲染进程的 9 个依赖（element-plus / monaco-editor /
 * lucide-vue-next…）连同它们的传递依赖一共 **31 个包 / 167MB**，一直躺在 asar 里，
 * 而它们的代码**早就被 vite 打进 `out/renderer` 了**（renderer 段没有 `externalizeDepsPlugin()`）。
 * 删掉它们应用照跑，不删也照跑 —— 所以只有断言能拦住它再长回来。
 *
 * 判据只有一条：**electron-builder 只打包 `package.json` 的 `dependencies`**。
 * 于是「这个包运行时到底要不要」就等价于「它在 dependencies 还是 devDependencies」：
 *
 *   - 主进程 / preload 运行时**真的** `import` / `require` 的 → `dependencies`（会进包）
 *   - 只被 vite 在构建期读走、打进 `out/renderer` 的 → `devDependencies`（不进包）
 *
 *   G24-1  `dependencies` 恰好是主进程/preload 运行时真要的那 4 个（多一个就是多打进一次包）
 *   G24-2  9 个渲染专用包**必须**在 devDependencies（少一个渲染进程就构建不出来）
 *   G24-3  主进程/preload 源码**不得** import 任何一个渲染专用包（否则 G24-2 会把运行时弄崩）
 *   G24-4  `electronLanguages` 是白名单、且**必须含 en-US**（英文系统上原生对话框要它）
 *   G24-5  `files` 排除 `resources/pyodide/**`（vite 已拷一份到 out/renderer，再收一份是纯重复）
 *   G24-6  `resources/brand/**` **不得**被排除（主进程窗口图标亲自读它）
 *   G24-7  renderer 构建 `emptyOutDir: true`（否则上一轮的 chunk 会留在产物里累加）
 *   G24-8  `resources/` 下的每一项，要么是主进程亲自读的，要么已在 files 里被排除
 *   G24-9  `publicDir` 仍指向 `resources/`（G24-5 成立的前提：渲染进程那份是从这里拷的）
 *
 * 跑法：`npm test`。产物级检查另有一个工具：`npm run check:bundle`（拆开 asar 数体积）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const builderYml = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')
const viteConfig = readFileSync(join(desktopRoot, 'electron.vite.config.ts'), 'utf8')

const dependencies = Object.keys(pkg.dependencies ?? {}).sort()
const devDependencies = Object.keys(pkg.devDependencies ?? {})

/**
 * 主进程 / preload 运行时**真的**需要的包（= 允许出现在 `dependencies` 里的全部）。
 *
 * 逐个说明为什么它不能挪走（挪走 = 打包后运行时 `Cannot find package`）：
 *   - `@earendil-works/pi-coding-agent`：主进程 `await import()` 它（ESM，只有 import 条件，
 *     `externalizeDepsPlugin()` 会把依赖留成运行期解析 → 包里必须有实体）。
 *   - `@electron-toolkit/utils`：主进程**静态 import**（构建产物里能 grep 到）。
 *   - `@electron-toolkit/preload`：preload 那一侧要用。
 *   - `@sinclair/typebox`：主进程**静态 import**（Tool 参数 schema）。
 */
const RUNTIME_DEPENDENCIES = [
  '@earendil-works/pi-coding-agent',
  '@electron-toolkit/preload',
  '@electron-toolkit/utils',
  '@sinclair/typebox'
]

/**
 * 只被渲染进程使用的包 —— 它们**全部**由 vite 打进 `out/renderer`，运行期不再读 node_modules。
 *
 * ⚠️ 往这里加名字之前先自问：它的代码真的进了 `out/renderer` 吗？
 *    判据是 renderer 段**没有** `externalizeDepsPlugin()` —— 所以只要源码里有
 *    字面量 `import`，vite 就会把它内联。（`monaco-setup.ts` 用的是
 *    `await import('monaco-editor/editor/editor.api')` 这种**字面量动态 import**，
 *    vite 照样切 chunk 打进产物，一样算「不需要 node_modules」。）
 */
const RENDERER_ONLY_PACKAGES = [
  '@element-plus/icons-vue',
  '@fontsource-variable/inter',
  '@fontsource-variable/jetbrains-mono',
  '@fontsource-variable/noto-sans-sc',
  'animejs',
  'element-plus',
  'lucide-vue-next',
  'monaco-editor',
  'pinia',
  // 长列表虚拟化（报告 §5.2 / D10）：只被渲染进程 import，代码由 vite 打进 out/renderer。
  'vue-virtual-scroller'
]

/** 把 `files:` 段（缩进两格、到下一个顶级键为止）的原文取出来。 */
function filesBlock(): string {
  const matched = /\nfiles:\n([\s\S]*?)(?=\n[a-zA-Z])/.exec(builderYml)
  assert.ok(matched, 'electron-builder.yml 里找不到 files: 段（锚点漂了就改为从这里读）')
  return matched[1]
}

/** `files:` 段里出现过的排除模式（去掉 YAML 引号）。 */
function excludedPatterns(): string[] {
  return [...filesBlock().matchAll(/^\s*-\s*'(![^']+)'/gm)].map((m) => m[1])
}

/** 递归收集目录下所有 .ts / .vue 源码文件（相对 desktopRoot 的路径）。 */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(desktopRoot, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|vue)$/.test(e.name))
    .map((e) => {
      const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath ?? (e as unknown as { path?: string }).path ?? dir
      return join(parent, e.name)
    })
}

test('G24-1 `dependencies` 恰好是主进程/preload 运行时真要的那 4 个', () => {
  assert.deepEqual(
    dependencies,
    [...RUNTIME_DEPENDENCIES].sort(),
    '`dependencies` 与预期不符。electron-builder **只**打包 dependencies，所以多一个包 = 多打进一次包\n' +
      '（渲染进程的依赖请放 devDependencies —— 它们的代码已经由 vite 打进 out/renderer 了）。\n' +
      '如果一个包**确实**是主进程/preload 运行时要的，把它的名字与理由加进 RUNTIME_DEPENDENCIES。'
  )
})

test('G24-2 渲染专用包必须都在 devDependencies', () => {
  for (const name of RENDERER_ONLY_PACKAGES) {
    assert.ok(
      devDependencies.includes(name),
      `${name} 不在 devDependencies 里。它在 dependencies 里就会被打进 asar，` +
        '而它的代码**已经**在 out/renderer 里了 —— 那是同一份代码打两遍（实测 31 个包 / 167MB）。'
    )
    assert.ok(
      !dependencies.includes(name),
      `${name} 同时出现在 dependencies 里（G24-1 也会红）—— 从 dependencies 里删掉它。`
    )
  }
})

test('G24-3 主进程/preload 源码不得 import 渲染专用包', () => {
  for (const dir of ['src/main', 'src/preload', 'src/shared']) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, 'utf8')
      for (const name of RENDERER_ONLY_PACKAGES) {
        // 匹配 `from 'x'` / `require('x')` / `import('x')`（含子路径 `x/y`）
        const referenced = new RegExp(`(from|require\\(|import\\()\\s*['"]${name}(/|['"])`).test(source)
        assert.ok(
          !referenced,
          `${file.replace(desktopRoot, '')} 引用了 ${name}。\n` +
            '它被挪进 devDependencies 的前提就是「只有渲染进程用」—— 主进程一旦 import 它，\n' +
            '打包后运行时会 Cannot find package。要么把这段逻辑搬进渲染进程，' +
            '要么把这个包移回 dependencies（并接受它进包）。'
        )
      }
    }
  }
})

test('G24-4 electronLanguages 是白名单且必含 en-US', () => {
  const matched = /\nelectronLanguages:\n([\s\S]*?)(?=\n[a-zA-Z])/.exec(builderYml)
  assert.ok(
    matched,
    '找不到 electronLanguages —— 没有它，Electron 自带的 55 个 locales/*.pak（49MB）会全部进包，' +
      '而这个应用只有中文界面、只有一处原生对话框（导出学习档案的 dialog.showSaveDialog）。'
  )
  const langs = [...matched[1].matchAll(/^\s*-\s*(\S+)/gm)].map((m) => m[1])
  assert.ok(langs.length > 0, 'electronLanguages 是空列表')
  for (const lang of langs) {
    assert.ok(!lang.includes('*'), `electronLanguages 里不许出现通配符（${lang}）—— 那就等于没裁。`)
  }
  assert.ok(
    langs.some((l) => l.toLowerCase().startsWith('en')),
    'electronLanguages 必须包含英文（en-US）：学生的系统若是英文 Windows，' +
      '删了它连「保存 / 取消」都会是别的语言 —— 这是裁剪唯一有用户可见后果的地方。'
  )
  assert.ok(langs.some((l) => l.toLowerCase().startsWith('zh')), 'electronLanguages 必须包含中文')
})

test('G24-5 files 排除了 resources/pyodide（vite 已拷一份到 out/renderer）', () => {
  assert.ok(
    excludedPatterns().includes('!resources/pyodide/**'),
    '`files` 里缺少 `!resources/pyodide/**`。\n' +
      '渲染进程的 pyodide 资源来自 vitet 的 publicDir 拷贝（打包态解析成\n' +
      '`file://…/out/renderer/pyodide/`，见 sandbox/pyodide-runner.ts 的 PYODIDE_INDEX_URL）；\n' +
      '`resources/pyodide/` 那一份**没有任何代码读它**，实测 15.73MB，而且被 asarUnpack 解包后实占磁盘。'
  )
})

test('G24-6 resources/brand 不得被排除（主进程窗口图标要读它）', () => {
  for (const pattern of excludedPatterns()) {
    assert.ok(
      !/resources\/brand/.test(pattern),
      `files 里的 ${pattern} 会把 resources/brand/** 排除掉 —— 但主进程的窗口图标\n` +
        '（src/main/index.ts 的 icon: ../../resources/brand/main.png）**亲自**读它，\n' +
        '排除后打包态的窗口图标会消失。'
    )
  }
})

test('G24-7 renderer 构建必须 emptyOutDir（否则旧 chunk 会累加进包）', () => {
  assert.ok(
    // ⚠️ 只要求「renderer 的 build 段里开着 emptyOutDir」，不钉它是不是唯一一项 ——
    //    build 段里还有 minify（WP-13 的压缩开关，报告 §5.1），写成严格紧邻的
    //    `emptyOutDir: true }` 会在加第二个键时误报（2026-09-27 实测踩到一次）。
    /build:\s*\{[\s\S]{0,400}?emptyOutDir:\s*true/.test(viteConfig),
    'electron.vite.config.ts 的 renderer 段缺少 `build: { emptyOutDir: true }`。\n' +
      'vite 的 outDir 在项目 root 之外时 `emptyOutDir` 默认是 false（对照实测：\n' +
      '往 out/renderer/assets/ 放一个假文件再构建 —— false 时它还在、true 时被清掉）。\n' +
      '不清空就会累积历史 chunk，而 electron-builder 会把这些没人引用的文件一并收进 asar。'
  )
})

test('G24-8 resources/ 下每一项要么主进程亲自读、要么已在 files 里排除', () => {
  const MAIN_READS = ['brand'] // 主进程窗口图标（见 G24-6）
  const pattern = excludedPatterns()
  const entries = readdirSync(join(desktopRoot, 'resources'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)

  assert.ok(entries.length > 0, 'resources/ 是空的 —— publicDir 指向它，渲染进程的自托管资源从这里拷')
  for (const name of entries) {
    if (MAIN_READS.includes(name)) continue
    assert.ok(
      pattern.includes(`!resources/${name}/**`),
      `resources/${name}/ 既不是主进程亲自读的，也没在 files 里排除。\n` +
        '这个目录**会同时**被 vite 拷进 out/renderer（运行时读的是那一份）**和**被 electron-builder\n' +
        '收进 asar 根 —— 同一份资源打两遍。要么加一条 `!resources/' +
        name +
        '/**`（前提是渲染进程不需要它），\n' +
        '要么把它放进 MAIN_READS（并确认主进程真的读）。'
    )
  }
})

test('G24-9 publicDir 仍指向 resources/（G24-5/G24-8 的成立前提）', () => {
  assert.ok(
    /publicDir:\s*resolve\('resources'\)/.test(viteConfig),
    'renderer 的 publicDir 不再指向 `resources/`。\n' +
      'out/renderer 下的自托管资源（pyodide / brand）就是从这里拷过去的 —— 这条链断了的话，\n' +
      'G24-5 的「渲染进程读 out/renderer 那一份」与 G24-8 的重复判据同时失效。'
  )
})
