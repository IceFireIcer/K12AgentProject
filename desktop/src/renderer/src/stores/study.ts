/**
 * 学习档案的数据状态（Pinia）：四个档案端点 + 会话 + 导出的**唯一入口**。
 *
 * 分工（与设置页同一套）：
 * - `api/study.ts`：桥接探测与纯逻辑（路径、投影、Markdown 拼装都**不在**这里）；
 * - 本文件：取数、加载态、错误文案、导出动作；
 * - `views/Study.vue` 与 `study/*Tab.vue`：只渲染，不自己发请求。
 *
 * ---------------------------------------------------------------------------
 * 三条纪律
 * ---------------------------------------------------------------------------
 * 1. ★ **失败不白屏**：每个区块有独立的 `error` 文案，取数失败显示一句可读中文
 *    （「本地数据服务没连上」这类），而不是让整页空掉。
 * 2. ★ **学生身份不由渲染进程决定**：请求里**不传** `studentId` ——
 *    主进程用 `resolveActiveStudentId()` 补上（否则就是「读别人的学习记录」）。
 *    这里只需要知道**当前学段**（章节/地图按学段查），而它来自既有的只读学段通道。
 * 3. ★ **不在渲染进程做聚合**：章节分组、连续天数、错题排序全部由 Python 给出；
 *    本文件只做「取回来 → 存进 ref → 给界面」。
 *
 * ⚠️ 导出的 Markdown **拼装**放在 `study/report-markdown.ts`（纯函数，可单测），
 *    本文件只负责把它交给主进程写盘。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { components } from '@shared/api-types'
import { resolveStudyBridge, type StudyBridge } from '../api/study'
import { composeMistakesMarkdown, composeReportMarkdown } from '../study/report-markdown'
import { todayStamp } from '../study/export-naming'
import { useKnowledgeStore } from './knowledge'
import { BRAND_NAME } from '@shared/brand'
import type { GradeLevel } from '@shared/ipc-events'

/** 四个档案端点的契约类型（**全部来自生成物**，不在这里手写一份，见 `api/study.ts`）。 */
export type LearningReport = components['schemas']['LearningReport']
export type MistakeListResponse = components['schemas']['MistakeListResponse']
export type ChapterListResponse = components['schemas']['ChapterListResponse']
export type GraphOverview = components['schemas']['GraphOverview']

/**
 * ★ **界面消费用的「字段必填」版本**（生成物里那些字段是可选的）。
 *
 * 为什么生成物是可选的：pydantic 侧给它们写了 `default_factory=list`，
 * OpenAPI 于是标成可选 —— 服务端**总会**给出它们，但类型上体现不出这一点。
 *
 * 两种应对方式都不好：① 组件里到处 `report.daily ?? []`（噪音，且漏一处就是运行时崩）；
 * ② 把生成物改成必填（那是手改生成物，防漂移链会红）。
 * 所以选第三种：store 在**验证阶段**就把缺的字段补成空数组/空对象，
 * 然后用这里的交叉类型告诉 TS「这些字段一定有」。补默认值这件事**只有一处**。
 */
export type ReportView = LearningReport & {
  daily: NonNullable<LearningReport['daily']>
  mastery: NonNullable<LearningReport['mastery']>
  chapters: NonNullable<LearningReport['chapters']>
  gradeHistory: NonNullable<LearningReport['gradeHistory']>
  badges: NonNullable<LearningReport['badges']>
  stageCounts: NonNullable<LearningReport['stageCounts']>
}

/** 错题本同上（`items` 在生成物里可选，服务端总会给）。 */
export type MistakesView = MistakeListResponse & {
  items: NonNullable<MistakeListResponse['items']>
}

/** 章节清单同上。 */
export type ChaptersView = ChapterListResponse & {
  chapters: NonNullable<ChapterListResponse['chapters']>
}

/** 依赖图全览同上。 */
export type GraphView = GraphOverview & {
  nodes: NonNullable<GraphOverview['nodes']>
  edges: NonNullable<GraphOverview['edges']>
}

/**
 * 会话两个类型**不在 pydantic 契约里**（Pi 的会话数据只存在于 TS 侧，
 * 与 `provider-catalog.ts` 那条「唯一例外」同一性质）。这里手写**最小**形状：
 * 只声明界面真正消费的字段，主进程那边的权威定义在 `main/study/sessions.ts`。
 */
export interface SessionSummaryShape {
  id: string
  title: string
  messageCount: number
  modifiedAt: number
  createdAt: number
  preview: string
  /**
   * ★★ 从哪条会话分出来的（`null` = 独立会话，不是分支）。
   *
   * 它是**分支关系**（Pi 在新会话文件头里记的 `parentSession`）——
   * 侧栏据此把会话画成一棵树。
   */
  parentId?: string | null
  /** 父会话的标题（父不在本列表里时为 `null`；仅用于展示）。 */
  parentTitle?: string | null
  /**
   * ★★ **树里的层级**（0 = 根）—— 侧栏按它缩进。
   *
   * ⚠️ 这三个字段是**可选**的：`session:list` 与它同源，但历史数据 / 旧响应里
   * 可能没有（本轮之前主进程回的是扁平列表）。组件对缺失值有降级（见
   * `SessionList.vue` 的 `depthOf()`）——「没有树信息」应当表现为**平铺**，
   * 而不是渲染出一堆 `undefined`。
   */
  depth?: number
  /** 直接子分支数（> 0 才给展开/收起箭头）。 */
  childCount?: number
  /** 是不是同层最后一个（决定画 `└` 还是 `├`）。 */
  isLast?: boolean
  /** 每个祖先层要不要画竖线（长度 = `depth`）。 */
  guides?: boolean[]
}

export interface SessionTranscriptShape {
  id: string
  title: string
  messages: Array<{ role: 'user' | 'assistant'; text: string; at: number }>
  truncated: number
}

export interface SessionSearchHitShape {
  id: string
  title: string
  snippet: string
  modifiedAt: number
}

/** 报告时间窗（界面上的三个选项；后端上限 90）。 */
export const REPORT_DAY_OPTIONS = [7, 14, 30] as const

export const useStudyStore = defineStore('study', () => {
  /** 知识点名索引（导出报告时把 kpId 换成中文名 —— 见 `exportReport` 的说明）。 */
  const knowledge = useKnowledgeStore()
  const report = ref<ReportView | null>(null)
  const reportDays = ref<number>(7)
  const mistakes = ref<MistakesView | null>(null)
  const chapters = ref<ChaptersView | null>(null)
  const graph = ref<GraphView | null>(null)

  /**
   * ★★ 错题本的**过期标记**（本轮修掉的真实缺陷：错题本读到之后永远不会再读）。
   *
   * 缺陷形态：写入侧一直是好的（每次判分都往 `learning_history` 落一条
   * `is_correct = 0/1` 的流水），坏的是读取侧 —— `loadMistakes()` 过去只被
   * `loadAll()` 调一次，而 `loadAll()` 只在 `views/Study.vue` 的 `onMounted` 里跑；
   * 那个视图挂在 `<KeepAlive>` 里（`App.vue`），切走**不卸载**、切回也**不重挂**。
   * 于是学生答错一题、回到学习档案，看到的是**逐字节相同**的旧错题本
   * （相当一部分学生会认为「这次错的题没记上」）。
   *
   * 修法两条，都在本 store 里，**不动别的 store**：
   *   ① `loadMistakes()` 自带缓存判据：有数据、且没过期就直接返回 ——
   *      于是它可以被「进档案页 / 每次切回档案页 / 切到错题本分页」反复调用，
   *      既不重复打请求，也不会把列表与加载态抖三遍；
   *   ② `invalidateMistakes()` 只翻这个标记、**不发请求**：谁观察到「刚判过分」，
   *      谁就翻它，真正的取数留给下一次需要时那一处（一处取数，不会并发抢写）。
   *      当前调用点：`views/Study.vue`（对话内题卡出现新批改结果时翻标记）。
   *      ⚠️ 闯关页判分（`stores/quiz.ts` 的 `submit`）那条路**没有**翻标记，
   *      它由「切回档案页时补一次」兜住（见 `views/Study.vue` 的 `onActivated`）——
   *      正确性不依赖它，只少一次触发。
   */
  const mistakesStale = ref(false)

  /** 每个区块自己的加载态（互不阻塞：地图慢不该让报告转圈）。 */
  const loading = ref<Record<'report' | 'mistakes' | 'chapters' | 'graph', boolean>>({
    report: false,
    mistakes: false,
    chapters: false,
    graph: false
  })
  /** 每个区块自己的错误文案（可读中文）。 */
  const errors = ref<Record<'report' | 'mistakes' | 'chapters' | 'graph', string | null>>({
    report: null,
    mistakes: null,
    chapters: null,
    graph: null
  })

  const sessions = ref<SessionSummaryShape[]>([])
  const sessionsLoading = ref(false)
  const sessionsError = ref<string | null>(null)
  const searchQuery = ref('')
  const searchHits = ref<SessionSearchHitShape[] | null>(null)

  const exporting = ref(false)
  const exportNotice = ref<string | null>(null)

  /** 桥接是否可用（`window.api` 上那批方法在不在）。 */
  const bridge = ref<StudyBridge | null>(null)
  const bridgeError = ref<string | null>(null)

  /** 正在飞的章节请求对应的学段（见 `loadChapters` 的第 ② 条保护）。**非响应式**。 */
  let chaptersInFlight: GradeLevel | null = null

  /** 正在飞的错题请求（同上：三个挂载点会同时触发，**非响应式**）。 */
  let mistakesInFlight: Promise<void> | null = null

  function ensureBridge(): StudyBridge | null {
    if (bridge.value) return bridge.value
    const lookup = resolveStudyBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return null
    }
    bridgeError.value = null
    bridge.value = lookup.bridge
    return lookup.bridge
  }

  /**
   * 统一的取数包装：置加载态 → 调桥 → 成功写 ref / 失败写可读文案。
   *
   * ★ `data` 是 `unknown`（主进程只搬运，见 `main/study/client.ts` 的注释）；
   *   这里按契约类型断言之前**先做一次结构检查** —— 直接 `as T` 会把
   *   「后端换了字段形状」这类漂移吞掉，界面随后渲染出 `undefined`。
   */
  async function load<T>(
    key: 'report' | 'mistakes' | 'chapters' | 'graph',
    run: (bridge: StudyBridge) => Promise<{ ok: true; data: unknown } | { ok: false; message: string }>,
    accept: (data: unknown) => T | null,
    assign: (value: T) => void
  ): Promise<void> {
    const api = ensureBridge()
    if (!api) {
      errors.value[key] = bridgeError.value ?? '学习档案还没接线。'
      return
    }
    loading.value[key] = true
    errors.value[key] = null
    try {
      const result = await run(api)
      if (!result.ok) {
        errors.value[key] = result.message
        return
      }
      const parsed = accept(result.data)
      if (parsed === null) {
        // ★ 学生话。原来的「（契约可能已变化）」是开发者的判断（pydantic 契约漂移），
        //   学生读到只会以为自己点坏了什么 —— 具体原因进日志，界面只说「取不到」。
        console.warn('[study] 本地数据服务的返回结构不符合预期（契约可能已变化）', key)
        errors.value[key] = '这份数据暂时取不到，稍后再试试。'
        return
      }
      assign(parsed)
    } catch (error) {
      // 桥本身抛异常（极少数：preload 被替换）：也变成一句可读中文，不让整页崩
      errors.value[key] = `加载失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      loading.value[key] = false
    }
  }

  /** 读学习报告（`days` 省略时用当前选定的天数）。 */
  async function loadReport(days?: number): Promise<void> {
    if (days !== undefined) reportDays.value = days
    await load(
      'report',
      (api) => api.readStudyReport({ days: reportDays.value }),
      (data) => readReport(data),
      (value) => {
        report.value = value
      }
    )
  }

  /**
   * 读错题本。
   *
   * ★ **幂等**（与 `loadChapters` 同一思路）：数据已在手上、且没有过期标记时不发请求。
   *   这一条是必须的 —— 它会被反复调用（进档案页的 `loadAll`、每次切回档案页、
   *   切到「错题本」分页各一次，见 `views/Study.vue`）。
   * ★ `force = true` 是**手动刷新**（错题本工具栏上的「刷新」按钮）的入口。
   * ★ 失败时**保留过期标记**：下一次进入还会再试一次，而不是把「读失败」缓存住。
   */
  async function loadMistakes(force = false): Promise<void> {
    // 同一份请求已在飞 → 直接复用（三个挂载点可能同时触发，见 `mistakesInFlight`）
    if (mistakesInFlight) return await mistakesInFlight
    if (!force && mistakes.value !== null && !mistakesStale.value) return
    const request = (async () => {
      await load(
        'mistakes',
        (api) => api.readStudyMistakes(),
        (data) => readWithDefaults<MistakesView>(data, ['items'], ['items']),
        (value) => {
          mistakes.value = value
          // 只有**成功**才清过期标记：读失败时保持过期，下一次进入还会再试一次
          // （把一次网络抖动缓存成「错题本就是空的」是最难查的一类假数据）。
          mistakesStale.value = false
        }
      )
    })()
    mistakesInFlight = request
    try {
      await request
    } finally {
      // 只清掉**仍然登记在案**的那一次（与 `stores/quiz.ts` 的取题收尾同一手法：
      // 迟到的旧请求不该把新请求的登记项抹掉，否则下一次调用会多发一份）
      if (mistakesInFlight === request) mistakesInFlight = null
    }
  }

  /** 把错题本标记为过期（**只翻标记，不发请求**）。见 `mistakesStale` 的注释。 */
  function invalidateMistakes(): void {
    mistakesStale.value = true
  }

  /**
   * 读章节清单。
   *
   * ⚠️ 必须带上**当前学段**：章节是按学段分的（四学段各自的目录不同）。
   *    学段来自 `chat.currentGrade`（系统推断的只读结果），拿不到就不发请求 ——
   *    编一个默认学段去查会显示**别的学段**的章节，比空着更糟。
   *
   * ★ 两处调用者共用这一条取数路径：学习档案页的「章节进度」分页，
   *   以及对话页顶栏的**章节指示器**（学生选章节时要看到当前学段的章节目录）。
   *   所以这里多三条保护（都不改变成功路径的行为）：
   *   ① **同一学段已经读到过就不再取**：`Study.vue` 每次进入档案页都会 `loadAll(...)`，
   *      重复取数会把加载态与列表再抖一遍（缓存命中时直接返回，连加载态都不翻）；
   *   ② **同一学段的请求已在飞就不再发一份**：三个视图都挂在 `<KeepAlive>` 里，
   *      学段一变可能有两个挂载中的视图**同时**触发同一份取数（档案页 + 设置页各一个 watch）；
   *   ③ **学段缺失时只在「还没有任何清单」的时候写那句提示**：这句文案进的是
   *      档案页共用的错误槽（`errors.chapters`），把上一次**成功**读到的清单报成错，
   *      学生会以为档案坏了 —— 而没有清单时这仍是档案页要显示的正确提示。
   */
  async function loadChapters(gradeLevel: GradeLevel | null): Promise<void> {
    if (!gradeLevel) {
      if (chapters.value === null) errors.value.chapters = '还没判定出学段，暂时无法列出教材章节。'
      return
    }
    // 已读到过同一学段的清单（服务端会回显请求的学段）→ 直接用，不重复请求
    if (chapters.value?.gradeLevel === gradeLevel) return
    // 同一学段的请求还在飞（另一个挂载中的视图刚发起过）→ 结果会落到同一个 ref，不必再发
    if (chaptersInFlight === gradeLevel) return

    chaptersInFlight = gradeLevel
    try {
      await load(
        'chapters',
        (api) => api.readStudyChapters({ gradeLevel }),
        (data) => readWithDefaults<ChaptersView>(data, ['chapters'], ['chapters']),
        (value) => {
          chapters.value = value
        }
      )
    } finally {
      chaptersInFlight = null
    }
  }

  /** 读依赖图全览（学习地图）。同样依赖当前学段。 */
  async function loadGraph(gradeLevel: GradeLevel | null): Promise<void> {
    if (!gradeLevel) {
      errors.value.graph = '还没判定出学段，暂时无法画学习地图。'
      return
    }
    await load(
      'graph',
      (api) => api.readStudyGraph({ gradeLevel }),
      (data) => readWithDefaults<GraphView>(data, ['nodes', 'edges'], ['nodes', 'edges']),
      (value) => {
        graph.value = value
      }
    )
  }

  /** 一次性把四个区块都拉起来（进入「学习档案」时调；四个请求互不依赖）。 */
  async function loadAll(gradeLevel: GradeLevel | null): Promise<void> {
    await Promise.all([
      loadReport(),
      loadMistakes(),
      loadChapters(gradeLevel),
      loadGraph(gradeLevel)
    ])
  }

  /* ---------------------------------------------------------------- 会话 */

  async function loadSessions(): Promise<void> {
    const api = ensureBridge()
    if (!api) {
      sessionsError.value = bridgeError.value ?? '历史会话还没接线。'
      return
    }
    sessionsLoading.value = true
    sessionsError.value = null
    try {
      const result = await api.listSessions()
      if (!result.ok) {
        sessionsError.value = result.message
        return
      }
      const parsed = readArray<SessionSummaryShape>(result.data)
      if (parsed === null) {
        sessionsError.value = '会话列表的结构不符合预期。'
        return
      }
      sessions.value = parsed
    } catch (error) {
      sessionsError.value = `读取历史会话失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      sessionsLoading.value = false
    }
  }

  /**
   * 搜索历史会话。
   *
   * ★ 空查询 → 清掉结果（**不是**「返回全部」）：界面上「清空搜索框」应当是
   *   「回到未搜索状态」，而不是突然列出一堆命中。
   */
  async function search(rawQuery: string): Promise<void> {
    searchQuery.value = rawQuery
    const query = rawQuery.trim()
    if (!query) {
      searchHits.value = null
      return
    }
    const api = ensureBridge()
    if (!api) {
      sessionsError.value = bridgeError.value ?? '历史会话还没接线。'
      return
    }
    try {
      const result = await api.searchSessions({ query })
      if (!result.ok) {
        sessionsError.value = result.message
        return
      }
      searchHits.value = readArray<SessionSearchHitShape>(result.data) ?? []
    } catch (error) {
      sessionsError.value = `搜索失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  /**
   * 读一条会话的正文（**只传 id** —— 主进程据此做白名单对齐，见 `main/study/sessions.ts`）。
   */
  async function readTranscript(sessionId: string): Promise<SessionTranscriptShape | null> {
    const api = ensureBridge()
    if (!api) {
      sessionsError.value = bridgeError.value ?? '历史会话还没接线。'
      return null
    }
    try {
      const result = await api.readSessionTranscript(sessionId)
      if (!result.ok) {
        sessionsError.value = result.message
        return null
      }
      return readTranscriptShape(result.data)
    } catch (error) {
      sessionsError.value = `读取会话失败：${error instanceof Error ? error.message : String(error)}`
      return null
    }
  }

  /* ---------------------------------------------------------------- 导出 */

  /**
   * 导出学习报告为 Markdown 文件。
   *
   * ★ 拼装是**纯函数**（`study/report-markdown.ts`），主进程只负责写盘；
   * ★ 学生取消保存时**不显示错误**（`canceled` 是正常路径）。
   * ★★ 导出前先 `ensureNames()` 并把 `kpId → 中文名` 传进拼装函数：
   *   报告里的掌握度表**只有 kpId**（契约的 `Mastery` 结构上没有名字），
   *   而这份文件是给家长看的 —— `prog-loop-jr` 对他们和乱码没有区别。
   *   名字取不到时不阻拦导出（退回「id（知识点编号）」，与既有口径一致）：
   *   一次取名失败不该让「导出」整个失效。
   * ★★ **文件名不带内部学生 id**（P2-2）：此前是 `学习报告-student_001-14天.md`，
   *   而 `student_001` 是**内部主键** —— 学生面不该出现它（D-063 双视角纪律）。
   *   改成与依赖边导出同一套口径（品牌 + 对象 + 日期）：`智团团-学习报告-20260926.md`。
   *   天窗（7/14/30 天）仍在**文件名里**，因为它是这份文件唯一区分彼此的信息。
   */
  async function exportReport(): Promise<void> {
    if (!report.value) return
    try {
      await knowledge.ensureNames()
    } catch {
      // 取名字失败只影响表格那一列的可读性，不影响导出本身
    }
    await runExport(
      `${BRAND_NAME}-学习报告-${reportDays.value}天-${todayStamp()}.md`,
      () => composeReportMarkdown(report.value!, reportDays.value, undefined, knowledge.kpIndex)
    )
  }

  /**
   * 导出错题本。
   *
   * ★ 同 P2-2：文件名去掉内部学生 id（`错题本-student_001.md` → `智团团-错题本-20260926.md`）。
   */
  async function exportMistakes(): Promise<void> {
    if (!mistakes.value) return
    await runExport(`${BRAND_NAME}-错题本-${todayStamp()}.md`, () =>
      composeMistakesMarkdown(mistakes.value!)
    )
  }

  async function runExport(fileName: string, compose: () => string): Promise<void> {
    const api = ensureBridge()
    if (!api) {
      exportNotice.value = bridgeError.value ?? '导出还没接线。'
      return
    }
    exporting.value = true
    exportNotice.value = null
    try {
      const result = await api.exportMarkdown({ fileName, content: compose() })
      if (result.ok) {
        exportNotice.value = `已导出：${result.fileName}`
      } else if (result.canceled) {
        // 取消不是错误：不显示任何提示（学生自己按的取消）
        exportNotice.value = null
      } else {
        exportNotice.value = result.message
      }
    } catch (error) {
      exportNotice.value = `导出失败：${error instanceof Error ? error.message : String(error)}`
    } finally {
      exporting.value = false
    }
  }

  const hasAnyError = computed(
    () =>
      errors.value.report ??
      errors.value.mistakes ??
      errors.value.chapters ??
      errors.value.graph ??
      sessionsError.value ??
      bridgeError.value
  )

  return {
    report,
    reportDays,
    mistakes,
    /** ★ 错题本是否已被标记为过期（界面一般不需要读它，`loadMistakes()` 自己会判断）。 */
    mistakesStale,
    chapters,
    graph,
    loading,
    errors,
    sessions,
    sessionsLoading,
    sessionsError,
    searchQuery,
    searchHits,
    exporting,
    exportNotice,
    bridgeError,
    hasAnyError,
    loadReport,
    loadMistakes,
    /** ★ 标记错题本过期（只翻标记；下一次 `loadMistakes()` 才会真的重取）。 */
    invalidateMistakes,
    loadChapters,
    loadGraph,
    loadAll,
    loadSessions,
    search,
    readTranscript,
    exportReport,
    exportMistakes
  }
})

/* ------------------------------------------------------------------ *
 * 结构检查（不信任 `unknown`：契约漂移要在这里就被挡住，而不是渲染出 undefined）
 * ------------------------------------------------------------------ */

/** 对象 + 指定字段存在（**只查一层**：够用且不会因为后端加字段而误判）。 */
function readObject<T>(data: unknown, requiredKeys: string[]): T | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  if (!requiredKeys.every((key) => key in record)) return null
  return data as T
}

/**
 * 对象 + 必填字段存在，并把**指定字段**在缺失时补成空数组。
 *
 * ★ 与 {@link readObject} 的分工：这个是「列表型区块」用的（错题 / 章节 / 地图），
 *   它们的容器字段在生成物里可选，而组件要直接 `.length` / `.map`。
 *   补默认值只有这一处（`?? []` 散在模板里漏一处就是运行时崩）。
 */
function readWithDefaults<T>(data: unknown, requiredKeys: string[], listKeys: string[]): T | null {
  const value = readObject<T>(data, requiredKeys)
  if (!value) return null
  const record = value as Record<string, unknown>
  for (const key of listKeys) {
    if (record[key] === undefined) record[key] = []
  }
  return value
}

/** 数组检查（会话列表 / 搜索结果）。 */
function readArray<T>(data: unknown): T[] | null {
  return Array.isArray(data) ? (data as T[]) : null
}

/**
 * 报告的检查**比其他区块严**：它是唯一一个界面要按字段逐个渲染的（表格 + 统计）。
 * 少一个字段会在界面上表现为一个空白格子，比整块报错更难发现。
 */
function readReport(data: unknown): ReportView | null {
  const required = [
    'studentId',
    'gradeLevel',
    'days',
    'daily',
    'mastery',
    'chapters',
    'stageCounts',
    'gradeHistory',
    'streakDays',
    'totalActivities',
    'quizTotal',
    'quizCorrect',
    'badges'
  ]
  const value = readObject<LearningReport>(data, required)
  if (!value) return null
  // ★ 这几个在生成物里是**可选**的（pydantic 给了 `default_factory`，服务端总会给，
  //   但 OpenAPI 标成可选）。补默认值只有这一处，组件里因此不必写 `?? []`
  //   （见 `ReportView` 的注释：不这么做就得在模板里到处兜底，漏一处就是运行时崩）。
  return {
    ...value,
    daily: value.daily ?? [],
    mastery: value.mastery ?? [],
    chapters: value.chapters ?? [],
    gradeHistory: value.gradeHistory ?? [],
    badges: value.badges ?? [],
    stageCounts: value.stageCounts ?? {}
  }
}

/** 会话正文的形状检查（消息数组 + role 只认两个值）。 */
function readTranscriptShape(data: unknown): SessionTranscriptShape | null {
  const value = readObject<SessionTranscriptShape>(data, ['id', 'messages'])
  if (!value) return null
  if (!Array.isArray(value.messages)) return null
  const ok = value.messages.every(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.text === 'string'
  )
  return ok ? value : null
}
