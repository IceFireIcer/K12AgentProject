/**
 * 主题（学段 × 饱和度）状态。
 *
 * ── 配色为什么跟着学段走 ────────────────────────────────────────────────
 * 「界面随学段自适应」是评分表上的明文项。学段一变，整站的强调色、页面底色
 * 与卡片配色一起换 —— 学生能直接看出「系统在按我的年级讲」。
 *
 * ── 学段的唯一来源是服务端 ──────────────────────────────────────────────
 * ★ 本 store **不推断**、也不持久化学段：真值来自 `stores/chat.ts` 的
 *   `currentGrade`（服务端推断 → `grade:changed` 推送 → store）。
 *   两处各存一份就会漂移（界面上是初中配色，回答却按小学讲）。
 * ★ 学段是 `default`（还没判出来）时用中性配色，**不拿冷启动默认值冒充判定结果**。
 *
 * ── 设计系统页的「预览」不是学生的学段 ──────────────────────────────────
 * 配色总览 / 四学段对照两页要**同时**展示多组配色，所以它们需要临时切配色。
 * 那是**预览**（`previewGrade`），只影响这两页的显示，既不写库也不动学生的学段 ——
 * 以前叫 `devMode`，那个名字会让人以为「开了就能改自己的学段」，已经改掉。
 */

import { defineStore } from 'pinia'
import { computed, ref, watchEffect } from 'vue'
import type { GradeLevel } from '@shared/ipc-events'
import { useChatStore } from './chat'

/** 配色轴上的学段键。⚠️ 用连字符（CSS 口味），与契约的下划线写法见 {@link GRADE_AXIS_OF}。 */
export type GradeKey = 'primary-low' | 'primary-high' | 'junior' | 'senior' | 'default' | 'brand'
export type SatKey = 'vivid' | 'soft' | 'mono'

export interface GradeMeta {
  key: GradeKey
  /** 面向学生的学段名 */
  label: string
  /** 学段认知定位（执行文档 §10.5） */
  layer: string
  /** System Prompt 语气 */
  tone: string
}

/** 四学段 + 两个设计系统专用档（default/brand 不对应真实学段）。 */
export const GRADES: GradeMeta[] = [
  { key: 'primary-low', label: '小学低年级', layer: '感知层', tone: '童话拟人' },
  { key: 'primary-high', label: '小学高年级', layer: '体验感知层', tone: '通俗 + 鼓励' },
  { key: 'junior', label: '初中', layer: '原理算法层', tone: '严谨逻辑' },
  { key: 'senior', label: '高中', layer: '工程实践层', tone: '工程化' },
  { key: 'default', label: '默认（设计系统）', layer: '—', tone: '—' },
  { key: 'brand', label: '品牌绿（设计系统）', layer: '—', tone: '—' }
]

export const SATS: { key: SatKey; label: string; desc: string }[] = [
  { key: 'vivid', label: '高饱和', desc: '低龄优先，色彩辨识度最高' },
  { key: 'soft', label: '柔和', desc: '浅底浅强调，长时间阅读友好' },
  { key: 'mono', label: '素净', desc: '去色为主，强调色只作点缀' }
]

/** 契约（下划线）→ 配色轴（连字符）。**两个方向都要有**，见 {@link GRADE_LEVEL_OF}。 */
export const GRADE_AXIS_OF: Record<GradeLevel, Exclude<GradeKey, 'default' | 'brand'>> = {
  primary_low: 'primary-low',
  primary_high: 'primary-high',
  junior: 'junior',
  senior: 'senior'
}

/** 配色轴（连字符）→ 契约（下划线）。认不出返回 `null`（不猜）。 */
export const GRADE_LEVEL_OF: Partial<Record<GradeKey, GradeLevel>> = {
  'primary-low': 'primary_low',
  'primary-high': 'primary_high',
  junior: 'junior',
  senior: 'senior'
}

const DEFAULT_SAT: SatKey = 'vivid'

export const useThemeStore = defineStore('theme', () => {
  const chat = useChatStore()

  /**
   * 学生的**真实学段** → 配色轴。真值在服务端，这里只是把它翻译成配色轴键。
   * `null`（还没判出来）→ `default`（中性配色）。
   */
  const inferredGrade = computed<GradeKey>(() =>
    chat.currentGrade === null ? 'default' : GRADE_AXIS_OF[chat.currentGrade]
  )

  /**
   * 设计系统页的临时预览（`null` = 没在预览）。只影响那两页的显示。
   * 学生的学段在 `chat.currentGrade` 里，这里**绝不**写回去。
   */
  const previewGrade = ref<GradeKey | null>(null)

  const grade = computed<GradeKey>(() => previewGrade.value ?? inferredGrade.value)
  const sat = ref<SatKey>(DEFAULT_SAT)

  const gradeMeta = computed(() => GRADES.find((g) => g.key === grade.value) ?? GRADES[4]!)
  const satMeta = computed(() => SATS.find((s) => s.key === sat.value) ?? SATS[0]!)

  /** 指示器实际展示的学段（与配色轴同一个值）。 */
  const displayGrade = computed<GradeKey>(() => grade.value)

  const displayGradeMeta = computed(
    () => GRADES.find((g) => g.key === displayGrade.value) ?? GRADES[4]!
  )

  /** 是不是一个**真实学段**（`default` / `brand` 两档只是设计系统档）。 */
  const isRealGrade = computed(
    () => displayGrade.value !== 'default' && displayGrade.value !== 'brand'
  )

  /** 是否正在做设计系统预览（配色总览 / 四学段对照两页）。 */
  const previewing = computed(() => previewGrade.value !== null)

  /** 学生端只读指示器文案，例如「当前：初中」；未判定时为「待判定」 */
  const gradeIndicatorText = computed(() =>
    isRealGrade.value ? `当前：${displayGradeMeta.value.label}` : '待判定'
  )

  /** 把两轴写进 <html> 的 data 属性，CSS 侧由 tokens.generated.css 消费 */
  watchEffect(() => {
    const el = document.documentElement
    el.dataset.grade = grade.value
    el.dataset.sat = sat.value
  })

  function setSat(next: SatKey) {
    sat.value = next
  }

  /**
   * 设计系统页用：预览某一档配色。**不写库、不改学生的学段。**
   * 学生要改自己的学段，走 `chat.setGrade`（`grade:set` 独立通道，由服务端写库）。
   */
  function setPreviewGrade(next: GradeKey) {
    previewGrade.value = next
  }

  /** 结束预览，配色回到学生的真实学段。 */
  function clearPreview() {
    previewGrade.value = null
  }

  return {
    grade,
    sat,
    previewGrade,
    previewing,
    inferredGrade,
    gradeMeta,
    satMeta,
    displayGrade,
    displayGradeMeta,
    gradeIndicatorText,
    isRealGrade,
    setSat,
    setPreviewGrade,
    clearPreview
  }
})
