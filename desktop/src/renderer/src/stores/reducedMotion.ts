/**
 * 减少动效偏好：**三档开关**（报告 §3.3 的「用户控制面板」）。
 *
 * ── 三个档位分别是什么 ──────────────────────────────────────────────────
 *   · `auto`（默认）：跟随系统（`prefers-reduced-motion`）—— 与以前的行为一字不差；
 *   · `on`：强制减动效（系统没开也生效）；
 *   · `off`：完整动效（**连系统偏好也覆盖**）。
 *
 * ★★ 为什么「关闭」要真的覆盖系统偏好（而不是只覆盖我们自己的开关）：
 *   界面上写着「自动 / 开启 / 关闭」三档，学生（或老师）选「关闭」时预期的是
 *   「我看到完整动效」。如果系统开了减动效而我们只关掉自己的开关，屏幕上仍然
 *   没有动效 —— 三档里的第三档就成了假选项。做法见 `base.css`：所有减动效规则
 *   都挂在 `:root:not([data-k12-reduced-motion='off'])` 上（媒体查询仍然管 `auto`），
 *   而这个属性就是本文件写到 `<html>` 上的模式值。
 *
 * ── 持久化与实时生效 ────────────────────────────────────────────────────
 *   · 落盘：`localStorage`（键 `k12.reducedMotion`）—— 与 QuizLayout 同一条纪律
 *     （读偏好失败绝不让页面白屏：认不出 / 读不到一律回 `auto`）；
 *   · 实时生效：`set()` 同时写属性 + 落盘。属性一变，CSS 立刻跟随；
 *     JS 侧（滚动 / 定时器）读 `useReducedMotion()`，它是同一份状态的 computed。
 */
import { computed, readonly, ref } from 'vue'

export type ReducedMotionMode = 'auto' | 'on' | 'off'

export const REDUCED_MOTION_MODES: readonly ReducedMotionMode[] = ['auto', 'on', 'off']
export const REDUCED_MOTION_STORAGE_KEY = 'k12.reducedMotion'
export const REDUCED_MOTION_DEFAULT: ReducedMotionMode = 'auto'
/** 写到 `<html>` 上的属性名（CSS 的减动效规则按它开关）。 */
export const REDUCED_MOTION_ATTR = 'data-k12-reduced-motion'

/** 三档的中文标签与说明（设置页与探针共用一份文案）。 */
export const REDUCED_MOTION_OPTIONS: ReadonlyArray<{
  value: ReducedMotionMode
  label: string
  desc: string
}> = [
  { value: 'auto', label: '自动', desc: '跟随系统设置' },
  { value: 'on', label: '开启', desc: '关闭页面切换、滚动动画和装饰性动效' },
  { value: 'off', label: '关闭', desc: '始终显示完整动效' }
]

/** 认不认识这个字面量（读盘与写入口都过这一道）。 */
export function isReducedMotionMode(value: unknown): value is ReducedMotionMode {
  return typeof value === 'string' && (REDUCED_MOTION_MODES as readonly string[]).includes(value)
}

/**
 * 读本地偏好：认不出 / 没存过 / 读异常（file:// + 某些沙箱组合下 localStorage 会抛）
 * 一律回默认 —— 一个偏好读不出来绝不能让整个应用起不来。
 */
export function readStoredReducedMotionMode(): ReducedMotionMode {
  try {
    if (typeof localStorage === 'undefined') return REDUCED_MOTION_DEFAULT
    const raw = localStorage.getItem(REDUCED_MOTION_STORAGE_KEY)
    return isReducedMotionMode(raw) ? raw : REDUCED_MOTION_DEFAULT
  } catch {
    return REDUCED_MOTION_DEFAULT
  }
}

/** 系统偏好（由 `useReducedMotion` 的单例 matchMedia 监听写入）。 */
const systemMatches = ref(false)
export function setSystemReducedMotionMatching(matches: boolean): void {
  systemMatches.value = matches
}

const mode = ref<ReducedMotionMode>(readStoredReducedMotionMode())
/** 只读的模式（设置页与探针读它）。 */
export const reducedMotionMode = readonly(mode)

/**
 * 有效值：`on` → 减；`off` → 不减；`auto` → 看系统。
 *
 * ★ 抽成纯函数是为了可单测（`matchesSystem` 由调用方给）——
 *   混在 composable 里的话，测这段逻辑要先装一个 matchMedia。
 */
export function effectiveReducedMotion(
  value: ReducedMotionMode,
  matchesSystem: boolean
): boolean {
  if (value === 'on') return true
  if (value === 'off') return false
  return matchesSystem
}

/** 有效值（响应式）：系统匹配 × 用户模式。 */
export const reducedMotionEffective = computed(() =>
  effectiveReducedMotion(mode.value, systemMatches.value)
)

/**
 * 把模式写到 `<html>` 的属性上（CSS 的减动效规则按它开关）。
 *
 * ★ 写成**模式值**（auto / on / off）而不是「有效值」（true/false）：
 *   `auto` 要留给媒体查询自己判断，写成布尔就把「跟随系统」这条信息丢了。
 */
export function applyReducedMotionAttribute(value: ReducedMotionMode = mode.value): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(REDUCED_MOTION_ATTR, value)
}

/** 改模式：立刻写属性 + 落盘（存不下不抛 —— 本次会话内仍然生效）。 */
export function setReducedMotionMode(next: ReducedMotionMode): void {
  mode.value = next
  applyReducedMotionAttribute(next)
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, next)
    }
  } catch {
    /* 存不下就算了 */
  }
}

// 模块加载即写属性：CSS 在**第一帧**就知道用户的模式（不等任何组件挂载）。
applyReducedMotionAttribute()
