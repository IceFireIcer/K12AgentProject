/**
 * 安装包与版本号守卫（D-067）—— 盯住「装上去之后会发生什么」这一类**看不见**的约定。
 *
 * 这一组断言存在的理由：安装器配置错了，**本地跑一遍什么都发现不了**
 * （要真打一次 NSIS、真装一次才暴露），而且错的往往不是「装不上」，
 * 是「装了但把学生的数据删了」「双击就闷头装完、学生完全不知道装到哪」。
 * 所以把它钉成可判定的断言 —— 改错了立刻红，不必等下一天的 nightly。
 *
 *   G21-1  引导式安装（`oneClick: false`）：不是双击就直接装完
 *   G21-2  允许学生自己选安装位置（且与 G21-1 成对：只对引导式有效）
 *   G21-3  ★★ 卸载/升级**不删学生数据**（`deleteAppDataOnUninstall` 不得为真）
 *   G21-4  欢迎页由 `build/installer.nsh` 提供（electron-builder 默认**没有**）
 *   G21-5  卸载项里带版本号（「装的是哪一版」要看得见）
 *   G21-6  ★ 版本号派生：形状满足 NSIS（三段数字、每段 ≤ 65535）、CI 下单调递增
 *   G21-7  打包前**必须**盖版本号（否则每个 nightly 都叫 0.1.0、安装包互相覆盖）
 *   G21-8  打包相关改动 push 即构建（否则要等第二天凌晨才知道打不打得出来）
 *   G21-9  ★ 正式发版（`release.yml`）：手动触发 + `K12_VERSION` 钉死版本号 + 发**非** prerelease
 *
 * 跑法：`npm test`。
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(desktopRoot, '..')

const builderYml = readFileSync(join(desktopRoot, 'electron-builder.yml'), 'utf8')
const versionScript = join(desktopRoot, 'scripts', 'build-version.mjs')
const nightlyYml = readFileSync(join(repoRoot, '.github', 'workflows', 'nightly.yml'), 'utf8')
const releaseYml = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')

/** 从 `electron-builder.yml` 里读 `nsis:` 那一段的原文（缩进两格、到下一个顶级键为止）。 */
function nsisBlock(): string {
  const matched = /\nnsis:\n([\s\S]*?)(?=\n[a-zA-Z])/.exec(builderYml)
  assert.ok(matched, 'electron-builder.yml 里找不到 nsis: 段（锚点漂了就改为从这里读）')
  return matched[1]
}

/** 在给定环境变量下跑一次 `scripts/build-version.mjs`（**不加 --write**，不动任何文件）。 */
function runVersionScript(env: Record<string, string>): { stdout: string; failed: boolean } {
  const clean = { ...process.env } as Record<string, string>
  delete clean.K12_VERSION
  delete clean.GITHUB_RUN_NUMBER
  try {
    const stdout = execFileSync('node', [versionScript], {
      cwd: desktopRoot,
      encoding: 'utf8',
      env: { ...clean, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { stdout, failed: false }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    return { stdout: `${failure.stdout ?? ''}${failure.stderr ?? ''}`, failed: true }
  }
}

/** 从脚本输出里取版本号（`[build-version] 1.0.42　（来源：...）`）。 */
function versionFrom(stdout: string): string {
  const matched = /\[build-version\]\s+(\d+\.\d+\.\d+)/.exec(stdout)
  assert.ok(matched, `脚本输出里读不到版本号：${stdout.slice(0, 200)}`)
  return matched[1]
}

/* ------------------------------------------------------------------ *
 * G21-1 / G21-2 / G21-5：安装向导的形态
 * ------------------------------------------------------------------ */

test('G21-1 ★ 安装器必须是**引导式**（oneClick: false）—— 不是双击就闷头装完', () => {
  // electron-builder 的 `oneClick` **默认就是 true**：双击安装包直接装完，
  // 学生看不到任何页面、也不知道装到哪去了。用户明确要求「按正常的页面走」。
  assert.match(
    nsisBlock(),
    /^\s{2}oneClick:\s*false\s*$/m,
    'nsis.oneClick 必须是 false —— 否则安装器没有向导页面（默认 true）'
  )
})

test('G21-2 允许学生自己选安装位置（且必须是引导式，否则 electron-builder 直接报错）', () => {
  assert.match(
    nsisBlock(),
    /^\s{2}allowToChangeInstallationDirectory:\s*true\s*$/m,
    '必须允许改安装目录（C 盘紧张的学生机需要装到别的盘）'
  )
  // ★ 这一对是**成对**的约束：allowToChangeInstallationDirectory 只在引导式下有意义
  //   （electron-builder 会抛 InvalidConfigurationError）。G21-1 保证前一半。
  assert.match(nsisBlock(), /^\s{2}oneClick:\s*false\s*$/m, '与 G21-1 成对')
})

test('G21-3 ★★ 卸载 / 升级**不得删学生数据**（这一条错了就是数据丢失）', () => {
  // `deleteAppDataOnUninstall: true` 会让安装器把 `$APPDATA\<APP_FILENAME>` **整目录删掉**，
  // 而学生的 config.json / learning.db / Pi 会话正好就在那儿
  // （userData slug 钉在 `k12-agent-desktop`，与 APP_FILENAME 同名 —— 见 applyStableUserDataSlug）。
  // 升级时 electron-builder 会带 `--updated` 跳过删除，但**手动卸载**会真的删。
  assert.match(
    nsisBlock(),
    /^\s{2}deleteAppDataOnUninstall:\s*false\s*$/m,
    'deleteAppDataOnUninstall 必须显式为 false（写成 true 会在卸载时删光学生数据）'
  )
  assert.ok(
    !/deleteAppDataOnUninstall:\s*true/.test(nsisBlock()),
    '不允许 deleteAppDataOnUninstall: true'
  )
})

test('G21-4 欢迎页由 build/installer.nsh 提供（electron-builder 默认没有欢迎页）', () => {
  const nshPath = join(desktopRoot, 'build', 'installer.nsh')
  assert.ok(existsSync(nshPath), 'build/installer.nsh 必须存在（nsis.include 指向它）')
  const nsh = readFileSync(nshPath, 'utf8')

  // ★★ 判据必须锚在**宏体**上，不能在整个文件里搜那串字：
  //   这个文件的注释里就写着「!insertmacro MUI_PAGE_WELCOME」（用来解释为什么需要它），
  //   在整文件里搜会**被注释满足** —— 于是把宏掏空（只留 `!macro customWelcomePage` +
  //   `!macroend`）这条守卫照样是绿的。
  //   实测：第一版就是这么写的，变异验证（㉞）当场抓到它「看着在守、其实守不住」。
  const macro = /!macro\s+customWelcomePage([\s\S]*?)!macroend/.exec(nsh)
  assert.ok(macro, '必须定义 customWelcomePage 宏 —— 这是 electron-builder 认的钩子名，别自创')
  assert.match(
    macro[1],
    /!insertmacro\s+MUI_PAGE_WELCOME/,
    'customWelcomePage 的**宏体里**要插入 MUI_PAGE_WELCOME（空宏等于没加欢迎页）'
  )
  // ★ 那个宏**只在 assistedInstaller.nsh 里**被插入，所以 oneClick 必须是 false（G21-1）；
  //   这里做一次交叉检查，免得「加了欢迎页但没人插」这种静默失效。
  assert.match(nsisBlock(), /^\s{2}oneClick:\s*false\s*$/m, '欢迎页只在引导式安装器里会被插入')
})

test('G21-5 卸载项里带版本号（「装的是哪一版」要看得见）', () => {
  assert.match(
    nsisBlock(),
    /^\s{2}uninstallDisplayName:.*\$\{version\}/m,
    'uninstallDisplayName 必须含 ${version} —— 否则控制面板里只有名字、看不出装的是哪一版'
  )
  // ★ 中文向导：产品没有英文界面，安装器跟着系统语言变英文只会让人困惑。
  assert.match(
    nsisBlock(),
    /installerLanguages:\s*\[zh_CN\]/,
    '安装向导固定简体中文'
  )
})

/* ------------------------------------------------------------------ *
 * G21-6 / G21-7：版本号机制
 * ------------------------------------------------------------------ */

test('G21-6 ★ 版本号派生：本地保持基线、CI 递增、非法输入响亮失败', () => {
  // ① 本地（无 CI 环境变量）：**不动**基线版本，本地构建不冒充某个 nightly
  const local = runVersionScript({})
  assert.equal(local.failed, false, `本地跑不应失败：${local.stdout.slice(0, 200)}`)
  assert.equal(versionFrom(local.stdout), '1.0.0', '本地构建保持 package.json 的基线版本')

  // ② CI：第三段 = run number（**单调递增** —— 「版本号高」才有判据）
  const run42 = versionFrom(runVersionScript({ GITHUB_RUN_NUMBER: '42' }).stdout)
  const run43 = versionFrom(runVersionScript({ GITHUB_RUN_NUMBER: '43' }).stdout)
  assert.equal(run42, '1.0.42')
  assert.equal(run43, '1.0.43')
  assert.ok(run43 > run42, 'run number 变大 → 版本号必须变大（字符串比较在这个形状下等价于数值比较）')

  // ③ 显式指定优先（手工发版用）
  assert.equal(versionFrom(runVersionScript({ K12_VERSION: '1.2.3' }).stdout), '1.2.3')
  assert.equal(
    versionFrom(runVersionScript({ K12_VERSION: '1.2.3', GITHUB_RUN_NUMBER: '99' }).stdout),
    '1.2.3',
    'K12_VERSION 压过 run number'
  )

  // ④ ★★ NSIS 的硬约束：`VIProductVersion` 是**四段 16 位数字**，每段 ≤ 65535。
  //    越界不是「降级」而是 makensis **直接报错**（整条打包链失败），所以必须挡在前面。
  const over = runVersionScript({ K12_VERSION: '0.1.70000' })
  assert.equal(over.failed, true, '超出 65535 必须非零退出（否则要等到 makensis 才炸）')
  assert.match(over.stdout, /65535/, '报错要说明是哪条约束')

  // ⑤ 形状不对（比如想把日期塞进版本号）也要挡下 —— 这是最容易被「顺手改」的一种
  for (const bad of ['0.1.0-nightly.20260921', '0.1', 'v0.1.0', '1.2.3.4']) {
    const result = runVersionScript({ K12_VERSION: bad })
    assert.equal(result.failed, true, `K12_VERSION=${JSON.stringify(bad)} 应当被拒绝`)
  }

  // ⑥ **空字符串 = 没设置**（CI 里偶尔会出现「变量存在但为空」）——
  //    它不该当非法值报错，而应退回基线版本（这条与上面那组是**反向对照**，
  //    少了它就分不清「挡得准」和「挡得过猛」）。
  assert.equal(
    versionFrom(runVersionScript({ K12_VERSION: '   ' }).stdout),
    '1.0.0',
    '空白 K12_VERSION 按「没设置」处理（退回基线），不是非法输入'
  )
})

test('G21-7 ★ 打包链必须在 electron-builder 之前盖版本号', () => {
  const stampAt = nightlyYml.indexOf('version:stamp')
  const builderAt = nightlyYml.indexOf('electron-builder --win')
  assert.ok(stampAt >= 0, 'nightly 必须调用 npm run version:stamp（否则每个 nightly 都叫 0.1.0）')
  assert.ok(builderAt >= 0, 'nightly 里找不到 electron-builder 那一步')
  assert.ok(
    stampAt < builderAt,
    '盖版本号必须在 electron-builder **之前** —— 包名与程序集版本都取自那一刻的 package.json'
  )
  // package.json 里那个脚本本身也要在
  const pkg = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  assert.match(
    pkg.scripts?.['version:stamp'] ?? '',
    /build-version\.mjs/,
    'npm run version:stamp 必须调 scripts/build-version.mjs（唯一实现）'
  )
})

test('G21-8 打包相关改动 push 即构建（且那一轮不发 Release）', () => {
  // ★ 用户的要求是「推上去让远程 CI 真的把安装包打出来」：
  //   只靠每天 UTC 18:00 的定时跑，改了安装器配置要等第二天才知道打不打得出来。
  assert.match(
    nightlyYml,
    /\n  push:\n[\s\S]*?paths:/,
    'nightly 必须有 push + paths 触发（只对真会影响产物的文件触发，别每次 push 都跑 19 分钟）'
  )
  for (const path of [
    'desktop/electron-builder.yml',
    'desktop/build/**',
    'desktop/scripts/build-version.mjs'
  ]) {
    assert.ok(nightlyYml.includes(path), `push 的 paths 白名单要包含 ${path}`)
  }
  // ★★ 2026-09-27（D-104 / P-153）：`desktop/package.json` **不许**回到白名单。
  //   它的日常改动（加一条 npm script）与产物无关，却会触发整条 19 分钟重活（含 90MB 模型下载）。
  //   实测事故：`3f08586` 只是一次「加两条 ux 探针脚本」的提交，白跑了一轮。
  //   依赖增减（会改 asar 内容）改由每日定时轮 / 手动 `workflow_dispatch` 覆盖 —— 24 小时内必有一次。
  const pushAt = nightlyYml.indexOf('\n  push:')
  // ⚠️ `concurrency:` 是**顶层键**（零缩进）—— 写成 `\n  concurrency:` 找不到，
  //    会让 pushEnd = -1 → 这条守卫自己先红（实测踩到过一次）。
  const pushEnd = nightlyYml.indexOf('\nconcurrency:', pushAt)
  assert.ok(pushAt > 0 && pushEnd > pushAt, '找不到 push 触发块（锚点漂了就改这里）')
  assert.ok(
    !nightlyYml.slice(pushAt, pushEnd).includes('desktop/package.json'),
    'push 白名单里不许再出现 desktop/package.json —— 脚本改动会白跑一轮 19 分钟的打包（P-153）'
  )
  // ★ push 触发的那一轮是「验能不能打出来」，不该冒充当天的 nightly 抢标签、覆盖夜间产物。
  assert.match(
    nightlyYml,
    /if:\s*github\.event_name\s*!=\s*'push'/,
    'push 触发的那一轮不得发布 Release（产物仍进 artifact，能下载验包）'
  )
})

test('G21-9 ★ 正式发版：手动触发 + K12_VERSION 钉死版本号 + 发非 prerelease', () => {
  // ① 只能**手动**触发：正式版的版本号是人给的，不该被 push / 定时任务自动发出去
  //    （自动跑就变成「算出来的版本号」，与标签 `v<版本号>` 的含义冲突）。
  const onAt = releaseYml.indexOf('\non:')
  const concurrencyAt = releaseYml.indexOf('\nconcurrency:')
  assert.ok(onAt > 0 && concurrencyAt > onAt, 'release.yml 的锚点漂了：找不到 on: / concurrency: 段')
  const onBlock = releaseYml.slice(onAt, concurrencyAt)
  assert.ok(onBlock.includes('workflow_dispatch:'), '正式发版必须由 workflow_dispatch 触发')
  for (const auto of ['push:', 'schedule:', 'pull_request:']) {
    assert.ok(
      !onBlock.includes(auto),
      `正式发版不得被 ${auto} 自动触发 —— 版本号必须由人显式给（否则标签与包内版本对不上）`
    )
  }

  // ② ★★ 版本号必须真的传下去：`K12_VERSION` 是 build-version.mjs 里
  //    「显式指定优先于 run number」的那一格。漏了它，打出来的还是 `<主>.<次>.<run>`，
  //    而标签是 `v1.0.0` —— 包内版本、文件名、控制面板三处全部与标签不一致。
  assert.match(
    releaseYml,
    /K12_VERSION:\s*\$\{\{\s*inputs\.version\s*\}\}/,
    '正式版必须把 inputs.version 传给 K12_VERSION（唯一决定版本号的地方）'
  )

  // ③ 与 G21-7 同一条纪律：盖版本号必须在 electron-builder **之前**。
  //    ⚠️ 所有命令锚点都打在**去注释后的正文**上：这份工作流的文件头注释里也逐字提到了
  //        `check:server:packaged` / `gh release create` / `electron-builder`，
  //        直接对整份文件 `indexOf` 会命中注释、把断言变成假绿（P-111 那个老病，
  //        本条守卫第一版就是这么红的 —— 实测踩到）。
  const releaseCode = releaseYml
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  const stampAt = releaseCode.indexOf('npm run version:stamp')
  const builderAt = releaseCode.indexOf('electron-builder --win')
  assert.ok(
    stampAt > 0 && builderAt > stampAt,
    'version:stamp 必须排在 electron-builder 之前（包名与程序集版本取自那一刻的 package.json）'
  )

  // ④ 三个形态都要出（安装版 / 绿色包 / 便携版），且必须显式标成 Latest。
  const builderLine = releaseCode
    .split('\n')
    .find((line) => line.includes('electron-builder --win')) ?? ''
  for (const target of ['nsis', 'zip', 'portable']) {
    assert.ok(builderLine.includes(target), `正式版必须打出 ${target} 目标（实际命令：${builderLine.trim()}）`)
  }
  assert.ok(releaseCode.includes('--latest'), '正式版必须显式标成 Latest')

  // ⑤ ★★ 不许出现 `--prerelease`：带上它就不抢 Latest，正式版等于没发（退回 nightly 形态）。
  //    注释里解释「为什么这里不是 prerelease」是正常的，所以只看上面那份去注释正文。
  assert.ok(
    !releaseCode.includes('--prerelease'),
    '正式版的发布命令里不得出现 --prerelease（已排除注释行；若确实要发预发布，请用 nightly）'
  )

  // ⑥ 发布**之前**必须验包内后端（P-072）：装了旧后端的包发出去，新端点只会 404。
  const checkAt = releaseCode.indexOf('run: npm run check:server:packaged')
  const publishAt = releaseCode.indexOf('gh release create')
  assert.ok(
    checkAt > 0 && publishAt > checkAt,
    'check:server:packaged 必须排在发布之前 —— 否则坏包先发出去了才发现'
  )

  // ⑦ 发布说明读最近 20 条提交标题：浅克隆会**静默**只剩一条。
  assert.match(releaseYml, /fetch-depth:\s*30/, '正式发版的 checkout 必须加深 fetch-depth')

  // ⑧ 模型缓存 key 与 nightly **逐字相同**：否则每次正式发版都要重下 90MB。
  assert.match(
    releaseYml,
    /key:\s*embedding-model-\$\{\{\s*hashFiles\('server\/app\/config\.py'\)\s*\}\}/,
    '嵌入模型缓存 key 必须与 nightly 一致（正式发版不该重新下 90MB）'
  )

  // ⑨ 建 Release 需要写权限：否则 `gh release create` 在最后一步 403，十几分钟构建全白跑。
  assert.match(
    releaseYml,
    /permissions:\s*\n\s*contents:\s*write/,
    'release.yml 必须有 permissions: contents: write'
  )
})
