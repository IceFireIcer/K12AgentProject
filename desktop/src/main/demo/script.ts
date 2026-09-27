/**
 * 演示沙箱的**三轮脚本**（学生原话 / 回答正文 / 引用 / 卡片 / 该轮诊断信封）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条贯穿全文件的判据
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 脚本住在主进程。**
 *   预置载荷带着知识点标识，而渲染进程的**每一个字符串字面量**都会被
 *   `tests/student-view-discipline.test.ts` 的知识点 slug 守卫扫到 ——
 *   写在渲染侧等于为了让演示好看而给守卫开一个洞。所以脚本在这里构建，
 *   经 `demo:script` 按需下发（类型见 `@shared/demo-seed` 的 `DemoScriptPayload`）。
 *
 * **② 内容态一律透传真数据，一个字都不编。**
 *   动画卡的 HTML、编程卡的脚手架与要求、闯关卡的题目，**全部从真实端点取**
 *   （`animation:render` / `code:template` / `quiz:bank`）。理由很简单：
 *   内容态一旦被假掉，演示里就会出现「假题目配假答案」这种一戳就破的东西。
 *   取不到时**不编一份顶上** —— 该降级的降级（动画卡落到既有降级文案、
 *   卡片整张缺席），与真实运行时遇到同样情况时的表现完全一致。
 *
 * **③ 诊断信封里的每一段提示词、每一个机制字段也都走真实模块。**
 *   拼 prompt 用的是真实链路的两个函数（`buildGradeSystemPrompt` + `withStudentContext`），
 *   切段用真实采集器的 `segmentPrompt()`，画像块指纹用真实的 `byteHash()`，
 *   画像块的正文由真实渲染函数（`renderStudentContextBlock()` → `renderProfileText()`）拼出来 ——
 *   见「诊断信封」那一节。**手写一份「看起来像提示词」的概述是最坏的做法**：
 *   界面上展开得像那么回事，与真正发给模型的那份却对不上，肉眼还看不出来。
 *   ⚠️ 同一条纪律对界面另一侧的字段（拦截记录）意味着：**没有真实来源就不填**
 *   —— 宁可空着，也不要一条与其它字段打架的「证据」（见三轮脚本里的说明）。
 *
 * **④ 预置的「历史会话」也要有自己的逐轮信封。**
 *   侧栏那三条会话点开就有正文，而原先**一条信封都没有** —— 运行透视的时间轴上
 *   只有脚本放过的轮次，看起来像这套机制只在当前那一段对话里跑过。
 *   现在三条会话各 3 轮，正文与信封由**同一张表**（{@link DemoHistoryTurn}）生成：
 *   同长度、同顺序、讲同一件事。轮次号在缓冲区里不重复（历史 1..9，脚本 10..12）。
 *
 * ⚠️ 本文件只在主进程加载（它经 `apiFetch` 取数）。**不碰任何落盘路径**：
 *    预置内容从不写盘，进程一退出就没了。
 */

import { apiFetch } from '../bridge/client.ts'
// ★★ 动画渲染只有一处实现（`demo/animation.ts`）：三轮脚本第 1 轮的卡片、预置历史
//    回看时那张卡片、动画库「我的动画」两条，全都从它取同一份真模板产物 ——
//    各写一份取数 + 字段映射的话，它们迟早不是同一份（各自一个 payloadId、各自一次渲染）。
import { renderDemoAnimation } from './animation.ts'
import {
  DEMO_CODE_SESSION_ID,
  DEMO_GRADE_LEVEL,
  DEMO_LOOP_SESSION_ID,
  DEMO_QUIZ_SESSION_ID,
  DEMO_SESSIONS,
  // ★ 画像 / 推荐 / 错题三份预置响应体：诊断信封里的画像块由它们拼出来
  //   （与「学习档案」「右栏推荐」看到的是同一份数据，见 `demoStudentContextBlock()`）。
  demoMistakesBody,
  demoProfileBody,
  demoRecommendationBody
} from './data.ts'
import type { Citation, CitationDetail, Degraded, PayloadKind } from '@shared/ipc-events'
import type {
  DemoHistorySession,
  DemoScriptPayload,
  DemoScriptTurn,
  DemoSeedCard
} from '@shared/demo-seed'
import type {
  DiagInterception,
  DiagRetrieval,
  DiagRetrievalLevel,
  DiagToolCall,
  TurnDiagnostics
} from '@shared/diagnostics'
// ★★ 提示词与诊断字段**全部走真实模块**（这一屏的全部价值是「所见即所发」）：
//   · `segmentPrompt` / `byteHash` / `estimateTokens` = 真实采集器用的同一批算法（见下面那条动态 import）；
//   · `buildGradeSystemPrompt` = 真实学段模板（含五条强制声明）+ 权威段；
//   · `withStudentContext` / `renderStudentContextBlock` = 真实画像块的拼装与渲染；
//   · `findHostPathLeaks` = 真实的上屏前本机路径断言。
//   任何一处改成手写文本，界面上展开的就不再是**真正发给模型的那一份**。
import { buildGradeSystemPrompt } from '../agent/extensions/grade.ts'
import type {
  MistakesResponse,
  ProfileResponse,
  RecommendationResponse
} from '../agent/extensions/profile.ts'
import { findHostPathLeaks } from '../agent/pi-bootstrap.ts'
import { renderStudentContextBlock, withStudentContext } from '../agent/prompts/student-context.ts'

/* ------------------------------------------------------------------ *
 * 诊断模块：**延迟加载**（本文件唯一一处动态 import）
 * ------------------------------------------------------------------ */

/** `agent/diagnostics.ts` 的模块类型（`typeof import(...)` 只是类型，不产生运行时依赖）。 */
type DiagnosticsModule = typeof import('../agent/diagnostics.ts')

/** 加载结果（进程内只加载一次；`buildDemoScript()` 保证在用到之前就装好）。 */
let diagnosticsModule: DiagnosticsModule | null = null

/**
 * 取（并缓存）诊断模块 —— `segmentPrompt` / `byteHash` / `estimateTokens` 三个真实算法都在里面。
 *
 * ★★ 为什么是**动态** import（这一步不是随手写的，换了会同时坏两件事）：
 *   `agent/diagnostics.ts` 在模块顶层 **value-import** 了 `@shared/diagnostics`
 *   （`isTurnDiagnostics` / `DIAGNOSTICS_TURN_LIMIT`），而 `@shared/*` 是打包器的别名
 *   （`electron.vite.config.ts` 的 `resolve.alias`）—— Node 直跑 TS 时解析不了它。
 *   而 `tests/demo-seed.test.ts` 是**静态** import 本文件的：ESM 的链接期在模块体执行之前
 *   就把整张图解析完，那时任何 `registerHooks` 都还没跑（实测过，勾子在链接期不生效）。
 *   推迟到真正构建脚本的那一刻调用，本文件的纯数据路径就还能被 `node --test` 覆盖。
 *   ⚠️ 同一个理由、同一个手法在这个仓库里已有两处先例：
 *     `extensions/profile.ts` 与 `extensions/learning-log.ts` 对 `bridge/client.ts` 的动态 import。
 */
async function loadDiagnostics(): Promise<DiagnosticsModule> {
  diagnosticsModule ??= await import('../agent/diagnostics.ts')
  return diagnosticsModule
}

/* ------------------------------------------------------------------ *
 * 这一轮讲的是哪个知识点
 *
 * ★ 三个都是**真实存在**的初中知识点（`prog-loop-jr` 等来自随包知识库的
 *   第 8 章「编程实践（补充）」）。章节名与知识点名逐字取自真实资产 ——
 *   界面上少一个「未命名知识点」，演示的可信度就少一分。
 * ------------------------------------------------------------------ */

/** 循环（第 2、3 轮的落点：编程卡与闯关卡）。 */
const KP_LOOP = 'prog-loop-jr'
/** 变量（右栏「推荐下一步」与动画库用）。 */
const KP_VARIABLE = 'prog-variable-jr'
/** 列表与字典（第 1 轮那张动画卡讲的正是它；错题本第三题也是它）。 */
const KP_LIST = 'prog-list-jr'

/** 第 8 章的真实章名（`preset-content/quizbank/ch08.json` 的顶层 `chapter`）。 */
const CHAPTER_PROGRAMMING = '第8章 编程实践（补充）'

/**
 * 引用里的教材小节标题。
 *
 * ★ 逐字取自 `server/knowledge-supplement/第八章.编程实践（补充）/8.3列表与字典.md`
 *   的**一级标题** —— 不写「列表」两个字的简称，是因为引用行上要显示的是教材里
 *   真实存在的那一行字。
 */
const SECTION_LIST = '列表与字典：把一批数据放在一起'

/**
 * 循环那一节的教材标题（逐字取自 `server/knowledge/junior/prog-loop-jr.md` 的
 * `knowledge_point`）。
 *
 * ★ 预置历史第 2 轮（「它每次都要从头看一遍吗」）的向量检索没命中，落到关键词那一档，
 *   命中的就是**这一节** —— 那一轮讲「一遍又一遍、什么时候停」，正是循环这一节的内容。
 */
const SECTION_LOOP = '循环：重复的事交给机器'

/**
 * 第 1 轮动画卡**点名**用的随包模板（`server/resources/templates/sorting-bars.json`）。
 *
 * ★★ 为什么是显式给模板 id，而不是只给知识点（渲染端点两条路都支持）：
 *   这一轮的动画换成它是**把 8 份随包模板逐个渲染、在 800×480 的卡片尺寸下
 *   隔几秒各截一张、人眼比出来的**结果（配色最抓眼、柱子一动就看得见在比哪一对、
 *   信息密度与卡片尺寸相称），属于**有意选定的观感**，不是「按知识点自动命中的副产物」。
 *   只给知识点的话，将来随包里多出一份覆盖同一知识点的模板，
 *   `pick_template` 取的是 `exact[0]`（顺序跟着目录里文件名的排序走）——
 *   演示的观感会在没人察觉的时候变掉，而这一轮换模板的全部意义就是观感。
 *   钉住 id 之后，这份模板万一不在了，表现是**诚实的降级**（渲染 404 → 卡片落回
 *   文字要点 + 全屏入口），而不是换一份谁也没看过的动画接着播。
 * ★ 代价是「模板真的覆盖这个知识点」不再由服务端把关（`templateId` 命中时它不做归属校验），
 *   所以那条判据改由 `tests/demo-seed.test.ts` 对着随包资产断言：
 *   这份模板的 `kp_ids` 必须覆盖 {@link KP_LIST}、`grade_levels` 必须含初中。
 *   改这里就要连那条断言一起过。
 */
const ANIMATION_TEMPLATE_ID = 'sorting-bars'

/** 三次请求的超时（本机回环，正常毫秒级；与 `wire/data.ts` 同量级）。 */
const CONTENT_TIMEOUT_MS = 8_000

/* ------------------------------------------------------------------ *
 * 内容态取数（三个资产各自记忆化，取到才缓存）
 *
 * ★★ 为什么「取到才缓存」而不是「一次取完缓存整包」：sidecar 可能还没起来
 *   （演示常常是「应用刚打开就点载入」）。若把失败也缓存住，这一整次运行里
 *   动画永远只剩降级文案 —— 而那本来只是一次启动竞态。
 * ------------------------------------------------------------------ */

let animationCardCache: DemoSeedCard | null = null
let codeCardCache: DemoSeedCard | null = null
let quizCardCache: DemoSeedCard | null = null

/** 发一次读请求并在失败时回 `null`（**不抛**：取不到内容不是异常，是降级）。 */
async function fetchJson(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  try {
    const response = await apiFetch(path, {
      method: init.method ?? 'GET',
      ...(init.body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(CONTENT_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** 读一个字符串字段（认不出回落空串）。 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 第 1 轮那张**动画卡**（真实模板产物）。
 *
 * ★ 渲染走 {@link renderDemoAnimation}（**唯一一处实现**：真实端点
 *   `POST /api/animation/render`）。这一轮讲的是列表（{@link KP_LIST}），
 *   模板**点名**用 {@link ANIMATION_TEMPLATE_ID}（为什么点名、代价是什么，见那个常量上方）。
 * ★ 拿不到时返回的载荷 `html` 为空、只带一句**真实的中文要点** ——
 *   渲染侧的既有降级路径会把它显示成「文字要点 + 一句提示」，绝不白屏。
 *   **不编 HTML** 是硬要求：编出来的动画在沙箱里跑不起来，现场就是一整块空白。
 */
async function buildAnimationCard(): Promise<DemoSeedCard> {
  if (animationCardCache !== null) return animationCardCache
  const payloadId = `demo-${KP_LIST}`
  const rendered = await renderDemoAnimation(KP_LIST, payloadId, ANIMATION_TEMPLATE_ID)
  const card: DemoSeedCard = {
    kind: 'animation',
    payload: {
      // ★ `concept` 与下面那句降级文案都**逐字取自 `sorting-bars` 模板声明的字段**
      //   （`concept` / `fallback_text`），与 `data.ts` 里动画库条目取模板 `concept`
      //   是同一个做法：这里只放真实资产的原话，不另编一段描述。
      //   真的取到渲染产物时，以产物里那两份为准（它们是同一份模板的同一个字段）。
      concept: rendered?.concept || '排序',
      html: rendered?.html ?? '',
      durationMs: rendered?.durationMs || 6000,
      fallbackText:
        rendered?.fallbackText ||
        '排序做的事，是反复比较相邻的两个数：如果左边的比右边的大，就把它们交换过来。一遍走完，最大的数就被推到了最后；再来一遍，第二大的也到了位置。重复「比较 + 交换」直到没有需要交换的，一整排数就排好了。',
      // ★ 模板自带的兜底静态图（自包含 dataURL）照原样带出去：降级时看到的是真实产物那张图。
      fallbackImage: rendered?.fallbackImage ?? null,
      source: 'template',
      // ★ 带着它，卡片才知道「这一段按哪个学段做的」（「按当前学段重画」的判据）
      gradeLevel: DEMO_GRADE_LEVEL,
      // ★ 用**渲染产物的**那把（它从 HTML 里读回来，与沙箱报的那个字字相同）；
      //   取不到时回落成请求里下发的那个 —— 降级载荷本来也不会建 iframe。
      payloadId: rendered?.payloadId ?? payloadId
    }
  }
  // 只有在真的拿到动画时才记住它（见上面的说明）
  if ((rendered?.html ?? '') !== '') animationCardCache = card
  return card
}

/** 第 2 轮那张**编程卡**（真实脚手架 + 真实要求）。 */
async function buildCodingCard(): Promise<DemoSeedCard> {
  if (codeCardCache !== null) return codeCardCache
  const raw = await fetchJson(`/api/code/templates/${encodeURIComponent(KP_LOOP)}?grade_level=${DEMO_GRADE_LEVEL}`)
  const record = (raw ?? {}) as Record<string, unknown>
  const scaffold = text(record.scaffold)
  const card: DemoSeedCard = {
    kind: 'coding',
    payload: {
      kpId: text(record.kpId) || KP_LOOP,
      language: 'python',
      scaffold,
      expectedBehavior: text(record.expectedBehavior)
    }
  }
  if (scaffold !== '') codeCardCache = card
  return card
}

/** 第 3 轮那张**闯关卡**（真实题目的**对外形态**：结构上没有答案）。 */
async function buildQuizCard(): Promise<DemoSeedCard> {
  if (quizCardCache !== null) return quizCardCache
  const raw = await fetchJson(
    `/api/quiz/bank/${encodeURIComponent(KP_LOOP)}?grade_level=${DEMO_GRADE_LEVEL}&count=3`
  )
  const record = (raw ?? {}) as Record<string, unknown>
  const questions = Array.isArray(record.questions) ? record.questions : []
  const card: DemoSeedCard = {
    kind: 'quiz',
    payload: {
      kpId: text(record.kpId) || KP_LOOP,
      source: 'bank',
      questions
    }
  }
  if (questions.length > 0) quizCardCache = card
  return card
}

/* ------------------------------------------------------------------ *
 * 引用（两条教材引用）
 * ------------------------------------------------------------------ */

/**
 * 一条引用的**细节**（右栏「教材原文」抽屉用）。
 *
 * ★ `degraded` 是这一条**在哪一档检索出来的**（`vector` / `cloud` / `fts` / `outline`）：
 *   它必须与信封里那条逐级记录说同一件事 —— 两处不一致正是「信封在撒谎」的样子。
 *   所以它由调用方给（缺省 `vector` = 第 1 级命中），不在这里写死。
 * ★ `text` 是**教材原文的摘要**（节级正文的节选），不是编的话术：
 *   它逐字取自随包知识库第 8 章那一节。
 */
function citationDetail(
  chunkId: string,
  kpId: string,
  body: string,
  score: number,
  degraded: Degraded = 'vector'
): CitationDetail {
  return {
    chunkId,
    text: body,
    score,
    parentChunkId: null,
    degraded,
    kpId,
    expanded: false
  }
}

/** 一条引用（5 个字段，与 `contracts.py` 的 `Citation` 逐字对应）。 */
function textbookCitation(chunkId: string, sectionTitle: string): Citation {
  return {
    chunkId,
    chapterTitle: CHAPTER_PROGRAMMING,
    sectionTitle,
    gradeLevel: DEMO_GRADE_LEVEL,
    compat: false
  }
}

/**
 * 一条引用 + 它的细节（**成对**生成）。
 *
 * ★★ 为什么成对：`citations` 与 `details` 按 `chunkId` 对齐，两处各写一份 chunkId 的话，
 *   抽屉里点开的那条原文迟早挂到另一行引用上（`details` 是可选字段，错了也不报错）。
 */
function citationPair(
  chunkId: string,
  kpId: string,
  sectionTitle: string,
  body: string,
  score: number,
  degraded: Degraded = 'vector'
): { citation: Citation; detail: CitationDetail } {
  return {
    citation: textbookCitation(chunkId, sectionTitle),
    detail: citationDetail(chunkId, kpId, body, score, degraded)
  }
}

/** 第 1 轮的两条引用（列表那一节的前后两块）。 */
function listCitations(): { citations: Citation[]; details: CitationDetail[] } {
  const pairs = [
    citationPair(
      'list-1',
      KP_LIST,
      SECTION_LIST,
      '列表和字典是两种最基本的容器：它们把多个值聚成一个整体，可以用一个名字管理。列表是有序序列，靠位置取用。',
      0.82
    ),
    citationPair(
      'list-2',
      KP_LIST,
      SECTION_LIST,
      '列表把一批数据按顺序排好，字典给每份数据配一个名字，方便按顺序取或按名字查。',
      0.76
    )
  ]
  return { citations: pairs.map((pair) => pair.citation), details: pairs.map((pair) => pair.detail) }
}

/* ------------------------------------------------------------------ *
 * 诊断信封（驾驶舱与机制浮窗的数据底座）
 * ------------------------------------------------------------------ */

/** 一轮信封的输入（各轮不同的那部分观察数据）。 */
interface EnvelopeInput {
  turn: number
  requestId: string
  studentText: string
  at: number
  /**
   * 本轮拼好的 **system prompt**（三轮共用同一份拼装结果，见 {@link demoSystemPrompt}）。
   *
   * ★ 它进信封的 `prompt` 字段（且由 `segmentPrompt()` 现场切段）—— 所以界面
   *   「提示词」那一栏展开的每一段都是**真提示词切出来的**，不是一份概述。
   */
  prompt: string
  /** 画像块正文（第 2、3 轮逐字节相同 —— 演示「前缀字节稳定」这条）。 */
  studentContext: string
  /** 上一轮的画像块字节指纹（第 1 轮没有上一轮 → 空串）。 */
  previousContextHash: string
  tools: DiagToolCall[]
  retrieval: DiagRetrieval | null
  interceptions: DiagInterception[]
  /**
   * 本轮正文的字符数（= 生成侧终审门里攒着的那段正文的长度，见 `safetyFinal.bufferedChars`）。
   *
   * ★ 由 `build()` 现算（取自 {@link DEMO_SCRIPT_TEXT} 这一轮真正放出去的那段话），
   *   不在这里手填一个数：手填的数字迟早与正文长度对不上。
   */
  answerChars: number
  firstTokenMs: number
  totalMs: number
  status: string
  ok: boolean
}

/**
 * 本轮 system prompt 的**真实拼装**（与 `runtime.ts` 的唯一出口 `buildSystemPrompt()` 同源）。
 *
 * 顺序与真实链路一字不差（**不要对调**）：
 *   ① `buildGradeSystemPrompt()` → 目标学段模板（`prompts/junior.ts` 的
 *      `JUNIOR_SYSTEM_PROMPT`：七节，含 §10.5 的五条强制声明）+ **恒追加的学段权威段**；
 *   ② `withStudentContext()` 把画像块插在**权威段之前**（理由见那个函数的注释）。
 *
 * ★ 为什么必须调这两个函数而不是抄一份文本：抄一份等于让演示演一份**不存在的提示词** ——
 *   界面上展开的每一段、每个字符数都与真正发给模型的那份对不上，而这一屏的全部价值
 *   就是「所见即所发」。同理，`segmentPrompt()` 是真实采集链路用的同一把切段器，
 *   所以这里切出来的段与真实运行时切出来的段**同源同算法**。
 *
 * `incoming: undefined` = 真实链路里**建会话**那一次的落点（基座里还没有上一轮的产物）：
 * 拿到的就是「目标模板 + 权威段」，与 `systemPromptOverride` 的产物逐字一致。
 */
function demoSystemPrompt(studentContextBlock: string): string {
  return withStudentContext(
    buildGradeSystemPrompt({ incoming: undefined, inferredGrade: DEMO_GRADE_LEVEL }),
    studentContextBlock
  )
}

/**
 * 画像块的正文 —— 用**真实构建函数**（`renderStudentContextBlock`）拼出来。
 *
 * 三份入参全部取自 `demo/data.ts` 的预置响应体（画像 / 推荐 / 错题），与「学习档案」
 * 与右栏推荐看到的是**同一份数据**：演示里模型拿到的画像，与参观者自己翻到的学习档案
 * 不可能是两个故事。走的是 `fetchStudentContext()` 的同一条路（同一个渲染函数、
 * 同一组默认上限），不是另写一段「给模型看的话」。
 *
 * ⚠️ 昵称「小同」**不在这一段里**，而且不该在：真实画像块由 `renderProfileText()` 渲染，
 *   它的首行是 `学生：<id>（<学段>）`，**不渲染昵称**（未成年人的称呼只走界面）。
 *   想让「小同」出现在提示词里，只能手写一段 —— 那正是这次要删掉的东西。
 * ⚠️ 返回值**只算一次、三轮共用**（见 `buildDemoScript()`）：块里任何一个每轮都会变的字节
 *   （时间戳、计数器、随机键序）都会同时毁掉「前缀字节稳定」这条证据与演示的可信度。
 */
function demoStudentContextBlock(): string {
  return renderStudentContextBlock(
    demoProfileBody() as unknown as ProfileResponse,
    {
      recommendation: demoRecommendationBody() as unknown as RecommendationResponse,
      mistakes: demoMistakesBody() as unknown as MistakesResponse
    }
  )
}

/**
 * 组装一份信封（字段与 `TurnDiagnostics` 逐字对应）。
 *
 * `diagnostics` 是延迟加载的真实诊断模块（见 {@link loadDiagnostics}）：切段、指纹、
 * token 估算三件事都用**它导出的那几个函数**，不在这里重写一份。
 */
function buildEnvelope(diagnostics: DiagnosticsModule, input: EnvelopeInput): TurnDiagnostics {
  // ★★ 切段与指纹都走**真实算法**：段是 `segmentPrompt()` 从拼好的 prompt 里现切的
  //    （与真实采集链路同一把切段器），画像块指纹是 `byteHash()`（sha256 前 12 位，
  //    与 `noteStudentContext()` 同一个函数）—— 不是另写一份摘要算法。
  const segments = diagnostics.segmentPrompt(input.prompt)
  const contextHash =
    input.studentContext.trim() === '' ? '' : diagnostics.byteHash(input.studentContext)
  return {
    turn: input.turn,
    requestId: input.requestId,
    at: input.at,
    input: { text: input.studentText, safetyInput: { verdict: 'pass' } },
    grade: {
      applied: DEMO_GRADE_LEVEL,
      // ★ 缓冲区里的 12 轮（预置历史 9 轮 + 脚本 3 轮）统一写死 `llm`：这些轮的学段是
      //   **AI 引擎复核**判的，不是本地规则层的结论 —— 界面上的来源标签（顶栏那颗学段按钮 /
      //   侧栏身份卡 / 运行透视）据此显示「AI 引擎判定」。它们的累计轮次都在第 7 轮之后，
      //   早已越过复核门槛（`LLM_DECIDES_FROM_TURN` 第 5 轮），所以每一轮都由复核层定方向。
      decidedBy: 'llm',
      // 第二层（LLM 复核）这一窗口**真的跑过**：`used`（不再是 `not_due`）——
      // 它正是上面那条 `decidedBy: 'llm'` 的来路，两处必须一起改。
      layer2: 'used',
      pending: null,
      // 与 `/api/grade/state` 同一口径：缓冲区里**最后一轮**（第 12 轮，= 脚本第 3 轮）
      // 落在累计第 18 轮（= 状态体里的 `lastTurn`）。偏移的来路见 `DEMO_TURN_OFFSET`。
      cumulativeTurns: input.turn + DEMO_TURN_OFFSET,
      // ★ 三轮都是 0，与状态体的 `cooldownRemainingTurns: 0` 一致。
      //   第三轮原先还挂着一条「学段 · 冷却窗口」的拦截（配套 `cooldownRemainingTurns: 4`），
      //   **已随本次改动删除**：手动冷却的锚点必须是最近一条 `source: 'explicit'` 的轨迹行，
      //   而那行会让来源显示成「手动选中」而不是「AI 引擎判定」，还会把状态体的冷却
      //   变成 10 轮起步。留着它就会同时与状态体的 `source: 'inferred'` /
      //   `decidedBy: 'llm'` / `cooldownRemainingTurns: 0` / `lastChangeTurn: 13` 四处打架
      //   （自动冷却若还剩 4 轮，最近一次改判就该在一两轮之前，而不是第 13 轮）。
      //   信封的全部意义是「这里每个数字都是运行时真的产生过的」，所以宁可少一条拦截
      //   记录，也不要一条自相矛盾的证据。
      cooldownRemainingTurns: 0,
      // 如实描述复核的结论（**不写破折号**：`tests/demo-seed.test.ts` 与
      // `student-view-discipline.test.ts` 都禁它）。
      note: 'AI 引擎复核判定为初中：近几轮的用词、提问深度与练习表现合起来看，稳定落在初中。'
    },
    prompt: {
      // ★ 字符数与 token 数都按**真实拼装结果**现算（与 `notePrompt()` 同一口径：
      //   字符数是 `prompt.length`，token 是 `estimateTokens()` 的估算）——
      //   不写死、也不用「各段之和」（那个数会因分段四舍五入而与整份对不上）。
      chars: input.prompt.length,
      totalTokens: diagnostics.estimateTokens(input.prompt),
      gradeTemplate: DEMO_GRADE_LEVEL,
      segments,
      // 三道运行时注入的说明逐字取自真实链路（`runtime.ts` 的 `notePromptFromState()`）。
      overrides: [
        {
          stage: 'override',
          applied: true,
          note: '建会话时整段替换 Pi 默认 prompt（防装机路径泄漏）'
        },
        {
          stage: 'per-turn',
          applied: true,
          note: '`before_agent_start` 每轮重拼一次（换成本轮学段 + 注入画像块）'
        },
        {
          stage: 'authority',
          applied: true,
          note: '学段权威段恒追加在末尾，使覆盖在提示词里可审计'
        }
      ],
      // 现算：真实链路里这一格是 `findHostPathLeaks(prompt, …)` 的结论
      //（本文件拿不到 `userDataDir` / `process.execPath` 那两个额外串，其余四条规则原样）。
      hostPathClean: findHostPathLeaks(input.prompt).length === 0
    },
    studentContext: {
      // 与 `noteStudentContext()` 逐条对齐：空块不注入、指纹现算、同异比上一轮的指纹。
      injected: contextHash !== '',
      chars: input.studentContext.length,
      byteHash: contextHash,
      sameAsPrev: contextHash !== '' && contextHash === input.previousContextHash,
      text: input.studentContext,
      // 真实采集器在这个长度上会截断展示用的 `text`；本块远短于那个上限
      //（`tests/demo-seed.test.ts` 盯着「块比自己声明的不截断上限短」这条）。
      truncated: false
    },
    reasoning: { available: false, filtered: '', note: '本轮没有拿到模型推理增量。' },
    tools: input.tools,
    retrieval: input.retrieval,
    safetyFinal: {
      // 三阶段**都要有结论**：入口预检放行 → 流式正文逐段过审 → 整段终审放行。
      // 每一格的判词都由该阶段的结论与下面三个计数推得，不写与计数打架的话。
      stages: [
        {
          stage: 'input',
          verdict: 'pass',
          reason: '入口预检放行：这一轮学生的输入没有命中任何安全规则，原话照常发给模型。'
        },
        {
          stage: 'stream',
          verdict: 'pass',
          reason: '流式正文边生成边过生成侧审查，转发出去的每一段都没有命中规则。'
        },
        {
          stage: 'final',
          verdict: 'pass',
          reason: '整段终审跑完就是下面这一次，回答全文放行，没有需要撤回的内容。'
        }
      ],
      // 真实链路里 `finalizations` 是「这一轮的 done 到了之后跑的终审次数」（一轮一次）。
      finalizations: 1,
      // 演示里没有撤回（`retractions` 保持 0，与三阶段全 pass 一致）。
      retractions: 0,
      // 真实语义：终审下结论之前先攒着、还没放给学生的正文字数。这里取**本轮真正
      // 放出去的正文长度**（`DEMO_SCRIPT_TEXT` 那一段，现算），三轮各不相同。
      bufferedChars: input.answerChars
    },
    interceptions: input.interceptions,
    done: {
      ok: input.ok,
      status: input.status,
      totalMs: input.totalMs,
      firstTokenMs: input.firstTokenMs
    }
  }
}

/**
 * 第 1 轮那次检索的完整轨迹（第 1 级命中）。
 *
 * ★ 命中的是**哪一节**要写出来，且必须与这一轮的引用（{@link listCitations} 的两条，
 *   都在 {@link SECTION_LIST} 这一节）说同一件事 —— 命中数由调用方按**引用条数**
 *   传进来，两处因此不可能各说一个数。
 */
function listRetrieval(hits: number, compat: number): DiagRetrieval {
  return retrievalTrace({
    query: '列表 按顺序排好 相邻比较',
    degraded: 'vector',
    hits,
    compat,
    section: SECTION_LIST
  })
}

/**
 * 四级降级链的档位顺序（`server/app/rag/retriever.py` 的编排：上一级没命中才试下一级）。
 *
 * ★ 它只用来算「哪几档走在最终档位之前 / 之后」——**不重排、也不替 Python 判定**：
 *   `degraded` 是由调用方如实传进来的最终档位。
 */
const RETRIEVAL_CHAIN: readonly DiagRetrievalLevel['level'][] = ['vector', 'cloud', 'fts', 'outline']

/** 一条检索轨迹的输入（各轮不同的那部分观察数据）。 */
interface RetrievalInput {
  /** 检索词（**模型自己拟的**，不是学生原话）。 */
  query: string
  /** Python 判定的最终档位（TS 不重新推理）。 */
  degraded: DiagRetrievalLevel['level']
  /** 命中块数（调用方按**这一轮的引用条数**传进来，两处因此不可能各说一个数）。 */
  hits: number
  /** 其中来自更低学段、已标兼容的块数。 */
  compat: number
  /** 命中的块落在哪里（逐字取自真实知识库：向量 / 关键词命中写小节名，大纲兜底写章名）。 */
  section: string
}

/**
 * 一条**逐级检索轨迹**（四级链四档都要有话说）。
 *
 * ★★ 每一档的 `note` 贴着真实产出写（`retriever.py` 的 `LevelAttempt.detail` 就是
 *   那几句：「sqlite-vec KNN」/「FTS5 trigram」/「章节大纲兜底」/「未配置云端嵌入
 *   （mode != cloud_api）」）：演示时要能一眼看出「它试了向量、没命中、于是往下走了一级」，
 *   而不是只看到一个最终档位。**没走到的档位也必须给出为什么**（降级链是
 *   「上一级没命中才试下一级」，前面命中之后，后面几档这一轮根本没被执行过）。
 * ★ 命中档位那一句里写的是**命中落在哪一节**，它与这一轮的引用说同一件事
 *   （命中的块数由调用方按引用条数传进来）。
 */
function retrievalTrace(input: RetrievalInput): DiagRetrieval {
  const finalIndex = RETRIEVAL_CHAIN.indexOf(input.degraded)
  const compatText =
    input.compat > 0 ? `（其中 ${input.compat} 块来自更低学段，已标兼容）` : '（没有跨学段的块）'
  /** 命中档位那一句（大纲兜底给的是一章里的小节名，说法与另外三档不同）。 */
  const hitNote: Record<DiagRetrievalLevel['level'], string> = {
    vector: `sqlite-vec KNN 命中 ${input.hits} 块，都落在「${input.section}」这一节${compatText}`,
    cloud: `云端嵌入 + 向量检索命中 ${input.hits} 块，都落在「${input.section}」这一节${compatText}`,
    fts: `FTS5 trigram 命中 ${input.hits} 块，都落在「${input.section}」这一节${compatText}`,
    outline: `章节大纲兜底命中 ${input.hits} 条：都在「${input.section}」这一章里，给的是各小节的名字（正文比问题宽一档）`
  }
  /** 试过但没命中那一句（为什么落到下一级）。 */
  const missNote: Record<DiagRetrievalLevel['level'], string> = {
    vector: 'sqlite-vec KNN 无命中：换了几种说法，相似度都压在阈值以下（学段过滤内没有更贴题的块）',
    cloud: '云端嵌入这一级没走通：本机配置的是本地嵌入（mode != cloud_api），没有云端通道可试',
    fts: 'FTS5 trigram 也没命中：这句话里的词与教材原句对不上',
    outline: '章节大纲也没读到可用的小节（这一章的大纲是空的）'
  }
  /** 前面已经命中、这一档没被执行过那一句。 */
  const skipNote: Record<DiagRetrievalLevel['level'], string> = {
    vector: '未走到这一档',
    cloud: '本地向量已命中，未走到这一级（云端嵌入只在本地嵌入不可用或没命中时才试）',
    fts: '前面已经命中，未走到全文检索这一级',
    outline: '前面已经命中，未走到章节大纲这一级（它只在前面三级都没命中时兜底）'
  }
  const levels: DiagRetrievalLevel[] = RETRIEVAL_CHAIN.map((level, index) => {
    if (index < finalIndex) return { level, tried: true, ok: false, hits: 0, note: missNote[level] }
    if (index === finalIndex) {
      return { level, tried: true, ok: true, hits: input.hits, note: hitNote[level] }
    }
    return { level, tried: false, ok: false, hits: 0, note: skipNote[level] }
  })
  return {
    query: input.query,
    degraded: input.degraded,
    gradeFilter: GRADE_FILTER,
    hitCount: input.hits,
    compatCount: input.compat,
    levels
  }
}

/**
 * 学段过滤条件**原文**（Python 按它真正下发的白名单生成）。
 *
 * ★ 白名单不是「只有初中」：检索的向上兼容开关默认开着，下发的是
 *   `compatible_grades('junior')` = 本学段 + **更低学段**（由高到低），
 *   即 `server/app/knowledge/library.py` 的 `['junior','primary_high','primary_low']`，
 *   由 `fallback.grade_filter_sql()` 渲染成下面这一行 —— 与真实运行时下发的那一行为**同一个函数
 *   对同一份白名单**的产物（同源性由服务端 `test_rag.py` 的 trace 用例钉住）。
 * ★ 更低学段在**白名单里**、却不一定命中：这一轮两条引用都是初中内容，
 *   所以 `compatCount` 是 0（`compat` 标的是「命中了更低学段」这件事，不是「允许命中」）。
 * ★ 不放一个"看起来像 SQL"的假字符串：那正是「信封在撒谎」的另一种样子。
 */
const GRADE_FILTER = "grade_level IN ('junior','primary_high','primary_low')"

/* ------------------------------------------------------------------ *
 * 三轮脚本
 * ------------------------------------------------------------------ */

/** 三轮的固定轮次号与请求号前缀（与 `stores/demoSeed.ts` 的约定一致）。 */
export const DEMO_REQUEST_PREFIX = 'script-'

/**
 * 沙箱态下**当前那条会话**的 id。
 *
 * ★ 它与那三条预置历史**必须是不同的 id**：沙箱态下当前对话是一段**全新的空会话**
 *   （学生还没开口，界面显示开场卡），而那三条是「已经聊过的」历史。
 *   共用一个 id 会让侧栏高亮到一条历史会话上、而消息区却是空的。
 */
export const DEMO_CURRENT_SESSION_ID = 'session-current'

/** 三轮脚本的标题（侧栏那三条历史会话的标题，与脚本一一对应）。 */
export const DEMO_SESSION_TITLES = DEMO_SESSIONS.map((session) => session.title)

/**
 * 预置历史三条会话占用的**轮次号个数**（各 3 轮，合计 9：缓冲区里的第 1..9 轮）。
 *
 * ★ 当前会话那三轮脚本的轮次号**接在它们后面**（第 10..12 轮）：时间轴上轮次号
 *   全局唯一、且按时间升序（历史在前、现在在后）—— 与真实链路同一口径
 *   （`agent/diagnostics.ts` 的 `DiagnosticsStore.beginTurn()` 是**跨会话单调**发号的）。
 * ★ 导出它是为了让「不撞号」这条断言有一处可引用的真源（见 `tests/demo-seed.test.ts`）。
 */
export const DEMO_HISTORY_TURN_COUNT = 9

/**
 * 轮次号的**偏移**：缓冲区里的第 N 轮 = 这个学生的累计第 `N + 6` 轮。
 *
 * ★★ 为什么是 6：缓冲区里一共 12 轮（预置历史 9 + 脚本 3），而演示的学段状态体
 *   （`demo/data.ts` 的 `demoGradeStateBody()`）写着这个学生**累计第 18 轮** ——
 *   12 + 6 = 18，于是**最后一轮**（第 12 轮 = 脚本第 3 轮）正好落在累计第 18 轮，
 *   与状态体的 `lastTurn: 18` / `lastChangeTurn: 13` / `cooldownRemainingTurns: 0`
 *   一一对应（这条对应关系原先写在 `buildEnvelope()` 里，当时缓冲区只有三轮脚本、
 *   偏移是 15）。
 * ★ 偏移**全缓冲区统一**：预置历史的信封也用它，所以那些轮次的累计数（7..15）
 *   都排在「现在」（18）前面 —— 历史不会跑到当前会话的后面去。
 */
const DEMO_TURN_OFFSET = 18 - (DEMO_HISTORY_TURN_COUNT + 3)

/**
 * 三轮的**学生原话与助手正文**（纯常量，不依赖任何取数）。
 *
 * ★★ 为什么单独抽出来而不是写在 `buildDemoScript()` 里：
 *   这两段字是**学生看得见的**，必须过 `student-view-discipline.test.ts` 那三条同一口径的
 *   排版纪律（不写未渲染的 Markdown、不用破折号连接句子），而那三条是**源码级扫描**——
 *   抽成常量，单测就能直接扫它们（见 `tests/demo-seed.test.ts`）。
 *   ⚠️ 改这三段话之前先看那条守卫：`**` / 反引号 / `——` 一个都不许出现。
 * ★ 它们的 `turn` 是**缓冲区里的轮次号**（不是 1、2、3）：前面 9 个号被预置历史占了
 *   （见 {@link DEMO_HISTORY_TURN_COUNT}），第一轮脚本接在第 10 轮上。
 *   这个号同时进 `requestId`（`script-10`）与时间轴上的「第 N 轮」，改它要一起想清楚。
 * ★ 脚本**循环播放**：放完第 3 轮回到第 1 轮。
 */
export const DEMO_SCRIPT_TEXT: readonly {
  turn: number
  studentText: string
  answer: string
}[] = [
  {
    turn: DEMO_HISTORY_TURN_COUNT + 1,
    studentText: '老师，列表里的数是怎么排好顺序的？',
    answer:
      '列表把一批数据按顺序放在一起，靠位置取用：第一个、第二个，数着位置就能找到。要让里面的一排数从小到大站好，机器用的办法很朴素，一次只看相邻的两个。\n\n先比头两个：左边比右边大，就把它俩换个位置；不大，就都不动。然后往右挪一格，再比下一对。像体育课排队，老师从左往右挨个看，谁比右边的人高就换过来。这样走一趟下来，最高的那个一定站到了排尾。\n\n一趟只安顿好一个，剩下的还得再走几趟。每多走一趟，末尾站定的人就多一个，要看的地方就少一对。走到没有需要换的，整排数就排好了。'
  },
  {
    turn: DEMO_HISTORY_TURN_COUNT + 2,
    studentText: '那我们用代码试试？',
    answer:
      '好，我们从代码填空开始。骨架已经给好了，里面留了待填的地方。\n\n第一处是每轮要做的那件事，最后一处是打印每一轮的结果。你照着注释里的提示写，写完直接把代码跑起来，看看输出对不对。\n\n跑之前先猜一猜：如果让它数到 5，屏幕上会出现哪几个数？猜完再跑，对上了就说明你读懂了。'
  },
  {
    turn: DEMO_HISTORY_TURN_COUNT + 3,
    studentText: '我想做几道题检验一下。',
    answer:
      '给你出了三道，从「认得出」到「用得上」再到「想得清」，一道比一道难一点。\n\n做完之后我按判分结果告诉你是哪一步没走通。错的题不用急着看答案，先自己说一遍当时是怎么想的。多数时候卡住的地方就在那一步。\n\n刚才这类题你之前错过几次，这次做完了掌握度会往上走一格，右栏那条进度能看到。'
  }
]

/**
 * 构建三轮脚本。
 *
 * ★ 每次调用都重新取内容态（三个资产各自记忆化，取到才缓存）——
 *   应用刚打开就点按钮时 sidecar 可能还没起来，那时**不该**把降级结果钉死一整次运行。
 */
export async function buildDemoScript(): Promise<DemoScriptPayload> {
  const now = Date.now()
  const [animationCard, codingCard, quizCard] = await Promise.all([
    buildAnimationCard(),
    buildCodingCard(),
    buildQuizCard()
  ])
  const { citations, details } = listCitations()
  // 诊断模块在这里装上（唯一一次）：下面用到的都是它导出的真实算法
  const diagnostics = await loadDiagnostics()
  /**
   * ★★ 画像块与 system prompt **只拼一次，三轮共用**（同一个字符串）。
   *
   * 这正是演示要的那条证据：`studentContext.byteHash` 三轮同值、第 2/3 轮
   * `sameAsPrev` 为真（「这一块逐字节没变，前缀缓存可以接着用」）。
   * 每轮重算一次的话，只要块里将来混进任何一个每轮都变的字节（时间、计数、键序），
   * 这条证据就会悄无声息地变成假的 —— 所以这里的写法本身就是一条纪律。
   */
  const studentContextBlock = demoStudentContextBlock()
  const systemPrompt = demoSystemPrompt(studentContextBlock)
  /**
   * 画像块的字节指纹（`byteHash()`，真实算法）。
   *
   * ★ 第 2、3 轮把它当「**上一轮的**指纹」传进信封：两轮的块与它逐字节相同，
   *   于是 `sameAsPrev` 为真 —— 这就是「前缀字节稳定、可被复用」的可观测证据。
   * ★ 第 1 轮传空串：真实链路里 `lastStudentContextHash` 的初值就是空串
   *   （`runtime.ts`），「没有上一轮」不该被算成「上一轮一样」。
   */
  const contextHash =
    studentContextBlock.trim() === '' ? '' : diagnostics.byteHash(studentContextBlock)

  // 文案全部来自 `DEMO_SCRIPT_TEXT`（**一份**，单测直接扫它过排版纪律），
  // 这里只把「每轮各自不同的观察数据」贴上去。
  const build = (
    index: number,
    extras: Pick<DemoScriptTurn, 'citations' | 'cards'> & {
      details?: CitationDetail[]
      degraded?: DemoScriptTurn['degraded']
    },
    envelope: Omit<EnvelopeInput, 'prompt' | 'studentContext' | 'answerChars'>
  ): DemoScriptTurn => {
    const text = DEMO_SCRIPT_TEXT[index]
    // `DEMO_SCRIPT_TEXT` 的长度就是轮数（3），索引不会越界；这里只是让 TS 看见。
    if (text === undefined) throw new Error('脚本轮次缺失')
    return {
      ...text,
      ...extras,
      diagnostics: buildEnvelope(diagnostics, {
        ...envelope,
        // 三轮共用的那两份（画像块 / prompt）与「本轮的正文长度」都在这里补上，
        // 免得三个调用点各写一遍、迟早写岔。
        prompt: systemPrompt,
        studentContext: studentContextBlock,
        answerChars: text.answer.length
      })
    }
  }

  const turns: DemoScriptTurn[] = [
    build(
      0,
      { citations, details, degraded: 'vector', cards: [animationCard] },
      {
        turn: DEMO_HISTORY_TURN_COUNT + 1,
        requestId: `${DEMO_REQUEST_PREFIX}${DEMO_HISTORY_TURN_COUNT + 1}`,
        studentText: DEMO_SCRIPT_TEXT[0]?.studentText ?? '',
        at: now,
        previousContextHash: '',
        tools: [{ seq: 1, name: 'rag_search', ok: true, latencyMs: 142, degraded: 'vector' }],
        // ★ 检索词是「模型自己拟的」，所以它要与这一轮讲的东西同题 ——
        //   讲列表却查「循环 重复执行」，信封第一行就自相矛盾了
        //   （命中数与命中在哪一节也一并由 `listRetrieval()` 说清楚）。
        retrieval: listRetrieval(citations.length, 0),
        interceptions: [],
        firstTokenMs: 640,
        totalMs: 4_180,
        status: 'done',
        ok: true
      }
    ),
    build(
      1,
      // 这一轮没查教材（模型接着上一轮的材料讲）→ 不投引用事件。
      // ★ 与信封里 `retrieval: null` 一致：**有引用就必须有检索轨迹**，
      //   两处对不上的信封就是一份自相矛盾的证据。
      { citations: [], cards: [codingCard] },
      {
        turn: DEMO_HISTORY_TURN_COUNT + 2,
        requestId: `${DEMO_REQUEST_PREFIX}${DEMO_HISTORY_TURN_COUNT + 2}`,
        studentText: DEMO_SCRIPT_TEXT[1]?.studentText ?? '',
        at: now + 60_000,
        // 与上一轮逐字节相同的那一份 → 信封里 `sameAsPrev` 为真
        previousContextHash: contextHash,
        tools: [
          // 名字逐个对过 `agent/extensions/index.ts` 的 `AGENT_TOOL_NAMES`（冻结词表）：
          // 取代码骨架与评估代码是**两个** Tool，这里就是真的那两个名字。
          { seq: 1, name: 'get_code_template', ok: true, latencyMs: 21 },
          { seq: 2, name: 'evaluate_code', ok: true, latencyMs: 890 }
        ],
        retrieval: null,
        interceptions: [],
        firstTokenMs: 520,
        totalMs: 3_260,
        status: 'done',
        ok: true
      }
    ),
    build(
      2,
      { citations: [], cards: [quizCard] },
      {
        turn: DEMO_HISTORY_TURN_COUNT + 3,
        requestId: `${DEMO_REQUEST_PREFIX}${DEMO_HISTORY_TURN_COUNT + 3}`,
        studentText: DEMO_SCRIPT_TEXT[2]?.studentText ?? '',
        at: now + 120_000,
        // 同上：与上一轮逐字节相同（第 2、3 轮共用同一份块）
        previousContextHash: contextHash,
        // ★ 只有 `generate_quiz`：这一轮**没有真的判分**（沙箱态下 `quiz:grade` 被拒），
        //   所以绝不在信封里写一条 `submit_quiz` —— 那是「承诺超出实际行为」，
        //   而信封的全部意义就是「这里每一个数字都是运行时真的产生过的」。
        tools: [{ seq: 1, name: 'generate_quiz', ok: true, latencyMs: 620 }],
        retrieval: null,
        // ★ 这一轮**不再有**「学段 · 冷却窗口」那条拦截（原先有，2026-09-27 随学段口径
        //   改成 AI 引擎判定一起删除）。它写的是「学生手动指定学段后仍在冷却期内，
        //   还剩 4 轮不接受自动调整」—— 而手动冷却的锚点必须是最近一条 explicit 轨迹行，
        //   那行会让来源显示成「手动选中」（而不是「AI 引擎判定」），冷却也会变成 10 轮起步。
        //   两处不能并存：保留拦截就得放弃「AI 引擎判定」，而那是本次改动唯一的目标。
        //   删除之后三处（三次信封 / 状态体 / 轨迹表）说的是同一件事：
        //   最近一次改判是第 13 轮的 AI 引擎复核，之后 5 轮稳定、不在任何冷却里。
        //
        // ★★ 也不拿别的机制来「补一条」（这一条对**全部 12 轮**成立，预置历史那 9 轮
        //   同样如实空着，见 `interceptions: []` 在 `buildDemoHistory()` 里那一行）：
        //   全仓真实的拦截来源只有四处，逐一对过，每一处都会与本信封里已经写下的字段打架 ——
        //     · 内容安全 · 入口预检 → 与本轮 `input.safetyInput.verdict: 'pass'` 冲突；
        //     · 内容安全 · 生成侧终审 → 与 `safetyFinal.retractions: 0` / 三阶段全 pass 冲突；
        //     · provider 边界 · 宿主路径断言 → 与 `prompt.hostPathClean: true` 冲突；
        //     · 学段 · 冷却窗口 → 见上面那段（来源会显示成「手动选中」）。
        //   拦截记录是演示里最强的证据，所以它必须**最严格**：一条对不上的「我拦下了什么」，
        //   毁掉的是整屏数据的可信度。没有真实且自洽的一条时，这里就如实空着。
        interceptions: [],
        firstTokenMs: 700,
        totalMs: 4_640,
        status: 'done',
        ok: true
      }
    )
  ]

  return {
    turns,
    sessionsWithCards: [DEMO_LOOP_SESSION_ID],
    history: await buildDemoHistory(diagnostics, studentContextBlock, systemPrompt, contextHash)
  }
}

/* ------------------------------------------------------------------ *
 * 预置历史会话：正文 + 逐轮信封（都是**同一张表**生成的，两处不可能讲两个故事）
 * ------------------------------------------------------------------ */

/**
 * 一条预置历史会话里的**一轮**：正文 + 那一轮信封所需的全部观察数据。
 *
 * ★★ 为什么正文（`buildDemoSessionMessages()`）与信封（`buildDemoScript()` 的 `history`）
 *   都从这张表生成：调用方要的是「点开那条会话看到的字」与「运行透视里那一轮」
 *   讲同一件事。两处各写一份的话，第一次改文案就会漂移成两个故事
 *   （界面上在讲列表怎么排，信封里却写着另一轮的检索词）。
 * ★ `turn` 是**缓冲区里的轮次号**（1 起，全局唯一）：历史占 1..9，脚本三轮接在后面。
 */
interface DemoHistoryTurn {
  /** 缓冲区里的轮次号（见 {@link DEMO_HISTORY_TURN_COUNT} 的说明）。 */
  turn: number
  /** 这一轮的学生原话（与那条会话的正文逐字相同）。 */
  studentText: string
  /** 这一轮的助手正文（与那条会话的正文逐字相同；`bufferedChars` 也用它现算）。 */
  answer: string
  /** 挂在这轮助手消息上的卡片（每条会话只在**第一轮**挂一张，与脚本那条共用同一份常量）。 */
  card?: DemoSeedCard
  /** 这一轮检索出来的块（条数必须与 `retrieval.hitCount` 一样多；没查教材就是空数组）。 */
  citations: Citation[]
  details: CitationDetail[]
  /** 这一轮的逐级检索轨迹（`null` = 这一轮没有查教材）。 */
  retrieval: DiagRetrieval | null
  tools: DiagToolCall[]
  firstTokenMs: number
  totalMs: number
  /** 这一轮提问与**上一条消息**之间隔了多久（毫秒；用来把正文的时间铺开）。 */
  gapMs: number
}

/**
 * 三条预置历史会话的逐轮内容（**唯一真源**）。
 *
 * ⚠️ 每一轮的 `cards` 与它讲的主题必须对得上（讲列表那一轮挂动画卡、写代码那两条挂编程卡、
 *    做题那一条挂闯关卡）：卡片是同一份真实产物，挂错轮它就成了另一件事的证据。
 * ⚠️ 轮次号从 1 起连续排到底（三条会话按**时间升序**：最旧的「列表是怎么工作的」在前）——
 *    时间轴从上往下读就是一条时间线，且与 `DEMO_SCRIPT_TEXT[].turn` 不撞号。
 * ⚠️ `gapMs` 之和 + `totalMs` 之和 = 会话内首尾消息的跨度；最后一条助手消息落在
 *    `demo/data.ts` 的 `agoMs` 那个时刻上（侧栏写「26 小时前」，点进去最后一句也得是那时）。
 */
async function demoHistoryTurns(sessionId: string): Promise<DemoHistoryTurn[]> {
  if (sessionId === DEMO_LOOP_SESSION_ID) {
    const card = await buildAnimationCard()
    const { citations, details } = listCitations()
    // 第 2 轮落到关键词那一档，命中的是循环那一节（正文逐字取自真实知识库那一节的节选）。
    const loop = citationPair(
      'loop-1',
      KP_LOOP,
      SECTION_LOOP,
      '循环用于重复执行一段代码。它解决的是「一批数据挨个处理」和「同一动作重复多次」这两类需求：给全班 40 个人的分数求平均，循环不会漏掉第 37 个。',
      0.71,
      'fts'
    )
    return [
      {
        turn: 1,
        // ★ 与脚本第 1 轮**同一句原话、同一段正文**（`DEMO_SCRIPT_TEXT[0]`）：
        //   侧栏那条会话的预览句、点进去的第一句、脚本放的第一句，三处必须是同一句话
        //   （预览句在 `demo/data.ts` 的 `DEMO_SESSION_PREVIEWS`，改这里要连它一起改）。
        studentText: DEMO_SCRIPT_TEXT[0]?.studentText ?? '',
        answer: DEMO_SCRIPT_TEXT[0]?.answer ?? '',
        card,
        citations,
        details,
        // ★ 检索词是「模型自己拟的」，所以它要与这一轮讲的东西同题 ——
        //   讲列表却查「循环 重复执行」，信封第一行就自相矛盾了。
        retrieval: listRetrieval(citations.length, 0),
        tools: [{ seq: 1, name: 'rag_search', ok: true, latencyMs: 138, degraded: 'vector' }],
        firstTokenMs: 880,
        totalMs: 5_240,
        gapMs: 0
      },
      {
        turn: 2,
        studentText: '那它每次都要把整排数从头看一遍吗？',
        answer:
          '不用从头看两遍。一趟走下来，排尾已经站定了最大的那个，下一趟只需要看到它前面。\n\n所以每多走一趟，要看的地方就少一对：第一趟看全部，第二趟少看最后一对，再往下每趟再少一对。到某一趟一次都没换过，说明整排已经站好了，就可以停。\n\n这个「一遍又一遍，直到不用再换」就是循环：做一遍的事写一次，什么时候停写成条件，机器自己会重复。',
        citations: [loop.citation],
        details: [loop.detail],
        // ★ 第 2 轮是**降级**那一轮：本地向量没命中（换了几种说法，相似度都在阈值以下），
        //   云端这一级本机没配（`mode = local_fastembed`），最后靠关键词兜底命中循环那一节。
        //   四级链逐级都写了为什么 —— 这正是「降级不是失败，是换了条路」的可观测证据。
        retrieval: retrievalTrace({
          query: '循环 重复执行 什么时候停',
          degraded: 'fts',
          hits: 1,
          compat: 0,
          section: SECTION_LOOP
        }),
        tools: [{ seq: 1, name: 'rag_search', ok: true, latencyMs: 264, degraded: 'fts' }],
        firstTokenMs: 960,
        totalMs: 4_380,
        gapMs: 96_000
      },
      {
        turn: 3,
        studentText: '我好像懂了，那我怎么知道自己是不是真的会了？',
        answer:
          '两个小办法。先说一遍：合上这一页，用自己的话把刚才那两步讲给同桌听，讲得顺就说明思路已经在你脑子里了。\n\n再动手一遍：把刚才那排数换成更乱的一组，自己在纸上走一趟，看看能不能走到排好为止。\n\n这一类内容你练得还不多，右栏那条进度能看见它慢慢往上走。今天先不看分数，能讲出来就是真的会了。',
        citations: [],
        details: [],
        // ★ 这一轮模型没查教材，而是**先看了画像**再回话（"这类内容你练得还不多"这句话的来路
        //   就是那个工具）：所以 `retrieval: null`、引用为空 —— 有引用就必须有检索轨迹。
        retrieval: null,
        tools: [{ seq: 1, name: 'get_student_profile', ok: true, latencyMs: 96 }],
        firstTokenMs: 520,
        totalMs: 3_120,
        gapMs: 54_000
      }
    ]
  }

  if (sessionId === DEMO_CODE_SESSION_ID) {
    const card = await buildCodingCard()
    return [
      {
        turn: 4,
        studentText: DEMO_SCRIPT_TEXT[1]?.studentText ?? '',
        answer: DEMO_SCRIPT_TEXT[1]?.answer ?? '',
        card,
        citations: [],
        details: [],
        retrieval: null,
        tools: [{ seq: 1, name: 'get_code_template', ok: true, latencyMs: 23 }],
        firstTokenMs: 610,
        totalMs: 3_480,
        gapMs: 0
      },
      {
        turn: 5,
        studentText: '我跑了一下，屏幕上只出来一个数，后面就没有了。',
        answer:
          '只出来一个，多半是那句打印被放在循环外面了：它只轮到一次，剩下的自然看不见。\n\n你回去看两处。一是要重复的那一行有没有缩进到循环里，缩进就是「这几行归循环管」的意思。二是范围有没有写全，只写一个数的时候，机器从 0 数到它前面一个就停，数出来的个数会比你想要的少一个。\n\n改好再跑一次。要是还不行，把屏幕上原样的报错发给我，我按报错给你提示。',
        citations: [],
        details: [],
        retrieval: null,
        // ★ 两个真实工具：先**跑一遍代码**看输出（`evaluate_code`），再按结果**逐级给提示**
        //   （`get_coding_hint`）—— 这正是「报错归一 + 分级提示」那条链路的样子。
        tools: [
          { seq: 1, name: 'evaluate_code', ok: true, latencyMs: 1_180 },
          { seq: 2, name: 'get_coding_hint', ok: true, latencyMs: 74 }
        ],
        firstTokenMs: 1_080,
        totalMs: 6_120,
        gapMs: 42_000
      },
      {
        turn: 6,
        studentText: '再给我一道差不多的，我自己写。',
        answer:
          '好，这道比刚才那题多一步：让它把 1 到 10 里的偶数一个一个打印出来。\n\n思路还是那两步：先想清楚每个数轮到的时候要做什么，再想清楚什么时候轮到下一个。写完先自己数一遍该出现几个数，再跑起来对数。\n\n卡住了不用急着问，先把你写的那几行发我，我看你卡在哪一步。',
        citations: [],
        details: [],
        retrieval: null,
        tools: [{ seq: 1, name: 'generate_code_exercise', ok: true, latencyMs: 640 }],
        firstTokenMs: 470,
        totalMs: 2_960,
        gapMs: 38_000
      }
    ]
  }

  if (sessionId === DEMO_QUIZ_SESSION_ID) {
    const card = await buildQuizCard()
    const position = citationPair(
      'list-3',
      KP_LIST,
      SECTION_LIST,
      '列表是有序序列，靠位置取用。要注意下标从 0 开始：第一个元素在位置 0，最后一个可以用倒数第一表示。',
      0.68
    )
    const outlineLoop = citationPair(
      'outline-1',
      KP_LOOP,
      SECTION_LOOP,
      // ★ 大纲兜底给的是**小节名的列表**（不是正文）：所以这两条的正文就是各节的摘要，
      //   逐字取自那一节的 front matter（`summary`）。
      '第8章的大纲条目：循环：重复的事交给机器。循环让同一段代码重复执行；写好「做一遍」和「什么时候停」，机器就能替你做很多遍。',
      0.44,
      'outline'
    )
    const outlineList = citationPair(
      'outline-2',
      KP_LIST,
      SECTION_LIST,
      '第8章的大纲条目：列表与字典：把一批数据放在一起。列表把一批数据按顺序排好，字典给每份数据配一个名字，方便按顺序取或按名字查。',
      0.41,
      'outline'
    )
    return [
      {
        turn: 7,
        studentText: DEMO_SCRIPT_TEXT[2]?.studentText ?? '',
        answer: DEMO_SCRIPT_TEXT[2]?.answer ?? '',
        card,
        citations: [],
        details: [],
        retrieval: null,
        // ★ 这一轮**没有真的判分**：判分走的是另一条通道，那一条在沙箱态下是被回绝的，
        //   所以这里只写 `generate_quiz`（出题），绝不写一条 `submit_quiz` ——
        //   那是「承诺超出实际行为」，而信封的全部意义就是每个数字都真的产生过。
        tools: [{ seq: 1, name: 'generate_quiz', ok: true, latencyMs: 620 }],
        firstTokenMs: 700,
        totalMs: 4_640,
        gapMs: 0
      },
      {
        turn: 8,
        studentText: '第二题我又错了，位置我还是数不对。',
        answer:
          '位置这件事有个小台阶：它从 0 开始数，不是从 1 开始。所以第一个数在位置 0，第二个在位置 1，最后一个可以倒着数成倒数第一。\n\n你念的时候可以带上位置一起念：第 0 个是 3，第 1 个是 8。念两遍，手就不会比脑子快。\n\n刚才那道错题我换了个说法又出了两道，题干变了、考点没变，你再试试看。',
        citations: [position.citation],
        details: [position.detail],
        // 这一轮讲的是「位置从 0 起」，所以模型查的就是列表那一节里讲下标的那一块。
        retrieval: retrievalTrace({
          query: '列表 位置 从 0 开始 取第几个',
          degraded: 'vector',
          hits: 1,
          compat: 0,
          section: SECTION_LIST
        }),
        tools: [{ seq: 1, name: 'generate_variants', ok: true, latencyMs: 720 }],
        firstTokenMs: 660,
        totalMs: 3_820,
        gapMs: 46_000
      },
      {
        turn: 9,
        studentText: '有没有一张图能帮我把这些都记住？',
        answer:
          '有。你上回见过那张排序的动画，一排柱子挨个比、挨个换，那就是列表最常做的事，翻回去再看一遍比背句子管用。\n\n这一章的教材我也替你翻出来了，给的是大纲，从循环到列表都在里面，想不起来的时候看小标题就行。\n\n记住两句就够用：位置从 0 起，重复靠循环。',
        citations: [outlineLoop.citation, outlineList.citation],
        details: [outlineLoop.detail, outlineList.detail],
        // ★ 三档都没命中、落到**章节大纲**这一档：向量与关键词都按「这个词」找不着，
        //   大纲就给回这一章的小节名（正文比问题宽一档）—— 四级链的最后一档长这样。
        retrieval: retrievalTrace({
          query: '列表 字典 小结 复习 记不住',
          degraded: 'outline',
          hits: 2,
          compat: 0,
          section: CHAPTER_PROGRAMMING
        }),
        tools: [{ seq: 1, name: 'rag_search', ok: true, latencyMs: 305, degraded: 'outline' }],
        firstTokenMs: 1_120,
        totalMs: 5_760,
        gapMs: 58_000
      }
    ]
  }

  return []
}

/**
 * 一条会话逐轮的时间表（**正文与信封共用**：两处各算一次迟早对不上）。
 *
 * 第 i 项 = 这一轮学生提问的时刻（信封的 `at`）：往前铺满 `gapMs + totalMs` 之后，
 * 最后一条助手消息正好落在会话的 `agoMs` 上。
 */
function historyTimeline(
  turns: readonly DemoHistoryTurn[],
  agoMs: number,
  now: number
): number[] {
  const span = turns.reduce((sum, turn) => sum + turn.gapMs + turn.totalMs, 0)
  let cursor = now - agoMs - span
  const out: number[] = []
  for (const turn of turns) {
    cursor += turn.gapMs
    out.push(cursor)
    cursor += turn.totalMs
  }
  return out
}

/**
 * 三条预置历史会话的逐轮信封（**按时间升序**：最旧的一条在最前）。
 *
 * ★★ 为什么在同一份载荷里下发：那三条会话点开就有正文，而原先一条信封都没有 ——
 *   运行透视的时间轴上「点开历史对话」是空的。现在它们与脚本那三轮共用同一个
 *   `buildEnvelope()`（同一份真实提示词、同一套真实算法），只是轮次号与观察数据不同。
 * ★ 每一轮都**如实空着** `interceptions`：理由与脚本第 3 轮那段注释逐条相同
 *   （全仓只有四种真实拦截来源，每一种都会与这些信封里已经写下的字段打架）。
 */
async function buildDemoHistory(
  diagnostics: DiagnosticsModule,
  studentContext: string,
  prompt: string,
  contextHash: string
): Promise<DemoHistorySession[]> {
  const now = Date.now()
  // 最旧的一条在前（`DEMO_SESSIONS` 里本来就是这个顺序，这里显式排一次：
  // 时间轴的阅读顺序 = 轮次号顺序，两处不能靠「数组碰巧有序」来对齐）。
  const ordered = [...DEMO_SESSIONS].sort((left, right) => right.agoMs - left.agoMs)
  const sessions: DemoHistorySession[] = []
  for (const session of ordered) {
    const turns = await demoHistoryTurns(session.id)
    const timeline = historyTimeline(turns, session.agoMs, now)
    sessions.push({
      sessionId: session.id,
      title: session.title,
      turns: turns.map((turn, index) =>
        buildEnvelope(diagnostics, {
          turn: turn.turn,
          requestId: `${HISTORY_REQUEST_PREFIX}${turn.turn}`,
          studentText: turn.studentText,
          at: timeline[index] ?? now,
          prompt,
          studentContext,
          // ★ 每条会话的**第 1 轮**传空串：真实链路里 `lastStudentContextHash` 的初值
          //   就是空串（`runtime.ts`），「换了一条会话、没有上一轮」不该被算成「上一轮一样」；
          //   同一会话的第 2、3 轮与上一轮逐字节相同 → `sameAsPrev` 为真。
          previousContextHash: index === 0 ? '' : contextHash,
          tools: turn.tools,
          retrieval: turn.retrieval,
          interceptions: [],
          answerChars: turn.answer.length,
          firstTokenMs: turn.firstTokenMs,
          totalMs: turn.totalMs,
          status: 'done',
          ok: true
        })
      )
    })
  }
  return sessions
}

/**
 * 折叠成 `{轮次号 → 引用条数}`（供 `tests/demo-seed.test.ts` 核对
 * 「`retrieval.hitCount` 与这一轮的引用条数一致」）。
 *
 * ★ 为什么单开一个导出：引用**不进历史正文**（真实回看也不恢复当时的引用，
 *   见 `buildDemoSessionMessages()` 的说明），所以那份对应关系在界面上看不见 ——
 *   而它一旦对不上，信封里那句「命中 N 块」就是编的。判据必须能在单测里站住。
 */
export async function demoHistoryCitationCounts(): Promise<
  Array<{ sessionId: string; turn: number; citations: number }>
> {
  const out: Array<{ sessionId: string; turn: number; citations: number }> = []
  for (const session of DEMO_SESSIONS) {
    for (const turn of await demoHistoryTurns(session.id)) {
      out.push({ sessionId: session.id, turn: turn.turn, citations: turn.citations.length })
    }
  }
  return out
}

/**
 * 预置历史轮次的 `requestId` 前缀（**模块级常量，不要内联**）。
 *
 * ★ 它与脚本轮次的 `script-` 前缀不同（见 `stores/demoSeed.ts` 的同名常量）：
 *   任何按 `requestId` 认领轮次的逻辑都不该认领一条历史轮次 —— 那些轮次没有对应的
 *   事件流，它只是「当时留下的记录」。
 */
const HISTORY_REQUEST_PREFIX = 'hist-'

/* ------------------------------------------------------------------ *
 * 预置历史会话的正文（点开侧栏那三条中的一条能看回来）
 * ------------------------------------------------------------------ */

/** 一条恢复出来的消息（与 `channels.ts` 的 `SessionStateResult.messages` 同形）。 */
export interface DemoSessionMessage {
  role: 'user' | 'assistant'
  text: string
  at: number
  entryId: string
  /**
   * ★ 只有预置会话会给：回看时把当时那张卡片一起铺回来。
   *   与 `channels.ts` 的 `SessionStateResult.messages[].cards` **同形**（`PayloadKind`
   *   而不是裸 `string`）—— 两处形状不一致时，渲染侧那条 `restoreConversation`
   *   会在编译期报错，那正是我们要的（而不是运行期静默丢掉卡片）。
   */
  cards?: Array<{ kind: PayloadKind; payload: unknown }>
}

/**
 * 三条预置历史会话的正文（点开侧栏那三条中的一条能看回来）。
 *
 * ★★ 正文与信封**同一张表**（{@link demoHistoryTurns}）生成：三条会话各 3 轮，
 *   逐轮的原话 / 正文与 `buildDemoScript()` 下发的 `history[].turns` 一一对应。
 *   两处各写一份的话，第一次改文案就会漂移成两个故事。
 * ★★ 为什么要给历史会话也挂卡片：现场最常见的动作是「点开历史对话看一眼」——
 *   如果那三条点开全是纯文本，动画就只在「刚好放到第 1 轮」时出现，
 *   等于把这一条押在了演示者的手速上。卡片挂在那条会话的**第一轮**上
 *   （最上面一条消息就是它），用的是与脚本同一份常量（`buildAnimationCard()` 等）。
 * ★ 时间也由 {@link historyTimeline} 算：最后一条助手消息正好落在 `demo/data.ts`
 *   那条会话的 `agoMs`（侧栏写「26 小时前」，点进去最后一句也得是那个时候），
 *   而每一条助手消息落在「学生提问 + 这一轮的信封时长」上 —— 两处说的是同一件事。
 * ★ 真实会话的条目里**根本没有 `cards` 这个字段**，所以真实历史的回看仍然是纯文本 ——
 *   那一侧「不恢复当时的卡片 / 引用 / 降级档位」的决策一个字都没变。
 */
export async function buildDemoSessionMessages(sessionId: string): Promise<DemoSessionMessage[]> {
  const session = DEMO_SESSIONS.find((item) => item.id === sessionId)
  if (session === undefined) return []
  const turns = await demoHistoryTurns(sessionId)
  if (turns.length === 0) return []
  const timeline = historyTimeline(turns, session.agoMs, Date.now())
  const messages: DemoSessionMessage[] = []
  turns.forEach((turn, index) => {
    const at = timeline[index] ?? Date.now()
    // 会话内的序号（1 起）：`entryId` 是**这一条会话里的第几条**，与缓冲区的轮次号无关。
    const local = index + 1
    messages.push({ role: 'user', text: turn.studentText, at, entryId: `${sessionId}-u${local}` })
    messages.push({
      role: 'assistant',
      text: turn.answer,
      at: at + turn.totalMs,
      entryId: `${sessionId}-a${local}`,
      ...(turn.card ? { cards: [turn.card] } : {})
    })
  })
  return messages
}

/**
 * 演示里用到的三个知识点 id（**真实存在**，全部属于第 8 章「编程实践（补充）」）。
 *
 * ★ 导出它们是为了让「脚本用的 kp 一定在真实资产里」这条断言有一处可引用的真源
 *   （`tests/demo-seed.test.ts` 拿它与随包知识库的 kp 清单对照）。
 */
export const DEMO_SCRIPT_KP_IDS = [KP_LOOP, KP_VARIABLE, KP_LIST] as const

/**
 * 第 1 轮动画卡的**知识点**与**模板 id**（两个都导出，供断言引用）。
 *
 * ★ 为什么要导出这一对：模板是**点名**给的（见 {@link ANIMATION_TEMPLATE_ID}），
 *   服务端在 `templateId` 命中时不做「这份模板覆盖哪个知识点」的校验 ——
 *   于是「动画讲的知识点 == 对话与引用讲的知识点」这条判据只剩测试能守。
 *   `tests/demo-seed.test.ts` 拿这两个值去随包模板里核对 `kp_ids` / `grade_levels`。
 *   ⚠️ 只改其中一个（换了模板却没换知识点，或反过来）会让那条断言当场红 ——
 *   这正是它的用途：把「讲列表却播别的」拦在提交之前。
 */
export const DEMO_ANIMATION_KP_ID = KP_LIST
export const DEMO_ANIMATION_TEMPLATE_ID = ANIMATION_TEMPLATE_ID

/** 演示里用到的知识点名（组件要显示的是中文，不是 id）。 */
export const DEMO_KP_NAMES = {
  loop: '循环：重复的事交给机器',
  variable: '变量：给数据起名字',
  list: '列表与字典：把一批数据放在一起'
} as const
