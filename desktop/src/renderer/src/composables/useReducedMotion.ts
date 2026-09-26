/**
 * 减弱动效偏好（响应式，**有效值**）。
 *
 * 为什么需要它：`base.css` 的 `@media (prefers-reduced-motion: reduce)` 只能收掉
 * **CSS** 的时长，收不掉 **JS 定时器**。界面里有两个播放时钟（动画卡、动画讲解页）
 * 每 100ms 更新一次进度——减动效用户打开开关后它们照样在跑，这是真 bug。
 * 有 JS 驱动的动效，就必须在 JS 侧也读这个偏好。
 *
 * 另外这不是「关掉一切」：减动效下颜色变化要保留（它有助于理解状态），
 * 只是不再移动、不再循环。所以调用方通常这样用：
 *   const reduced = useReducedMotion()
 *   直接渲染终态 while (reduced.value) ...
 *
 * ★★ 2026-09-27（报告 §3.3 的三档开关）：返回的不再只是系统偏好，而是
 *   **有效值** = `stores/reducedMotion.ts` 的用户模式 × 系统偏好：
 *     · 用户选「开启」→ 永远 true（系统没开也减）；
 *     · 用户选「关闭」→ 永远 false（系统开了也给完整动效）；
 *     · 「自动」→ 跟随系统（与以前的行为一字不差）。
 *   系统偏好仍然由这里**唯一一处** matchMedia 订阅写进 store —— 多处各订阅一份
 *   迟早有人忘记清理监听（与 `stores/panels.ts` 的单例订阅同一条纪律）。
 */
import { computed, onBeforeUnmount, onMounted } from 'vue'
import {
  reducedMotionEffective,
  setSystemReducedMotionMatching
} from '../stores/reducedMotion'

const QUERY = '(prefers-reduced-motion: reduce)'

/** 单例订阅：多处调用共享同一个 matchMedia，避免每个组件挂一个监听 */
let mql: MediaQueryList | null = null
const subscribers = new Set<() => void>()

function ensureListener(): void {
  if (mql || typeof window === 'undefined') return
  mql = window.matchMedia(QUERY)
  setSystemReducedMotionMatching(mql.matches)
  mql.addEventListener('change', (e) => {
    setSystemReducedMotionMatching(e.matches)
    for (const fn of subscribers) fn()
  })
}

export function useReducedMotion() {
  ensureListener()

  // 订阅变化：调用方可以 watch 这个值来对偏好变化做出反应
  const rerender = () => {
    /* 触发依赖收集即可 */
  }
  onMounted(() => subscribers.add(rerender))
  onBeforeUnmount(() => subscribers.delete(rerender))

  return computed(() => reducedMotionEffective.value)
}

/**
 * 按减动效偏好滚动到某个元素（**全站唯一实现**，报告 §3.3 的「rollIntoView 全局替换」）。
 *
 * ★ 为什么必须有这一层：CSS 的 `@media (prefers-reduced-motion: reduce)` **收不掉
 *   JS 发起的平滑滚动** —— `scrollIntoView({ behavior: 'smooth' })` 走的是浏览器
 *   自己的滚动动画。每一处各自写一遍 `behavior: reduced ? 'auto' : 'smooth'`，
 *   迟早有人漏一处（而且"减动效开启但页面还在滑"正是最容易被感知的一种失败）。
 *
 * ★ 传进来的 `behavior` 会被覆盖（`auto` 永远优先）——调用方不需要再判断一遍。
 */
export function scrollIntoViewRespectingMotion(
  element: Element | null | undefined,
  options: ScrollIntoViewOptions = { block: 'nearest' }
): void {
  if (!element) return
  const behavior: ScrollBehavior =
    reducedMotionEffective.value || options.behavior === 'auto' ? 'auto' : 'smooth'
  try {
    element.scrollIntoView({ ...options, behavior })
  } catch {
    /* 老环境 / 元素已脱离文档：滚动失败不该把业务打断 */
  }
}
