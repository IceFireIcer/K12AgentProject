/**
 * 票 09 守卫：**Pi 会话改道**与**跨学生隔离断言**（执行文档 §8.1 / §8.2 / §12，AGENTS §5.8）。
 *
 * 这一组断言守护的是**合规硬伤**，不是某个功能：
 *
 *   G9-1  一个学生的 Pi 路径全部落在 `<userData>/students/<id>/pi-agent/` 之内（agentDir / sessionDir）
 *   G9-2  学生 id 是**文件系统白名单**（`../` 之类一律拒绝）—— 否则「选学生」等于「读写任意目录」
 *   G9-3  Pi 真的把会话写到了学生目录（`SessionManager.getSessionDir()` / `usesDefaultSessionDir()`）
 *   G9-4  扫描磁盘：`students/<id>/` 之外不得出现本应用的 `.jsonl`（★ 失败即抛，不是警告）
 *   G9-5  `~/.pi`（用户自己的 Pi CLI 目录）文件清单与 mtime **均未变化**
 *   G9-6  哨兵：一次「建目录 → 跑一轮 → 校验」的全流程在干净环境下通过，在越界/被动过时立刻抛
 *
 * ⚠️ 关于 `~/.pi` 的判据：本机**确实存在** `~/.pi`（用户自己的 Pi CLI：两个空目录 +
 * 两个 skills 符号链接），所以「目录不存在 = 没碰过」这种断言是错的（会永远通过）。
 * 这里用**前后快照比对**（清单 + mtime + size），比「今天没被改」更严：
 * 既有条目的 mtime 停在 8/31 与 9/1，只要本应用碰过任何一个，这里立刻红。
 *
 * 跑法：`npm test`。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assertNoStraySessions,
  assertSessionManagerIsolated,
  assertStudentId,
  assertStudentSessionPartition,
  comparePiHome,
  createIsolationSentinel,
  defaultPiHomeDir,
  describeIsolation,
  describeStudentPartition,
  ensureStudentPiDirs,
  entriesModifiedSince,
  findJsonlFiles,
  inspectStraySessions,
  inspectStudentSessionPartition,
  isInside,
  isolationShellHints,
  prettyPath,
  resolvePiPaths,
  resolveStudentDir,
  resolveStudentPiPaths,
  SessionIsolationError,
  snapshotDir,
  STUDENT_ID_PATTERN,
  type StudentPiPaths
} from '../src/main/agent/pi-paths.ts'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 临时目录夹具（Windows 上没关的句柄会占住文件，所以统一 `rmSync`）。 */
function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 执行 `run` 并**要求**抛出 `SessionIsolationError`（断言 + 取回异常，便于看具体违规项）。 */
function captureIsolationError(run: () => unknown): SessionIsolationError {
  try {
    run()
  } catch (error) {
    assert.ok(
      error instanceof SessionIsolationError,
      `期望 SessionIsolationError，实际是 ${error instanceof Error ? error.name : typeof error}`
    )
    return error
  }
  throw new Error('期望抛出 SessionIsolationError，但没有抛 —— 跨学生隔离断言失效了')
}

/** 造一份「学生目录里已经有一个会话文件」的磁盘状态。 */
function writeSession(studentDir: string, name = 'session.jsonl', content = '{"type":"session"}\n'): string {
  const sessions = join(studentDir, 'pi-agent', 'sessions')
  mkdirSync(sessions, { recursive: true })
  const file = join(sessions, name)
  writeFileSync(file, content, 'utf8')
  return file
}

// ── G9-1 一人一套 Pi 路径 ───────────────────────────────────────────────

test('G9-1 学生级 Pi 路径全部落在 students/<id>/pi-agent/ 之内，learning.db 同层', () => {
  const userData = join('D:', 'user-data')
  const paths = resolveStudentPiPaths(userData, 'student_001')

  assert.equal(paths.studentDir, join(userData, 'students', 'student_001'))
  assert.equal(paths.root, join(paths.studentDir, 'pi-agent'))
  assert.equal(paths.sessionDir, join(paths.root, 'sessions'))
  assert.equal(paths.agentDir, join(paths.root, 'agent'))
  assert.equal(paths.learningDbPath, join(paths.studentDir, 'learning.db'))

  for (const key of ['root', 'agentDir', 'authPath', 'modelsPath', 'sessionDir', 'logDir'] as const) {
    assert.ok(
      isInside(paths.studentDir, paths[key]),
      `${key} 越出了学生目录：${paths[key]}（学生目录=${paths.studentDir}）`
    )
  }
  // ★ 显式挡住「有人图省事退回 ~/.pi/agent」这条路径
  assert.ok(!paths.agentDir.includes('.pi'), `agentDir 不得指向用户全局 Pi 目录：${paths.agentDir}`)
  assert.ok(!paths.sessionDir.includes('.pi'), `sessionDir 不得指向用户全局 Pi 目录：${paths.sessionDir}`)
  assert.equal(resolveStudentDir(userData, 'student_001'), paths.studentDir)
  assert.throws(() => resolveStudentPiPaths('', 'student_001'), /userDataDir 不能为空/)

  // 两个学生必须落在**互不相同**的目录树里（同前缀不算同目录）
  const other = resolveStudentPiPaths(userData, 'student_002')
  assert.notEqual(other.sessionDir, paths.sessionDir)
  assert.ok(!isInside(paths.studentDir, other.sessionDir))
  assert.ok(!isInside(other.studentDir, paths.sessionDir))

  // 应用级（票 03 的）路径仍在 <userData>/pi-agent 下，不受影响
  assert.equal(resolvePiPaths(userData).root, join(userData, 'pi-agent'))
})

test('G9-1b isInside 用相对路径判定（前缀相同不算包含：C:\\a 不含 C:\\ab）', () => {
  assert.ok(isInside(join('C:', 'a'), join('C:', 'a')))
  assert.ok(isInside(join('C:', 'a'), join('C:', 'a', 'b')))
  assert.ok(!isInside(join('C:', 'a'), join('C:', 'ab')))
  assert.ok(!isInside(join('C:', 'a', 'b'), join('C:', 'a')))
})

// ── G9-2 学生 id 白名单 ────────────────────────────────────────────────

test('G9-2 学生 id 是文件系统白名单：路径穿越、绝对路径、空串一律拒绝', () => {
  assert.ok(STUDENT_ID_PATTERN.test('student_001'))
  assert.equal(assertStudentId('student_001'), 'student_001')

  const bad = [
    '../student_002',
    '..\\student_002',
    'students/../..',
    'C:\\Windows',
    '/etc/passwd',
    '',
    '.',
    '..',
    'student 001',
    'student_001;rm',
    'a'.repeat(65)
  ]
  for (const value of bad) {
    assert.throws(
      () => assertStudentId(value),
      (error: unknown) => error instanceof SessionIsolationError,
      `非法学生 id 必须被拒绝，否则会拼出跨学生/任意目录的路径：${JSON.stringify(value)}`
    )
  }
  // 穿透式 id 绝不能拼出学生目录之外的路径
  assert.throws(() => resolveStudentPiPaths(join('D:', 'user-data'), '../../etc'))
})

test('G9-2b ensureStudentPiDirs 建目录，且拒绝越界路径', () => {
  withTempDir('k12-paths-', (dir) => {
    const paths = resolveStudentPiPaths(dir, 'student_001')
    ensureStudentPiDirs(paths)
    for (const key of ['root', 'agentDir', 'sessionDir', 'logDir'] as const) {
      assert.ok(isInside(paths.studentDir, paths[key]))
    }
    // 被人为改坏（sessionDir 指到别的学生）时必须抛
    const broken: StudentPiPaths = { ...paths, sessionDir: join(dir, 'students', 'student_002', 'pi-agent', 'sessions') }
    assert.throws(() => ensureStudentPiDirs(broken), (error: unknown) => error instanceof SessionIsolationError)
  })
})

// ── G9-3 Pi 真的把会话写到了学生目录 ──────────────────────────────────

test('G9-3 assertSessionManagerIsolated：正确的 SessionManager 放行，Pi 默认目录立刻抛', () => {
  const userData = join('D:', 'user-data')
  const paths = resolveStudentPiPaths(userData, 'student_001')

  // ✅ 显式传了 sessionDir（`SessionManager.create(cwd, sessionDir)` 的第二个参数）
  assert.doesNotThrow(() =>
    assertSessionManagerIsolated(
      {
        getSessionDir: () => paths.sessionDir,
        usesDefaultSessionDir: () => false,
        getSessionFile: () => join(paths.sessionDir, '2026-09-16T10-00-00.jsonl'),
        getSessionId: () => 'sess-1'
      },
      paths.sessionDir
    )
  )

  // ★ 漏传 sessionDir：Pi 会静默退回 ~/.pi/agent/sessions/--<cwd>--/
  const violation = captureIsolationError(() =>
    assertSessionManagerIsolated(
      {
        getSessionDir: () => join(defaultPiHomeDir(), 'agent', 'sessions', '--D--user-data--'),
        usesDefaultSessionDir: () => true
      },
      paths.sessionDir
    )
  )
  assert.match(violation.message, /默认会话目录/)
  assert.match(violation.message, /SessionManager\.create/)

  // 会话文件落到别的学生目录里同样要抛
  assert.throws(
    () =>
      assertSessionManagerIsolated(
        {
          getSessionDir: () => paths.sessionDir,
          usesDefaultSessionDir: () => false,
          getSessionFile: () => join(userData, 'students', 'student_002', 'pi-agent', 'sessions', 'x.jsonl')
        },
        paths.sessionDir
      ),
    (error: unknown) => error instanceof SessionIsolationError
  )
})

// ── G9-3b ★ 生产接线：runtime.ts 真的把 sessionDir 传给了 Pi ──────────

test('★ G9-3b 接线守卫：runtime.ts 三条会话来源**都**传了 `paths.sessionDir` 且当场校验隔离', () => {
  // 为什么必须有这条：上面 G9-3 把 `assertSessionManagerIsolated` 当**纯函数**测（喂假对象），
  // 于是「生产里到底有没有调它、第二个参数有没有传」完全没有机器判据 ——
  // 有人重构 `createChatRuntime` 时删掉这次调用（或删掉第二个参数让 Pi 退回
  // `~/.pi/agent/sessions/--<cwd>--/`），单测全绿，只能靠现场手查 `~/.pi`。
  // 这条守卫读的是**去注释后的源码**（注释里写 `SessionManager.create(a, b)` 说明纪律不算接线）。
  //
  // ★★ 本轮扩充（会话恢复功能）：会话有**三种来源**（`create` / `continueRecent` / `open`），
  //    三者都吃 `(…, sessionDir)` 这第二个参数、也都可能漏传。
  //    漏传 `open` 那份**比漏传 `create` 更严重**：新建只是写错地方，
  //    而恢复会**读到别的会话**（Pi 会去 `~/.pi/agent/sessions/` 里找）。
  //    所以判据从「一个调用」改成「三个调用一个都不许漏」。
  const source = stripComments(
    readFileSync(join(desktopRoot, 'src', 'main', 'agent', 'runtime.ts'), 'utf8')
  )

  /** 三种会话来源（与 `ChatSessionSource` 一一对应）。 */
  const FORMS: Array<{ call: string; why: string }> = [
    { call: 'create', why: '新建会话（「新对话」按钮）' },
    { call: 'continueRecent', why: '续上最近一条（应用冷启动）' },
    { call: 'open', why: '打开指定一条（历史列表里点开）' }
  ]

  for (const form of FORMS) {
    // ★ 必须锚在 `manager.` 上：`ModelRuntime.create({…})` 也含 `.create(`
    //   （它吃的是一个对象、与 sessionDir 无关），只写 `\.create\(` 会命中那一处 ——
    //   于是这条守卫变成「检查了一个不相关的调用」，而真正的漏传静默通过。
    const pattern = new RegExp(`\\bmanager\\.${form.call}\\(([^)]*)\\)`, 's')
    const hit = pattern.exec(source)
    assert.ok(
      hit,
      `runtime.ts 里必须出现 \`manager.${form.call}(…)\` —— 它承担「${form.why}」；` +
        '整个调用被删掉会让这条路走不成（而不是安静降级）'
    )
    const args = hit[1]
    assert.ok(
      args.includes('paths.sessionDir'),
      `\`${form.call}(…)\` 的实参里必须含 \`paths.sessionDir\`（${form.why}）—— ` +
        '漏传第二个参数会让 Pi 退回 `~/.pi/agent/sessions/`：新建是写错地方，' +
        `恢复是**读到别的会话**。实际实参：${args.trim()}`
    )
  }

  // ② 紧接着必须**当场校验**（相信 Pi 会照做 = 没有防线）
  const assertAt = source.indexOf('assertSessionManagerIsolated(')
  assert.ok(
    assertAt > 0,
    'runtime.ts 必须调用 assertSessionManagerIsolated —— 它是「Pi 真的认了 sessionDir」的唯一防线'
  )
  // 第二次实参仍是 sessionDir（校验对象与建会话时传的是同一个目录）
  const call = source.slice(assertAt, assertAt + 400)
  assert.ok(
    call.includes('paths.sessionDir'),
    `assertSessionManagerIsolated 必须拿 paths.sessionDir 去校验：${call.slice(0, 160)}`
  )
  // ③ ★ 三条来源必须收敛在**同一处**：各写一遍就会有一条忘了校验，
  //    而漏掉的那条正好是「读到别的学生的会话」这条路。
  const managerCalls = [...source.matchAll(/\bmanager\.(?:create|open|continueRecent)\(/g)]
  assert.equal(
    managerCalls.length,
    3,
    `三种会话来源应当只在**同一个** helper 里各出现一次，实际 ${managerCalls.length} 处 —— ` +
      '散在多处就会出现「新建那条校验了、恢复那条忘了」这种不对称'
  )
  // 而那个 helper 必须**只有一个**（三个调用都在它里面）
  const helperAt = source.indexOf('function openSessionManager(')
  assert.ok(helperAt > 0, '三种会话来源必须收敛到 `openSessionManager` 这一个 helper')
  // ④ 顺序：先建/开会话再 assert（校验一个还没存在的对象没有意义）
  const firstCall = source.indexOf('openSessionManager(')
  assert.ok(
    firstCall > 0 && firstCall < assertAt,
    '必须先建/开 SessionManager 再校验落盘目录'
  )
})

// ── G9-4 磁盘扫描：越界的 .jsonl 一律不许出现 ──────────────────────────

test('G9-4 ★ 越界会话必须让断言失败（演示：故意把会话放到学生目录之外）', () => {
  withTempDir('k12-stray-', (dir) => {
    const ownStudentDir = resolveStudentDir(dir, 'student_001')
    const own = writeSession(ownStudentDir, 'own.jsonl')
    const otherStudentDir = resolveStudentDir(dir, 'student_002')
    ensureStudentPiDirs(resolveStudentPiPaths(dir, 'student_002'))
    const otherStudent = writeSession(otherStudentDir, 'other.jsonl')
    // 应用级旧目录（票 03 的 <userData>/pi-agent/sessions）—— 学生改道后再落这里就是越界
    const legacy = join(dir, 'pi-agent', 'sessions')
    mkdirSync(legacy, { recursive: true })
    const strayLegacy = join(legacy, 'legacy.jsonl')
    writeFileSync(strayLegacy, '{}\n', 'utf8')

    // ── ① 默认模式：别的学生目录是**合法**的（学生是先后使用的），
    //      但「学生目录树之外」的文件必须被抓到 ──
    const report = inspectStraySessions({ userDataDir: dir, studentId: 'student_001' })
    assert.equal(report.ok, false, '越界会话必须被判为不合规')
    assert.equal(report.allowedRoot, join(ownStudentDir, 'pi-agent', 'sessions'))
    // 自己的会话被扫到（证明断言不是空壳）
    assert.deepEqual(report.own.map(prettyPath), [prettyPath(own)])
    assert.deepEqual(report.otherStudents.map(prettyPath), [prettyPath(otherStudent)])
    assert.deepEqual(report.stray.map(prettyPath), [prettyPath(strayLegacy)])
    assert.match(report.violations[0], /学生目录树之外/)
    assert.match(report.violations[0], /~\/\.pi/, '失败信息要点出最容易犯的那个形态')

    // ★ 抛出去，而不是打印警告
    const failure = captureIsolationError(() => assertNoStraySessions({ userDataDir: dir, studentId: 'student_001' }))
    assert.match(failure.message, /合规硬伤/)
    assert.match(
      describeIsolation({
        ok: false,
        studentId: 'student_001',
        sessions: report,
        piHome: { ok: true, root: defaultPiHomeDir(), existedBefore: true, changes: [], violations: [] },
        violations: report.violations
      }),
      /★ 未通过/
    )

    // ── ② 强模式（`allowOtherStudents: false`）：别的学生目录也算越界 → 抓到「跨学生混放」 ──
    const strict = inspectStraySessions({ userDataDir: dir, studentId: 'student_001', allowOtherStudents: false })
    assert.deepEqual(
      strict.stray.map(prettyPath).sort(),
      [otherStudent, strayLegacy].map(prettyPath).sort(),
      `强模式的越界清单不符：${strict.stray.map(prettyPath).join(', ')}`
    )
    assert.ok(
      strict.violations.some((line) => line.includes('跨学生数据混放')),
      '强模式要明确指出这是跨学生混放'
    )

    // ── ③ 清掉越界文件后必须通过（证明断言判的是事实，不是「永远失败」） ──
    rmSync(otherStudent)
    rmSync(strayLegacy)
    rmSync(join(dir, 'pi-agent'), { recursive: true, force: true })
    const clean = assertNoStraySessions({ userDataDir: dir, studentId: 'student_001' })
    assert.equal(clean.ok, true)
    assert.equal(clean.stray.length, 0)
    assert.equal(clean.own.length, 1, '自己的那一条仍然要被扫到（own 不为空）')
    assert.equal(clean.otherStudents.length, 0)
  })
})

test('G9-4c ★ 切换学生：各自的会话只落自己目录（分区检查，人数对得上才算过）', () => {
  withTempDir('k12-partition-', (dir) => {
    // 模拟「student_001 跑一轮 → 切到 student_002 再跑一轮」
    const a = resolveStudentPiPaths(dir, 'student_001')
    const b = resolveStudentPiPaths(dir, 'student_002')
    ensureStudentPiDirs(a)
    ensureStudentPiDirs(b)
    writeSession(a.studentDir, 'a-turn1.jsonl', '{"student":"A"}\n')
    writeSession(b.studentDir, 'b-turn1.jsonl', '{"student":"B"}\n')

    const ok = assertStudentSessionPartition(dir, { student_001: 1, student_002: 1 })
    assert.equal(ok.ok, true)
    assert.deepEqual(Object.keys(ok.perStudent).sort(), ['student_001', 'student_002'])
    // 两人对话内容互不可见：各自目录里只有自己那份
    assert.ok(readFileSync(ok.perStudent.student_001[0], 'utf8').includes('A'))
    assert.ok(readFileSync(ok.perStudent.student_002[0], 'utf8').includes('B'))
    assert.ok(!readFileSync(ok.perStudent.student_001[0], 'utf8').includes('B'))

    // 反例：有人把两个学生的会话写进同一个目录（B 的也丢进 A 目录）
    const leak = writeSession(a.studentDir, 'a-turn1-copy.jsonl', '{"student":"B"}\n')
    const broken = captureIsolationError(() => assertStudentSessionPartition(dir, { student_001: 1, student_002: 1 }))
    assert.match(broken.message, /数量不符/)
    assert.match(describeStudentPartition(inspectStudentSessionPartition(dir, { student_001: 1, student_002: 1 })), /★ 未通过/)
    rmSync(leak)
    assert.equal(inspectStudentSessionPartition(dir, { student_001: 1, student_002: 1 }).ok, true)
  })
})

test('G9-4b findJsonlFiles 不跟随符号链接、只认 .jsonl', () => {
  withTempDir('k12-jsonl-', (dir) => {
    mkdirSync(join(dir, 'a'), { recursive: true })
    writeFileSync(join(dir, 'a', 'x.jsonl'), '{}\n', 'utf8')
    writeFileSync(join(dir, 'a', 'y.txt'), 'not jsonl\n', 'utf8')
    assert.deepEqual(findJsonlFiles(dir), [join(dir, 'a', 'x.jsonl')])
  })
})

// ── G9-5 ~/.pi 不许被动 ───────────────────────────────────────────────

test('G9-5 快照比对：created / modified / removed 三种变化都能抓到', () => {
  withTempDir('k12-pihome-', (dir) => {
    const before = snapshotDir(dir)
    mkdirSync(join(dir, 'agent', 'skills'), { recursive: true })
    writeFileSync(join(dir, 'agent', 'settings.json'), '{"theme":"dark"}\n', 'utf8')

    const after = snapshotDir(dir)
    const report = comparePiHome(before, after, dir)
    assert.equal(report.ok, false)
    assert.deepEqual(
      report.changes.map((change) => `${change.change}:${change.path}`).sort(),
      ['created:agent', 'created:agent/settings.json', 'created:agent/skills']
    )

    // 内容未变 → 通过
    assert.equal(comparePiHome(after, snapshotDir(dir), dir).ok, true)

    // 改写既有文件（mtime 变化）→ 抓到 modified
    // 注：父目录的 mtime 也会跟着变（子项一变目录就变），所以只筛文件那一行来看
    const fileChanges = (report: { changes: Array<{ path: string; change: string }> }): string[] =>
      report.changes
        .filter((change) => change.path.endsWith('settings.json'))
        .map((change) => change.change)

    writeFileSync(join(dir, 'agent', 'settings.json'), '{"theme":"light"}\n', 'utf8')
    const modified = comparePiHome(after, snapshotDir(dir), dir)
    assert.equal(modified.ok, false)
    assert.deepEqual(fileChanges(modified), ['modified'])
    assert.match(modified.violations[0], /~\/\.pi 被改动（modified）/)

    // 删除 → 抓到 removed
    const third = snapshotDir(dir)
    rmSync(join(dir, 'agent', 'settings.json'))
    assert.deepEqual(fileChanges(comparePiHome(third, snapshotDir(dir), dir)), ['removed'])
  })
})

test('G9-5b ★ 本机真实 ~/.pi：跑完一轮模拟工作后清单与 mtime 均未变化', (t) => {
  const piHome = defaultPiHomeDir()
  const before = snapshotDir(piHome)
  // 本机没装 Pi CLI（没有 ~/.pi）时**显式跳过**：那种环境下「清单未变化」是空集合比对，
  // 恒真（没有任何条目可比），静默通过会让这条守卫伪装成有效证据。
  if (before.size === 0) {
    t.skip(`本机没有 ${piHome}（没装 Pi CLI）—— 清单为空时比对恒真，跳过而不是假装通过`)
    return
  }
  const userData = mkdtempSync(join(tmpdir(), 'k12-real-'))
  try {
    // 模拟「student_001 跑一轮 → 切换学生 student_002 再跑一轮 → 各自校验」这条真实路径
    for (const studentId of ['student_001', 'student_002']) {
      const paths = resolveStudentPiPaths(userData, studentId)
      ensureStudentPiDirs(paths)
      writeSession(paths.studentDir, `${studentId}.jsonl`, `{"student":"${studentId}"}\n`)
    }
    // 切换后各自的会话只在自己目录（票 09 第三条验收）
    assertStudentSessionPartition(userData, { student_001: 1, student_002: 1 })
    for (const studentId of ['student_001', 'student_002']) {
      assertNoStraySessions({ userDataDir: userData, studentId })
      createIsolationSentinel({ userDataDir: userData, studentId }).verify()
    }
  } finally {
    rmSync(userData, { recursive: true, force: true })
  }

  const after = snapshotDir(piHome)
  const report = comparePiHome(before, after, piHome)
  assert.equal(
    report.ok,
    true,
    `本应用绝不允许写用户自己的 Pi 目录：\n  ${report.violations.join('\n  ')}\n` +
      '（若你同时在用 pi CLI，请重跑一次：那次运行可能恰好落在两次快照之间，与本应用无关）'
  )

  // 诊断信息（**不是断言**：用户自己的 Pi CLI 今天用过也会改 mtime）。
  // 原来这里写成 `assert.ok(Array.isArray(touchedToday), …)` —— 返回的永远是数组，
  // 恒真，但消息读起来像断言（典型的「假绿伪装成检查」）。改成一条明确的日志。
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const touchedToday = entriesModifiedSince(after, today.getTime())
  console.log(
    `[info] 本机 ~/.pi 条目 ${before.size} 个；其中今天被动过的 ${touchedToday.length} 个` +
      `（若有，属用户自己的 Pi CLI 行为，与本应用无关）`
  )
  // 真断言：已存在的目录不会被判成「不存在」——判据必须建立在快照上，而不是 existsSync
  assert.equal(report.existedBefore, true, '快照非空 ⇒ existedBefore 必须为 true（判据建立在快照上）')
})

// ── G9-6 哨兵：全流程 ─────────────────────────────────────────────────

test('G9-6 隔离哨兵：干净环境通过；越界会话或 ~/.pi 被动过都会立刻抛', () => {
  withTempDir('k12-sentinel-', (dir) => {
    const userData = join(dir, 'userData')
    const fakeHome = join(dir, 'home')
    mkdirSync(join(fakeHome, '.pi', 'agent', 'skills'), { recursive: true })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), '{}\n', 'utf8')

    const sentinel = createIsolationSentinel({
      userDataDir: userData,
      studentId: 'student_001',
      piHomeDir: join(fakeHome, '.pi')
    })
    writeSession(sentinel.studentPaths.studentDir, 'turn-1.jsonl')
    const report = sentinel.verify()
    assert.equal(report.ok, true)
    assert.equal(report.sessions.found.length, 1)

    // ① 越界会话 → 抛
    const strayDir = join(userData, 'pi-agent', 'sessions')
    mkdirSync(strayDir, { recursive: true })
    const stray = join(strayDir, 'stray.jsonl')
    writeFileSync(stray, '{}\n', 'utf8')
    assert.throws(
      () => createIsolationSentinel({ userDataDir: userData, studentId: 'student_001', piHomeDir: join(fakeHome, '.pi') }).verify(),
      (error: unknown) => error instanceof SessionIsolationError
    )
    rmSync(stray)

    // ② ~/.pi 被写 → 抛（模拟「有人在别处图省事退回了 ~/.pi」）
    const second = createIsolationSentinel({
      userDataDir: userData,
      studentId: 'student_001',
      piHomeDir: join(fakeHome, '.pi')
    })
    writeFileSync(join(fakeHome, '.pi', 'agent', 'settings.json'), '{"touched":true}\n', 'utf8')
    const failure = captureIsolationError(() => second.verify())
    assert.match(failure.message, /~\/\.pi/)
  })
})

test('G9-6b 人工核验命令给全「学生自己的会话 / 越界 / ~/.pi」三条', () => {
  const hints = isolationShellHints(join('D:', 'userData'), 'student_001')
  assert.equal(hints.length, 6)
  const text = hints.join('\n')
  assert.match(text, /students[\\/]student_001[\\/]pi-agent[\\/]sessions/)
  assert.match(text, /\.pi/)
  assert.match(text, /jsonl/)
})

test("G9-6c 学生路径的唯一拼装点是 pi-paths.ts（别处不得手写 'students' 目录）", () => {
  const mainDir = join(desktopRoot, 'src', 'main')
  const offenders: string[] = []
  for (const file of listSourceFiles(mainDir)) {
    if (file.endsWith(join('agent', 'pi-paths.ts'))) continue
    const source = stripComments(readFileSync(file, 'utf8'))
    // 手写路径片段（`join(x, 'students', ...)` / `'students/'`）才算违规；
    // 注释里解释约定、类型名 `StudentPiPaths`、变量名 `students` 都不该被判违规。
    if (/['"`](students|pi-agent)[\\/]['"`]/.test(source) || /['"`]students['"`]/.test(source)) {
      offenders.push(file.slice(desktopRoot.length + 1).replace(/\\/g, '/'))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件手写了学生目录路径（必须在 pi-paths.ts 里统一拼装）：\n  ${offenders.join('\n  ')}`
  )
})

/** 递归列出源码文件（跳过 node_modules 与隐藏目录）。 */
function listSourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...listSourceFiles(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

/** 去掉注释，只留可执行代码（注释里写约定是好事，不该被判违规）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/.*$/gm, '$1')
}
