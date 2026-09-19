/**
 * 减弱动效偏好（响应式）。
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
 */
import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

const QUERY = '(prefers-reduced-motion: reduce)'

/** 单例订阅：多处调用共享同一个 matchMedia，避免每个组件挂一个监听 */
let mql: MediaQueryList | null = null
const matches = ref(false)
const subscribers = new Set<() => void>()

function ensureListener() {
  if (mql || typeof window === 'undefined') return
  mql = window.matchMedia(QUERY)
  matches.value = mql.matches
  mql.addEventListener('change', (e) => {
    matches.value = e.matches
    for (const fn of subscribers) fn()
  })
}

export function useReducedMotion() {
  ensureListener()

  // 订阅变化：调用方可以 watch 这个 ref 来对偏好变化做出反应
  const rerender = () => {
    /* 触发依赖收集即可 */
  }
  onMounted(() => subscribers.add(rerender))
  onBeforeUnmount(() => subscribers.delete(rerender))

  return readonly(matches)
}
