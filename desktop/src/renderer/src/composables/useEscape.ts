/**
 * Esc 关闭：所有模态层都该有，但审计发现**一个都没有**。
 *
 * 对一个 `role="dialog"` 的元素来说，不能用键盘关掉是硬伤 ——
 * 键盘用户被卡在弹窗里，只能去点关闭按钮，而那个按钮还不一定在焦点链上。
 *
 * 为什么写成 composable 而不是全局监听：模态是**按需存在**的，
 * 全局监听会在没有模态时也响应 Esc（比如将来给输入框加"清空"快捷键时会打架）。
 * 这里只在组件挂载期间监听，卸载即摘除。
 */
import { onBeforeUnmount, onMounted } from 'vue'

export function useEscape(onEscape: () => void, enabled: () => boolean = () => true) {
  function handler(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !enabled()) return
    e.stopPropagation()
    onEscape()
  }
  onMounted(() => window.addEventListener('keydown', handler))
  onBeforeUnmount(() => window.removeEventListener('keydown', handler))
}
