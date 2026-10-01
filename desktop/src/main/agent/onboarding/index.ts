/**
 * onboarding 模块的**唯一入口**（票 25 主进程半）。
 *
 * ★★ 契约书 §4 的四个符号从这里出去（C 只 import 这个文件就够）：
 *   isOnboardingActive()          —— grade.ts 的 systemPromptFor() 切引导模式
 *   buildOnboardingSystemPrompt() —— 引导模式整份 prompt
 *   onboardingGuardNotes()        —— 引导模式下关掉了哪三块
 *   onboardingService             —— { start(); answer(); dispose(); snapshot() }
 *
 * ⚠️ 这里只是**转发**，不重写任何实现 —— 实现分住在 state / sanitize / extract / prompt /
 *   summarize / summarize-llm / service 七个文件里，各自是纯函数或单一职责（便于逐条断言）。
 *   加一层 barrel 的理由只有一个：**签名对不上是两个文件的错，而 C 只需要看一个文件。**
 */

export { isOnboardingActive, onboardingService, createOnboardingService } from './service.ts'
export type { OnboardingDeps, OnboardingService, OnboardingSnapshot, OnboardingTransport } from './service.ts'
// ★ 四个 profile / identity 出口也经 barrel 出去：IPC 层只 import 这一个文件，
//   免得「通道在处理器的文件、端点在另一个文件」这种两处对齐的活儿落到调用方头上。
export {
  defaultRequestJson,
  fetchIdentity,
  fetchProfileTags,
  fetchProfileTimeline,
  profileIdentityFlagsPath,
  profileIdentityPath,
  profileTagPath,
  profileTagsPath,
  readIdentityPayload,
  readProfileTagsPayload,
  retractProfileTag,
  saveIdentityFlags,
  ONBOARDING_FLUSH_TIMEOUT_MS,
  ONBOARDING_REQUEST_TIMEOUT_MS,
  onboardingAnswerPath,
  onboardingStatePath
} from './service.ts'

export { buildOnboardingSystemPrompt, onboardingGuardNotes, ONBOARDING_MODE_HEADING, ONBOARDING_DISABLED_SECTIONS } from './prompt.ts'
export type { OnboardingPromptInput, OnboardingDisabledSection } from './prompt.ts'

export {
  initialProgress,
  isFinished,
  isGuidedState,
  nextQuestionId,
  readQuestionId,
  recordAnswer,
  selectProgress,
  shouldStartOnboarding
} from './state.ts'

export {
  extractAnswer,
  gradeLevelFromText,
  normalizeEmotion,
  normalizeIntensity,
  onboardingQuestionText,
  subjectsFromText,
  tagsFromSignals,
  EXPLAIN_CHIP_TAGS,
  GRADE_CHIP_MAP,
  PACE_CHIP_MAP,
  SUBJECT_KEYWORDS
} from './extract.ts'

export {
  firstPiiPattern,
  isFallbackName,
  safeDisplayName,
  sanitizeStudentText,
  MAX_ONBOARDING_ANSWER_CHARS,
  PII_PATTERNS
} from './sanitize.ts'

export {
  createDegradedSummarizer,
  createFailingSummarizer,
  createStaticSummarizer,
  ONBOARDING_SUMMARY_DEFERRED_REASON,
  ONBOARDING_SUMMARY_MAX_ATTEMPTS,
  ONBOARDING_SUMMARY_TIMEOUT_MS
} from './summarize.ts'
export type { OnboardingSummarizer, OnboardingSummaryInput, OnboardingSummaryOutcome } from './summarize.ts'

// ★ 票 31：概括的**真实现**（生产由 ipc/handlers.ts 注入 refreshRuntimeLlmConfig）
export {
  buildSummaryPayload,
  chatCompletionsUrl,
  chatCompletionsVariantUrl,
  createLlmSummarizer,
  parseSummaryTags,
  summaryQuestionText,
  ONBOARDING_SUMMARY_ALLOWED_KEYS,
  ONBOARDING_SUMMARY_MAX_TAGS
} from './summarize-llm.ts'
export type { LlmConfigProvider, LlmSummarizerConfig, SummaryResponseFetch } from './summarize-llm.ts'

export type {
  GradeLevelLiteral,
  OnboardingExtraction,
  OnboardingGates,
  OnboardingProgress,
  OnboardingTagWrite,
  SanitizeOutcome,
  TagSource
} from './types.ts'
export { GRADE_LEVELS } from './types.ts'
export type { LlmVisibleTag, OnboardingQuestionId, OnboardingState } from './types.ts'
