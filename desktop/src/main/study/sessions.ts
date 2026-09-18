/**
 * 历史会话的**只读**读取（会话列表 + 单条会话正文）。
 *
 * ---------------------------------------------------------------------------
 * 为什么是「只读」，以及它为什么不能做成「打开会话继续聊」
 * ---------------------------------------------------------------------------
 * Pi 的 `SessionManager` 提供 `open` / `continueRecent`，把历史会话接回对话页在能力上可行，
 * 但那是**另一件事**：切会话要 dispose 当前 runtime（否则 JSONL 半写）、
 * 要把 `SessionEntry[]` 投影成前端的 turns、还要处理「装配期间被 dispose」的代际竞态。
 * 本轮只做「**看**」：`list()` 列出来、`open()` 读出来、投影成一段可读文本。
 * 继续对话留给后续（见 `architecture/pending/03-会话保存与恢复.md`）。
 *
 * ---------------------------------------------------------------------------
 * ★★ 两条安全约束（这两条不满足就是漏洞，不是「待优化」）
 * ---------------------------------------------------------------------------
 * 1. **只接受会话 id，绝不接受路径**。渲染进程递进来的东西一律先与
 *    `SessionManager.list()` 的结果**对齐**（在白名单里才认），再用**Pi 自己给的 `path`**
 *    去打开。若直接 `open(前端给的路径)`，渲染进程就等于拿到了「读任意文件」的能力
 *    （`..\\..\\config.json` 这类）。这是本模块存在的**首要理由**。
 * 2. **会话目录必须显式指向该学生**（`resolveStudentPiPaths(...).sessionDir`）。
 *    Pi 的默认目录是 `~/.pi/agent/sessions/`，漏传第二个参数会静默读到**用户自己 Pi CLI 的会话**
 *    —— 既是隐私问题，也让「跨学生隔离」失效（`pi-paths.ts` 的断言守的就是这条）。
 *
 * 纯函数与「需要 Pi」的部分**分开**：投影、切片、搜索都是纯函数（可在 `node --test` 里跑），
 * 只有 `listSessions` / `readTranscript` 需要真的去问 Pi。
 */

import type { SessionInfo } from '@earendil-works/pi-coding-agent'

/** 会话列表里的一项（**给界面看的投影**，不是 Pi 的原始 `SessionInfo`）。 */
export interface SessionSummary {
  /** ★ 恢复/读取时只认它（**不是** path：path 绝不进渲染进程） */
  id: string
  /** 标题：优先 Pi 的 `name`，否则取首条消息截断 */
  title: string
  /** 消息条数 */
  messageCount: number
  /** 最后修改时间（Unix 毫秒） */
  modifiedAt: number
  /** 创建时间（Unix 毫秒） */
  createdAt: number
  /** 首条消息的预览（可能为空：会话刚建、还没说话） */
  preview: string
}

/** 一条会话消息（投影后的形态，渲染进程直接渲染）。 */
export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  /** Unix 毫秒（来自 entry 的 timestamp） */
  at: number
}

/** 一条会话的正文（只读回看用）。 */
export interface SessionTranscript {
  id: string
  title: string
  messages: TranscriptMessage[]
  /** 被截断掉的消息条数（超过上限时 > 0；界面据此提示「只显示最近 N 条」） */
  truncated: number
}

/** 单条会话最多回传的消息数（防一个超长会话把 IPC 载荷撑爆）。 */
export const MAX_TRANSCRIPT_MESSAGES = 200

/** 标题/预览的截断长度（**按字符**，不是字节 —— 按字节会把汉字切成半个）。 */
export const TITLE_MAX_CHARS = 24
const PREVIEW_MAX_CHARS = 80

/**
 * 按**字符**截断（不按字节）。
 *
 * ★ 用 `Array.from` 而不是 `slice`：`'😀'.length === 2`，直接 `slice` 会把代理对
 *   劈成两半，界面上显示成 ``。汉字虽然只在 BMP 里（一个 code unit），
 *   但学生的会话里完全可能出现 emoji。
 */
export function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, maxChars).join('')}…`
}

/**
 * 把 Pi 的 `SessionInfo[]` 投影成界面用的摘要列表（**纯函数**）。
 *
 * 排序：**最后修改时间倒序**（最近用过的在最上面）。平局按 id 兜底 ——
 * 否则同一毫秒的两条会话顺序会随 Pi 的返回顺序漂，列表每次刷新都在跳。
 */
export function projectSessionList(infos: SessionInfo[]): SessionSummary[] {
  return infos
    .map((info) => ({
      id: info.id,
      // ★ 标题优先取 Pi 的 name（会话命名功能写入的），否则退回首条消息。
      //   两者都没有就显示一句占位，**不要**把 path 当标题（那会把宿主目录结构带到界面上）。
      title: truncateChars(
        (info.name || info.firstMessage || '').replace(/\s+/g, ' ').trim() || '（空会话）',
        TITLE_MAX_CHARS
      ),
      messageCount: info.messageCount,
      modifiedAt: toMs(info.modified),
      createdAt: toMs(info.created),
      preview: truncateChars((info.firstMessage || '').replace(/\s+/g, ' ').trim(), PREVIEW_MAX_CHARS)
    }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
}

/** `Date` → Unix 毫秒（非法日期回 0，不抛）。 */
export function toMs(value: Date | string | number | undefined): number {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

/**
 * 把一段**纯文本**投影成标题（导出的文件名等场合用；纯函数）。
 *
 * 这里刻意不做字符截断之外的任何处理：不翻译、不补标点 —— 标题应当就是学生自己说的话。
 */
export function titleFromText(text: string, maxChars = TITLE_MAX_CHARS): string {
  return truncateChars(text.replace(/\s+/g, ' ').trim() || '未命名', maxChars)
}

/** Pi 的一条 session entry 里我们关心的字段（**结构检查**用，不 import Pi 的类型）。 */
interface RawEntry {
  type?: unknown
  timestamp?: unknown
  message?: { role?: unknown; content?: unknown }
}

/**
 * 把 Pi 的会话条目投影成可显示的问答（**纯函数**，不碰文件系统）。
 *
 * Pi 的 `getEntries()` 返回的是一串**条目**（`message` / `model_change` /
 * `thinking_level_change` / `custom_message` …），而不是「一问一答」。
 * 这里只挑 `type === 'message'` 且角色是 user/assistant 的，把 content 里的
 * **文本块**抽出来拼成正文。
 *
 * ★ **为什么只取 text 块**：assistant 的 content 里还有 `thinking`（思考）与
 *   `toolCall`（工具调用）两种块。思考过程是模型内部推理，工具参数可能含题干/答案；
 *   回看历史对话**不需要**它们，且把它们显示出来会泄漏不该给学生看的内容。
 *
 * @param entries Pi 的条目数组（`unknown[]`：这里做结构检查，不信任任何字段）
 * @param limit 最多回传多少条（超出部分丢弃，返回 `truncated` 计数）
 */
export function projectTranscript(
  entries: unknown[],
  options: { limit?: number } = {}
): { messages: TranscriptMessage[]; truncated: number } {
  const limit = options.limit ?? MAX_TRANSCRIPT_MESSAGES
  const messages: TranscriptMessage[] = []
  for (const entry of entries) {
    const projected = projectEntry(entry)
    if (projected) messages.push(projected)
  }
  if (messages.length <= limit) return { messages, truncated: 0 }
  // ★ 保留**最近**的 limit 条（学生回看通常关心最后聊了什么）
  return { messages: messages.slice(messages.length - limit), truncated: messages.length - limit }
}

/** 单条 entry → 一条可显示消息（认不出返回 `null`）。 */
function projectEntry(entry: unknown): TranscriptMessage | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as RawEntry
  if (raw.type !== 'message') return null
  const message = raw.message
  if (typeof message !== 'object' || message === null) return null
  const role = message.role
  if (role !== 'user' && role !== 'assistant') return null
  const text = extractText(message.content)
  if (!text) return null
  return { role, text, at: toMs(typeof raw.timestamp === 'string' ? raw.timestamp : undefined) }
}

/** 从 message.content 里抽纯文本（字符串直取；数组只取 `type === 'text'` 的块）。 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n').trim()
}

/**
 * 在会话列表里按 id 找一条（**白名单对齐**，纯函数）。
 *
 * ★ 这是「只接受 id」那条安全约束的落点：`readTranscript` 拿到 id 后**必须**先过这里，
 *   拿到的 `path` 由 Pi 提供（而不是前端给的字符串）。
 */
export function findSessionById(infos: SessionInfo[], id: string): SessionInfo | null {
  return infos.find((info) => info.id === id) ?? null
}

/**
 * 会话搜索（**纯函数**）：在标题与全文里找关键词。
 *
 * `allMessagesText` 是 Pi 已经提供的全文字段（无需我们遍历 JSONL），
 * 这里只做匹配与片段提取。
 *
 * ★ 返回**片段**而不是整段全文：命中的位置前后各取一段（像 grep 的上下文），
 *   否则一个长会话会把整篇正文塞进搜索结果里。
 */
export interface SessionSearchHit {
  id: string
  title: string
  /** 命中处周围的片段（已截断） */
  snippet: string
  modifiedAt: number
}

/** 片段长度上限（命中位置前后各取多少字符）。 */
export const SNIPPET_CONTEXT_CHARS = 30

export function searchSessions(
  infos: SessionInfo[],
  query: string,
  options: { limit?: number } = {}
): SessionSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const limit = options.limit ?? 20
  const hits: SessionSearchHit[] = []
  for (const info of infos) {
    const haystack = `${info.name ?? ''}\n${info.allMessagesText ?? ''}`
    const at = haystack.toLowerCase().indexOf(needle)
    if (at < 0) continue
    hits.push({
      id: info.id,
      title: truncateChars((info.name || info.firstMessage || '（空会话）').trim(), TITLE_MAX_CHARS),
      snippet: snippetAround(haystack, at, needle.length),
      modifiedAt: toMs(info.modified)
    })
  }
  return hits.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)).slice(0, limit)
}

/** 抽命中处前后的片段（把换行压成空格，便于单行显示）。 */
function snippetAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - SNIPPET_CONTEXT_CHARS)
  const end = Math.min(text.length, at + length + SNIPPET_CONTEXT_CHARS)
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim()
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${slice}${suffix}`
}

/* ------------------------------------------------------------------ *
 * 需要真的去问 Pi 的两个函数（**本文件里唯一碰文件系统/Pi 的地方**）
 *
 * ★ 为什么用动态 import：`@earendil-works/pi-coding-agent` 从包根导入会 evaluate CLI 的
 *   `main.js`（拖入 esbuild，见 AGENTS §8.2）。虽然主进程本来就会加载 Pi，
 *   但这两个函数**只属于「学习档案」这一条支线** —— 推迟到真的点开会话列表那一刻，
 *   能让「应用启动 → 对话」这条主路径完全不依赖这条支线（也让纯函数测试不必加载 Pi）。
 *   与 `extensions/profile.ts` 的调用点动态 import 同一手法。
 * ------------------------------------------------------------------ */

/**
 * 列出某学生的历史会话（**只读**）。
 *
 * ★ `sessionDir` **必须显式传**（第二个参数）：漏传的话 Pi 会静默退回
 *   `~/.pi/agent/sessions/--<cwd>--/` —— 那是**用户自己 Pi CLI 的目录**，
 *   既读到了不该读的东西，也让跨学生隔离失效。这里用 `resolveStudentPiPaths`
 *   拼出该学生自己的目录（与其他地方共用同一个拼装点，守卫 G9-6c 会扫「别处手写 students 目录」）。
 */
export async function listStudentSessions(
  userDataDir: string,
  studentId: string
): Promise<SessionInfo[]> {
  const { resolveStudentPiPaths } = await import('../agent/pi-paths.ts')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const paths = resolveStudentPiPaths(userDataDir, studentId)
  // cwd 用学生目录：Pi 的 `list(cwd, sessionDir)` 第一个参数只用于推导默认目录，
  // 第二个参数给了就以它为准（这里两个都指到该学生，语义上不留歧义）。
  return await SessionManager.list(paths.studentDir, paths.sessionDir)
}

/**
 * 按**白名单里的那条 `SessionInfo`** 读出它的条目（**只读**）。
 *
 * ★★ `info.path` 必须来自 `listStudentSessions()` 的返回（见文件头安全约束 1）：
 *   渲染进程只能给 id，path 由 Pi 提供。这一点由调用方（`handlers.ts`）保证 ——
 *   它先 `findSessionById` 对齐白名单，再把 `info` 传进来。
 * ★ 这里再**复核一次**路径确实落在该学生的会话目录内：单靠调用方守规矩不够，
 *   这个函数自己也要能挡住「有人直接在别处传了个路径进来」。
 */
export async function readStudentSessionEntries(
  userDataDir: string,
  studentId: string,
  info: { path: string }
): Promise<unknown[]> {
  const { isInside, resolveStudentPiPaths } = await import('../agent/pi-paths.ts')
  const { SessionManager } = await import('@earendil-works/pi-coding-agent')
  const paths = resolveStudentPiPaths(userDataDir, studentId)
  if (!isInside(paths.sessionDir, info.path)) {
    throw new Error(
      `拒绝读取学生会话目录之外的文件（${info.path} 不在 ${paths.sessionDir} 内）`
    )
  }
  const manager = SessionManager.open(info.path, paths.sessionDir, paths.studentDir)
  return manager.getEntries()
}
