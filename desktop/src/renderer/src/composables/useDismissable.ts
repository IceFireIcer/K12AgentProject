/**
 * 「可关闭浮层」的**唯一实现**：Esc + 点击外部，两条一起给。
 *
 * ★ 为什么要有它（实测缺陷）：学段选择器与章节选择器**两条都没有** ——
 *   学生点开下拉、看了一眼不想选，然后点别处希望它收起来：**它不收**。
 *   唯一能关掉的办法是再点一次触发器，或者被迫选一个。
 *   实测两种退化都发生了：
 *     - 面板一直悬在内容上方，挡住下面的东西（截图里能看到它叠在「新会话」那一行上）；
 *     - 学生会以为界面卡住了。
 *
 * ★ 为什么 Esc 与「点外部」写在一个 composable 里：这两条是**同一个意图**
 *   （「我不选了」）的两种表达，拆成两处实现必然出现「一个有了另一个忘了」——
 *   本文件诞生前就是那样：`useEscape` 被 6 个组件用了，而这两个下拉**一个都没用**。
 *
 * ★ 为什么用 `pointerdown` 而不是 `click`：点外部时若目标本身可点（比如另一个按钮），
 *   `click` 会**先执行它自己的动作、再关面板** —— 于是「点另一个按钮」会变成
 *   「既触发了那个按钮、又关掉了面板」，而学生的预期往往只是「关掉面板」。
 *   `pointerdown` 在更早的时机收面板，且与拖拽类交互不冲突。
 *
 * ★ 为什么挂在 **capture** 阶段：冒泡阶段的 document 监听会被中途任何一处
 *   `stopPropagation()` 吃掉（组件里到处可能有），那时面板就**卡住关不掉**了。
 *   capture 自上而下先跑，没人能拦。面板内部的点击不会因此被吞 ——
 *   下面用 `contains()` 显式放过，面板自己的按钮照常工作。
 */
import { onBeforeUnmount, watch, type Ref } from 'vue'

export interface DismissOptions {
  /** 面板根元素（判断「点在不在里面」用）。 */
  panel: Ref<HTMLElement | null>
  /** 触发按钮（点它由触发器自己 toggle，这里要**放过**，否则会立刻又被关掉）。 */
  trigger?: Ref<HTMLElement | null>
  /** 面板是否开着。 */
  open: () => boolean
  /** 关闭它。 */
  close: () => void
}

export function useDismissable(options: DismissOptions): void {
  const { panel, trigger, open, close } = options
  // 解构后的 `trigger` 是 `Ref | undefined`；先收成一个确定的值，省掉每处 `?.`
  const triggerRef = trigger ?? { value: null }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open()) return
    // 只处理自己这一层：更内层的浮层（如从面板里开的模态）已 stopPropagation 时收不到
    event.stopPropagation()
    close()
  }

  function onPointerDown(event: PointerEvent): void {
    if (!open()) return
    const target = event.target as Node | null
    if (!target) return
    // 点在面板里 → 放过（选完由面板自己关）
    if (panel.value?.contains(target)) return
    // 点在触发器上 → 放过（交给触发器 toggle，否则「点一下开、再点一下关」会失效）
    if (triggerRef.value?.contains(target)) return
    close()
  }

  // 只在开着的时候挂监听：面板不开时不该响应 Esc（否则会和输入框的快捷键打架），
  // 也少一份常驻的 document 级监听。
  function bind(on: boolean): void {
    if (on) {
      window.addEventListener('keydown', onKeydown)
      document.addEventListener('pointerdown', onPointerDown, true)
    } else {
      window.removeEventListener('keydown', onKeydown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }

  watch(() => open(), bind, { immediate: true })
  onBeforeUnmount(() => bind(false))
}
