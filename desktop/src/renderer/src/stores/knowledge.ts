/**
 * 教材知识库（Pinia）：体检数字 / 知识点清单 / 导入 / 重建。
 *
 * ★★ 本 store 是全应用**唯一会写知识库**的地方，两条写路径都是重活：
 *   - `importKnowledge`：校验（格式 + 学段错位自检）→ 落盘 → 可选重建；
 *   - `rebuildKnowledge`：分块 + 嵌入整份教材（实测 ~7s，教材变多会更久）。
 *   两者在主进程侧都用**长超时**（180s）—— 用默认 8s 会把一次成功的重建
 *   报成「操作失败：响应超时」，而库其实已经写好了（最难查的一类假失败）。
 *
 * ★ 导入回执的形状值得注意：`{ok:true, data:{ok:false, problems:[…]}}`
 *   —— **HTTP 成功但内容被拒**。那是内容问题（缺文件头 / kp_id 与文件名不一致 /
 *   学段错位 / 超纲术语），界面要在同一张卡片里**逐条**列出来。
 *   本 store 因此把 `problems` 原样带出来，不折叠成一句话。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import {
  resolveDataBridge,
  type KnowledgeImportView,
  type KnowledgePointsView,
  type KnowledgeStatsView
} from '../api/data'

/** 导入的三态：还没试 / 校验被拒 / 已接收（可能重建失败）。 */
export type ImportPhase = 'idle' | 'rejected' | 'accepted'
/** 重建的三态。 */
export type RebuildPhase = 'idle' | 'running' | 'done' | 'failed'

export const useKnowledgeStore = defineStore('knowledge', () => {
  const stats = ref<KnowledgeStatsView | null>(null)
  const statsLoading = ref(false)
  const statsError = ref<string | null>(null)

  const points = ref<KnowledgePointsView | null>(null)
  const pointsLoading = ref(false)
  const pointsError = ref<string | null>(null)
  /** 表格的学段过滤（空串 = 全部学段）。 */
  const gradeFilter = ref('')

  /** 导入状态。 */
  const importPhase = ref<ImportPhase>('idle')
  const importing = ref(false)
  const importProblems = ref<string[]>([])
  const importMessage = ref('')
  const importedFile = ref<{ name: string; sizeKb: number } | null>(null)

  /** 重建状态。 */
  const rebuildPhase = ref<RebuildPhase>('idle')
  const rebuildMessage = ref('')
  const indexedAt = ref<string | null>(null)
  const lastElapsedMs = ref<number | null>(null)

  const bridgeError = ref<string | null>(null)
  /** 非响应式：并发取数只发一次（统计与清单会同时被挂载）。 */
  let statsInFlight: Promise<void> | null = null
  let pointsInFlight: Promise<void> | null = null

  /** 知识点总数（统计卡的第一格）。 */
  const knowledgePointCount = computed(
    () => stats.value?.counts?.kp ?? points.value?.points?.length ?? 0
  )
  /** 分块总数（父子都算；`counts.chunk` 是权威）。 */
  const chunkCount = computed(() => stats.value?.counts?.chunk ?? 0)
  /** 依赖边数。 */
  const dependencyCount = computed(() => stats.value?.counts?.dependencies ?? 0)
  /** 当前用的是不是**用户重建**的那一份（学生最想确认的就是这个）。 */
  const userRebuilt = computed(() => stats.value?.userRebuilt === true)
  /** 向量引擎是否可用（false = 检索只能走关键词 / 大纲降级）。 */
  const vecReady = computed(() => stats.value?.vecReady === true)
  /** 有内容的学段数。 */
  const gradeCount = computed(() => stats.value?.gradeLevels?.length ?? 0)

  /** 表格行（按学段过滤；**排序保持服务端的教材顺序**，不在这里重排）。 */
  const filteredPoints = computed(() => {
    const rows = points.value?.points ?? []
    const filter = gradeFilter.value
    return filter ? rows.filter((row) => row.gradeLevel === filter) : rows
  })

  /** 导入是否「内容被拒」（界面据此显示逐条原因 + 不显示成功态）。 */
  const importRejected = computed(() => importPhase.value === 'rejected')

  /**
   * 知识点 id → 显示名 的索引。
   *
   * ★ 存在的理由：画像端点只回 `kpId`（掌握度是纯数据），而界面要说「决策树 42%」。
   *   名字的唯一来源是 `kb.sqlite` 的 `kp` 表 —— 也就是本 store 的 `points`。
   * ★ 别的 store（右栏、档案页、闯关页）都从这里取，**不各存一份名字表**：
   *   教材改一次名字，两张表就对不上了。
   */
  const kpIndex = computed(() => {
    const map = new Map<string, string>()
    for (const row of points.value?.points ?? []) {
      if (row.name) map.set(row.kpId, row.name)
    }
    return map
  })

  /** 取知识点显示名；拿不到回 `null`（调用方回退显示 id，**不编名字**）。 */
  function kpNameOf(kpId: string): string | null {
    return kpIndex.value.get(kpId) ?? null
  }

  /**
   * 确保名字索引可用（幂等）。
   *
   * ★ 有些页面（对话右栏）只为了显示几个名字，不该自己管 loading ——
   *   它们调这个，本 store 决定要不要真的发请求。
   */
  async function ensureNames(): Promise<void> {
    if (points.value === null && !pointsLoading.value) await loadPoints()
  }

  async function loadStats(force = false): Promise<void> {
    if (statsInFlight) return await statsInFlight
    if (stats.value !== null && !force) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    statsLoading.value = true
    statsError.value = null
    statsInFlight = (async () => {
      try {
        const result = await lookup.bridge.readKnowledgeStats()
        if (result.ok) stats.value = result.data as KnowledgeStatsView
        else statsError.value = result.message
      } catch (thrown) {
        statsError.value = thrown instanceof Error ? thrown.message : String(thrown)
      } finally {
        statsLoading.value = false
        statsInFlight = null
      }
    })()
    await statsInFlight
  }

  async function loadPoints(force = false): Promise<void> {
    if (pointsInFlight) return await pointsInFlight
    if (points.value !== null && !force) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    pointsLoading.value = true
    pointsError.value = null
    pointsInFlight = (async () => {
      try {
        // ★ 不带学段过滤：一次取全，过滤在**界面层**（`filteredPoints`）。
        //   每切一次学段就重发一次请求，换来的只是一个本地就能做的筛选。
        const result = await lookup.bridge.readKnowledgePoints({})
        if (result.ok) points.value = result.data as KnowledgePointsView
        else pointsError.value = result.message
      } catch (thrown) {
        pointsError.value = thrown instanceof Error ? thrown.message : String(thrown)
      } finally {
        pointsLoading.value = false
        pointsInFlight = null
      }
    })()
    await pointsInFlight
  }

  async function loadAll(force = false): Promise<void> {
    await Promise.all([loadStats(force), loadPoints(force)])
  }

  /**
   * 导入一份教材 Markdown。
   *
   * @param input.fileName 决定 kp_id（约定「文件名 = kp_id.md」）
   * @param input.markdown 全文（含 `---` 文件头）
   *
   * ★ 主进程会先挡路径分隔符与超大内容（两道都要有：Python 侧还会再校验一次）。
   * ★ 成功时顺手刷新统计与清单 —— 刚导入的知识点应该立刻出现在表格里。
   */
  async function importMarkdown(input: {
    fileName: string
    markdown: string
    gradeLevel?: GradeLevel
    rebuild?: boolean
  }): Promise<void> {
    if (importing.value) return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    importing.value = true
    importPhase.value = 'idle'
    importProblems.value = []
    importMessage.value = ''
    importedFile.value = { name: input.fileName, sizeKb: Math.max(1, Math.round(input.markdown.length / 1024)) }
    try {
      const result = await lookup.bridge.importKnowledge({
        fileName: input.fileName,
        markdown: input.markdown,
        ...(input.gradeLevel ? { gradeLevel: input.gradeLevel } : {}),
        ...(typeof input.rebuild === 'boolean' ? { rebuild: input.rebuild } : {})
      })
      if (!result.ok) {
        // 传输层失败（sidecar 没起来 / 超时）—— 与「内容被拒」不是一回事
        importPhase.value = 'rejected'
        importProblems.value = [result.message]
        return
      }
      const data = result.data as KnowledgeImportView
      importMessage.value = data.message
      if (data.ok) {
        importPhase.value = 'accepted'
      } else {
        // ★ 内容被拒：逐条列出原因（缺文件头 / kp_id 不符 / 学段错位 / 超纲术语）
        importPhase.value = 'rejected'
        importProblems.value = data.problems ?? []
      }
      if (data.stats) stats.value = data.stats
      await loadAll(true)
    } catch (thrown) {
      importPhase.value = 'rejected'
      importProblems.value = [thrown instanceof Error ? thrown.message : String(thrown)]
    } finally {
      importing.value = false
    }
  }

  /**
   * 重建索引（长任务）。
   *
   * ★ 完成后必须刷新统计：重建回执里的 `stats` 是**重建后**的，
   *   把它直接落进 store 比再发一次请求更准（中间可能又有别的写入）。
   * ★ 失败时保留上一次的统计（不清空）——“重建失败”不该让页面变成「知识库是空的」。
   */
  async function rebuild(): Promise<void> {
    if (rebuildPhase.value === 'running') return
    const lookup = resolveDataBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    rebuildPhase.value = 'running'
    rebuildMessage.value = ''
    try {
      const result = await lookup.bridge.rebuildKnowledge()
      if (!result.ok) {
        rebuildPhase.value = 'failed'
        rebuildMessage.value = result.message
        return
      }
      const data = result.data as {
        ok: boolean
        message: string
        elapsedMs: number
        stats: KnowledgeStatsView | null
      }
      lastElapsedMs.value = typeof data.elapsedMs === 'number' ? data.elapsedMs : null
      if (data.ok) {
        rebuildPhase.value = 'done'
        rebuildMessage.value = data.message
        if (data.stats) stats.value = data.stats
        indexedAt.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
        await loadPoints(true)
      } else {
        rebuildPhase.value = 'failed'
        rebuildMessage.value = data.message
      }
    } catch (thrown) {
      rebuildPhase.value = 'failed'
      rebuildMessage.value = thrown instanceof Error ? thrown.message : String(thrown)
    }
  }

  /** 收起导入反馈卡。 */
  function dismissImport(): void {
    importPhase.value = 'idle'
    importProblems.value = []
    importMessage.value = ''
    importedFile.value = null
  }

  return {
    stats,
    statsLoading,
    statsError,
    points,
    pointsLoading,
    pointsError,
    gradeFilter,
    importPhase,
    importing,
    importProblems,
    importMessage,
    importedFile,
    importRejected,
    rebuildPhase,
    rebuildMessage,
    indexedAt,
    lastElapsedMs,
    bridgeError,
    knowledgePointCount,
    chunkCount,
    dependencyCount,
    userRebuilt,
    vecReady,
    gradeCount,
    filteredPoints,
    kpIndex,
    kpNameOf,
    ensureNames,
    loadStats,
    loadPoints,
    loadAll,
    importMarkdown,
    rebuild,
    dismissImport
  }
})
