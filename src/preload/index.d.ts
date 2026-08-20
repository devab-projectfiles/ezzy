import type { EzyApi } from '../shared/types'

declare global {
  interface Window {
    ezy: EzyApi
  }
}
