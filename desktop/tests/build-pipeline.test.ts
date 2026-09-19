/**
 * ★★ 构建联动守卫（P-072 的回归防线）。
 *
 * 断言的是一件**测试测不到、但交付物会出事**的事：sidecar 是独立打包的产物，
 * 不随 `electron-vite build` 更新；而 `electron-builder` 只是把磁盘上现成的那份 exe
 * 拷进安装包。所以「改了 `server/` 却没重打」的包能顺利构建、能过全部单测，
 * 只是**包里跑的是几天前的后端**（新端点 404、老 bug 还活着，且不报任何错）。
 *
 * 这一组守卫把「构建必须联动」钉成代码：
 *
 *   G20-1  `npm run build` 必须**先**确保 sidecar 是最新的（顺序不对就白搭）
 *   G20-2  `build:win` / `build:unpack` 必须在 electron-builder **之后**校验包里那一份
 *   G20-3  `extraResources` 必须把 `build-info.json` 一起拷进包（否则无从比对）
 *   G20-4  指纹算法**只有一份**（Python 侧）—— JS 侧不得自己写 setTimeout 式的重算
 *   G20-5  `build-info.json` 必须是**源资产**：`.gitignore` 不得把产物目录一起吞掉
 *   G20-6  逃生舱（`K12_SKIP_SERVER_BUILD`）必须**响亮地警告**，不得静默跳过
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')

function read(...segments: string[]): string {
  return readFileSync(join(desktopRoot, ...segments), 'utf8')
}

/** 去掉注释：注释里举反例 / 讲历史是常态，不该把守卫自己绊倒。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
const scripts = pkg.scripts ?? {}
const builderYml = read('electron-builder.yml')
const buildServerScript = read('scripts', 'build-server.mjs')

/* ------------------------------------------------------------------ *
 * G20-1 / G20-2 构建链拓扑
 * ------------------------------------------------------------------ */

test('G20-1 `npm run build` 必须先确保 sidecar 是最新的，再编前端', () => {
  const build = scripts.build
  assert.ok(build, 'package.json 必须有 build 脚本')
  assert.match(
    build,
    /npm run build:server/,
    '`build` 必须调用 build:server —— 否则「改了 server/ 只编前端」的老毛病原样回来'
  )
  assert.ok(
    build.indexOf('npm run build:server') < build.indexOf('electron-vite build'),
    `sidecar 必须在编前端**之前**就绪（当前顺序：${build}）—— 反过来的话前端产物会基于旧后端生成`
  )
  assert.match(
    scripts['build:server'] ?? '',
    /scripts\/build-server\.mjs/,
    'build:server 必须走 scripts/build-server.mjs（那里有 --if-stale 与逃生舱）'
  )
})

test('G20-2 build:win / build:unpack 必须在 electron-builder 之后校验**包里**那一份', () => {
  for (const name of ['build:win', 'build:unpack'] as const) {
    const script = scripts[name]
    assert.ok(script, `package.json 必须有 ${name}`)
    assert.match(
      script,
      /npm run check:server:packaged/,
      `${name} 必须在装包后校验包里的后端（build-info.json 的指纹）—— 这是 P-072 的最后一道闸`
    )
    assert.ok(
      script.indexOf('electron-builder') < script.indexOf('check:server:packaged'),
      `${name} 的校验必须在 electron-builder **之后**（现在校验的是装包前的产物，等于没查）`
    )
  }
  assert.match(
    scripts['check:server:packaged'] ?? '',
    /--check packaged/,
    'check:server:packaged 必须调 build-server.mjs --check packaged'
  )
  assert.match(scripts['check:server'] ?? '', /--check dist/, 'check:server 必须调 build-server.mjs --check dist')
})

test('G20-3 extraResources 必须把 build-info.json 一起拷进包', () => {
  const source = stripComments(builderYml)
  assert.match(
    source,
    /from:\s*\.\.\/server\/dist\/k12-agent-server\s*\n\s*to:\s*server/,
    'extraResources 必须把 server/dist/k12-agent-server 拷成 <resources>/server'
  )
  // 不得有把它排除掉的规则：一旦被挡在包外，装包后的新鲜度校验就无从比对
  assert.doesNotMatch(
    source,
    /build-info\.json[\s\S]{0,40}!/,
    '不得在 extraResources 里排除 build-info.json —— 它是装包后校验的唯一依据'
  )
  assert.doesNotMatch(
    source,
    /!\*\*\/build-info\.json/,
    'files 里不得排除 build-info.json'
  )
})

/* ------------------------------------------------------------------ *
 * G20-4 指纹算法只有一份
 * ------------------------------------------------------------------ */

test('G20-4 指纹算法唯一实现在 Python 侧，JS 只做调用与比对', () => {
  // JS 侧**不得**出现 sha256 / createHash —— 一旦两套算法并存，
  // 细微差异（排序、编码、换行）会表现为「刚打过包却永远判过期」或更糟的「过期却判新鲜」。
  assert.doesNotMatch(
    buildServerScript,
    /createHash|createHash\(|crypto/,
    'scripts/build-server.mjs 不得自己算哈希 —— 指纹的唯一实现是 server/scripts/build_info.py'
  )
  assert.match(
    buildServerScript,
    /build_info\.py/,
    'build-server.mjs 必须调用 server/scripts/build_info.py 取指纹'
  )
  assert.match(
    buildServerScript,
    /--if-stale/,
    'build-server.mjs 必须用 build_server.py 的 --if-stale（新鲜就秒退，过期才重打）'
  )
  // 后端侧：实现存在、且 build_server 真的把指纹写进产物 + 自检里断言新鲜
  const buildInfoPy = readFileSync(join(repoRoot, 'server', 'scripts', 'build_info.py'), 'utf8')
  assert.match(buildInfoPy, /def compute_fingerprint/, 'build_info.py 必须提供 compute_fingerprint')
  assert.match(buildInfoPy, /FINGERPRINT_SCHEMA\s*=\s*\d+/, '指纹必须带 schema 版本（改算法即失效）')

  const buildServerPy = readFileSync(join(repoRoot, 'server', 'scripts', 'build_server.py'), 'utf8')
  assert.match(buildServerPy, /write_build_stamp\(/, 'build_server.py 必须把指纹写进产物')
  assert.match(buildServerPy, /def verify_build_stamp/, 'build_server.py 自检必须校验指纹新鲜度')
  assert.match(
    buildServerPy,
    /--if-stale/,
    'build_server.py 必须支持 --if-stale（前端构建链靠它避免每次都重打 exe）'
  )
  // ★ 顺序：指纹必须在起 PyInstaller **之前**算（打完再算会把打包途中的改动认作新鲜）
  const runBuild = buildServerPy.slice(
    buildServerPy.indexOf('def run_build()'),
    buildServerPy.indexOf('def write_build_stamp')
  )
  assert.ok(runBuild.includes('compute_fingerprint'), 'run_build 必须先算指纹')
  assert.ok(
    runBuild.indexOf('compute_fingerprint') < runBuild.indexOf('"-m",'),
    '算指纹必须发生在起 PyInstaller 之前（否则打包途中的改动会被误判为已包含）'
  )
})

test('G20-5 产物内的指纹文件名在两侧同名，且产物目录整体不入库', () => {
  const buildInfoPy = readFileSync(join(repoRoot, 'server', 'scripts', 'build_info.py'), 'utf8')
  assert.match(
    buildInfoPy,
    /BUILD_INFO_FILENAME\s*=\s*['"]build-info\.json['"]/,
    '产物内的指纹文件名必须在 Python 侧具名（JS 侧按同名读，名字只有这一处定义）'
  )
  assert.match(
    buildServerScript,
    /BUILD_INFO_FILENAME = 'build-info\.json'/,
    'JS 侧的同名常量必须一致 —— 名字对不上，校验会永远找不到指纹'
  )
  // exe 与 build-info.json 都是**构建产出**（每次打包现写），必须落在 dist/ 下、不入库
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
  assert.match(gitignore, /^dist\/$/m, '.gitignore 必须忽略 dist/（构建产物不入库）')
})

test('G20-6 逃生舱必须响亮警告，不得静默跳过', () => {
  assert.match(
    buildServerScript,
    /K12_SKIP_SERVER_BUILD/,
    'escape hatch 的名字要稳定（文档与 CI 都引用它）'
  )
  const idx = buildServerScript.indexOf('K12_SKIP_SERVER_BUILD === ')
  assert.ok(idx > 0, '必须真的判断这个环境变量')
  const branch = buildServerScript.slice(idx, idx + 900)
  assert.match(
    branch,
    /console\.(log|warn|error)\(/,
    '跳过时必须打印警告 —— 静默跳过正是本机制要消灭的东西'
  )
  assert.match(branch, /旧后端|stale|跳过/, '警告要讲清后果（包里可能是旧后端）')
})

/**
 * ★★ G20-6b：逃生舱**只能**作用于「构建」这条路径，绝不能吞掉 `--check`。
 *
 * 缺口（审计结论）：上面那条 G20-6 只验了「会警告」，没验「它在什么条件下生效」。
 * 实现里那个 `if (!target)` 是**唯一**把逃生舱挡在 `--check` 之外的守卫：
 *
 *     if (process.env.K12_SKIP_SERVER_BUILD === '1') {
 *       if (!target) { 警告; return }        // ← 删掉这一行会怎样？
 *     }
 *
 * 删掉 `if (!target)` 之后，`K12_SKIP_SERVER_BUILD=1 npm run build:win` 会**静默跳过**
 * 「包里那份后端是不是当前源码打的」这道校验（`build:win` 的最后一步），
 * 而 G20-6 照样全绿 —— 于是又能打出一个「跑的是旧后端」的包，
 * 也就是 P-072 当初要根治的那件事原样回来。
 *
 * 这里改成**正向断言那个条件本身**：跳过分支必须被 `!target` 包住。
 * （不写成「禁止 `return`」那类反向断言 —— 本项目一贯要求正向判据。）
 */
test('★★ G20-6b 逃生舱必须只在「构建」路径生效：跳过分支被 `!target` 包住，不得吞掉 --check', () => {
  const hatchIdx = buildServerScript.indexOf('K12_SKIP_SERVER_BUILD === ')
  assert.ok(hatchIdx > 0, '必须真的判断这个环境变量')

  // 逃生舱那一段代码（到 `--check` 分支开始之前）
  const hatchEnd = buildServerScript.indexOf("if (target === 'dist')", hatchIdx)
  assert.ok(hatchEnd > hatchIdx, '`--check dist` 分支必须排在逃生舱之后（顺序即语义）')
  const hatch = buildServerScript.slice(hatchIdx, hatchEnd)

  assert.match(
    hatch,
    /if\s*\(\s*!target\s*\)/,
    '★ 跳过分支必须被 `!target` 包住 —— 少了它就是「逃生舱连 --check 一起跳过」，' +
      'build:win / build:unpack 的最后一道闸会在设置了该变量时静默失效'
  )
  // ★ 逃生舱块里**只该有一个** `return`：就是 `!target` 分支里那个。
  //   数 `return` 而不是手工扫括号 —— 第一版按 `indexOf('}')` 找块尾，
  //   结果被 `${yellow('⚠')}` 里的那个 `}` 提前截断了（模板字符串里的花括号是字面量），
  //   于是把「块内那个 return」误判成了「块外的第二个 return」。
  //   计数法对这两个方向都够用：少了 `!target` → 上面的正则先红；
  //   多出「某一类 target 也提前返回」→ 这里红。
  const returns = hatch.match(/\breturn\b/g) ?? []
  assert.equal(
    returns.length,
    1,
    `逃生舱块里有 ${returns.length} 处 return（应当只有 \`!target\` 分支里的那一处）——` +
      '多出来的那处意味着某一类 target 也会被静默跳过'
  )

  // 另一条正向判据：`target` 一旦取值，就必须走到真正的校验（checkStamp）
  const afterHatchAll = buildServerScript.slice(hatchEnd)
  assert.match(
    afterHatchAll,
    /checkStamp\(\s*SERVER_DIST/,
    '`--check dist` 必须真的去比对指纹（不是打个日志就返回）'
  )
  assert.match(
    afterHatchAll,
    /checkStamp\(\s*PACKAGED_DIST/,
    '`--check packaged` 必须真的去比对**包里**那一份的指纹'
  )
})

test('G20-7 校验失败必须带**可执行的修法**（不许只丢一句「过期」）', () => {
  const idx = buildServerScript.indexOf('function checkStamp')
  assert.ok(idx > 0, 'build-server.mjs 必须有 checkStamp')
  const body = buildServerScript.slice(idx, idx + 1600)
  assert.match(body, /build_server\.py/, '失败信息里要给出重打命令')
  assert.match(body, /process\.exit\(1\)|return false/, '失败必须真的失败（非零退出码）')
})

test('G20-8 产物两侧路径都写死在「一处」：dist 与装包后的 resources/server', () => {
  assert.ok(
    existsSync(join(desktopRoot, 'scripts', 'build-server.mjs')),
    'scripts/build-server.mjs 必须存在（构建联动的实现）'
  )
  assert.match(
    buildServerScript,
    /'dist',\s*'win-unpacked',\s*'resources',\s*'server'/,
    '装包后的路径必须是 <desktop>/dist/win-unpacked/resources/server（electron-builder --dir 的布局）'
  )
  assert.match(
    buildServerScript,
    /join\(SERVER,\s*'dist',\s*'k12-agent-server'\)/,
    '构建侧路径必须是 <repo>/server/dist/k12-agent-server'
  )
})
