import { OpenAPIConverter, OpenAPIToMCPOptions } from './index.js'
import { APIGateway } from './api-gateway.js'
import { MCPService, MCPServiceOptions } from '../../types.js'

export interface OpenAPIMCPAdapterOptions extends MCPServiceOptions {
  apiSpec: OpenAPIToMCPOptions['apiSpec']
  apiHost: string
}

export class OpenAPIMCPAdapter implements MCPService {
  private converter: OpenAPIConverter
  private gateway: APIGateway
  private tools: ReturnType<OpenAPIConverter['convert']>

  constructor(options: OpenAPIMCPAdapterOptions) {
    this.converter = new OpenAPIConverter({
      apiSpec: options.apiSpec,
      apiHost: options.apiHost,
    })

    this.tools = this.converter.convert()
    this.gateway = new APIGateway(options.apiHost, this.tools)
  }

  public async initialize(): Promise<void> {
    // 无需特殊初始化
  }

  public async destroy(): Promise<void> {
    // 无需特殊清理
  }

  public getTools() {
    return this.tools
  }

  public async executeToolCall(
    toolName: string,
    params: Record<string, any>,
  ): Promise<any> {
    return this.gateway.execute(toolName, params)
  }
}
