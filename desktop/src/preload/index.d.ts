import { ElectronAPI } from '@electron-toolkit/preload'
import type { SidecarInfo } from '../shared/sidecar-types'

/** preload 暴露的白名单接口（与 src/preload/index.ts 保持同步）。 */
export interface K12DesktopApi {
  getSidecarInfo(): Promise<SidecarInfo>
  restartSidecar(): Promise<SidecarInfo>
  onSidecarChanged(listener: (info: SidecarInfo) => void): () => void
  getLogPath(): Promise<string>
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: K12DesktopApi
  }
}
