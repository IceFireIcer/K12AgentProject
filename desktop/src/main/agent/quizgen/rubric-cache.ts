/**
 * 主观题评分细则（rubric）的**主进程缓存**。
 *
 * ★★ 为什么必须有这个文件（真机验收发现计划漏掉的一环）：练习页的生成题里带 `rubric`
 *    的是**主观题**，后端 `POST /api/quiz/grade` 对它一律 **409**
 *    （「必须走 POST /api/quiz/grade-subjective」）；而渲染层拿不到 rubric ——
 *    `GET /api/quiz/generated/{id}` 是投影后的（无 rubric / 无答案），后端也没有
 *    「读单题」端点。**登记的那一刻是唯一能拿到 rubric 的时机**，所以在这里留一份，
 *    判分遇 409 时用它走模型判分。契约与后端零改动（计划 §5.1）。
 *
 * ★ 只存 `qid` / `stem` / `rubric`：**绝不存答案**。
 *   `stem` 是判分 Prompt 要用的（`buildSubjectiveGradingPrompt` 要题干）。
 *
 * ★ 落盘 `<userData>/quiz-rubrics.json`，**原子写**（先写 `.tmp` 再 `renameSync`，
 *   与 `accounts.json` 同一手法）：覆写中途崩掉会留下半截 JSON，那会把此前所有题的
 *   细则一起丢掉 —— 表现是「以前出过的题突然全判不了了」。
 * ★ 读失败 / 文件坏 / 不在 Electron 宿主（纯 node 单测）→ 内存表照常工作、**不抛**：
 *   判分失败要可读（回到「没留下评分要点」那句），不是崩。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** 落盘文件名（与 `accounts.json` 同目录、不同文件）。 */
export const RUBRIC_CACHE_FILE_NAME = 'quiz-rubrics.json'

/** 每人最多留多少条（一次生成 ≤10 条；上限只为防文件无限长大）。 */
const MAX_ENTRIES_PER_STUDENT = 300
const MAX_QID_CHARS = 128
const MAX_STEM_CHARS = 2000
const MAX_RUBRIC_CHARS = 2000

interface RubricEntry {
  rubric: string
  stem: string
}

/** 学生 id → qid → 那一题的细则（对象键顺序 = 写入顺序，裁剪时丢最早的）。 */
type RubricTable = Record<string, Record<string, RubricEntry>>

/** 进程内表（懒加载一次；null = 还没读过盘）。 */
let table: RubricTable | null = null
/** 已解析的落盘路径；`undefined` = 还没解析过，`null` = 这个环境不落盘（只用内存表）。 */
let cachePath: string | null | undefined

/**
 * 解析 `<userData>/quiz-rubrics.json` 的路径。
 *
 * ★ 用 `createRequire(import.meta.url)` 取 Electron 的 `app`（主进程产物是 ESM，
 *   没有裸 `require`；而静态 `import { app } from 'electron'` 会让纯 node 单测
 *   加载本模块时直接语法错 —— handlers-data.ts 的文件头有同一条纪律）。
 * ★ 拿不到（纯 node / 非 Electron）返回 null：**不落盘，只用内存表**。
 */
function resolveCachePath(): string | null {
  if (cachePath !== undefined) return cachePath
  let resolved: string | null = null
  try {
    const require_ = createRequire(import.meta.url)
    const electron = require_('electron') as { app?: { getPath?: (name: string) => string } }
    const dir = electron?.app?.getPath?.('userData')
    if (typeof dir === 'string' && dir.length > 0) resolved = join(dir, RUBRIC_CACHE_FILE_NAME)
  } catch {
    resolved = null
  }
  cachePath = resolved
  return resolved
}

/** 读一条（只认 rubric 非空；字段一律截断，别让一份畸形文件把内存撑爆）。 */
function readEntry(value: unknown): RubricEntry | null {
  if (!value || typeof value !== 'object') return null
  const record = value as { rubric?: unknown; stem?: unknown }
  const rubric = typeof record.rubric === 'string' ? record.rubric.trim() : ''
  if (rubric === '') return null
  const stem = typeof record.stem === 'string' ? record.stem : ''
  return { rubric: rubric.slice(0, MAX_RUBRIC_CHARS), stem: stem.slice(0, MAX_STEM_CHARS) }
}

/** 懒加载落盘的那一份（失败当空表）。 */
function loadTable(): RubricTable {
  if (table !== null) return table
  table = {}
  const path = resolveCachePath()
  if (path === null) return table
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object') return table
    for (const [studentId, entries] of Object.entries(parsed as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object') continue
      const kept: Record<string, RubricEntry> = {}
      for (const [qid, value] of Object.entries(entries as Record<string, unknown>)) {
        const entry = readEntry(value)
        if (entry !== null) kept[qid] = entry
      }
      table[studentId] = kept
    }
  } catch {
    // 文件坏 / 读不到：当作空表（判分回到「没留下评分要点」那句可读提示）
    table = {}
  }
  return table
}

/** 原子落盘（失败不影响本次判分：内存表还在，只是重启后这份细则用不了）。 */
function persist(): void {
  const path = resolveCachePath()
  if (path === null || table === null) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temp = path + '.tmp'
    writeFileSync(temp, JSON.stringify(table), 'utf8')
    renameSync(temp, path)
  } catch {
    // 落盘失败不是判分失败：本次仍用内存表
  }
}

/**
 * 记住这一批题里**带 rubric 的那些**（登记成功后由出题服务调用）。
 *
 * @param studentId 归属学生（主进程解析出来的，不是渲染层递的）
 * @param questions 登记用的题目（`prepareVariants` 的 products，含 rubric/stem/qid）
 */
export function rememberRubrics(
  studentId: string,
  questions: ReadonlyArray<{ qid?: unknown; stem?: unknown; rubric?: unknown }>
): void {
  if (typeof studentId !== 'string' || studentId === '') return
  const current = loadTable()
  const forStudent = current[studentId] ?? {}
  let changed = false
  for (const question of questions) {
    const qid =
      typeof question?.qid === 'string' ? question.qid.trim().slice(0, MAX_QID_CHARS) : ''
    if (qid === '') continue
    const entry = readEntry({ rubric: question.rubric, stem: question.stem })
    if (entry === null) continue
    forStudent[qid] = entry
    changed = true
  }
  if (!changed) return
  const qids = Object.keys(forStudent)
  if (qids.length > MAX_ENTRIES_PER_STUDENT) {
    for (const stale of qids.slice(0, qids.length - MAX_ENTRIES_PER_STUDENT)) delete forStudent[stale]
  }
  current[studentId] = forStudent
  persist()
}

/** 取某一题的细则（没有就返回 null —— 调用方据此回一句可读提示，不瞎判）。 */
export function rubricFor(studentId: string, qid: string): { rubric: string; stem: string } | null {
  if (studentId === '' || qid === '') return null
  const entry = loadTable()[studentId]?.[qid]
  return entry ? { rubric: entry.rubric, stem: entry.stem } : null
}
