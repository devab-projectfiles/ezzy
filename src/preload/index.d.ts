import type { EzzyApi } from '../shared/types'

declare global {
  interface Window {
    ezzy: EzzyApi
  }
}
