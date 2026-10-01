/**
 * 画像标签卡（票 27）的界面状态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 三条铁律（执行报告 §5.1）在界面上的落点
 * ══════════════════════════════════════════════════════════════════════════
 *   1. L3 永远不能写 L1 —— 前端一个字节都写不了画像，它只递「撤销这一条」；
 *   2. **每个标签带来源与置信度**，界面上看得见「这是猜的，75%」
 *      （{@link SOURCE_LABELS} + confidence 的百分比）；
 *   3. **每个可撤销的标签一键可撤销** —— 但只有猜出来的那些能撤
 *      （{@link canRetract}）：学生自己说过的、系统量到的，撤了就是删证据，
 *      那不是纠错而是让界面撒谎。
 *
 * ── ★★ 不做乐观更新（这一条是本页最容易被写错的地方）────────────────────
 * 点「不对」之后**不先改界面**：等后端回执（它回的是**撤销后的完整清单**），
 * 用回执整份替换。理由：撤销是写操作，它会失败（库锁 / 服务没起来 / 那条标签
 * 已经被 TTL 清掉了）。先改界面的后果是**界面说谎** —— 学生看到标签没了，
 * 而库里它还在，下一轮模型照样按它讲。
 *
 * ── 维度分组由后端给 ────────────────────────────────────────────────────
 * 一条标签属于哪一维（1..12）由后端给（dimension）；**这一维叫什么**也由后端给
 * （载荷里的 `dimensionLabels`，键是字符串化的序号）。渲染层**一个字都不自己拼** ——
 * 自己拼就意味着在渲染进程源码里写下一批维度名，而守卫会把这些字面量当成
 * 「学生面出现内部标识」当场报出来。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  PROFILE_CARD_BRIDGE_MISSING_HINT,
  normalizeIdentity,
  normalizeProfileTags,
  normalizeTimeline,
  resolveProfileCardBridge,
  type IdentityView,
  type ProfileTagView,
  type ProfileTimelineEventView,
  type TagSource
} from '../api/profile-card'
/**
 * 三档来源的**学生话**（界面唯一实现，别在组件里再写一份）。
 *
 * ★ 措辞的原则是**说清「这个结论是谁给的」**，不评价值多少：
 *   · declared = 学生自己说的（最可信）；
 *   · observed = 系统从他的学习里量到的；
 *   · inferred = **猜的** —— 必须说出来，否则学生会把一个猜测当成事实记住。
 * ★ 一个技术词都不许有（「推断」「观察」这类词在 K12 语境里并不好懂）。
 */
export const SOURCE_LABELS: Readonly<Record<TagSource, string>> = {
  declared: '你告诉我的',
  observed: '我从你的学习里看到的',
  inferred: '我猜的'
}

/**
 * 猜出来的那些**才能撤销**。
 *
 * ★ 为什么只给猜出来的：撤销一个「学生自己说过」的标签，等于把他刚说的话
 *   从系统记忆里抹掉（他真说过，那不是错），而撤销一个「系统量到的」标签，
 *   会让界面与学习记录对不上。纠错的边界恰好是**猜测**。
 */
export function canRetract(tag: ProfileTagView): boolean {
  return tag.source === 'inferred'
}

/** 置信度的百分比写法（后端没给就回 null —— 不编一个数字出来）。 */
export function confidencePercent(tag: ProfileTagView): number | null {
  if (tag.confidence === null) return null
  return Math.round(tag.confidence * 100)
}

/** 标签卡上的一维（组标题由界面按维度序号排，中间不出现标签名）。 */
export interface TagDimensionGroup {
  dimension: number
  /** 这一维的中文小标题（**后端给的**；后端没给这一维就回空串，界面据此不渲染标题行）。 */
  title: string
  tags: ProfileTagView[]
}

export const useProfileCardStore = defineStore('profileCard', () => {
  const tags = ref<ProfileTagView[]>([])
  /**
   * 维度序号（字符串化）→ 中文小标题，**后端给**（跟随 tags 一起下发）。
   * ★ 界面从不自己写维度名；这一份是它唯一的中文来源。
   * ★ 空对象是正常态（老后端 / 桥没接全）：界面回落到「不渲染组标题」，标签照常显示。
   */
  const dimensionLabels = ref<Record<string, string>>({})
  const parentConsent = ref(true)
  const memorySwitch = ref(true)
  const identity = ref<IdentityView | null>(null)
  /**
   * 画像变化时间线（§5.2 #11）。**新的在前**（后端已排序，界面不重排）。
   * ★ 空数组是正常态：新学生还没发生过任何变化。
   */
  const timeline = ref<ProfileTimelineEventView[]>([])
  /**
   * 时间线能力**是否接上**（preload 里有没有那条方法）。
   * ★ 它与 tags 的可用性**无关**：这条读通道是后加的，缺了只让「变化」那一段不渲染，
   *   不该把标签卡一起拖下线（既有能力被新能力连坐，是本项目踩过的坑）。
   */
  const timelineAvailable = ref(false)
  /**
   * 画像小结（三期，2026-09-30）：主进程缓存里的一段中文（空串 = 还没生成过）。
   * ★ 它**不是**画像标签，而是由标签整理出来的一段话（学习档案五行结构的第五行）。
   */
  const summary = ref('')
  /** ★ 五行结构的三张表（2026-09-30，均由后端随 tags 一起下发）：
   *  行标题 / 行↔键映射 / 空态文案 —— 渲染层一个中文名都不写（双视角纪律）。 */
  const portraitRowLabels = ref<Record<string, string>>({})
  const portraitRowKeys = ref<Record<string, string[]>>({})
  const portraitEmptyNotes = ref<Record<string, string>>({})
  /** 正在撤销哪一个（用它禁用那一条的按钮；空串 = 没有在撤）。 */
  const retracting = ref('')
  /** 撤销之类写操作的失败提示（学生面，可读中文）。 */
  const notice = ref<string | null>(null)
  /** 桥整块不可用时给学生看的那句（null = 正常）。 */
  const bridgeError = ref<string | null>(null)
  /** 已经读过一次没有（用来区分「还没读」与「读到了空清单」）。 */
  const loaded = ref(false)

  /** 按维度分组的标签（组的顺序 = 维度序号；组内保持后端给的顺序）。 */
  const groups = computed<TagDimensionGroup[]>(() => {
    const map = new Map<number, ProfileTagView[]>()
    for (const tag of tags.value) {
      const list = map.get(tag.dimension)
      if (list === undefined) map.set(tag.dimension, [tag])
      else list.push(tag)
    }
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([dimension, list]) => ({
        dimension,
        // ★ 标题只从后端给的字典里取（键是字符串化序号）；取不到就空串，
        //   界面据此**整行不渲染** —— 宁可没有小标题，也不拼一个名字出来。
        title: dimensionLabels.value[String(dimension)] ?? '',
        tags: list
      }))
  })

  const hasTags = computed(() => tags.value.length > 0)

  /**
   * 五行结构的一行（2026-09-30）。
   *
   * ★ `title` / `emptyNote` 都是**后端给的现成中文**；`values` 是该行命中的标签值
   *   （按后端给的键顺序拼）。渲染层只负责摆位置，一个中文名都不写。
   */
  interface PortraitFactRow {
    /** 行 id（后端给的键：style / personality / preference / interest …）。 */
    readonly id: string
    /** 行标题（后端给；空串 = 这一行不渲染）。 */
    readonly title: string
    /** 这一行当前命中的值（可能为空数组 = 空态）。 */
    readonly values: readonly string[]
    /** 空态文案（后端给；说下一步做什么，不说「无数据」）。 */
    readonly emptyNote: string
  }

  /**
   * ★★ 五行结构的数据：把标签按**后端给的行↔键映射**分桶。
   *
   * ★ 为什么映射放后端（而不是在渲染层写死「偏好 = 这七个键」）：
   *   行的主题（类型/性格/偏好/兴趣）跨多个维度，在渲染层复制一份分组口径
   *   就是第二份真相 —— 与 `TAG_DIMENSIONS` 落在后端是同一条理由。
   * ★ 行顺序 = 后端字典的顺序（JSON 保序：类型 → 性格 → 偏好 → 兴趣）。
   * ★ 后端没给这三张表（老版本 / 桥没接全）→ 返回空数组，界面整块不渲染：
   *   新能力缺失不许拖垮既有能力（与时间线同一条纪律）。
   * ⚠️ `summary` 行**不在**这里的 `rowKeys` 中 —— 它的数据不是标签值而是 AI 小结
   *   （另一条读通道），由组件自己取；本 computed 只管标签行。
   */
  const factRows = computed<PortraitFactRow[]>(() => {
    const byKey = new Map(tags.value.map((tag) => [tag.key, tag]))
    return Object.entries(portraitRowKeys.value).map(([id, keys]) => {
      const values: string[] = []
      for (const key of keys) {
        const tag = byKey.get(key)
        if (tag !== undefined && tag.value !== '') values.push(tag.value)
      }
      return {
        id,
        title: portraitRowLabels.value[id] ?? '',
        values,
        emptyNote: portraitEmptyNotes.value[id] ?? ''
      }
    })
  })

  /**
   * 第五行（小结）的**后端文案**：标题与空态文案。
   *
   * ★ 为什么需要它：小结的**正文**来自另一条读通道（AI 生成，见 `profile-refresh`），
   *   但这一行的标题与空态文案与其余四行同源（后端字典）—— 所以在这里单独取出来，
   *   让组件不必写「行 id 是 summary」这种约定字面量。
   * ★ 行 id 是 `summary`：与 `PORTRAIT_ROW_LABELS` 的键约定一致（`PORTRAIT_ROW_KEYS`
   *   里没有它 —— 因为它取的不是标签值）。
   */
  const summaryRow = computed(() => ({
    title: portraitRowLabels.value['summary'] ?? '',
    emptyNote: portraitEmptyNotes.value['summary'] ?? ''
  }))

  /** 把一份标签载荷落进界面（**唯一的写入点**）。 */
  function applyTags(raw: unknown): void {
    const view = normalizeProfileTags(raw)
    if (view === null) return
    tags.value = view.tags
    dimensionLabels.value = view.dimensionLabels ?? {}
    portraitRowLabels.value = view.portraitRowLabels ?? {}
    portraitRowKeys.value = view.portraitRowKeys ?? {}
    portraitEmptyNotes.value = view.portraitEmptyNotes ?? {}
    parentConsent.value = view.parentConsent
    memorySwitch.value = view.memorySwitch
    loaded.value = true
  }

  /** 把一份身份载荷落进界面（开关回显与本地替换都用它）。 */
  function applyIdentity(raw: unknown): void {
    const view = normalizeIdentity(raw)
    if (view === null) return
    identity.value = view
    parentConsent.value = view.parentConsent
    memorySwitch.value = view.memorySwitch
  }

  /**
   * 读一次标签 + 身份行。
   *
   * ★ 两条**各自独立**失败：标签读到了、身份读不到时，标签卡照常显示
   *   （开关那一段只是回落到上一次的值）。合并成一条会为了一个开关
   *   把整张标签卡也拖没。
   * ★ 失败**不抛**（降级永不白屏）：桥不可用时整张卡片不出现。
   */
  async function load(): Promise<void> {
    const lookup = resolveProfileCardBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return
    }
    bridgeError.value = null
    const bridge = lookup.bridge
    try {
      timelineAvailable.value = typeof bridge.timeline === 'function'
      const [tagsResult, identityResult, timelineResult, summaryResult] = await Promise.all([
        bridge.tags().catch(() => null),
        bridge.identity().catch(() => null),
        // ★ 独立失败：时间线读不到不影响标签与开关（下一轮动作会再对齐一次）
        bridge.timeline ? bridge.timeline().catch(() => null) : Promise.resolve(null),
        // ★ 独立失败（三期）：小结读不到就保持现状 —— 界面显示后端给的空态文案
        bridge.summary ? bridge.summary().catch(() => null) : Promise.resolve(null)
      ])
      if (tagsResult !== null && tagsResult.ok) applyTags(tagsResult.data)
      if (identityResult !== null && identityResult.ok) applyIdentity(identityResult.data)
      if (summaryResult !== null && summaryResult.ok) summary.value = summaryResult.data.text
      if (timelineResult !== null && timelineResult.ok) {
        const view = normalizeTimeline(timelineResult.data)
        if (view !== null) timeline.value = view.events
      }
    } catch {
      /* 读不到就保持现状（下一轮动作会再对齐一次） */
    }
  }

  /**
   * ★★ **撤销一条标签**（点「不对」）—— **等回执再改界面**。
   *
   * @returns 一句可读中文（null = 成功）。失败时界面**一个像素都不动**。
   */
  async function retract(tag: ProfileTagView): Promise<string | null> {
    if (!canRetract(tag)) return '这条不是猜的，撤不了。'
    if (retracting.value !== '') return null
    const lookup = resolveProfileCardBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return lookup.message
    }
    retracting.value = tag.key
    notice.value = null
    try {
      const result = await lookup.bridge.retract(tag.key)
      if (!result.ok) {
        notice.value = result.message
        return result.message
      }
      // ★ 回执是**撤销之后的完整清单**，整份替换：不做「本地删掉那一条」这种
      //   局部更新 —— 局部更新会在并发（TTL 到期 / 另一条被撤）时与后端错位。
      applyTags(result.data)
      return null
    } catch {
      const message = '刚才那一下没生效，可以再试一次。'
      notice.value = message
      return message
    } finally {
      retracting.value = ''
    }
  }

  /**
   * 写两道闸（家长同意 / 记忆开关）。
   *
   * ★ 同样**等回执再改界面**（与撤销同一条纪律）。两个开关各自可以单独失败。
   */
  async function setFlags(flags: {
    parentConsent?: boolean
    memorySwitch?: boolean
  }): Promise<string | null> {
    const lookup = resolveProfileCardBridge()
    if (!lookup.ready) {
      bridgeError.value = lookup.message
      return lookup.message
    }
    notice.value = null
    try {
      const result = await lookup.bridge.setFlags(flags)
      if (!result.ok) {
        notice.value = result.message
        return result.message
      }
      applyIdentity(result.data)
      return null
    } catch {
      const message = '开关没保存上，可以再试一次。'
      notice.value = message
      return message
    }
  }

  return {
    tags,
    groups,
    dimensionLabels,
    // ★ 五行结构（2026-09-30）：行标题 / 值 / 空态文案都在这两个派生里，组件只消费它们
    factRows,
    summaryRow,
    // ★ 小结正文（三期）：五行结构第五行渲染它
    summary,
    hasTags,
    parentConsent,
    memorySwitch,
    identity,
    timeline,
    timelineAvailable,
    retracting,
    notice,
    bridgeError,
    loaded,
    load,
    retract,
    setFlags,
    bridgeMissingHint: PROFILE_CARD_BRIDGE_MISSING_HINT
  }
})
