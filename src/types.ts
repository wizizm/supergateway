export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

// 添加cors模块的类型引用
import { CorsOptions } from 'cors'
export { CorsOptions }
