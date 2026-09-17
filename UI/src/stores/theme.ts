/**
 * 主题（学段 × 饱和度）状态。
 *
 * ⚠️ 架构约束（AGENTS.md §5.1 / §6）：学段在正式产品里**没有人工入口**——
 * 没有选择器、没有下拉、没有确认按钮，唯一写路径是服务端自动推断。
 * 因此本原型里：
 *   - 默认走 `default` 学段色调，学生端**只读**；
 *   - 手动切学段的入口只在 `devMode` 打开时可用，且只出现在「开发页」。
 * 接线时：把 grade 的来源换成服务端推断结果（before_agent_start 生效），
 * 删掉 devMode 那一支即可，只读指示器（GradeIndicator）保持不变。
 */
import { defineStore } from 'pinia'
import { computed, ref, watchEffect } from 'vue'

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

/** 四学段 + 两个设计系统专用档（default/brand 仅用于设计系统页，不对应真实学段） */
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

const DEFAULT_SAT: SatKey = 'vivid'

export const useThemeStore = defineStore('theme', () => {
  /**
   * 学生的**真实学段** —— 领域事实，唯一来源是服务端推断。
   * 原型用 mock 值；接线后由推断结果驱动（`before_agent_start` 生效），
   * 配色轴 `grade` 会跟着它走，从而做到「界面随学段自适应」。
   */
  const inferredGrade = ref<Exclude<GradeKey, 'default' | 'brand'>>('junior')

  /**
   * 配色轴上的学段档。**初值跟学生的真实学段一致** ——
   * 学生端看到的配色应当反映他自己的学段，而不是某个中性默认值。
   * `default` / `brand` 两档只用于设计系统页（配色总览 / 四学段对照）。
   */
  const grade = ref<GradeKey>(inferredGrade.value)
  const sat = ref<SatKey>(DEFAULT_SAT)

  /**
   * 开发模式开关：只有打开后，开发页才允许手动切学段。
   * 生产构建里这个入口保持关闭；接线后整块删除。
   */
  const devMode = ref(false)

  const gradeMeta = computed(
    () => GRADES.find((g) => g.key === grade.value) ?? GRADES[4]!
  )
  const satMeta = computed(() => SATS.find((s) => s.key === sat.value) ?? SATS[0]!)

  /**
   * 指示器实际展示的学段：
   *  - 开发模式下跟随配色轴（相当于「模拟一次新的推断结果」）；
   *  - 否则展示学生真实学段（服务端推断结果）。
   * 这样配色轴就不会被误当成「学生学段」显示出来。
   */
  const displayGrade = computed<GradeKey>(() =>
    devMode.value ? grade.value : inferredGrade.value
  )

  const displayGradeMeta = computed(
    () => GRADES.find((g) => g.key === displayGrade.value) ?? GRADES[4]!
  )

  const isRealGrade = computed(
    () => displayGrade.value !== 'default' && displayGrade.value !== 'brand'
  )

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

  /** 仅开发模式可用；正式接线后学段由服务端推断写入，此函数应删除 */
  function setGrade(next: GradeKey) {
    if (!devMode.value) {
      console.warn('[theme] 学段不接受人工写入（AGENTS.md §5.1）；请先开启开发模式')
      return
    }
    grade.value = next
  }

  function setSat(next: SatKey) {
    sat.value = next
  }

  function setDevMode(on: boolean) {
    devMode.value = on
    // 关闭开发模式时把配色轴复位到学生的真实学段，避免开发态残留影响验收
    if (!on) grade.value = inferredGrade.value
  }

  function reset() {
    grade.value = inferredGrade.value
    sat.value = DEFAULT_SAT
  }

  return {
    grade,
    sat,
    devMode,
    inferredGrade,
    gradeMeta,
    satMeta,
    displayGrade,
    displayGradeMeta,
    gradeIndicatorText,
    isRealGrade,
    setGrade,
    setSat,
    setDevMode,
    reset
  }
})
