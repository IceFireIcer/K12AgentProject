/**
 * 确认对话框（全局单实例）。
 *
 * 为什么要 store 而不是每页一个组件：确认框是**模态**的，同一时刻只该有一个；
 * 每页各挂一个会出现两层遮罩叠在一起。这里用 Promise 包装，调用方写起来是同步语义：
 *
 *   const confirm = useConfirm()
 *   if (!(await confirm.ask({ title: '清空这段对话？', danger: true }))) return
 *   // 用户确认后才执行
 *
 * 这条 `await` 很关键：它让"确认 → 执行"成为一个不可跳过的序列，
 * 而不是"先执行，再弹个提示"。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface ConfirmOptions {
  title: string
  body?: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
}

export const useConfirm = defineStore('confirm', () => {
  const open = ref(false)
  const options = ref<ConfirmOptions>({ title: '' })
  /** 挂起中的 resolve；用户点确认/取消时调用它 */
  let settle: ((ok: boolean) => void) | null = null

  /** 打开确认框，等用户决定。返回 true=确认，false=取消 */
  function ask(opts: ConfirmOptions): Promise<boolean> {
    // 若已有一个在等，先当作取消（不会发生，但防御）
    settle?.(false)
    options.value = opts
    open.value = true
    return new Promise<boolean>((resolve) => {
      settle = resolve
    })
  }

  function onConfirm() {
    open.value = false
    settle?.(true)
    settle = null
  }

  function onCancel() {
    open.value = false
    settle?.(false)
    settle = null
  }

  return { open, options, ask, onConfirm, onCancel }
})
