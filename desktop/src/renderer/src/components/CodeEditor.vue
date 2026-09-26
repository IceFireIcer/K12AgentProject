<script setup lang="ts">
/**
 * Monaco 编辑器宿主组件（报告 §5.1 的异步组件**本体**）。
 *
 * ── 它是异步组件（由调用方用 `defineAsyncComponent` 装配）─────────────────
 *   · `loader` 是 `() => import('./CodeEditor.vue')` —— 组件代码本身是一个小 chunk；
 *   · 真正的重活（2 MB 级的 Monaco）在**组件内部**由 `createCodeEditor()` 懒加载；
 *   · 加载中由调用方盖 `<CodeEditorSkeleton>`，失败由 `@failure` 交给调用方显示。
 *
 * ── 为什么句柄用 `defineExpose` 交给父组件而不是在这里管运行 ──────────────
 *   学生点「运行」时的流程（锁编辑器 → 跑 Worker → 解锁）住在卡片/页面里，
 *   运行器（Pyodide）与编辑器的生命周期**不是**一回事。所以这里只负责
 *   「装配 + 释放 + 暴露最小句柄」，业务动作仍由调用方驱动 —— 与
 *   `monaco-setup.ts` 的 `CodeEditorHandle` 同一组方法，不再多一层抽象。
 *
 * ★ 装配失败**不抛到渲染树**：异常收成 `failure` 事件（父组件渲染一句可读说明），
 *   这是本仓「失败也要可读、绝不白屏」的通用口径。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import {
  DEFAULT_EDITOR_THEME,
  createCodeEditor,
  observeEditorResize,
  type CodeEditorHandle,
  type CodeEditorTheme
} from '../sandbox/monaco-setup'

const props = withDefaults(
  defineProps<{
    /** 初始源码（通常是脚手架）。 */
    value: string
    /**
     * 主题。默认（也是当前唯一入口）是 `vs-dark` —— 报告 §5.1 的主题精简口径，
     * 见 `monaco-setup.ts` 的 `DEFAULT_EDITOR_THEME`。
     */
    theme?: CodeEditorTheme
  }>(),
  { theme: DEFAULT_EDITOR_THEME }
)

const emit = defineEmits<{
  (event: 'ready'): void
  (event: 'change', value: string): void
  (event: 'failure', message: string): void
}>()

const host = ref<HTMLElement | null>(null)
/** 非响应式：句柄只在装配 / 释放时进出。 */
let editor: CodeEditorHandle | null = null
let stopResizeObserver: (() => void) | null = null

defineExpose({
  /** 是否已经装配好（父组件拿它决定按钮可不可点）。 */
  isReady: (): boolean => editor !== null,
  getValue: (): string => editor?.getValue() ?? props.value,
  setValue: (text: string): void => editor?.setValue(text),
  setReadOnly: (readOnly: boolean): void => editor?.setReadOnly(readOnly),
  layout: (): void => editor?.layout(),
  focus: (): void => editor?.focus()
})

onMounted(async () => {
  const element = host.value
  if (element === null) return
  try {
    editor = await createCodeEditor({
      container: element,
      value: props.value,
      theme: props.theme,
      onChange: (value) => emit('change', value)
    })
    stopResizeObserver = observeEditorResize(element, editor)
    emit('ready')
  } catch (error) {
    emit('failure', error instanceof Error ? error.message : String(error))
  }
})

/**
 * 释放。★ KeepAlive 下切页走 `onDeactivated`（这里不执行），真正卸载才释放 ——
 * 与既有实现同一口径（见 `cards/CodingCard.vue` 的注释）。
 */
onBeforeUnmount(() => {
  stopResizeObserver?.()
  stopResizeObserver = null
  editor?.dispose()
  editor = null
})
</script>

<template>
  <div ref="host" class="code-editor" />
</template>

<style scoped>
/* 尺寸由调用方给（卡片 300px / 编程页 420px）；这里只保证撑满宿主盒。
 * ★★ `height: 100%` 要求父层是**确定高度**：调用方必须把尺寸挂在它自己的普通盒子上
 *   （`views/Coding.vue` 的 `.code__editor` / `cards/CodingCard.vue` 的 `.coding__editor`），
 *   **不能**挂在本组件（异步组件）的根节点上 —— 两份 CSS 同权重时谁生效取决于 chunk 加载顺序，
 *   实测就是本规则把对方的 420px 覆盖掉、外层 auto 高度下塌成 5px（2026-09-27 真机事故）。 */
.code-editor {
  width: 100%;
  height: 100%;
}
</style>
