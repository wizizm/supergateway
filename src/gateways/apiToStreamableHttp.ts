import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import fetch from 'node-fetch'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'

interface ApiToStreamableHttpArgs {
  apiHost: string
  apiSpecPath: string
  port: number
  httpPath: string
  headers?: Record<string, string>
  corsOrigin?: any
  healthEndpoints?: string[]
  logger: Logger
}

interface OpenAPIProperty {
  type?: string
  description?: string
  format?: string
  items?: OpenAPIProperty
  properties?: Record<string, OpenAPIProperty>
  [key: string]: any
}

interface OpenAPIOperation {
  operationId?: string
  summary?: string
  description?: string
  parameters?: Array<{
    name: string
    in: string
    schema: {
      type: string
      enum?: string[]
      format?: string
    }
    description?: string
    required?: boolean
  }>
  requestBody?: {
    content: {
      'application/json': {
        schema: {
          type: string
          properties?: Record<string, OpenAPIProperty>
          required?: string[]
        }
      }
    }
    required?: boolean
    description?: string
  }
  responses?: Record<
    string,
    {
      description?: string
      content?: {
        [contentType: string]: {
          schema?: {
            type?: string
            properties?: Record<string, OpenAPIProperty>
            items?: OpenAPIProperty
          }
        }
      }
    }
  >
}

interface OpenAPIPathItem {
  parameters?: OpenAPIOperation['parameters']
  [method: string]:
    | OpenAPIOperation
    | OpenAPIOperation['parameters']
    | undefined
}

interface OpenAPISpec {
  paths?: Record<string, OpenAPIPathItem>
  components?: {
    schemas?: Record<string, any>
  }
  info?: {
    title?: string
    version?: string
    description?: string
  }
}

// MCP工具参数
interface ToolArg {
  name: string
  description: string
  type: string
  required: boolean
  position: 'path' | 'query' | 'body' | 'header'
}

// MCP工具请求模板
interface RequestTemplate {
  url: string
  method: string
  headers?: Array<{ key: string; value: string }>
}

// MCP工具响应模板
interface ResponseTemplate {
  prependBody?: string
}

// MCP工具定义
interface McpTool {
  name: string
  description: string
  args: ToolArg[]
  requestTemplate: RequestTemplate
  responseTemplate: ResponseTemplate
}

// API输入数据接口
interface ApiInputData {
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  body?: Record<string, any>
  path?: Record<string, string>
  [key: string]: any
}

// 简化的API规范加载函数
async function loadOpenApiSpec(
  apiSpecPath: string,
  logger: Logger,
): Promise<OpenAPISpec> {
  try {
    logger.info(`加载 OpenAPI 规范: ${apiSpecPath}`)

    try {
      await fs.access(apiSpecPath)
    } catch (err) {
      logger.warn(`OpenAPI规范文件不存在，使用空规范: ${apiSpecPath}`)
      return { paths: {} }
    }

    try {
      const specContent = await fs.readFile(apiSpecPath, 'utf-8')
      const spec = JSON.parse(specContent) as OpenAPISpec
      logger.info(
        `OpenAPI 规范加载成功: ${Object.keys(spec.paths || {}).length} 个路径`,
      )
      return spec
    } catch (err) {
      logger.warn(`OpenAPI规范解析失败，使用空规范: ${err.message}`)
      return { paths: {} }
    }
  } catch (error) {
    logger.error(`加载 OpenAPI 规范过程中发生错误: ${apiSpecPath}`, error)
    return { paths: {} }
  }
}

// 将CORS源序列化为正确的格式
function formatCorsOrigin(
  origin: any,
): string | RegExp | (string | RegExp)[] | undefined {
  if (
    origin === '*' ||
    origin === false ||
    origin === true ||
    origin === undefined
  ) {
    return origin
  }
  if (Array.isArray(origin)) {
    return origin
  }
  if (typeof origin === 'string') {
    return origin.split(',').map((o) => o.trim())
  }
  return origin
}

// 从OpenAPI类型转换为简化的JSON Schema类型
function getSimpleType(openApiType: string | undefined): string {
  if (!openApiType) return 'string'

  switch (openApiType.toLowerCase()) {
    case 'integer':
    case 'number':
      return 'integer'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

// 生成响应模板内容
function generateResponseTemplate(
  operation: OpenAPIOperation,
  method: string,
  path: string,
): string {
  let template = `# API Response Information

Below is the response from an API call. To help you understand the data, I've provided:

1. A detailed description of all fields in the response structure
2. The complete API response

## Response Structure

`

  // 查找默认响应或成功响应（2xx）
  let responseObj =
    operation.responses &&
    (operation.responses['200'] ||
      operation.responses['201'] ||
      operation.responses['default'])
  if (!responseObj) {
    return (
      template +
      `No detailed response structure information available.\n\n## Original Response\n\n`
    )
  }

  // 检查响应内容类型
  let contentType = 'application/json'
  let schema = null

  if (
    responseObj.content &&
    responseObj.content[contentType] &&
    responseObj.content[contentType].schema
  ) {
    schema = responseObj.content[contentType].schema
    template += `> Content-Type: ${contentType}\n\n`

    // 处理不同类型的响应
    if (schema.type === 'object' && schema.properties) {
      for (const [propName, propDetailsRaw] of Object.entries(
        schema.properties,
      )) {
        // 使用类型断言确保类型安全
        const propDetails = propDetailsRaw as OpenAPIProperty
        const description = propDetails.description || 'No description'
        const type = propDetails.type || 'unknown'
        template += `- **${propName}**: ${description} (Type: ${type})\n`

        // 如果是数组类型，添加数组项的描述
        if (propDetails.type === 'array' && propDetails.items) {
          const itemType = propDetails.items.type || 'unknown'

          // 如果数组项是对象，添加对象属性的描述
          if (
            propDetails.items.type === 'object' &&
            propDetails.items.properties
          ) {
            for (const [itemPropName, itemPropDetailsRaw] of Object.entries(
              propDetails.items.properties,
            )) {
              const itemPropDetails = itemPropDetailsRaw as OpenAPIProperty
              const itemDescription =
                itemPropDetails.description || 'No description'
              const itemType = itemPropDetails.type || 'unknown'
              template += `  - **${propName}[].${itemPropName}**: ${itemDescription} (Type: ${itemType})\n`
            }
          } else {
            template += `  - **${propName}[]**: Array items of type ${itemType}\n`
          }
        }
      }
    } else if (schema.type === 'array' && schema.items) {
      template += `- Array items`

      // 如果数组项是对象，添加对象属性的描述
      if (schema.items.type === 'object' && schema.items.properties) {
        for (const [propName, propDetailsRaw] of Object.entries(
          schema.items.properties,
        )) {
          const propDetails = propDetailsRaw as OpenAPIProperty
          const description = propDetails.description || 'No description'
          const type = propDetails.type || 'unknown'
          template += `  - **[].${propName}**: ${description} (Type: ${type})\n`
        }
      } else {
        template += ` of type ${schema.items.type || 'unknown'}\n`
      }
    } else {
      template += `- Response type: ${schema.type || 'unknown'}\n`
      template += `- Description: ${responseObj.description || 'No description'}\n`
    }
  } else {
    template += `No detailed response structure information available.\n`
    template += `- Description: ${responseObj.description || 'No description'}\n`
  }

  template += `\n## Original Response\n\n`
  return template
}

// 创建MCP工具参数
function createToolArgs(operation: OpenAPIOperation): ToolArg[] {
  const args: ToolArg[] = []

  // 处理路径参数
  if (operation.parameters) {
    for (const param of operation.parameters) {
      if (param.in === 'path') {
        args.push({
          name: param.name,
          description: param.description || `Path parameter: ${param.name}`,
          type: getSimpleType(param.schema?.type),
          required: param.required !== false, // 路径参数通常是必需的
          position: 'path',
        })
      } else if (param.in === 'query') {
        args.push({
          name: param.name,
          description: param.description || `Query parameter: ${param.name}`,
          type: getSimpleType(param.schema?.type),
          required: !!param.required,
          position: 'query',
        })
      } else if (param.in === 'header') {
        args.push({
          name: param.name,
          description: param.description || `Header parameter: ${param.name}`,
          type: getSimpleType(param.schema?.type),
          required: !!param.required,
          position: 'header',
        })
      }
    }
  }

  // 处理请求体参数
  if (
    operation.requestBody &&
    operation.requestBody.content &&
    operation.requestBody.content['application/json'] &&
    operation.requestBody.content['application/json'].schema &&
    operation.requestBody.content['application/json'].schema.properties
  ) {
    const schema = operation.requestBody.content['application/json'].schema
    const required = schema.required || []

    for (const [propName, propDetailsRaw] of Object.entries(
      schema.properties || {},
    )) {
      const propDetails = propDetailsRaw as OpenAPIProperty
      args.push({
        name: propName,
        description: propDetails.description || `Body parameter: ${propName}`,
        type: getSimpleType(propDetails.type),
        required: required.includes(propName),
        position: 'body',
      })
    }
  }

  return args
}

// 创建工具定义
function createMcpTool(
  path: string,
  method: string,
  operation: OpenAPIOperation,
): McpTool {
  // 使用operationId作为工具ID，如果不存在则构造一个基于路径和方法的ID
  const toolName =
    operation.operationId ||
    `api_${method.toLowerCase()}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`

  // 构建工具的描述信息
  const toolDescription =
    operation.description ||
    operation.summary ||
    `${method.toUpperCase()} ${path}`

  // 创建工具参数
  const args = createToolArgs(operation)

  // 创建请求模板
  const requestTemplate: RequestTemplate = {
    url: path,
    method: method.toUpperCase(),
  }

  // 如果有请求体参数，添加Content-Type头
  if (
    args.some((arg) => arg.position === 'body') &&
    ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase())
  ) {
    requestTemplate.headers = [
      { key: 'Content-Type', value: 'application/json' },
    ]
  }

  // 创建响应模板
  const responseTemplate: ResponseTemplate = {}

  // 添加响应前缀
  const prependBody = generateResponseTemplate(
    operation,
    method.toUpperCase(),
    path,
  )
  if (prependBody) {
    responseTemplate.prependBody = prependBody
  }

  return {
    name: toolName,
    description: toolDescription,
    args,
    requestTemplate,
    responseTemplate,
  }
}

// 转换OpenAPI规范到MCP工具
function convertOpenApiToMcpTools(
  spec: OpenAPISpec,
  logger: Logger,
): McpTool[] {
  const tools: McpTool[] = []

  logger.info(`开始转换OpenAPI到MCP工具...`)

  // 遍历路径
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    // 遍历HTTP方法
    for (const [method, operation] of Object.entries(pathItem || {})) {
      if (
        ['get', 'post', 'put', 'delete', 'patch'].includes(
          method.toLowerCase(),
        ) &&
        operation &&
        typeof operation === 'object' &&
        !Array.isArray(operation)
      ) {
        const op = operation as OpenAPIOperation
        const tool = createMcpTool(path, method, op)

        logger.info(`生成MCP工具: ${tool.name} - ${tool.description}`)
        tools.push(tool)
      }
    }
  }

  logger.info(`共生成 ${tools.length} 个MCP工具`)
  return tools
}

/**
 * 注册MCP工具
 */
function registerMcpTools(
  server: McpServer,
  tools: McpTool[],
  apiHost: string,
  headers: Record<string, string> = {},
  logger: Logger,
) {
  for (const tool of tools) {
    logger.info(`注册MCP工具: ${tool.name}`)

    // 创建工具参数schema
    const paramSchema: Record<string, any> = {}

    // 针对每个工具参数创建对应的schema
    for (const arg of tool.args) {
      let schema

      switch (arg.type) {
        case 'integer':
          schema = arg.required ? z.number().int() : z.number().int().optional()
          break
        case 'boolean':
          schema = arg.required ? z.boolean() : z.boolean().optional()
          break
        case 'array':
          schema = arg.required ? z.array(z.any()) : z.array(z.any()).optional()
          break
        case 'object':
          schema = arg.required
            ? z.record(z.any())
            : z.record(z.any()).optional()
          break
        default: // string
          schema = arg.required ? z.string() : z.string().optional()
      }

      paramSchema[arg.name] = schema.describe(arg.description || arg.name)
    }

    // 注册工具 - 使用直接参数调用模式
    server.tool(tool.name, tool.description, paramSchema, async (params) => {
      try {
        // 将参数分类
        const pathParams: Record<string, string> = {}
        const queryParams: Record<string, any> = {}
        const bodyParams: Record<string, any> = {}
        const headerParams: Record<string, string> = {}

        for (const arg of tool.args) {
          const value = params[arg.name]
          if (value !== undefined) {
            switch (arg.position) {
              case 'path':
                pathParams[arg.name] = String(value)
                break
              case 'query':
                queryParams[arg.name] = value
                break
              case 'body':
                bodyParams[arg.name] = value
                break
              case 'header':
                headerParams[arg.name] = String(value)
                break
            }
          } else if (arg.required) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `错误: 必需参数 ${arg.name} 缺失`,
                },
              ],
            }
          }
        }

        // 处理路径参数
        let url = tool.requestTemplate.url
        for (const [paramName, paramValue] of Object.entries(pathParams)) {
          url = url.replace(
            `{${paramName}}`,
            encodeURIComponent(String(paramValue)),
          )
        }

        // 完整URL - 检查URL是否已经是一个完整的URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          // 确保apiHost末尾没有斜杠，而url开头有斜杠
          const baseUrl = apiHost.endsWith('/') ? apiHost.slice(0, -1) : apiHost
          const pathUrl = url.startsWith('/') ? url : `/${url}`
          url = `${baseUrl}${pathUrl}`
        } else {
          logger.info(`使用完整URL: ${url}`)
        }

        // 添加查询参数
        if (Object.keys(queryParams).length > 0) {
          const queryParts = []
          for (const [key, value] of Object.entries(queryParams)) {
            if (value !== undefined) {
              queryParts.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
              )
            }
          }
          if (queryParts.length > 0) {
            url += `?${queryParts.join('&')}`
          }
        }

        logger.info(`调用API: ${tool.requestTemplate.method} ${url}`)

        // 准备请求头
        const requestHeaders: Record<string, string> = {
          ...headers,
          ...headerParams,
        }

        // 添加Content-Type头
        if (
          ['POST', 'PUT', 'PATCH'].includes(tool.requestTemplate.method) &&
          Object.keys(bodyParams).length > 0
        ) {
          requestHeaders['Content-Type'] = 'application/json'
        }

        // 添加工具中定义的请求头
        if (tool.requestTemplate.headers) {
          for (const header of tool.requestTemplate.headers) {
            requestHeaders[header.key] = header.value
          }
        }

        // 请求体
        const body =
          Object.keys(bodyParams).length > 0
            ? JSON.stringify(bodyParams)
            : undefined

        // 发送API请求
        const response = await fetch(url, {
          method: tool.requestTemplate.method,
          headers: requestHeaders,
          body,
        })

        // 处理响应
        const contentType = response.headers.get('content-type') || ''
        let result: any

        if (contentType.includes('application/json')) {
          result = await response.json()
          logger.info(
            `API响应状态: ${response.status}, 内容类型: application/json`,
          )
        } else {
          result = await response.text()
          logger.info(
            `API响应状态: ${response.status}, 内容类型: ${contentType}`,
          )
        }

        // 构建响应内容
        let resultText = ''

        // 添加响应前缀
        if (tool.responseTemplate.prependBody) {
          resultText += tool.responseTemplate.prependBody
        }

        // 添加原始响应
        resultText +=
          typeof result === 'string' ? result : JSON.stringify(result, null, 2)

        return {
          content: [
            {
              type: 'text' as const,
              text: resultText,
            },
          ],
        }
      } catch (error) {
        logger.error(`工具调用错误 (${tool.name}):`, error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `错误: ${error.message}`,
            },
          ],
        }
      }
    })
  }
}

/**
 * 处理MCP请求
 */
async function handleMcpRequest(
  req: express.Request,
  res: express.Response,
  tools: McpTool[],
  apiHost: string,
  headers: Record<string, string> = {},
  logger: Logger,
) {
  // 创建MCP服务器
  const server = new McpServer({
    name: 'API Gateway',
    version: getVersion(),
  })

  logger.info(`创建MCP服务器实例，处理请求: ${req.method} ${req.path}`)

  // 注册tools/call处理函数
  server.tool(
    'apiCallHandler',
    '处理API调用',
    {
      name: z.string().describe('API工具名称'),
      arguments: z.record(z.any()).optional().describe('API调用参数'),
    },
    async (toolParams) => {
      const { name, arguments: args = {} } = toolParams

      // 查找工具
      const tool = tools.find((t) => t.name === name)
      if (!tool) {
        throw new Error(`Tool not found: ${name}`)
      }

      // 处理路径参数
      const pathParams: Record<string, string> = {}
      const queryParams: Record<string, any> = {}
      const bodyParams: Record<string, any> = {}
      const headerParams: Record<string, string> = {}

      for (const arg of tool.args) {
        const value = args[arg.name]
        if (value !== undefined) {
          switch (arg.position) {
            case 'path':
              pathParams[arg.name] = String(value)
              break
            case 'query':
              queryParams[arg.name] = value
              break
            case 'body':
              bodyParams[arg.name] = value
              break
            case 'header':
              headerParams[arg.name] = String(value)
              break
          }
        } else if (arg.required) {
          throw new Error(`必需参数 ${arg.name} 缺失`)
        }
      }

      // 处理路径参数
      let url = tool.requestTemplate.url
      for (const [paramName, paramValue] of Object.entries(pathParams)) {
        url = url.replace(
          `{${paramName}}`,
          encodeURIComponent(String(paramValue)),
        )
      }

      // 完整URL - 检查URL是否已经是一个完整的URL
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        // 确保apiHost末尾没有斜杠，而url开头有斜杠
        const baseUrl = apiHost.endsWith('/') ? apiHost.slice(0, -1) : apiHost
        const pathUrl = url.startsWith('/') ? url : `/${url}`
        url = `${baseUrl}${pathUrl}`
      } else {
        logger.info(`使用完整URL: ${url}`)
      }

      // 添加查询参数
      if (Object.keys(queryParams).length > 0) {
        const queryParts = []
        for (const [key, value] of Object.entries(queryParams)) {
          if (value !== undefined) {
            queryParts.push(
              `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
            )
          }
        }
        if (queryParts.length > 0) {
          url += `?${queryParts.join('&')}`
        }
      }

      logger.info(`调用API: ${tool.requestTemplate.method} ${url}`)

      // 准备请求头
      const requestHeaders: Record<string, string> = {
        ...headers,
        ...headerParams,
      }

      // 添加Content-Type头
      if (
        ['POST', 'PUT', 'PATCH'].includes(tool.requestTemplate.method) &&
        Object.keys(bodyParams).length > 0
      ) {
        requestHeaders['Content-Type'] = 'application/json'
      }

      // 添加工具中定义的请求头
      if (tool.requestTemplate.headers) {
        for (const header of tool.requestTemplate.headers) {
          requestHeaders[header.key] = header.value
        }
      }

      // 请求体
      const body =
        Object.keys(bodyParams).length > 0
          ? JSON.stringify(bodyParams)
          : undefined

      // 发送API请求
      try {
        const response = await fetch(url, {
          method: tool.requestTemplate.method,
          headers: requestHeaders,
          body,
        })

        // 处理响应
        const contentType = response.headers.get('content-type') || ''
        let result: any

        if (contentType.includes('application/json')) {
          result = await response.json()
          logger.info(
            `API响应状态: ${response.status}, 内容类型: application/json`,
          )
        } else {
          result = await response.text()
          logger.info(
            `API响应状态: ${response.status}, 内容类型: ${contentType}`,
          )
        }

        // 构建响应内容
        let resultText = ''

        // 添加响应前缀
        if (tool.responseTemplate.prependBody) {
          resultText += tool.responseTemplate.prependBody
        }

        // 添加原始响应
        resultText +=
          typeof result === 'string' ? result : JSON.stringify(result, null, 2)

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        }
      } catch (error) {
        logger.error(`API调用失败:`, error)
        return {
          content: [
            {
              type: 'text',
              text: `错误: ${error.message}`,
            },
          ],
        }
      }
    },
  )

  // 注册所有API工具
  for (const tool of tools) {
    server.tool(
      tool.name,
      tool.description,
      tool.args.reduce(
        (schema, arg) => {
          // 根据参数类型创建对应的schema
          let argSchema
          switch (arg.type) {
            case 'integer':
              argSchema = arg.required
                ? z.number().int()
                : z.number().int().optional()
              break
            case 'boolean':
              argSchema = arg.required ? z.boolean() : z.boolean().optional()
              break
            case 'array':
              argSchema = arg.required
                ? z.array(z.any())
                : z.array(z.any()).optional()
              break
            case 'object':
              argSchema = arg.required
                ? z.record(z.any())
                : z.record(z.any()).optional()
              break
            default: // string
              argSchema = arg.required ? z.string() : z.string().optional()
          }
          schema[arg.name] = argSchema.describe(arg.description || arg.name)
          return schema
        },
        {} as Record<string, z.ZodTypeAny>,
      ),
      async (params) => {
        // 处理路径参数
        const pathParams: Record<string, string> = {}
        const queryParams: Record<string, any> = {}
        const bodyParams: Record<string, any> = {}
        const headerParams: Record<string, string> = {}

        for (const arg of tool.args) {
          const value = params[arg.name]
          if (value !== undefined) {
            switch (arg.position) {
              case 'path':
                pathParams[arg.name] = String(value)
                break
              case 'query':
                queryParams[arg.name] = value
                break
              case 'body':
                bodyParams[arg.name] = value
                break
              case 'header':
                headerParams[arg.name] = String(value)
                break
            }
          } else if (arg.required) {
            throw new Error(`必需参数 ${arg.name} 缺失`)
          }
        }

        // 处理路径参数
        let url = tool.requestTemplate.url
        for (const [paramName, paramValue] of Object.entries(pathParams)) {
          url = url.replace(
            `{${paramName}}`,
            encodeURIComponent(String(paramValue)),
          )
        }

        // 完整URL - 检查URL是否已经是一个完整的URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          // 确保apiHost末尾没有斜杠，而url开头有斜杠
          const baseUrl = apiHost.endsWith('/') ? apiHost.slice(0, -1) : apiHost
          const pathUrl = url.startsWith('/') ? url : `/${url}`
          url = `${baseUrl}${pathUrl}`
        } else {
          logger.info(`使用完整URL: ${url}`)
        }

        // 添加查询参数
        if (Object.keys(queryParams).length > 0) {
          const queryParts = []
          for (const [key, value] of Object.entries(queryParams)) {
            if (value !== undefined) {
              queryParts.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
              )
            }
          }
          if (queryParts.length > 0) {
            url += `?${queryParts.join('&')}`
          }
        }

        logger.info(`调用API: ${tool.requestTemplate.method} ${url}`)

        // 准备请求头
        const requestHeaders: Record<string, string> = {
          ...headers,
          ...headerParams,
        }

        // 添加Content-Type头
        if (
          ['POST', 'PUT', 'PATCH'].includes(tool.requestTemplate.method) &&
          Object.keys(bodyParams).length > 0
        ) {
          requestHeaders['Content-Type'] = 'application/json'
        }

        // 添加工具中定义的请求头
        if (tool.requestTemplate.headers) {
          for (const header of tool.requestTemplate.headers) {
            requestHeaders[header.key] = header.value
          }
        }

        // 请求体
        const body =
          Object.keys(bodyParams).length > 0
            ? JSON.stringify(bodyParams)
            : undefined

        // 发送API请求
        try {
          const response = await fetch(url, {
            method: tool.requestTemplate.method,
            headers: requestHeaders,
            body,
          })

          // 处理响应
          const contentType = response.headers.get('content-type') || ''
          let result: any

          if (contentType.includes('application/json')) {
            result = await response.json()
            logger.info(
              `API响应状态: ${response.status}, 内容类型: application/json`,
            )
          } else {
            result = await response.text()
            logger.info(
              `API响应状态: ${response.status}, 内容类型: ${contentType}`,
            )
          }

          // 构建响应内容
          let resultText = ''

          // 添加响应前缀
          if (tool.responseTemplate.prependBody) {
            resultText += tool.responseTemplate.prependBody
          }

          // 添加原始响应
          resultText +=
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2)

          return {
            content: [
              {
                type: 'text',
                text: resultText,
              },
            ],
          }
        } catch (error) {
          logger.error(`API调用失败 (${tool.name}):`, error)
          return {
            content: [
              {
                type: 'text',
                text: `错误: ${error.message}`,
              },
            ],
          }
        }
      },
    )
  }

  // 为请求创建传输实例
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  try {
    // 连接服务器和传输
    await server.connect(transport)
    logger.info('服务器和传输连接成功')

    // 处理请求
    await transport.handleRequest(req, res, req.body)

    // 在连接关闭时清理资源
    res.on('close', () => {
      transport.close()
      server.close()
      logger.info('连接关闭，资源已清理')
    })
  } catch (error) {
    logger.error('处理MCP请求时出错:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      })
    }
  }
}

export const apiToStreamableHttp = async (args: ApiToStreamableHttpArgs) => {
  const { logger } = args
  const app = express()

  logger.info(`初始化API->StreamableHTTP网关配置:`)
  logger.info(`- API主机: ${args.apiHost}`)
  logger.info(`- API规范路径: ${args.apiSpecPath}`)
  logger.info(`- 服务端口: ${args.port}`)
  logger.info(`- HTTP路径: ${args.httpPath}`)

  // 启用CORS，确保跨域请求正常工作
  app.use(
    cors({
      origin: formatCorsOrigin(args.corsOrigin) || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'x-session-id',
        'mcp-session-id',
        'Accept',
      ],
      exposedHeaders: ['x-session-id', 'mcp-session-id'],
      credentials: true,
      maxAge: 86400,
    }),
  )

  // 对非MCP请求应用bodyParser中间件
  app.use((req, res, next) => {
    if (req.path !== args.httpPath) {
      bodyParser.json()(req, res, next)
    } else {
      next()
    }
  })

  // 健康检查端点
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
    })
  })

  // 状态检查端点
  app.get('/status', (req, res) => {
    res.status(200).json({
      status: 'ok',
      version: getVersion(),
      uptime: process.uptime(),
      timestamp: Date.now(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
      },
    })
  })

  // 用户自定义健康检查端点
  for (const ep of args.healthEndpoints || []) {
    app.get(ep, (req, res) => {
      res.status(200).send('ok')
    })
  }

  // 加载OpenAPI规范
  const openApiSpec = await loadOpenApiSpec(args.apiSpecPath, logger)

  // 转换为MCP工具
  const mcpTools = convertOpenApiToMcpTools(openApiSpec, logger)

  // 创建MCP配置文件端点（用于调试）
  app.get('/mcp-config', (req, res) => {
    const config = {
      server: {
        name: openApiSpec.info?.title || 'API Gateway',
        version: openApiSpec.info?.version || getVersion(),
      },
      tools: mcpTools,
    }

    res.status(200).json(config)
  })

  // 处理MCP请求
  app.post(args.httpPath, async (req, res) => {
    await handleMcpRequest(
      req,
      res,
      mcpTools,
      args.apiHost,
      args.headers,
      logger,
    )
  })

  // 处理GET请求 - 返回方法不允许
  app.get(args.httpPath, async (_req, res) => {
    logger.info('收到GET MCP请求')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  // 处理DELETE请求 - 返回方法不允许
  app.delete(args.httpPath, async (_req, res) => {
    logger.info('收到DELETE MCP请求')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  // 启动服务器
  try {
    const server = app.listen(args.port, () => {
      logger.info(`服务器启动成功:`)
      logger.info(`- 监听端口: ${args.port}`)
      logger.info(
        `- StreamableHTTP端点: http://localhost:${args.port}${args.httpPath}`,
      )
      logger.info(`- 健康检查端点: http://localhost:${args.port}/health`)
      logger.info(`- 状态检查端点: http://localhost:${args.port}/status`)
      logger.info(`- MCP配置文件: http://localhost:${args.port}/mcp-config`)
    })

    // 添加错误处理
    server.on('error', (error) => {
      logger.error(`服务器错误: ${error.message}`, error)
    })

    // 确保在进程退出时清理资源
    const cleanup = () => {
      logger.info('清理资源...')
      server.close(() => {
        logger.info('服务器已关闭')
      })
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    return {
      server,
    }
  } catch (error) {
    logger.error(`服务器启动失败: ${error.message}`, error)
    throw error
  }
}
