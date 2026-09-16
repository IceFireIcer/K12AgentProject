/**
 * Pi 运行时的**目录隔离**（票 03 建立底座，票 09 下沉到「一人一份」）。
 *
 * Pi 的默认行为：
 *   - `getAgentDir()`           → `~/.pi/agent`      （**用户自己 Pi CLI 的配置目录**！）
 *   - `SessionManager.create()` → `~/.pi/agent/sessions/<encoded-cwd>/`
 * 直接用默认值会**读写用户全局 Pi 配置**，并把学生对话写进全局目录 —— 既是跨学生数据混放
 * （合规硬伤，AGENTS §5.8 / 执行文档 §8.2、§12），也会污染用户自己的 Pi CLI。
 *
 * 本文件负责三层：
 *
 * 1. **应用级**（票 03）：<userData>/pi-agent/ 的 `agentDir` / `authPath` / `modelsPath` / `sessionDir`；
 * 2. **学生级**（票 09 ★）：`<userData>/students/<id>/pi-agent/`，`learning.db` 同层 ——
 *    `agentDir` / `sessionDir` **必须显式指向这里**，否则两个学生的对话会落进同一目录；
 * 3. **断言**（票 09 ★★）：`students/<id>/` 之外不得出现本应用的 `.jsonl`；
 *    `~/.pi` 在运行前后文件清单与 mtime 均不得变化。**失败即抛，不退回警告** ——
 *    跨学生混放是合规问题，不能靠日志里的一行 WARN。
 *
 * 关于「怎么验 `~/.pi` 没被动过」：本机 `~/.pi` **是存在的**（用户自己的 Pi CLI：两个空目录
 * 加两个 skills 符号链接），所以「目录不存在 = 没碰过」这种判据是错的（会永远通过）。
 * 这里改用**文件清单 + mtime 快照比对**：运行前后任一条目被创建 / 删除 / 改写，`verify()` 立刻抛。
 * 符号链接**不跟随**（`~/.pi/agent/skills/*` 指向 `~/.agents/skills/*`，跟进去会扫一大片无关目录）。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, relative, resolve, sep } from 'node:path'

/** 本应用在 `<userData>` 下的 Pi 根目录名（不是 `~/.pi`）。 */
export const PI_APP_DIR_NAME = 'pi-agent'

/** 学生目录的父目录名（§8.2：`userData/students/<id>/`）。 */
export const STUDENTS_DIR_NAME = 'students'

/** `learning.db` 文件名（一人一份，§8.1）。 */
export const LEARNING_DB_NAME = 'learning.db'

/**
 * ★ 跨学生隔离违规。**单独一个错误类型**，便于上层「要么放行、要么明确报错」而不吞掉它。
 */
export class SessionIsolationError extends Error {
  readonly violations: string[]
  constructor(violations: string[]) {
    super(`跨学生数据隔离断言失败：\n  - ${violations.join('\n  - ')}`)
    this.name = 'SessionIsolationError'
    this.violations = violations
  }
}

export interface PiPaths {
  /** `<userData>/pi-agent` —— 应用级 Pi 数据根（学生级见 {@link StudentPiPaths}）。 */
  root: string
  /** `agentDir`：Pi 的全局配置目录（settings.json / skills / prompts / tools 都在这里）。 */
  agentDir: string
  /** `authPath`：API Key 落盘位置（只存本应用自己的 Key，绝不碰用户全局 `auth.json`）。 */
  authPath: string
  /** `modelsPath`：自定义 provider / BaseURL / ModelID 的配置文件（赛题硬要求）。 */
  modelsPath: string
  /** `sessionDir`：Pi JSONL 会话树落盘位置（一人一份）。 */
  sessionDir: string
  /** system prompt 落盘检查用的目录（冒烟证据，仅供排查）。 */
  logDir: string
}

/** Pi 的六个目录字段（断言用；`Object.keys` 顺序即此顺序）。 */
export const PI_DIR_KEYS: readonly (keyof PiPaths)[] = [
  'root',
  'agentDir',
  'authPath',
  'modelsPath',
  'sessionDir',
  'logDir'
]

/** ★ 一个学生**独占**的那一套路径（票 09：一人一目录、一人一库）。 */
export interface StudentPiPaths extends PiPaths {
  userDataDir: string
  /** `student_001` 这类 id（经 {@link assertStudentId} 校验后才可能出现在这里）。 */
  studentId: string
  /** `<userData>/students/<id>`：该学生的全部本地数据（Pi 会话 + learning.db + 动画缓存）。 */
  studentDir: string
  /** `<userData>/students/<id>/learning.db`（**对话正文不存在这里**）。 */
  learningDbPath: string
}

/**
 * 学生 id 白名单：**它会被拼进文件系统路径**，所以必须在这里挡住路径穿越。
 *
 * 学生 id 一路来自渲染进程（学生列表 / 设置页），不校验就等于把「选学生」变成
 * 「读写任意目录」（`../../` 直接跨学生、跨库）。只允许 `[A-Za-z0-9_-]`，长度 1..64。
 */
export const STUDENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 校验学生 id；不合法直接抛（**不要**在外面做一次「大概没问题」的判断）。 */
export function assertStudentId(studentId: string): string {
  if (typeof studentId !== 'string' || !STUDENT_ID_PATTERN.test(studentId)) {
    throw new SessionIsolationError([
      `非法学生 id：${JSON.stringify(studentId)}（只允许 [A-Za-z0-9_-]{1,64}）`,
      '学生 id 会被拼进文件系统路径，放行等于允许路径穿越（跨学生读写）'
    ])
  }
  return studentId
}

/**
 * 由 Electron 的 `app.getPath('userData')` 推导出**应用级** Pi 路径。
 * **不接受任何默认值**：调用方必须显式给 userDataDir，避免有人图省事退回 `~/.pi`。
 *
 * ⚠️ 学生级请用 {@link resolveStudentPiPaths}（票 09 之后，业务路径一律走那一份）。
 */
export function resolvePiPaths(userDataDir: string): PiPaths {
  if (!userDataDir) {
    throw new Error('resolvePiPaths: userDataDir 不能为空（禁止回退到 ~/.pi）')
  }
  const root = join(userDataDir, PI_APP_DIR_NAME)
  const agentDir = join(root, 'agent')
  return {
    root,
    agentDir,
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    sessionDir: join(root, 'sessions'),
    logDir: join(root, 'logs')
  }
}

/** `<userData>/students/<id>`（学生数据的唯一根；`learning.db` 与 `pi-agent/` 都在其下）。 */
export function resolveStudentDir(userDataDir: string, studentId: string): string {
  if (!userDataDir) {
    throw new Error('resolveStudentDir: userDataDir 不能为空（禁止回退到 ~/.pi）')
  }
  return join(userDataDir, STUDENTS_DIR_NAME, assertStudentId(studentId))
}

/**
 * ★★ 票 09 的核心：**一个学生一套 Pi 路径**。
 *
 * 全部落在 `<userData>/students/<id>/pi-agent/` 之内：
 *   - `agentDir`   = `<studentDir>/pi-agent/agent`   （Pi 的 settings / skills / prompts）
 *   - `sessionDir` = `<userData>/students/<id>/pi-agent/sessions`（**JSONL 只落这里**）
 *   - `authPath` / `modelsPath` 同样按学生分开：Key 与 BaseURL 属于本机配置，不该按学生复制，
 *     但**路径必须在学生目录内**（应用级的那份仍是回退来源，见 `pi-bootstrap.ts` 的 Key 解析链）。
 *     这样做的理由只有一个：**任何写入都不可能落到别人的目录**，审计时只看一个根就够。
 */
export function resolveStudentPiPaths(userDataDir: string, studentId: string): StudentPiPaths {
  const studentDir = resolveStudentDir(userDataDir, studentId)
  const root = join(studentDir, PI_APP_DIR_NAME)
  const agentDir = join(root, 'agent')
  return {
    userDataDir: resolve(userDataDir),
    studentId,
    studentDir,
    learningDbPath: join(studentDir, LEARNING_DB_NAME),
    root,
    agentDir,
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    sessionDir: join(root, 'sessions'),
    logDir: join(root, 'logs')
  }
}

/** 建目录（幂等）。只允许建在 `paths.root` 之内 —— 越界直接抛，防止误改全局目录。 */
export function ensurePiDirs(paths: PiPaths): void {
  for (const dir of [paths.root, paths.agentDir, paths.sessionDir, paths.logDir]) {
    if (!dir.startsWith(paths.root)) {
      throw new Error(`ensurePiDirs: 拒绝在 Pi 根目录之外创建目录：${dir}`)
    }
    mkdirSync(dir, { recursive: true })
  }
}

/** 学生级目录就绪（学生目录 + Pi 三处 + 动画缓存目录；`learning.db` 由 Python 侧建）。 */
export function ensureStudentPiDirs(paths: StudentPiPaths): void {
  const violations: string[] = []
  for (const key of PI_DIR_KEYS) {
    const dir = paths[key]
    if (!isInside(paths.studentDir, dir)) violations.push(`${key} 越出学生目录：${dir}`)
  }
  if (violations.length > 0) throw new SessionIsolationError(violations)
  for (const dir of [paths.studentDir, paths.root, paths.agentDir, paths.sessionDir, paths.logDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** 路径包含判定（**用相对路径算**，避免 `C:\a` 与 `C:\ab` 这类前缀误判）。 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))
}

/** 用户自己的全局 Pi 目录（`~/.pi`）。**本应用只允许读它的快照，一个字节都不许写。** */
export function defaultPiHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, '.pi')
}

/* ------------------------------------------------------------------ *
 * 磁盘扫描与快照（断言的基础设施）
 * ------------------------------------------------------------------ */

export interface DirEntrySnapshot {
  /** 相对扫描根的路径（`/` 分隔，便于跨平台比对与打印）。 */
  path: string
  kind: 'file' | 'dir' | 'symlink' | 'other'
  mtimeMs: number
  size: number
  /** 符号链接的目标（不跟随，只记录）。 */
  linkTarget?: string
}

export type DirSnapshot = Map<string, DirEntrySnapshot>

/**
 * 目录快照（**递归，但不跟随符号链接**）。
 *
 * 不跟随是刻意的：`~/.pi/agent/skills/*` 是指向 `~/.agents/skills/*` 的符号链接，
 * 跟进去会把用户整个技能库卷进来，快照既慢又会假报「变化」。
 */
export function snapshotDir(root: string, options: { maxEntries?: number } = {}): DirSnapshot {
  const snapshot: DirSnapshot = new Map()
  const limit = options.maxEntries ?? 20_000
  if (!existsSync(root)) return snapshot

  const walk = (dir: string): void => {
    if (snapshot.size > limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 权限不足等情况：跳过而不是让断言本身崩掉
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const key = relative(root, full).split(sep).join('/')
      let stat
      try {
        stat = lstatSync(full)
      } catch {
        continue
      }
      const kind: DirEntrySnapshot['kind'] = stat.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'dir'
          : stat.isFile()
            ? 'file'
            : 'other'
      const record: DirEntrySnapshot = {
        path: key,
        kind,
        mtimeMs: Math.trunc(stat.mtimeMs),
        size: stat.size
      }
      if (kind === 'symlink') {
        try {
          record.linkTarget = readlinkSync(full)
        } catch {
          record.linkTarget = undefined
        }
      }
      snapshot.set(key, record)
      // 只在真目录里递归（符号链接不跟）
      if (kind === 'dir') walk(full)
    }
  }

  walk(root)
  return snapshot
}

export type DirChangeKind = 'created' | 'removed' | 'modified'

export interface DirChange {
  path: string
  change: DirChangeKind
  before?: DirEntrySnapshot
  after?: DirEntrySnapshot
}

/** 两个快照的差异（**只看清单与 mtime/size**；mtime 截断到整数毫秒避免浮点抖动）。 */
export function diffDir(before: DirSnapshot, after: DirSnapshot): DirChange[] {
  const changes: DirChange[] = []
  for (const [path, afterEntry] of after) {
    const beforeEntry = before.get(path)
    if (!beforeEntry) {
      changes.push({ path, change: 'created', after: afterEntry })
      continue
    }
    if (
      beforeEntry.mtimeMs !== afterEntry.mtimeMs ||
      beforeEntry.size !== afterEntry.size ||
      beforeEntry.kind !== afterEntry.kind ||
      beforeEntry.linkTarget !== afterEntry.linkTarget
    ) {
      changes.push({ path, change: 'modified', before: beforeEntry, after: afterEntry })
    }
  }
  for (const [path, beforeEntry] of before) {
    if (!after.has(path)) changes.push({ path, change: 'removed', before: beforeEntry })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

/** 快照里 mtime 落在 `since` 之后的条目（即「今天被动过」的那些）。 */
export function entriesModifiedSince(snapshot: DirSnapshot, since: number): DirEntrySnapshot[] {
  return [...snapshot.values()].filter((entry) => entry.mtimeMs >= since)
}

/** 递归找 `*.jsonl`（**不跟随符号链接**；`skipDirs` 里的目录整棵跳过）。 */
export function findJsonlFiles(root: string, options: { skipDirs?: string[] } = {}): string[] {
  const found: string[] = []
  if (!existsSync(root)) return found
  const skip = new Set((options.skipDirs ?? []).map((dir) => resolve(dir)))

  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (skip.has(resolve(full))) continue
        walk(full)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        found.push(full)
      }
    }
  }

  walk(root)
  return found.sort()
}

/* ------------------------------------------------------------------ *
 * ★★ 断言一：JSONL 只许落在自己的学生目录里
 * ------------------------------------------------------------------ */

export interface StraySessionReport {
  ok: boolean
  studentId: string
  /** 本学生的 Pi 会话目录（**本学生**的 `.jsonl` 只允许出现在这里）。 */
  allowedRoot: string
  /** 允许出现 `.jsonl` 的全部根（默认含所有学生的会话目录，见 `allowOtherStudents`）。 */
  allowedRoots: string[]
  /** 扫描过的根。 */
  scannedRoots: string[]
  found: string[]
  /** 本学生目录内的文件。 */
  own: string[]
  /** 其他学生目录内的文件（正常现象：切换过学生之后就该有）。 */
  otherStudents: string[]
  /** ★ 越界的文件（空数组 = 通过）。 */
  stray: string[]
  violations: string[]
}

export interface StraySessionOptions {
  userDataDir: string
  studentId: string
  /**
   * 是否允许**其他学生**的会话目录里出现 `.jsonl`（默认 `true`）。
   *
   * 为什么默认允许：学生是**先后**使用的，「切到 student_002 之后 student_001 的会话文件仍然在
   * 自己目录里」是正常状态；若默认禁止，多学生场景下这条断言会天天误报，最后被当成噪音关掉。
   * 真正要防的两件事各有更强的判据：
   *   - 「所有学生写进同一个目录」→ `allowOtherStudents: false` 的强模式，
   *     以及 {@link assertSessionManagerIsolated}（建会话当场看 Pi 报告的落盘目录）；
   *   - 「会话跑到学生目录树之外」（`~/.pi`、`<userData>/pi-agent/sessions`、安装目录）
   *     → 默认模式就抓到，这是最容易真实发生的形态。
   */
  allowOtherStudents?: boolean
  /**
   * 额外扫描的根（默认就是 `<userData>` 本身）。
   * 打包态可把安装目录也塞进来，确保没有「随手写到 exe 旁边」的会话文件。
   */
  extraRoots?: string[]
  /** 扫描时整棵跳过的目录（例如 `node_modules`、PyInstaller 的 `_internal`）。 */
  skipDirs?: string[]
}

/** `<userData>/students` 下所有学生的 Pi 会话目录（已存在的）。 */
export function studentSessionRoots(userDataDir: string, options: { skipStudentId?: string } = {}): string[] {
  const studentsRoot = join(userDataDir, STUDENTS_DIR_NAME)
  if (!existsSync(studentsRoot)) return []
  const roots: string[] = []
  for (const entry of readdirSync(studentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (options.skipStudentId && entry.name === options.skipStudentId) continue
    if (!STUDENT_ID_PATTERN.test(entry.name)) continue
    roots.push(join(studentsRoot, entry.name, PI_APP_DIR_NAME, 'sessions'))
  }
  return roots
}

/**
 * ★★ 票 09 的合规断言：跑完一轮对话后，本应用的 `.jsonl` **不得出现在学生目录树之外**
 * （默认还要求「本学生自己的文件就在自己目录里」）。
 *
 * 为什么用「扫描磁盘」而不是「读 Pi 的配置」：配置写对了不代表 Pi 真的按它落盘
 * （默认目录的代码路径就在 Pi 内部，一旦哪天被 `settings.sessionDir` 覆盖掉，
 * 读配置的断言依然全绿）。这条断言直接看**结果**。
 */
export function inspectStraySessions(options: StraySessionOptions): StraySessionReport {
  const studentId = assertStudentId(options.studentId)
  const paths = resolveStudentPiPaths(options.userDataDir, studentId)
  const allowOtherStudents = options.allowOtherStudents ?? true
  const scannedRoots = [resolve(options.userDataDir), ...(options.extraRoots ?? []).map((dir) => resolve(dir))]
  // ⚠️ 默认**不跳过**学生自己的会话目录：`own` 要能看出「本应用确实写了会话」，
  //    否则「越界 0 个」既可能因为没写、也可能因为写对了 —— 那样断言就退化成空壳。
  const skipDirs = [...(options.skipDirs ?? [])]

  const found: string[] = []
  for (const root of scannedRoots) {
    for (const file of findJsonlFiles(root, { skipDirs })) {
      if (!found.includes(file)) found.push(file)
    }
  }

  const otherRoots = allowOtherStudents ? studentSessionRoots(options.userDataDir, { skipStudentId: studentId }) : []
  const allowedRoots = [paths.sessionDir, ...otherRoots]

  const own: string[] = []
  const otherStudents: string[] = []
  const stray: string[] = []
  for (const file of found) {
    if (isInside(paths.sessionDir, file)) {
      own.push(file)
      continue
    }
    const otherRoot = otherRoots.find((root) => isInside(root, file))
    if (otherRoot) {
      otherStudents.push(file)
      continue
    }
    stray.push(file)
  }

  const violations = stray.map((file) => {
    const insideStudentTree = isInside(join(resolve(options.userDataDir), STUDENTS_DIR_NAME), file)
    return insideStudentTree
      ? `本学生的会话文件落到别的学生目录里：${file}（本学生只允许 ${paths.sessionDir}）` +
          '—— 这是**跨学生数据混放**，属合规硬伤'
      : `本应用的会话文件落在学生目录树之外：${file}（允许根：${allowedRoots.join(' / ')}）` +
          '—— Pi 默认会写 `~/.pi/agent/sessions/`，漏传 sessionDir 就是这种形态，**属合规硬伤**'
  })

  return {
    ok: violations.length === 0,
    studentId,
    allowedRoot: paths.sessionDir,
    allowedRoots,
    scannedRoots,
    found,
    own,
    otherStudents,
    stray,
    violations
  }
}

/** 同 {@link inspectStraySessions}，但**违规即抛**（`SessionIsolationError`）。 */
export function assertNoStraySessions(options: StraySessionOptions): StraySessionReport {
  const report = inspectStraySessions(options)
  if (!report.ok) throw new SessionIsolationError(report.violations)
  return report
}

/* ------------------------------------------------------------------ *
 * ★★ 断言二：`~/.pi` 一个字节都没被动过
 * ------------------------------------------------------------------ */

export interface PiHomeReport {
  ok: boolean
  root: string
  /** `false` = 目录本来就不存在（也算通过，但会写明）。 */
  existedBefore: boolean
  changes: DirChange[]
  violations: string[]
}

/**
 * 比对 `~/.pi` 的前后快照。
 *
 * 判据：**文件清单 + mtime + size 全等**（比「今天有没有被改」更严 —— 本机 `~/.pi`
 * 的既有条目 mtime 是 8/31 与 9/1，只要本应用碰过任何一个，这里立刻红）。
 */
export function comparePiHome(before: DirSnapshot, after: DirSnapshot, root: string): PiHomeReport {
  const changes = diffDir(before, after)
  const violations = changes.map(
    (change) =>
      `~/.pi 被改动（${change.change}）：${change.path}` +
      (change.after ? `（mtime=${change.after.mtimeMs}）` : '')
  )
  return {
    ok: violations.length === 0,
    root,
    existedBefore: before.size > 0,
    changes,
    violations
  }
}

/**
 * ★ 隔离哨兵：**一次 Pi 会话前后各拍一张快照**，`verify()` 同时检查两件事：
 *
 *   1. 该学生的 `.jsonl` 只在 `<userData>/students/<id>/pi-agent/sessions/` 之内；
 *   2. `~/.pi`（用户自己的 Pi CLI 目录）文件清单与 mtime **完全没变**。
 *
 * 用法（`runtime.ts` 接线，**每轮或退出前调用**；失败要让它抛出去）：
 * ```ts
 * const sentinel = createIsolationSentinel({ userDataDir, studentId })
 * // …建 session、跑一轮…
 * sentinel.verify()          // 违规直接抛 SessionIsolationError
 * ```
 */
export interface IsolationSentinel {
  readonly studentId: string
  readonly studentPaths: StudentPiPaths
  /** 建哨兵时的快照（诊断用）。 */
  readonly before: { userData: DirSnapshot; piHome: DirSnapshot }
  /** 立即再拍一张并比对；**不通过就抛**。 */
  verify(): IsolationReport
  /** 只看结果不抛（测试与诊断用）。 */
  inspect(): IsolationReport
}

export interface IsolationReport {
  ok: boolean
  studentId: string
  sessions: StraySessionReport
  piHome: PiHomeReport
  violations: string[]
}

export interface IsolationSentinelOptions {
  userDataDir: string
  studentId: string
  /** `~/.pi` 的位置（默认 `join(os.homedir(), '.pi')`；测试可指向临时目录）。 */
  piHomeDir?: string
  /** 见 {@link StraySessionOptions.allowOtherStudents}（默认 `true`）。 */
  allowOtherStudents?: boolean
  extraRoots?: string[]
  skipDirs?: string[]
}

export function createIsolationSentinel(options: IsolationSentinelOptions): IsolationSentinel {
  const studentPaths = resolveStudentPiPaths(options.userDataDir, options.studentId)
  ensureStudentPiDirs(studentPaths)
  const piHomeDir = options.piHomeDir ?? defaultPiHomeDir()
  const before = {
    userData: snapshotDir(resolve(options.userDataDir), { maxEntries: 200_000 }),
    piHome: snapshotDir(piHomeDir)
  }

  const inspect = (): IsolationReport => {
    const sessions = inspectStraySessions({
      userDataDir: options.userDataDir,
      studentId: options.studentId,
      allowOtherStudents: options.allowOtherStudents,
      extraRoots: options.extraRoots,
      skipDirs: options.skipDirs
    })
    const piHome = comparePiHome(before.piHome, snapshotDir(piHomeDir), piHomeDir)
    const violations = [...sessions.violations, ...piHome.violations]
    return { ok: violations.length === 0, studentId: studentPaths.studentId, sessions, piHome, violations }
  }

  return {
    studentId: studentPaths.studentId,
    studentPaths,
    before,
    inspect,
    verify(): IsolationReport {
      const report = inspect()
      if (!report.ok) throw new SessionIsolationError(report.violations)
      return report
    }
  }
}

/* ------------------------------------------------------------------ *
 * ★★ 断言三：切换学生后，各自的会话只落自己目录（分区检查）
 * ------------------------------------------------------------------ */

export interface StudentPartitionReport {
  ok: boolean
  /** 每个学生目录里的 `.jsonl` 清单。 */
  perStudent: Record<string, string[]>
  /** 落在 `students/<id>/pi-agent/sessions/` 之外的 `.jsonl`。 */
  stray: string[]
  violations: string[]
}

/**
 * 「切换学生」场景的判据：每人一份目录，且**各自那几轮产生的会话文件只在自己目录里**。
 *
 * `expectedCounts` 是这条判据的关键：只数「越界」是不够的（全都没写会话也是 0 个越界）。
 * 传 `{ student_001: 1, student_002: 1 }` 就等于断言「A 的那一轮落在 A 目录、B 的那一轮落在 B 目录」——
 * 如果有人把两人的会话写进同一个目录，计数立刻对不上。
 */
export function inspectStudentSessionPartition(
  userDataDir: string,
  expectedCounts: Record<string, number> = {}
): StudentPartitionReport {
  const studentsRoot = join(userDataDir, STUDENTS_DIR_NAME)
  const perStudent: Record<string, string[]> = {}
  const violations: string[] = []
  const stray: string[] = []

  if (existsSync(studentsRoot)) {
    for (const entry of readdirSync(studentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !STUDENT_ID_PATTERN.test(entry.name)) continue
      const id = assertStudentId(entry.name)
      const sessions = join(studentsRoot, id, PI_APP_DIR_NAME, 'sessions')
      perStudent[id] = findJsonlFiles(sessions)
    }
  }

  for (const file of findJsonlFiles(studentsRoot)) {
    const inside = Object.entries(perStudent).some(([, files]) => files.includes(file))
    if (!inside) stray.push(file)
  }
  for (const file of stray) {
    violations.push(`学生目录树里出现「不属于任何学生会话目录」的文件：${file}`)
  }

  for (const [id, expected] of Object.entries(expectedCounts)) {
    const actual = perStudent[id]?.length ?? 0
    if (actual !== expected) {
      violations.push(
        `学生 ${id} 的会话文件数量不符：期望 ${expected} 个，实际 ${actual} 个` +
          '（多人混放进同一目录时，这里会同时对不上）'
      )
    }
  }

  return { ok: violations.length === 0, perStudent, stray, violations }
}

/** 同 {@link inspectStudentSessionPartition}，但**违规即抛**。 */
export function assertStudentSessionPartition(
  userDataDir: string,
  expectedCounts: Record<string, number> = {}
): StudentPartitionReport {
  const report = inspectStudentSessionPartition(userDataDir, expectedCounts)
  if (!report.ok) throw new SessionIsolationError(report.violations)
  return report
}

/** 分区结论的可读形态（人工核验与报告素材用）。 */
export function describeStudentPartition(report: StudentPartitionReport): string {
  const lines = [`跨学生会话分区：${report.ok ? '通过' : '★ 未通过'}`]
  for (const [id, files] of Object.entries(report.perStudent).sort()) {
    lines.push(`  ${id}：${files.length} 个会话文件`)
  }
  if (report.stray.length > 0) lines.push(`  不属于任何学生会话目录：${report.stray.length} 个`)
  for (const violation of report.violations) lines.push(`  - ${violation}`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * ★★ 断言三：Pi 真的把会话写到了学生目录
 * ------------------------------------------------------------------ */

/** `SessionManager`（或它的只读视图）里我们用来判定隔离的三个方法。 */
export interface SessionManagerLike {
  getSessionDir(): string
  usesDefaultSessionDir(): boolean
  getSessionFile?(): string | undefined
  getSessionId?(): string
}

/**
 * 建完 session **立刻**校验 Pi 拿到的落盘位置。
 *
 * 这一步挡的是「代码写对了、Pi 没照做」：`SessionManager.create(cwd, sessionDir)` 的第二个参数
 * 一旦漏传，Pi 会静默退回 `~/.pi/agent/sessions/--<cwd>--/`（`usesDefaultSessionDir()` 会变 true）。
 * 等 `.jsonl` 真的写出来才发现，就已经产生跨学生数据了 —— 所以在**建 session 的当场**就抛。
 */
export function assertSessionManagerIsolated(
  sessionManager: SessionManagerLike,
  expectedSessionDir: string,
  label = 'Pi 会话'
): void {
  const violations: string[] = []
  const actual = String(sessionManager.getSessionDir?.() ?? '')

  if (!actual) {
    violations.push(`${label} 没有报告 sessionDir（SessionManager 形态不符合预期）`)
  } else if (!isInside(expectedSessionDir, actual)) {
    violations.push(
      `${label} 的落盘目录不在学生目录内：${actual}（期望在 ${expectedSessionDir} 内）`
    )
  }
  if (sessionManager.usesDefaultSessionDir?.() === true) {
    violations.push(
      `${label} 使用了 Pi 的默认会话目录（~/.pi/agent/sessions/--<cwd>--/）——` +
        '`SessionManager.create(cwd, sessionDir)` 的第二个参数必须显式传入'
    )
  }
  const file = sessionManager.getSessionFile?.()
  if (file && !isInside(expectedSessionDir, file)) {
    violations.push(`${label} 的 JSONL 文件不在学生目录内：${file}`)
  }
  if (violations.length > 0) throw new SessionIsolationError(violations)
}

/* ------------------------------------------------------------------ *
 * 报告（给「报告素材」与断言失败信息用）
 * ------------------------------------------------------------------ */

/** 一段可读的隔离结论（人工核验命令与报告素材都直接用它）。 */
export function describeIsolation(report: IsolationReport): string {
  const lines: string[] = []
  lines.push(`跨学生隔离：${report.ok ? '通过' : '★ 未通过'}`)
  lines.push(`  学生：${report.studentId}`)
  lines.push(`  本学生会话目录：${report.sessions.allowedRoot}`)
  lines.push(
    `  扫到 .jsonl：${report.sessions.found.length} 个（本学生 ${report.sessions.own.length} / ` +
      `其他学生 ${report.sessions.otherStudents.length} / **越界 ${report.sessions.stray.length}**）`
  )
  lines.push(`  ~/.pi（${report.piHome.root}）：${report.piHome.ok ? '未变化' : '★ 被改动'}`)
  for (const violation of report.violations) lines.push(`  - ${violation}`)
  return lines.join('\n')
}

/**
 * 人工核验命令（写进报告素材用）。
 * 断言负责「机器判定」，这两条命令负责「当场给人看」，两者都要有 —— 演示现场没人会读测试日志。
 */
export function isolationShellHints(userDataDir: string, studentId: string): string[] {
  const paths = resolveStudentPiPaths(userDataDir, studentId)
  return [
    `# 该学生自己的会话（应当只有这里出现 .jsonl）`,
    `dir /s /b "${paths.sessionDir}\\*.jsonl"`,
    `# 越界检查：userData 下除该学生目录以外的 .jsonl（应当无输出）`,
    `powershell -NoProfile -Command "Get-ChildItem -Path '${userDataDir}' -Recurse -Filter *.jsonl | Where-Object { $_.FullName -notlike '${paths.sessionDir}*' } | Select-Object -ExpandProperty FullName"`,
    `# 用户自己的 Pi 目录（应当无今天的新文件）`,
    `powershell -NoProfile -Command "Get-ChildItem -Path '${defaultPiHomeDir()}' -Recurse -Force | Select-Object FullName,LastWriteTime"`
  ]
}

/** 目录是否可写（诊断用；不写入任何东西）。 */
export function isWritableDir(dir: string): boolean {
  try {
    const stat = statSync(dir)
    return stat.isDirectory()
  } catch {
    return false
  }
}

/** 归一化路径（供外部打印/比对；Windows 下统一成 `/` 分隔，便于写进报告）。 */
export function prettyPath(value: string): string {
  return normalize(value).replace(/\\/g, '/')
}
