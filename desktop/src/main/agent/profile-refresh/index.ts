/**
 * profile-refresh 模块的**唯一入口**（持续画像迭代）。
 *
 * ★ 与 onboarding / index.ts 同一条纪律：实现分住在各文件（纯函数，便于逐条断言），
 *   这里只是转发 —— 加一层 barrel 的理由只有一个：**调用方只需要看一个文件**。
 *
 * ## 一期交付（无 LLM）
 *
 * - {@link noteTurn} / {@link shouldRefresh} / {@link markRefreshed} / {@link calibrateTurn}
 *   —— 「什么时候跑」（`turn-clock.ts`）；
 * - {@link pushTurn} / {@link recentTurns} —— 「跑的时候看哪几轮」（`transcript-window.ts`）。
 *
 * ## 二期交付（接上概括）
 *
 * - {@link buildRefreshPayload} / {@link parseRefreshTags} —— 「发什么、收什么」（`payload.ts`）；
 * - {@link runRefresh} —— 「什么时候、把什么、发给谁、写到哪」（`refresh.ts`）。
 */

export {
  calibrateTurn,
  currentTurn,
  isMeaningful,
  markRefreshed,
  noteTurn,
  resetAllTurnClocks,
  resetTurnClock,
  shouldRefresh,
  MIN_MEANINGFUL_TURN_CHARS,
  PROFILE_REFRESH_EVERY_TURNS
} from './turn-clock.ts'

export {
  clearAllTranscriptWindows,
  clearTranscriptWindow,
  pushTurn,
  recentTurns,
  turnWindowSize,
  PROFILE_REFRESH_WINDOW_TURNS
} from './transcript-window.ts'
export type { TranscriptTurn } from './transcript-window.ts'

// ★ 二期：载荷与解析（纯函数）
export {
  buildRefreshPayload,
  parseRefreshTags,
  REFRESH_ALLOWED_KEYS,
  REFRESH_INFERRED_KEYS,
  REFRESH_MAX_TAGS,
  REFRESH_MSG_MAX_CHARS,
  REFRESH_MAX_VALUE_CHARS,
  REFRESH_DEFAULT_CONFIDENCE
} from './payload.ts'
export type { RefreshPayload, RefreshPayloadInput, RefreshTagWrite } from './payload.ts'

// ★ 二期：编排（把载荷 → 模型 → 后端串成一条链）
export {
  applyRefreshTagsFromSidecar,
  readKnownTagsFromSidecar,
  profileRefreshApplyPath,
  runRefresh,
  REFRESH_TIMEOUT_MS,
  REFRESH_MAX_ATTEMPTS,
  REFRESH_MAX_TOKENS,
  REFRESH_APPLY_TIMEOUT_MS
} from './refresh.ts'
export type { RefreshApplyOutcome, RefreshDeps, RefreshKnownTag, RefreshRunResult } from './refresh.ts'

// ★ 三期（2026-09-30）：AI 小结（画像变更后生成 + 本地缓存；渲染层只读缓存）
export {
  buildSummaryLinePayload,
  generateSummaryLine,
  parseSummaryLine,
  readSummaryLineCache,
  summaryCachePath,
  tagFingerprint,
  writeSummaryLineCache,
  SUMMARY_LINE_FORBIDDEN_WORDS,
  SUMMARY_LINE_MAX_ATTEMPTS,
  SUMMARY_LINE_MAX_CHARS,
  SUMMARY_LINE_MAX_TOKENS,
  SUMMARY_LINE_MIN_CHARS,
  SUMMARY_LINE_TECH_WORDS,
  SUMMARY_LINE_TIMEOUT_MS
} from './summary-line.ts'
export type {
  SummaryLineCacheEntry,
  SummaryLineDeps,
  SummaryLineInput,
  SummaryLinePayload
} from './summary-line.ts'
