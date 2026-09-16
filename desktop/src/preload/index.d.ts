import type { K12Api } from './index'

declare global {
  interface Window {
    api: K12Api
  }
}
