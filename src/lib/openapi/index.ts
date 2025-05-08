import { OpenAPIV3_1 } from 'openapi-types'

export interface OpenAPIToMCPOptions {
  apiSpec: OpenAPIV3_1.Document
  apiHost: string
}

export interface MCPToolDefinition {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, any>
    required: string[]
  }
}

export class OpenAPIConverter {
  private apiSpec: OpenAPIV3_1.Document
  private apiHost: string

  constructor(options: OpenAPIToMCPOptions) {
    this.apiSpec = options.apiSpec
    this.apiHost = options.apiHost
  }

  /**
   * 将 OpenAPI 规范转换为 MCP 工具定义列表
   */
  public convert(): MCPToolDefinition[] {
    const tools: MCPToolDefinition[] = []

    // 遍历所有路径
    for (const [path, pathItem] of Object.entries(this.apiSpec.paths || {})) {
      if (!pathItem || typeof pathItem === 'string' || Array.isArray(pathItem))
        continue

      // 遍历所有 HTTP 方法
      for (const [method, operation] of Object.entries(pathItem)) {
        if (
          method === 'parameters' ||
          !operation ||
          typeof operation === 'string' ||
          Array.isArray(operation)
        )
          continue

        const operationObj = operation as OpenAPIV3_1.OperationObject
        tools.push(this.convertOperationToTool(path, method, operationObj))
      }
    }

    return tools
  }

  private isHttpMethod(method: string): method is OpenAPIV3_1.HttpMethods {
    return [
      'get',
      'put',
      'post',
      'delete',
      'options',
      'head',
      'patch',
      'trace',
    ].includes(method.toLowerCase())
  }

  private convertOperationToTool(
    path: string,
    method: string,
    operation: OpenAPIV3_1.OperationObject,
  ): MCPToolDefinition {
    const parameters: Record<string, any> = {}
    const required: string[] = []

    // 处理路径参数
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if ('name' in param && 'schema' in param) {
          parameters[param.name] = this.convertSchema(
            param.schema as OpenAPIV3_1.SchemaObject,
          )
          if (param.required) {
            required.push(param.name)
          }
        }
      }
    }

    // 处理请求体
    if (operation.requestBody && 'content' in operation.requestBody) {
      const content = operation.requestBody.content
      if (content['application/json']?.schema) {
        const schema = content['application/json']
          .schema as OpenAPIV3_1.SchemaObject
        if (schema.properties) {
          for (const [propName, propSchema] of Object.entries(
            schema.properties,
          )) {
            parameters[propName] = this.convertSchema(
              propSchema as OpenAPIV3_1.SchemaObject,
            )
          }
          if (schema.required) {
            required.push(...schema.required)
          }
        }
      }
    }

    return {
      name: this.generateToolName(path, method, operation),
      description:
        operation.summary ||
        operation.description ||
        `${method.toUpperCase()} ${path}`,
      parameters: {
        type: 'object',
        properties: this.convertParameters(operation),
        required: this.getRequiredParameters(operation),
      },
    }
  }

  private generateToolName(
    path: string,
    method: string,
    operation: OpenAPIV3_1.OperationObject,
  ): string {
    // 优先使用 operationId
    if (operation.operationId) {
      return operation.operationId
    }

    // 否则根据路径和方法生成名称
    const pathName = path
      .split('/')
      .filter(Boolean)
      .map((segment) => segment.replace(/[^a-zA-Z0-9]/g, '_'))
      .join('_')

    return `${method.toLowerCase()}_${pathName}`
  }

  private convertParameters(
    operation: OpenAPIV3_1.OperationObject,
  ): Record<string, any> {
    const properties: Record<string, any> = {}

    // 处理路径参数、查询参数等
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if (!param || typeof param === 'string' || Array.isArray(param))
          continue

        if ('schema' in param) {
          const schema = param.schema
          if (schema && !('$ref' in schema)) {
            properties[param.name] = this.convertSchema(schema)
          }
        }
      }
    }

    // 处理请求体
    if (operation.requestBody && !('$ref' in operation.requestBody)) {
      const requestBody = operation.requestBody
      if ('content' in requestBody) {
        const content = requestBody.content['application/json']
        if (content?.schema && !('$ref' in content.schema)) {
          properties.body = this.convertSchema(content.schema)
        }
      }
    }

    return properties
  }

  private convertSchema(schema: OpenAPIV3_1.SchemaObject): any {
    return {
      type: schema.type,
      description: schema.description,
      ...(schema.enum ? { enum: schema.enum } : {}),
    }
  }

  private getRequiredParameters(
    operation: OpenAPIV3_1.OperationObject,
  ): string[] {
    const required: string[] = []

    // 收集必需的参数
    if (operation.parameters) {
      for (const param of operation.parameters) {
        if (!param || typeof param === 'string' || Array.isArray(param))
          continue

        if ('required' in param && param.required && 'name' in param) {
          required.push(param.name)
        }
      }
    }

    // 处理必需的请求体
    if (
      operation.requestBody &&
      !('$ref' in operation.requestBody) &&
      operation.requestBody.required
    ) {
      required.push('body')
    }

    return required
  }
}
