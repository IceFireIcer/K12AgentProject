/**
 * ★★ 构建联动：**前端构建前自动确保 sidecar 是最新的**（P-072 的根治）。
 *
 * 为什么需要它：sidecar 是**独立打包的产物**（PyInstaller → `server/dist/k12-agent-server/`），
 * 它不随 `electron-vite build` 更新；而 `electron-builder` 只是把磁盘上**现成的那份** exe
 * 拷进安装包（`electron-builder.yml` 的 `extraResources`）。于是：
 *
 *   「改了 `server/` 但没重跑 `build_server.py`」= **包里跑的是几天前的后端** ——
 *   能构建、能通过全部单测（单测测的是源码）、只是新端点 404 / 老 bug 还在。
 *
 * 本脚本把这条纪律变成**代码**，而不是文档里的一句「记得先跑」：
 *
 *   node scripts/build-server.mjs                 # ensure：过期内重打（挂在 npm run build 前）
 *   node scripts/build-server.mjs --check dist     # 校验 server/dist 里的产物是最新的
 *   node scripts/build-server.mjs --check packaged # 校验**装进安装包后**的那一份是最新的
 *
 * 判定算法只有一份：`server/scripts/build_info.py` 算源码指纹，本脚本只做调用与比对
 * —— 两套算法一旦有细微差异（排序 / 编码 / 换行），会出现「刚打过包却永远判过期」
 * 或更糟的「过期却判新鲜」。所以这里**不重写**哈希逻辑。
 *
 * 逃生舱：`K12_SKIP_SERVER_BUILD=1`（例如 CI 里刚单独打过、或临时只想编前端）。
 * 用了它会**明确打印警告**，不会静默跳过 —— 静默跳过正是这个脚本要消灭的东西。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = resolve(HERE, '..')
const REPO = resolve(DESKTOP, '..')
const SERVER = join(REPO, 'server')
const BUILD_INFO_SCRIPT = join(SERVER, 'scripts', 'build_info.py')
const BUILD_SERVER_SCRIPT = join(SERVER, 'scripts', 'build_server.py')

const SERVER_DIST = join(SERVER, 'dist', 'k12-agent-server')
const PACKAGED_DIST = join(DESKTOP, 'dist', 'win-unpacked', 'resources', 'server')

/** 产物里的指纹文件名（与 `server/scripts/build_info.py` 的 BUILD_INFO_FILENAME 一致）。 */
const BUILD_INFO_FILENAME = 'build-info.json'

const dim = (text) => `\u001b[2m${text}\u001b[0m`
const red = (text) => `\u001b[31m${text}\u001b[0m`
const yellow = (text) => `\u001b[33m${text}\u001b[0m`
const green = (text) => `\u001b[32m${text}\u001b[0m`

function fail(message) {
  console.error(`\n${red('✗')} ${message}\n`)
  process.exit(1)
}

/**
 * 统一走 `uv`：本机裸 `python` / `py` 指向已删除的 `D:\\Code\\PythonEvm`
 * （残留注册项，报 `0x80070003`）。见 AGENTS.md §8.1。
 */
function runUv(args, options = {}) {
  const result = spawnSync('uv', ['run', 'python', ...args], {
    cwd: SERVER,
    stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    env: process.env
  })
  if (result.error?.code === 'ENOENT') {
    fail(
      '找不到 `uv` —— 本项目的 Python 一律经 uv 运行（裸 python 在本机不可用）。\n' +
        '  安装：https://docs.astral.sh/uv/  ；或设 K12_SKIP_SERVER_BUILD=1 临时只编前端（会跳过产物新鲜度保障）'
    )
  }
  if (result.error) fail(`调用 uv 失败：${result.error.message}`)
  return result
}

/** 当前源码的指纹（**唯一实现**在 Python 侧）。 */
function currentFingerprint(label) {
  if (!existsSync(BUILD_INFO_SCRIPT)) fail(`找不到 ${BUILD_INFO_SCRIPT}`)
  const result = runUv([BUILD_INFO_SCRIPT, '--fingerprint'], { capture: true })
  if (result.status !== 0) fail(`算源码指纹失败（退出码 ${result.status}）`)
  const value = (result.stdout ?? '').trim().split(/\r?\n/).pop()?.trim()
  if (!value || !/^[0-9a-f]{64}$/.test(value)) {
    fail(`源码指纹格式不对（${label}）：${JSON.stringify(result.stdout)}`)
  }
  return value
}

/** 读某个产物目录里的 `build-info.json`。 */
function readStamp(directory) {
  const path = join(directory, BUILD_INFO_FILENAME)
  try {
    return { path, data: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { path, data: null, error }
  }
}

/**
 * 校验某个目录里的产物是**当前源码**打出来的，且**已经装进了安装包**时的额外一致性。
 * 返回 true = 新鲜。
 */
function checkStamp(directory, where, expected) {
  const stamp = readStamp(directory)
  if (!stamp.data) {
    console.error(`${red('✗')} ${where} 里没有可用的 ${BUILD_INFO_FILENAME}：${stamp.path}`)
    if (stamp.error) console.error(dim(`    ${stamp.error.message}`))
    return false
  }
  const recorded = String(stamp.data.fingerprint ?? '')
  const commit = stamp.data.gitCommit ?? '?'
  const builtAt = stamp.data.builtAt ?? '?'
  if (recorded !== expected) {
    console.error(
      `${red('✗')} ${where} 的后端不是当前源码打的：\n` +
        `    产物 ${recorded.slice(0, 16)}…（${builtAt} @ ${commit}）\n` +
        `    源码 ${expected.slice(0, 16)}…\n` +
        `    修法：cd server && uv run python scripts/build_server.py  （或整条链重跑 npm run build:win）`
    )
    return false
  }
  console.log(`${green('✓')} ${where} 的后端与当前源码一致：${recorded.slice(0, 16)}… @ ${commit}（${builtAt}）`)
  return true
}

function ensureServerBuild() {
  if (!existsSync(BUILD_SERVER_SCRIPT)) fail(`找不到 ${BUILD_SERVER_SCRIPT}`)
  console.log(
    dim('[build-server] 检查 sidecar 是否为当前源码所打（过期则自动重打，P-072 的构建联动）')
  )
  // `--if-stale`：产物新鲜就秒退（不碰 PyInstaller），过期才走完整的「建库 + 打包 + 24 项自检」。
  const result = runUv([BUILD_SERVER_SCRIPT, '--if-stale'])
  if (result.status !== 0) {
    fail(
      `sidecar 构建/自检失败（退出码 ${result.status}）。\n` +
        '  上面有具体是哪一项断言没过 —— 别绕过它：产物有问题时打出的安装包一定跑不起来。'
    )
  }
}

function main() {
  const args = process.argv.slice(2)
  const checkIndex = args.indexOf('--check')
  const target = checkIndex >= 0 ? args[checkIndex + 1] : null

  if (checkIndex >= 0 && !target) {
    fail('--check 需要目标：--check dist（server/dist 产物）或 --check packaged（安装包内那一份）')
  }

  if (process.env.K12_SKIP_SERVER_BUILD === '1') {
    if (!target) {
      console.log(
        `${yellow('⚠')} K12_SKIP_SERVER_BUILD=1 —— 跳过 sidecar 构建。\n` +
          '  安装包里可能是**旧后端**；确认没问题再这么做（默认路径不该用它）。'
      )
      return
    }
  }

  if (target === 'dist') {
    if (!existsSync(SERVER_DIST)) fail(`产物目录不存在：${SERVER_DIST}\n  先跑：cd server && uv run python scripts/build_server.py`)
    process.exit(checkStamp(SERVER_DIST, 'server/dist/k12-agent-server', currentFingerprint('check:dist')) ? 0 : 1)
  }

  if (target === 'packaged') {
    if (!existsSync(PACKAGED_DIST)) {
      fail(
        `安装包里没有 sidecar：${PACKAGED_DIST}\n` +
          '  —— `extraResources` 没生效，或还没跑过 electron-builder。'
      )
    }
    // 关键：比的是**包里的那一份**（而不是构建机上的 dist/）。开发者手改过
    // server/dist 或装了旧包，都会在这里被抓住。
    process.exit(
      checkStamp(PACKAGED_DIST, '安装包内 resources/server', currentFingerprint('check:packaged')) ? 0 : 1
    )
  }

  const unexpected = args.filter((arg) => arg !== '--check' && arg !== target)
  if (unexpected.length > 0) fail(`未知参数：${unexpected.join(' ')}`)

  ensureServerBuild()
}

main()
