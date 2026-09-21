#!/usr/bin/env node
/**
 * 构建版本号派生（D-067）—— **唯一**决定「这次打包是几号版本」的地方。
 *
 * 为什么需要一个脚本而不是手改 `package.json`：
 *   手改的版本号有两个死结 —— ① 忘了改，于是每个 nightly 都叫 `0.1.0`，
 *   安装包同名互相覆盖，用户也看不出自己装的是哪一版；② 手改的数字**不保证递增**，
 *   而「装上去了但看不出版本变化」会让升级演练失去判据。
 *
 * 规则（优先级从高到低）：
 *
 * | 输入 | 结果 | 谁用 |
 * | --- | --- | --- |
 * | `K12_VERSION=1.2.3` | 原样采用 | 手工发版 / 指定版本复现 |
 * | `GITHUB_RUN_NUMBER=N`（CI） | `<major>.<minor>.<N>` | nightly —— **单调递增** |
 * | 都没有（本地开发） | 保持 `package.json` 里的版本不动 | 本地 `build:win` |
 *
 * ★★ **为什么是 `<major>.<minor>.<run>` 这个形状**（而不是 `0.1.0-nightly.20260921`）：
 *   NSIS 的 `VIProductVersion` 只接受 **`X.X.X.X` 四段数字、每段 ≤ 65535**；
 *   electron-builder 用 `getVersionInWeirdWindowsForm()` 解析 `version` 的前三段
 *   （`parseInt` 每段），第四段另取 buildNumber。
 *   所以：
 *   - **不能**把日期直接塞成一段（`20260921 > 65535` → makensis 直接报
 *     `invalid VIProductVersion format`，整条打包链失败）；
 *   - **不要**用 `-nightly.<date>` 之类的 prerelease 后缀：`parseInt('0-nightly')` 虽然
 *     碰巧是 0（不报错），但四段数字里**丢掉了构建信息**，Windows 文件版本对所有
 *     nightly 都是同一个值，「版本号高」就无从判定。
 *   run number 是小整数（本仓库量级：几十），几十年都到不了 65535。
 *
 * 用法：
 *   node scripts/build-version.mjs            # 只打印（不写文件）
 *   node scripts/build-version.mjs --write    # 写进 package.json + package-lock.json
 *
 * ⚠️ 它**改的是工作区文件**，所以只在 CI 的打包步骤里跑（工作区是一次性的）。
 *   本地要跑就自己 `git checkout -- package.json package-lock.json` 收尾。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Windows 版本信息的每一段都是 16 位无符号（0–65535）。
 * 超过它 → NSIS `VIProductVersion` 报错 → **打包整个失败**（而不是降级）。
 */
export const MAX_VERSION_PART = 65535

/** `X.Y.Z` → `[X, Y, Z]`；不是三段数字、或某段越界就抛（**响亮失败**，不静默截断）。 */
export function parseSemverTriple(value, label) {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim())
  if (matched === null) {
    throw new Error(`${label} 必须是 X.Y.Z 三段数字（NSIS 只接受这种形状），实际是：${value}`)
  }
  const parts = [Number(matched[1]), Number(matched[2]), Number(matched[3])]
  for (const part of parts) {
    if (part > MAX_VERSION_PART) {
      throw new Error(
        `${label} 的某一段超过 ${MAX_VERSION_PART}（Windows 版本信息的每段是 16 位）：${value}`
      )
    }
  }
  return parts
}

/**
 * 纯函数：算出这次构建该用的版本号。**不碰文件系统**，便于单测。
 *
 * @param {{ base?: unknown, override?: unknown, runNumber?: unknown }} input
 *   `base` = package.json 里的版本（人工维护的基线）
 *   `override` = `K12_VERSION`（显式指定，最高优先）
 *   `runNumber` = `GITHUB_RUN_NUMBER`（CI 提供；单调递增）
 */
export function computeBuildVersion(input = {}) {
  const [major, minor, patch] = parseSemverTriple(input.base, 'package.json 的 version（基线版本）')

  // ① 显式指定优先：手工发版、或要复现某个具体版本时用。
  const overrideRaw = String(input.override ?? '').trim()
  if (overrideRaw !== '') {
    const [oMajor, oMinor, oPatch] = parseSemverTriple(overrideRaw, 'K12_VERSION')
    return { version: `${oMajor}.${oMinor}.${oPatch}`, reason: 'K12_VERSION（显式指定）' }
  }

  // ② CI：把 major.minor 留在人工手里，**第三段交给 run number**（单调递增）。
  const runRaw = String(input.runNumber ?? '').trim()
  if (runRaw !== '') {
    if (!/^\d+$/.test(runRaw)) {
      throw new Error(`GITHUB_RUN_NUMBER 必须是纯数字，实际是：${runRaw}`)
    }
    const run = Number(runRaw)
    if (run < 1 || run > MAX_VERSION_PART) {
      throw new Error(
        `GITHUB_RUN_NUMBER=${run} 超出可用区间 1–${MAX_VERSION_PART}；` +
          '请把 package.json 的基线版本往上抬一档（改 minor）后重新发版'
      )
    }
    return { version: `${major}.${minor}.${run}`, reason: `CI run number（第 ${run} 次）` }
  }

  // ③ 本地：**不动** package.json 的版本（本地构建不冒充某个 nightly 版本号）。
  return { version: `${major}.${minor}.${patch}`, reason: '本地构建（保持基线版本）' }
}

/** `package.json` + `package-lock.json` 里的三处 version 一起改（避免 npm 认为两者不同步）。 */
function stamp(version) {
  const touched = []
  for (const [file, apply] of [
    ['package.json', (data) => ({ ...data, version })],
    [
      'package-lock.json',
      (data) => {
        const next = { ...data, version }
        if (next.packages && next.packages['']) {
          next.packages = { ...next.packages, '': { ...next.packages[''], version } }
        }
        return next
      }
    ]
  ]) {
    const path = join(desktopRoot, file)
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      if (data.version === version) continue
      // 保持 2 空格缩进 + 结尾换行（与仓库里原有的格式一致，diff 才不乱）
      writeFileSync(path, `${JSON.stringify(apply(data), null, 2)}\n`, 'utf8')
      touched.push(file)
    } catch (error) {
      if (error && error.code === 'ENOENT') continue // package-lock 可能不存在（不强制）
      throw error
    }
  }
  return touched
}

function main() {
  const write = process.argv.includes('--write')
  const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'))
  const { version, reason } = computeBuildVersion({
    base: pkg.version,
    override: process.env.K12_VERSION,
    runNumber: process.env.GITHUB_RUN_NUMBER
  })
  const changed = write ? stamp(version) : []
  console.log(`[build-version] ${version}　（来源：${reason}）`)
  console.log(
    changed.length > 0
      ? `[build-version] 已写入：${changed.join(' / ')}`
      : write
        ? '[build-version] 版本未变，无文件改动'
        : '[build-version] 未加 --write，只打印'
  )
}

// 只在被当成脚本直接跑时执行（被 import 做单测时不跑）。
if (process.argv[1] && process.argv[1].endsWith('build-version.mjs')) {
  main()
}
