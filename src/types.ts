export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  debug: (...args: any[]) => void
}

// 添加cors模块的类型引用
import { CorsOptions } from 'cors'
export { CorsOptions }

export interface MCPServiceOptions {
  // 基础服务选项
}

export interface MCPService {
  initialize(): Promise<void>
  destroy(): Promise<void>
  getTools(): Array<{
    name: string
    description: string
    parameters: {
      type: string
      properties: Record<string, any>
      required: string[]
    }
  }>
  executeToolCall(toolName: string, params: Record<string, any>): Promise<any>
}
