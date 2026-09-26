/**
 * 便携（绿色）形态的**数据目录决策** —— 纯函数，可单测（`tests/portable-data-dir.test.ts`）。
 *
 * ---------------------------------------------------------------------------
 * 为什么必须把这件事抽出来单独判（P0-1 实测事故）
 * ---------------------------------------------------------------------------
 * electron-builder 的 `portable` 目标产出的**单文件 exe 是个自解压启动器**：
 * 它先把应用解压到 `%TEMP%\<unpackDirName>`，再运行里面的 `k12-agent-desktop.exe`，
 * 退出时 `RMDir /r` 把那个目录删掉（见 `app-builder-lib/templates/nsis/portable.nsi`）。
 *
 * 于是「exe 同级 `data/`」这条路在单文件形态下等于**把学生数据写进临时目录**：
 * 关掉再开，启动器重新解压一份干净副本 —— 配置全丢、学段回到未判定、知识库消失。
 * 而 `npm run build:portable`（本仓库**唯一**的本地出包命令）产出的正是**这一个形态**，
 * 所以这不是边角情形，是演示现场一重启就回出厂状态的事故。
 *
 * 真正「用户把 exe 放在哪」只有启动器注入的 `PORTABLE_EXECUTABLE_DIR` 知道
 * （NSIS 里 `Kernel32::SetEnvironmentVariable` 设给子进程）。但那条环境变量
 * **不保证被子进程继承到**（实测在便携单文件形态下拿到过 `undefined`）。
 *
 * ---------------------------------------------------------------------------
 * 判定规则（两段，缺一不可）
 * ---------------------------------------------------------------------------
 * 1. **是不是便携形态**：`K12_PORTABLE=1` 或 exe 同级存在 `portable.marker`。
 * 2. **那个「exe 同级」到底持不持久**：候选目录取
 *    `PORTABLE_EXECUTABLE_DIR ?? exeDir`，只有当它**不在临时目录里**、
 *    且不是那个已知的临时解压目录名时，才认它是持久的、把 `userData` 指过去。
 *
 * 拿不到持久目录时**不硬改道**（那就是数据丢失的来源），退回 Electron 默认的
 * 固定 slug 目录（`%APPDATA%\<slug>`，跨重启存活）。代价是单文件形态下数据不在
 * exe 旁边（「绿色」程度打折），但**不丢数据**是硬要求，可移植性次之。
 * 想要「数据跟着 exe 走」的完整绿色体验，请用 zip 形态（解压到一个**真实**目录再运行）。
 */

import { isAbsolute, join, relative, sep } from 'node:path'
/** electron-builder `portable.unpackDirName` 的取值（与 `electron-builder.yml` 一字不差）。 */
export const PORTABLE_UNPACK_DIR_NAME = 'k12-agent-desktop-portable'

export interface PortableDataDirInput {
  /** `app.isPackaged`：开发态一律不改道（否则 `npm run dev` 把数据写进源码目录）。 */
  isPackaged: boolean
  /** `dirname(app.getPath('exe'))`。 */
  exeDir: string
  /** `os.tmpdir()`。 */
  tempDir: string
  /** 启动器注入的 `PORTABLE_EXECUTABLE_DIR`；拿不到就是 `null`。 */
  portableExecutableDir: string | null
  /** exe 同级存在 `portable.marker`。 */
  markerExists: boolean
  /** 环境变量 `K12_PORTABLE=1`。 */
  forced: boolean
  /**
   * ★ **显式逃生舱**：环境变量 `K12_DATA_DIR` 指定的数据目录（绝对路径）。
   *
   * 为什么要有它：单文件便携形态拿不到持久目录时（见 `temp-unpack-dir`），
   * 我们退回默认的 `%APPDATA%\<slug>` —— 不丢数据，但数据不在 exe 旁边。
   * 演示现场若坚持「数据就在我这个 U 盘上」，可以显式给一个路径
   * （`K12_DATA_DIR=E:\k12data`），这条规则**优先级最高**、与是否便携无关。
   */
  explicitDataDir?: string | null
  /** 已知的临时解压目录名（默认 {@link PORTABLE_UNPACK_DIR_NAME}）。 */
  unpackDirName?: string
}

/** 决策结果：`redirect` 为真时 `dataDir` 一定有值；为假时退回默认 userData。 */
export interface PortableDataDirDecision {
  /** 是否把 `userData` 改道到 `dataDir`。 */
  redirect: boolean
  /** 改道目标（`redirect` 为假时为 `null`）。 */
  dataDir: string | null
  /**
   * 一句话原因（进日志；也便于单测断言「走的是哪条分支」）。
   * 取值：`not-packaged` / `explicit-data-dir` / `not-portable` /
   * `persistent-real-dir` / `temp-unpack-dir`。
   */
  reason:
    | 'not-packaged'
    | 'explicit-data-dir'
    | 'not-portable'
    | 'persistent-real-dir'
    | 'temp-unpack-dir'
}

/**
 * 判断 `child` 是否落在 `parent` 之内（含相等）。
 *
 * ★ Windows 路径**大小写不敏感**：`C:\Users\X\AppData\Local\Temp` 与
 *   `c:\users\x\...` 是同一个目录 —— 只按字节比较会让「临时目录识别」在大小写不同的
 *   机器上假阴性（表现为数据又写进临时目录）。
 */
function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(lowercase(parent), lowercase(child))
  if (rel === '') return true
  if (rel.startsWith('..')) return false
  return !isAbsolute(rel)
}

function lowercase(value: string): string {
  // 只在 win32 上折大小写；其它平台路径是大小写敏感的，折了会误判。
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** 路径的最后一段（去尾部分隔符；用于比对已知的临时解压目录名）。 */
function lastSegment(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * 判断某个目录是不是「**一次性**的」（关掉应用就会被删/重建）。
 *
 * 两种形态都覆盖：
 *   - 落在系统临时目录里（单文件便携解压到 `%TEMP%\<unpackDirName>` 就是这一种）；
 *   - 最后一段正好是那个已知的解压目录名（有些环境 `TEMP` 被改到别处，
 *     但目录名是构建时钉死的，按名字兜住）。
 */
function isThrowawayDir(dir: string, tempDir: string, unpackDirName: string): boolean {
  if (isInsideDir(tempDir, dir)) return true
  return lowercase(lastSegment(dir)) === lowercase(unpackDirName)
}

/**
 * 决策：便携形态到底该把 `userData` 指到哪。
 *
 * 判定顺序（每一条都有实测依据，别调换）：
 *   ① 显式 `K12_DATA_DIR`（绝对路径）→ 直接改道到它（与形态无关，优先级最高）；
 *   ② 非打包态 → 不改道（开发态污染源码目录）；
 *   ③ 非便携形态 → 不改道（走默认 `%APPDATA%\<slug>`）；
 *   ④ 候选目录（`PORTABLE_EXECUTABLE_DIR ?? exeDir`）**是持久的** → 改道到 `<候选>/data`；
 *   ⑤ 候选目录是临时的 → **不改道**（退回默认目录，数据不再丢）。
 */
export function decidePortableDataDir(input: PortableDataDirInput): PortableDataDirDecision {
  const unpackDirName = input.unpackDirName ?? PORTABLE_UNPACK_DIR_NAME

  // ① 显式逃生舱最高优先：学生/演示者明确指定了数据放哪，就照办。
  const explicit =
    typeof input.explicitDataDir === 'string' && input.explicitDataDir.trim().length > 0
      ? input.explicitDataDir.trim()
      : null
  if (explicit !== null && isAbsolute(explicit)) {
    return { redirect: true, dataDir: join(explicit, 'data'), reason: 'explicit-data-dir' }
  }

  if (!input.isPackaged) {
    return { redirect: false, dataDir: null, reason: 'not-packaged' }
  }
  if (!input.forced && !input.markerExists) {
    return { redirect: false, dataDir: null, reason: 'not-portable' }
  }

  // ★ 候选优先级：启动器给的真实目录 > exe 自己所在的目录。
  //   前者在单文件形态下才可能拿到；后者在 zip 绿色形态下就是用户的解压位置。
  const candidate =
    input.portableExecutableDir !== null && input.portableExecutableDir.trim().length > 0
      ? input.portableExecutableDir
      : input.exeDir

  if (isThrowawayDir(candidate, input.tempDir, unpackDirName)) {
    // 单文件形态、且拿不到真实目录：宁可不改道，也不把数据写进会被删掉的临时目录。
    return { redirect: false, dataDir: null, reason: 'temp-unpack-dir' }
  }

  return { redirect: true, dataDir: join(candidate, 'data'), reason: 'persistent-real-dir' }
}

/** 分隔符统一（Windows 反斜杠）—— 仅供日志与断言拼路径时用。 */
export function normalizeSeparators(value: string): string {
  return sep === '/' ? value : value.replace(/\//g, sep)
}
