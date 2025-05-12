import { MCPToolDefinition } from './index.js'
import axios, { AxiosInstance } from 'axios'

export class APIGateway {
  private axios: AxiosInstance
  private tools: Map<string, MCPToolDefinition>

  constructor(apiHost: string, tools: MCPToolDefinition[]) {
    this.axios = axios.create({
      baseURL: apiHost,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    })

    this.tools = new Map(tools.map((tool) => [tool.name, tool]))
  }

  /**
   * 执行工具调用
   * @param toolName 工具名称
   * @param params 调用参数
   */
  public async execute(
    toolName: string,
    params: Record<string, any>,
  ): Promise<any> {
    const tool = this.tools.get(toolName)
    if (!tool) {
      throw new Error(`未找到工具: ${toolName}`)
    }

    // 验证必需参数
    this.validateParams(tool, params)

    // 执行 API 调用
    try {
      const response = await this.axios.request({
        method: this.extractMethod(toolName),
        url: this.buildUrl(toolName, params),
        data: params.body,
        params: this.extractQueryParams(params),
      })

      return response.data
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`API 调用失败: ${error.message}`)
      }
      throw error
    }
  }

  private validateParams(
    tool: MCPToolDefinition,
    params: Record<string, any>,
  ): void {
    const missing = tool.parameters.required.filter(
      (param) => !(param in params),
    )
    if (missing.length > 0) {
      throw new Error(`缺少必需参数: ${missing.join(', ')}`)
    }
  }

  private extractMethod(toolName: string): string {
    const method = toolName.split('_')[0].toUpperCase()
    return ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)
      ? method
      : 'GET'
  }

  private buildUrl(toolName: string, params: Record<string, any>): string {
    // 从工具名称中提取路径
    const pathParts = toolName.split('_').slice(1)
    let path = '/' + pathParts.join('/')

    // 替换路径参数
    Object.entries(params).forEach(([key, value]) => {
      if (path.includes(`{${key}}`)) {
        path = path.replace(`{${key}}`, encodeURIComponent(String(value)))
      }
    })

    return path
  }

  private extractQueryParams(params: Record<string, any>): Record<string, any> {
    // 过滤出不是请求体的参数作为查询参数
    const queryParams: Record<string, any> = {}
    Object.entries(params).forEach(([key, value]) => {
      if (key !== 'body') {
        queryParams[key] = value
      }
    })
    return queryParams
  }
}
