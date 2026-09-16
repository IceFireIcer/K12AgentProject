/**
 * 票 03 / 风险 #17 证据工具：**实测** Pi 的导入图，不靠假设。
 *
 * 做法：用 Node 的同步模块钩子（`module.registerHooks`，Node >= 22.15）记录每一次
 * `resolve`，再 `import()` 目标入口，最后统计：
 *   - 一共加载了多少模块；
 *   - 是否触及 `@earendil-works/chord` / `esbuild` / `dist/bundle` / CLI 的 `main.js`；
 *   - 加载到的外部包（node_modules）清单。
 *
 * 跑法（在 desktop/ 下）：
 *   node scripts/pi-import-graph.mjs                                  # 默认：包根入口
 *   node scripts/pi-import-graph.mjs @earendil-works/pi-coding-agent/rpc-entry
 *   node scripts/pi-import-graph.mjs ./node_modules/.../dist/bundle/index.js
 *   node scripts/pi-import-graph.mjs --json                            # 机器可读输出
 */

import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const target = argv.find((arg) => !arg.startsWith('--')) ?? '@earendil-works/pi-coding-agent'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(pathToFileURL(resolve(desktopRoot, 'package.json')))

/**
 * 解析出目标入口的真实文件路径（先于钩子，避免把探针自己算进去）。
 * 本脚本位于 desktop/scripts/，`import.meta.resolve` 会向上找到 desktop/node_modules。
 * ★ 同时记录 `require.resolve` 的结果：Pi 只有 `import` 条件，**CJS 侧 require 会失败**，
 *   这正是「主进程 CJS 产出 + externalizeDepsPlugin 会把 Pi 变成失败的 require()」的证据。
 */
let entryPath
let requireResolveError = null
try {
  // 相对/绝对路径直接转 file URL，避免 `node_modules/...` 被当成包名解析
  entryPath =
    /^[./\\]|[A-Za-z]:[\\/]/.test(target) && !target.startsWith('//')
      ? fileURLToPath(pathToFileURL(resolve(desktopRoot, target)).href)
      : fileURLToPath(import.meta.resolve(target))
} catch (error) {
  console.error(`无法解析入口 ${target}：${error.message}`)
  process.exit(2)
}
try {
  require.resolve(target)
} catch (error) {
  requireResolveError = `${error.code ?? 'ERR'}: ${error.message}`
}

/** 记录所有 resolved URL。 */
const resolved = []
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    resolved.push({ specifier, url: result.url })
    return result
  }
})

const startedAt = process.hrtime.bigint()
let importError = null
let entryExports = []
try {
  const namespace = await import(pathToFileURL(entryPath).href)
  entryExports = Object.keys(namespace).sort()
} catch (error) {
  importError = error
}
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

const fileUrls = resolved.map((entry) => entry.url).filter((url) => url.startsWith('file:'))
const filePaths = fileUrls.map((url) => fileURLToPath(url).replace(/\\/g, '/'))
const unique = [...new Set(filePaths)]
const specifierByUrl = new Map(resolved.map((entry) => [entry.url, entry.specifier]))

const probe = (needle) => unique.filter((path) => path.toLowerCase().includes(needle.toLowerCase()))

/** node_modules 里的包名（含 scope）。 */
const packagesOf = (paths) =>
  [
    ...new Set(
      paths
        .map((path) => {
          const index = path.lastIndexOf('/node_modules/')
          if (index < 0) return null
          const tail = path.slice(index + '/node_modules/'.length)
          const segments = tail.split('/')
          return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
        })
        .filter(Boolean)
    )
  ].sort()

const findings = {
  target,
  entryPath: entryPath.replace(/\\/g, '/'),
  cjsRequireError: requireResolveError,
  importOk: importError === null,
  importError: importError === null ? null : String(importError),
  elapsedMs: Number(elapsedMs.toFixed(1)),
  moduleCount: unique.length,
  exportCount: entryExports.length,
  cliMainJs: probe('/pi-coding-agent/dist/main.js'),
  bundledCliChunks: probe('/pi-coding-agent/dist/bundle/'),
  chord: probe('/@earendil-works/chord/'),
  esbuild: probe('/esbuild/'),
  nativeBinaries: unique.filter((path) => /esbuild\.exe$|\.node$|\.dll$/i.test(path)),
  packages: packagesOf(unique)
}

if (asJson) {
  console.log(JSON.stringify(findings, null, 2))
} else {
  console.log(`入口           : ${findings.target}`)
  console.log(`实际文件       : ${findings.entryPath}`)
  console.log(`CJS require()  : ${findings.cjsRequireError ? `失败 -> ${findings.cjsRequireError}` : 'OK'}`)
  console.log(`ESM import     : ${findings.importOk ? 'OK' : `失败 -> ${findings.importError}`}`)
  console.log(`耗时           : ${findings.elapsedMs} ms`)
  console.log(`加载模块数     : ${findings.moduleCount}`)
  console.log(`根导出符号数   : ${findings.exportCount}`)
  console.log('')
  console.log(`是否评估 CLI main.js   : ${findings.cliMainJs.length ? '是' : '否'}  ${findings.cliMainJs.join(', ')}`)
  console.log(`是否加载 bundle/ 分块 : ${findings.bundledCliChunks.length ? '是' : '否'}  ${findings.bundledCliChunks.join(', ')}`)
  console.log(`是否拖入 chord        : ${findings.chord.length ? '是' : '否'}  ${findings.chord.join(', ')}`)
  console.log(`是否拖入 esbuild      : ${findings.esbuild.length ? '是' : '否'}  ${findings.esbuild.join(', ')}`)
  console.log(`加载到的原生文件      : ${findings.nativeBinaries.length ? findings.nativeBinaries.join(', ') : '（无）'}`)
  console.log('')
  console.log(`本次实际加载的 node_modules 包（${findings.packages.length}）：`)
  for (const name of findings.packages) console.log(`  - ${name}`)
}

process.exitCode = importError === null ? 0 : 1
