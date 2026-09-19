/**
 * sidecar 状态（主进程唯一 HTTP 客户端 → 经 `sidecar:changed` / `sidecar:get-info` 推送）。
 *
 * ★ 状态里**没有 token**（`SidecarState` 结构上就没有），渲染进程只知道
 *   「几阶段 / 哪个端口 / 什么错」——也只需要知道这些。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { SidecarPhase, SidecarState } from '../../../main/sidecar/protocol'
// ★ 连接层失败必须变成中文：`fetch failed` 的真正原因（ECONNREFUSED）在 error.cause 里，
//   直接透传 error.message 就是把英文递给用户。判据与主进程 `ipc/handlers.ts` 同一口径。
import { describeClientError } from '../api/student-facing'

export const PHASE_TEXT: Record<SidecarPhase, string> = {
  idle: '等待启动',
  starting: '启动中',
  ready: '已就绪',
  failed: '启动失败',
  stopped: '已停止'
}

export const PHASE_HINT: Record<SidecarPhase, string> = {
  idle: '尚未拉起本地数据服务（Python sidecar）。',
  starting: '正在启动本地数据服务，就绪前不影响窗口操作。',
  ready: '本地数据服务已就绪，教材检索与学习记录可用。',
  failed: '本地数据服务未能启动，请查看下方错误与日志。',
  stopped: '本地数据服务已停止。'
}

export const useSidecarStore = defineStore('sidecar', () => {
  const state = ref<SidecarState | null>(null)
  const loadError = ref<string | null>(null)
  let unsubscribe: (() => void) | null = null

  const phase = computed<SidecarPhase>(() => state.value?.phase ?? 'idle')
  const phaseText = computed(() => PHASE_TEXT[phase.value])
  const errorText = computed(() => state.value?.lastError ?? loadError.value)

  /** 连上主进程推送（幂等：重复调用不会重复订阅）。 */
  function connect(): void {
    if (unsubscribe !== null) return
    if (typeof window === 'undefined' || typeof window.api === 'undefined') {
      loadError.value = '预加载脚本未生效（window.api 缺失），无法读取本地数据服务状态。'
      return
    }

    unsubscribe = window.api.onSidecarChanged((next) => {
      state.value = next
    })

    void window.api
      .getSidecarInfo()
      .then((info) => {
        state.value = info
      })
      .catch((error: unknown) => {
        loadError.value = `读取本地数据服务状态失败：${describeClientError(error)}`
      })
  }

  function disconnect(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  return { state, loadError, phase, phaseText, errorText, connect, disconnect }
})
