/**
 * 与后端冻结契约（`server/app/contracts.py`）对齐的前端类型。
 *
 * 约定：
 *  - 后端 Python 侧写 snake_case，出参经 pydantic alias 转 camelCase；此处**一律 camelCase**。
 *  - 这里是**手写的对照镜像**，用于原型阶段。接线时须替换为
 *    `openapi-typescript` 由 OpenAPI 生成物（票 04 的防漂移链），不要长期维护两份。
 *  - 字段名与后端逐字对齐，不做「前端友好」改名，避免接线时对不上。
 *
 * ⚠️ 已知契约内部不一致（已记录，待确认）：
 *   `contracts.py` 的 `ChatRequest` 仍带 `grade_level: GradeLevel`，但其 docstring 与
 *   AGENTS.md §5.1 都声明「请求不带学段」。两者矛盾，本原型按「请求不带学段」执行。
 */

/* ── 冻结字面量 ───────────────────────────────────────────────────────── */

/** 学段。⚠️ 后端用下划线（`primary_low`），画布 CSS 轴用连字符（`primary-low`），两套都要保留 */
export type GradeLevel = 'primary_low' | 'primary_high' | 'junior' | 'senior'

/** 6 事件词表（**冻结**，改动需同步 Python / preload / 守卫测试） */
export type IpcEventName = 'delta' | 'citation' | 'payload' | 'blocked' | 'done' | 'error'

/** `payload` 事件的三类载荷 */
export type PayloadKind = 'animation' | 'coding' | 'quiz'

/** 检索四级降级链档位 */
export type Degraded = 'vector' | 'cloud' | 'fts' | 'outline'

/** 学习活动类型 */
export type LearningActivity = 'qa' | 'animation' | 'coding' | 'quiz'

/** 闯关阶段 */
export type ProgressStage = 'locked' | 'learning' | 'quizzed' | 'mastered'

/** 题型：第一期只做三种 */
export type QuizQuestionType = 'choice' | 'blank' | 'code_blank'

/** 依赖关系类型 */
export type DepRelation = 'prerequisite' | 'related'

/** 依赖方向：`prerequisite` = 查前置，`successor` = 查后继 */
export type DepDirection = 'successor' | 'prerequisite'

/** 学段判定信号四类 */
export type GradeSignalType = 'vocab' | 'depth' | 'quiz_perf' | 'meta_cognition'

/** 掌握度单次变化限幅（与后端 MASTERY_DELTA_LIMIT 一致） */
export const MASTERY_DELTA_LIMIT = 0.2

/* ── 对话与检索 ───────────────────────────────────────────────────────── */

/** 检索引用条目（`citation` 事件的 5 个投影字段，**顺序冻结**） */
export interface Citation {
  chunkId: string
  chapterTitle: string
  sectionTitle: string
  gradeLevel: GradeLevel
  /** 是否跨学段向上兼容命中 */
  compat: boolean
}

/** 检索命中（比 Citation 多出正文与评分，用于右栏检索卡） */
export interface RagHit extends Citation {
  parentChunkId?: string | null
  text?: string
  knowledgePoint?: string
  kpId?: string
  score?: number
  degraded?: Degraded
  expanded?: boolean
}

/* ── 掌握度与画像 ─────────────────────────────────────────────────────── */

export interface Mastery {
  kpId: string
  /** 0.0 – 1.0 */
  score: number
  attempts: number
  correct: number
  lastSeenAt?: number | null
}

export interface Student {
  studentId: string
  nickname: string
  gradeLevel: GradeLevel
  createdAt: number
  lastActiveAt: number
}

export interface StudentProfile {
  student: Student
  mastery: Mastery[]
  preferences: Record<string, string>
  recommendedKpIds: string[]
}

/* ── 学段推断（只读指示器用）────────────────────────────────────────── */

export interface GradeSignal {
  signalType: GradeSignalType
  value: number
  raw?: string | null
  ts?: number | null
}

export interface GradeSignals {
  studentId: string
  currentLevel: GradeLevel
  /** 恒为 inferred —— 唯一写路径是服务端推断 */
  source: 'inferred'
  suggestedLevel?: GradeLevel | null
  confidence: number
  signals: GradeSignal[]
}

/* ── 六个 Extension 的载荷 ───────────────────────────────────────────── */

export interface AnimationPayload {
  concept: string
  /** 沙箱 iframe 用的完整自包含 HTML（模板内不得内联 CDN） */
  html: string
  durationMs: number
  fallbackText: string
  fallbackImage?: string | null
  source: 'template' | 'generated'
}

export interface CodeTemplate {
  kpId: string
  language: 'python'
  scaffold: string
  expectedBehavior: string
}

export interface CodingHint {
  level: 1 | 2 | 3
  hint: string
}

export interface CodeError {
  type: string
  message: string
  rawTraceback?: string
  line?: number | null
}

export interface CodeEvaluation {
  ok: boolean
  stdout: string
  error?: CodeError | null
  feedback: string
  nextHint?: CodingHint | null
}

/** ⚠️ 对外题：**没有 `answer`**（§6.3 答案泄漏防护，判分只走后端） */
export interface QuizQuestionOut {
  qid: string
  kpId: string
  type: QuizQuestionType
  stem: string
  options?: string[] | null
  explanation: string
}

export interface QuizPayload {
  kpId: string
  questions: QuizQuestionOut[]
  source: 'bank' | 'generated'
}

export interface QuizResult {
  qid: string
  correct: boolean
  scoredBy: 'rule' | 'llm'
  feedback: string
  /** 限幅 ±0.2 */
  masteryDelta: number
}

/* ── 知识点依赖（依赖图谱页用）──────────────────────────────────────── */

export interface DepNode {
  kpId: string
  name: string
  gradeLevel: GradeLevel
  relation: DepRelation
  direction: DepDirection
  weight: number
  depth: number
}

/* ── 设置 ─────────────────────────────────────────────────────────────── */

export interface LlmConfig {
  providerName: string
  baseUrl: string
  hasKey: boolean
  modelId: string
}

export type EmbeddingMode = 'local_fastembed' | 'cloud_api' | 'none'

export interface EmbeddingConfig {
  mode: EmbeddingMode
  baseUrl?: string | null
  hasKey: boolean
  modelId?: string | null
}

export interface SettingsResponse {
  llm: LlmConfig
  embedding: EmbeddingConfig
}

/* ── 工具调用轨迹（票 08 产出，服务 25% 设计分）────────────────────── */

/** 与 `tool_execution_start` / `tool_execution_end` 对齐的一行轨迹 */
export interface ToolTraceEntry {
  turn: number
  toolName: string
  /** 参数摘要（不含 Key 等敏感值） */
  argsSummary: string
  ok: boolean
  latencyMs: number
  degraded?: Degraded | null
}
