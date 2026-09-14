/**
 * preload：contextBridge 白名单。
 *
 * 原则：**只暴露最小接口**。渲染层拿不到 Node、拿不到任意 IPC——
 * 想加能力必须在这里显式新增一个方法。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/** 与主进程 `sidecar:get-info` / `sidecar:restart` 保持一致。 */
const api = {
  /** 取当前 sidecar 快照（界面首次加载时用）。 */
  getSidecarInfo: (): Promise<unknown> => ipcRenderer.invoke('sidecar:get-info'),

  /** 手动重启后端（失败界面上的「重试」按钮）。 */
  restartSidecar: (): Promise<unknown> => ipcRenderer.invoke('sidecar:restart'),

  /** sidecar 状态变化订阅；返回取消订阅函数。 */
  onSidecarChanged: (listener: (info: unknown) => void): (() => void) => {
    const handler = (_event: unknown, info: unknown): void => listener(info)
    ipcRenderer.on('sidecar:changed', handler)
    return () => ipcRenderer.removeListener('sidecar:changed', handler)
  },

  /** 日志文件路径（界面上给「打开日志」用）。 */
  getLogPath: (): Promise<string> => ipcRenderer.invoke('app:get-log-path')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type K12Api = typeof api
