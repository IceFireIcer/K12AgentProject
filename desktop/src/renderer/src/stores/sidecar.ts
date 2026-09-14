import { defineStore } from 'pinia'
import { computed, onUnmounted, ref } from 'vue'
import type { SidecarInfo } from '../../../shared/sidecar-types'

/**
 * sidecar 状态仓储。
 *
 * 状态以主进程推送的全量快照为准（`sidecar:changed`），不在渲染层自行推断——
 * 进程状态只有一个事实来源。
 */
export const useSidecarStore = defineStore('sidecar', () => {
  const info = ref<SidecarInfo | null>(null)
  const error = ref<string | null>(null)

  const phase = computed(() => info.value?.phase ?? 'idle')
  const isReady = computed(() => phase.value === 'ready')
  const isBusy = computed(() =>
    ['starting', 'handshaking', 'restarting'].includes(phase.value)
  )
  const isFailed = computed(() => phase.value === 'failed')

  /** 界面上「一句话状态」文案。 */
  const phaseText = computed(() => {
    switch (phase.value) {
      case 'idle':
        return '未启动'
      case 'starting':
        return '正在启动后端服务…'
      case 'handshaking':
        return '正在等待后端就绪…'
      case 'ready':
        return '后端服务已就绪'
      case 'restarting':
        return '后端意外退出，正在重启…'
      case 'failed':
        return '后端服务启动失败'
      case 'stopped':
        return '后端服务已停止'
      default:
        return '未知状态'
    }
  })

  const portText = computed(() => (info.value?.port ? String(info.value.port) : '—'))

  async function refresh(): Promise<void> {
    try {
      info.value = (await window.api.getSidecarInfo()) as SidecarInfo
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function restart(): Promise<void> {
    try {
      info.value = (await window.api.restartSidecar()) as SidecarInfo
      error.value = null
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** 订阅主进程推送；返回取消订阅函数。 */
  function subscribe(): () => void {
    return window.api.onSidecarChanged((next) => {
      info.value = next
    })
  }

  return {
    info,
    error,
    phase,
    isReady,
    isBusy,
    isFailed,
    phaseText,
    portText,
    refresh,
    restart,
    subscribe
  }
})

/** 组件里一行接入：订阅 + 首次拉取 + 卸载时取消。 */
export function useSidecar(): ReturnType<typeof useSidecarStore> {
  const store = useSidecarStore()
  const unsubscribe = store.subscribe()
  void store.refresh()
  onUnmounted(unsubscribe)
  return store
}
