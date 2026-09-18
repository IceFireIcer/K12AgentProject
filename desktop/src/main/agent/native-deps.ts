/**
 * 原生依赖在**打包产物内**的可用性修复（票 03 / 关卡 B₁ / 风险 #15）。
 *
 * ★★ 这是本项目踩到 Pi 迁移的**真实坑**，不是理论风险。实测现象：
 *
 *   1. `electron-builder.yml` 里把 esbuild 放进 `asarUnpack` 之后，
 *      `resources/app.asar.unpacked/node_modules/@esbuild/win32-x64/esbuild.exe`
 *      确实是一个 11,670,528 B 的实体文件（`verify-unpacked-asars.mjs` 可证）。
 *   2. **但 esbuild 依然起不来**，在打包产物里 `esbuild.buildSync()` 抛：
 *        The service is no longer running: spawn
 *        E:\...\resources\app.asar\node_modules\@esbuild\win32-x64\esbuild.exe ENOENT
 *      注意路径里的 `app.asar`（**不是** `app.asar.unpacked`）。
 *   3. 根因：esbuild 的 `lib/main.js` 用
 *        binPath = require.resolve(`${pkg}/${subpath}`)   // = require.resolve('@esbuild/win32-x64/esbuild.exe')
 *      拿路径。**Electron 的 `require.resolve` 对 asar 内文件会返回 asar 虚拟路径**
 *      （Electron 只给 `fs` 打了 asar 补丁，`child_process.spawn` 没有），
 *      于是 spawn 一个"存在于虚拟文件系统、但 OS 看不到"的路径 → ENOENT。
 *   4. 这与 Pi 官方 issue **#9286**（"Cannot find package 'esbuild'" in Electron）是同一个故障。
 *
 * 结论（写进报告素材）：**「解包」是必要条件，不是充分条件**。
 *   必须再补一步：把 esbuild 的 `ESBUILD_BINARY_PATH` 环境变量显式指向
 *   `app.asar.unpacked/...` 下的实体文件 —— 这是 esbuild 官方留的逃生口
 *   （`isValidBinaryPath(ESBUILD_BINARY_PATH)` 分支优先于 `require.resolve`）。
 *
 * 何时调用：**在任何 `import('esbuild')` 之前**。esbuild 在模块求值时就把
 * `process.env.ESBUILD_BINARY_PATH` 读进局部变量（实测 0.28.1 的 `lib/main.js:1889`：
 * `var ESBUILD_BINARY_PATH = process.env.ESBUILD_BINARY_PATH || ESBUILD_BINARY_PATH;`），
 * 之后再设已经晚了。
 *
 * ⚠️ 本应用**不在启动路径上调用**它：导入图实测（`scripts/pi-import-graph.mjs`）表明
 *  Pi 的包根导入**不触及 esbuild**（esbuild 只被 `@earendil-works/chord/dist/node/bundle.js`
 *  引用，而 Pi 从不导入 `chord/bundler` / `chord/node`）。当前唯一的 esbuild 使用者是
 *  关卡 B₁ 的原生依赖探针（`pi-bootstrap.probeNativeDeps()`），它自己会在 `require('esbuild')`
 *  之前调用本函数。将来若真要用 chord 打包 Extension，**必须在那个 import 之前**补一次调用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 把 asar 虚拟路径映射到 `app.asar.unpacked/` 下的实体路径。
 * 纯 Node / 开发态下是恒等变换（路径里没有 `app.asar` 段）。
 */
export function toUnpackedPath(path: string): string {
  const marker = `${sep}app.asar${sep}`
  if (!path.includes(marker)) return path
  const candidate = path.replace(marker, `${sep}app.asar.unpacked${sep}`)
  return existsSync(candidate) ? candidate : path
}

/**
 * 从给定入口逐级向上，在**每一层** `node_modules` 里找 `@esbuild/<platform>/esbuild[.exe]`，
 * 并优先返回 `app.asar.unpacked/` 下的实体文件。
 *
 * 复现 Node 的真实解析顺序：先看包自己那层（Pi 嵌套副本），再看被提升到顶层的副本。
 */
export function findEsbuildBinaryNear(entryPath: string): string | undefined {
  const platform = `${process.platform}-${process.arch}`
  const binaryName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild'
  let dir = dirname(entryPath)
  for (let i = 0; i < 8; i += 1) {
    const candidate = toUnpackedPath(join(dir, 'node_modules', '@esbuild', platform, binaryName))
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 从给定入口逐级向上找 **esbuild 的 JS 包**（`node_modules/esbuild/package.json`）。
 *
 * ★ 为什么必须和「找二进制」用同一个起点：本仓库里有**三份** esbuild
 *   （顶层 0.25.12 = electron-vite 的构建期依赖、`vite/node_modules` 0.28.2、
 *    `pi-coding-agent/node_modules` 0.28.1 = chord 声明的那个）。
 *   二进制和 JS 包如果来自不同副本，`--version` 是通的但真实打包会炸
 *   （版本不匹配时 esbuild 服务端与客户端协议对不上）。所以这里让两者**同源**。
 */
export function findEsbuildPackageJsonNear(entryPath: string): string | undefined {
  let dir = dirname(entryPath)
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'node_modules', 'esbuild', 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 一次解析的完整结果（诊断用，字段都尽量给全，缺哪一项就说明哪一项）。 */
export interface EsbuildLocation {
  /** 解析起点（应传 Pi 的入口文件，才能命中 chord 真正会用的那一份）。 */
  searchedFrom: string
  /** require 会命中的 `esbuild/package.json`。 */
  packageJson?: string
  /** 从 `package.json` 读出的版本（与二进制必须来自同一副本）。 */
  version?: string
  /** `@esbuild/<platform>/esbuild[.exe]` 的路径（已尽量纠正到 `app.asar.unpacked/`）。 */
  binary?: string
  /** ★ 二进制是否仍落在 `app.asar` 内（= 未解包，OS 执行不了）。 */
  binaryInsideAsar: boolean
}

/** 只做解析、不改环境变量。 */
export function locateEsbuild(entryPath: string): EsbuildLocation {
  const packageJson = findEsbuildPackageJsonNear(entryPath)
  let version: string | undefined
  if (packageJson) {
    try {
      version = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: string }).version
    } catch {
      // 读不出来就算了，版本只是交叉核对用的信息
    }
  }
  const binary = findEsbuildBinaryNear(entryPath)
  return {
    searchedFrom: entryPath,
    packageJson,
    version,
    binary,
    binaryInsideAsar: Boolean(binary && binary.includes(`${sep}app.asar${sep}`))
  }
}

/**
 * ★ 幂等地修好 esbuild 的二进制路径。返回实际生效的路径（`undefined` = 没找到，
 * 此时**不要**写环境变量，宁可让 esbuild 用它自己的逻辑报出原始错误）。
 *
 * `entryPath` 传 Pi 的入口文件（`pi-coding-agent/dist/index.js`）：那里向上解析到的
 * 就是 chord 声明的 `esbuild@0.28.1` + 它自己的 `@esbuild/win32-x64`，两者同源。
 */
export function ensureEsbuildBinaryPath(entryPath: string = import.meta.url): string | undefined {
  const entryFile = entryPath.startsWith('file:') ? entryPath : pathToFileURL(entryPath).href
  const fromPath = entryFile.startsWith('file:')
    ? decodeURIComponent(new URL(entryFile).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
    : entryFile
  const location = locateEsbuild(fromPath)
  if (!location.binary) return undefined
  // 只在指向实体文件时才设：写一个 asar 内路径进去，反而会把 esbuild 引到 ENOENT。
  if (location.binaryInsideAsar) return undefined
  if (process.env.ESBUILD_BINARY_PATH !== location.binary) {
    process.env.ESBUILD_BINARY_PATH = location.binary
  }
  return location.binary
}
