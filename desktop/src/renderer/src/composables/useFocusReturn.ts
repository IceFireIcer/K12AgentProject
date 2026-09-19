/**
 * 焦点归还 + 焦点收束：模态层（抽屉 / 对话框 / 浮层）的键盘契约。
 *
 * 为什么必须有：这些层此前只有 `v-if` 与 Esc —— **打开时焦点还在背后的页面上**，
 * 关闭时焦点回到 `body`。对键盘与读屏用户来说等于「点开一个看不见的东西」：
 * Tab 会跑到遮罩后面的按钮上，关掉之后还得从头 Tab 回去。
 *
 * 三件事，按发生顺序：
 *   1. 打开 → 记住此刻的 `document.activeElement`（**触发元素**），把焦点移进面板；
 *   2. 打开期间 → Tab / Shift+Tab 在面板内循环，不逃到遮罩后；
 *   3. 关闭 → 焦点还回那个触发元素（若它已不在文档里，则退回 body）。
 *
 * 与 `useEscape` 的分工：Esc 关不关是**语义**（各组件自己决定，见 useEscape）；
 * 这里是纯粹的可达性管道。两者互不依赖，可单独使用，也可一起用。
 *
 * 用法：
 *   const panel = ref<HTMLElement | null>(null)
 *   useFocusReturn(panel, () => props.open)
 *   // 模板：<aside ref="panel" role="dialog" aria-modal="true"> … </aside>
 *
 * ⚠️ 不要给非模态的浮层用（比如 hover 菜单）：它们不该抢焦点。
 */
import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

/** 可聚焦元素：与浏览器自身的 Tab 顺序规则保持一致的子集 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

function focusablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    // 排除不可见元素（display:none 的元素依然会被 querySelectorAll 命中）
    (el) => el.offsetParent !== null || el === document.activeElement
  )
}

/**
 * 打开时把焦点移入 `panelRef`，关闭时还回打开前的元素。
 *
 * @param panelRef 面板根元素
 * @param isOpen   是否打开（传 getter，不要在调用处取一次值）
 * @param options.initial 优先聚焦的元素（默认第一个可聚焦元素，找不到则聚焦面板自身）
 */
export function useFocusReturn(
  panelRef: Ref<HTMLElement | null>,
  isOpen: () => boolean,
  options: { initial?: () => HTMLElement | null | undefined } = {}
) {
  let trigger: HTMLElement | null = null

  /** 面板自身也放进焦点链：否则面板里一个控件都没有时，焦点无处可去（会掉回 body） */
  function focusInto() {
    const panel = panelRef.value
    if (!panel) return
    const target = options.initial?.() ?? focusablesIn(panel)[0] ?? panel
    if (target === panel && !panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1')
    target.focus()
  }

  /** Tab 循环：焦点走到两端时折回，不逃到遮罩后面 */
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab' || !isOpen()) return
    const panel = panelRef.value
    if (!panel) return
    const items = focusablesIn(panel)
    if (items.length === 0) {
      e.preventDefault()
      return
    }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  watch(isOpen, async (open, wasOpen) => {
    if (open === wasOpen) return
    if (open) {
      trigger = (document.activeElement as HTMLElement | null) ?? null
      await nextTick()
      focusInto()
    } else {
      // 还回触发元素；它可能在这一轮里被卸载（比如"知道了"按钮自毁）
      const back = trigger
      trigger = null
      await nextTick()
      if (back && document.contains(back)) back.focus()
      else (document.activeElement as HTMLElement | null)?.blur()
    }
  })

  window.addEventListener('keydown', onKeydown, true)
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
}
