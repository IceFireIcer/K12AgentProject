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
import { warnWiring } from '../api/wiring-notice'

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
      // ★★ 2026-09-22 改口（报告 0.2 + 双视角 D-063）：这一句渲染在**侧栏状态位**上
      //    （`AppSidebar` 的 `data-testid="sidecar-error"`）—— 学生每天都在看的地方，
      //    原来写的是「预加载脚本未生效（window.api 缺失），无法读取本地数据服务状态。」
      //    现在屏幕上是学生话，「缺什么 / 怎么接」进控制台（`warnWiring`）。
      warnWiring(
        'sidecar',
        'window.api 缺失：preload 没有加载（读不到本地数据服务的推送与状态）。检查 preload 入口与 contextIsolation / sandbox 配置。'
      )
      loadError.value = '状态暂时读不到，需要时请老师帮忙看看。'
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
