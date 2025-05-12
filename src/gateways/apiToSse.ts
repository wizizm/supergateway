import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import fetch from 'node-fetch'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import yaml from 'js-yaml'
import { z } from 'zod'

interface ApiToSseArgs {
  apiHost: string
  mcpTemplateFile: string
  port: number
  ssePath: string
  messagePath: string
  headers?: Record<string, string>
  corsOrigin?: any
  healthEndpoints?: string[]
  logger: Logger
}

// MCP tool parameters
interface ToolArg {
  name: string
  description: string
  type: string
  required: boolean
  position: 'path' | 'query' | 'body' | 'header'
}

// MCP request template
interface RequestTemplate {
  url: string
  method: string
  headers?: Array<{ key: string; value: string }>
}

// MCP response template
interface ResponseTemplate {
  prependBody?: string
}

// MCP tool definition
interface McpTool {
  name: string
  description: string
  args: ToolArg[]
  requestTemplate: RequestTemplate
  responseTemplate: ResponseTemplate
}

// MCP server configuration
interface McpTemplate {
  server: {
    name: string
    version?: string
  }
  tools: McpTool[]
}

// Format CORS origin into the correct format
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

/**
 * Load MCP template file
 * If it's an OpenAPI specification, automatically convert it to MCP template
 */
async function loadMcpTemplate(
  templatePath: string,
  logger: Logger,
): Promise<McpTemplate> {
  try {
    logger.info(`Loading file: ${templatePath}`)

    try {
      await fs.access(templatePath)
    } catch (err) {
      logger.error(`File does not exist: ${templatePath}`)
      throw new Error(`File does not exist: ${templatePath}`)
    }

    // Read file content
    const fileContent = await fs.readFile(templatePath, 'utf-8')
    let template: McpTemplate | null = null
    let isOpenApi = false

    // Try to parse the file
    try {
      // Choose parsing method based on file extension
      const parsedContent = templatePath.endsWith('.json')
        ? JSON.parse(fileContent)
        : yaml.load(fileContent)

      // Check if it's an OpenAPI specification
      if (parsedContent && typeof parsedContent === 'object') {
        // OpenAPI specification has an openapi field
        if (parsedContent.openapi && parsedContent.paths) {
          logger.info(
            `Detected OpenAPI specification, version: ${parsedContent.openapi}`,
          )
          isOpenApi = true
        }
        // MCP template has server and tools fields
        else if (parsedContent.server && parsedContent.tools) {
          logger.info('Detected MCP template document')
          template = parsedContent as McpTemplate
        }
        // Doesn't match any known format
        else {
          logger.warn(
            'Document format not recognized, trying to process as MCP template',
          )
          template = parsedContent as McpTemplate
        }
      }
    } catch (parseError) {
      const msg =
        parseError instanceof Error ? parseError.message : String(parseError)
      logger.error(`Failed to parse file: ${msg}`, parseError)
      throw new Error(`Failed to parse file: ${msg}`)
    }

    // If it's an OpenAPI specification, convert to MCP template
    if (isOpenApi) {
      try {
        logger.info('Converting OpenAPI specification to MCP template...')
        const { convertOpenApiToMcpServer } = await import(
          '../lib/openapi-to-mcpserver/index.js'
        )

        // Convert OpenAPI to MCP template
        const mcpTemplateContent = await convertOpenApiToMcpServer(
          { input: templatePath },
          {},
          templatePath.endsWith('.json') ? 'json' : 'yaml',
          logger,
        )

        // Parse the generated template
        if (templatePath.endsWith('.json')) {
          template = JSON.parse(mcpTemplateContent) as McpTemplate
        } else {
          template = yaml.load(mcpTemplateContent) as McpTemplate
        }

        logger.info(
          'OpenAPI specification successfully converted to MCP template',
        )
      } catch (conversionError) {
        const msg =
          conversionError instanceof Error
            ? conversionError.message
            : String(conversionError)
        logger.error(
          `OpenAPI specification conversion failed: ${msg}`,
          conversionError,
        )
        throw new Error(`OpenAPI specification conversion failed: ${msg}`)
      }
    }

    // Ensure template is not null and contains necessary fields
    if (!template) {
      throw new Error('Unable to create a valid MCP template from file')
    }

    // Ensure template has necessary fields
    if (!template.server) {
      template.server = { name: 'API Gateway' }
    }

    if (!template.tools || !Array.isArray(template.tools)) {
      template.tools = []
    }

    logger.info(
      `MCP template loaded successfully: contains ${template.tools.length} tools`,
    )
    return template
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to load MCP template: ${msg}`, error)
    throw error
  }
}

/**
 * Handle MCP request
 */
async function handleMcpRequest(
  toolName: string,
  toolArgs: any,
  tool: McpTool,
  apiHost: string,
  headers: Record<string, string> = {},
  logger: Logger,
  clientHeaders?: Record<string, string | string[]>,
) {
  try {
    logger.info(`===== EXECUTING API TOOL: ${toolName} =====`)
    logger.info(`Tool arguments: ${JSON.stringify(toolArgs, null, 2)}`)

    if (!toolName) {
      logger.error('Missing tool name in request')
      return {
        error: 'Missing tool name',
      }
    }

    // Get request URL from the tool configuration
    const apiPath = tool.requestTemplate?.url || ''
    if (!apiPath) {
      logger.error(`Tool ${toolName} has no URL in request template`)
      return {
        error: 'Missing URL in request template',
      }
    }

    // Parse path parameters
    let processedPath = apiPath
    const pathParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'path') || []

    pathParams.forEach((param: ToolArg) => {
      const paramValue = toolArgs[param.name]
      if (param.required && paramValue === undefined) {
        const errorMsg = `Missing required path parameter: ${param.name}`
        logger.error(errorMsg)
        throw new Error(errorMsg)
      }
      if (paramValue !== undefined) {
        processedPath = processedPath.replace(
          `{${param.name}}`,
          encodeURIComponent(String(paramValue)),
        )
      }
    })

    // Create complete URL (handle relative paths)
    let url = processedPath
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url =
        apiHost +
        (apiHost.endsWith('/') ? '' : '/') +
        processedPath.replace(/^\//, '')
    }

    // Build query parameters
    const queryParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'query') || []
    if (queryParams.length > 0) {
      const searchParams = new URLSearchParams()
      queryParams.forEach((param: ToolArg) => {
        const paramValue = toolArgs[param.name]
        if (param.required && paramValue === undefined) {
          const errorMsg = `Missing required query parameter: ${param.name}`
          logger.error(errorMsg)
          throw new Error(errorMsg)
        }
        if (paramValue !== undefined) {
          searchParams.append(param.name, String(paramValue))
        }
      })

      const queryString = searchParams.toString()
      if (queryString) {
        url += (url.includes('?') ? '&' : '?') + queryString
      }
    }

    // Get request method
    const method = (tool.requestTemplate?.method || 'GET').toUpperCase()

    // 合并headers，优先处理客户端headers（类似apiToStreamableHttp中的处理方式）
    // 转换所有键为小写，便于标准化比较
    const lowerCaseHeaders = (obj: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]),
      )

    // 合并所有headers来源
    const mergedHeaders = {
      ...lowerCaseHeaders(headers),
      ...(clientHeaders && lowerCaseHeaders(clientHeaders)),
    }

    // 构建最终的请求headers
    const requestHeaders: Record<string, string | string[]> = {}

    // 从合并的headers中构建请求headers，跳过一些不需要的header
    for (const [key, value] of Object.entries(mergedHeaders)) {
      if (
        ['host', 'connection', 'content-length', 'accept-encoding'].includes(
          key,
        )
      )
        continue

      if (Array.isArray(value)) {
        requestHeaders[key] = value.map(String)
      } else if (value !== undefined && value !== null) {
        requestHeaders[key] = String(value)
      }
    }

    // Add headers defined in the tool template
    if (
      tool.requestTemplate?.headers &&
      Array.isArray(tool.requestTemplate.headers)
    ) {
      tool.requestTemplate.headers.forEach((header) => {
        if (header.key && header.value !== undefined) {
          // Support UUID template variable
          let value = header.value
          value = value.replace('{{uuidv4}}', randomUUID())
          requestHeaders[header.key] = value
        }
      })
    }

    // Add header parameters
    const headerParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'header') || []

    logger.info(
      `[MCP] headerParams for tool '${toolName}': ${JSON.stringify(headerParams.map((p) => p.name))}`,
    )

    headerParams.forEach((param: ToolArg) => {
      const paramValue = toolArgs[param.name]
      if (param.required && paramValue === undefined) {
        const errorMsg = `Missing required header parameter: ${param.name}`
        logger.error(errorMsg)
        throw new Error(errorMsg)
      }
      if (paramValue !== undefined) {
        requestHeaders[param.name] = String(paramValue)
      }
    })

    // Process request body
    let requestBody = undefined
    const bodyParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'body') || []
    if (bodyParams.length > 0) {
      const bodyData: Record<string, any> = {}
      bodyParams.forEach((param: ToolArg) => {
        const paramValue = toolArgs[param.name]
        if (param.required && paramValue === undefined) {
          const errorMsg = `Missing required body parameter: ${param.name}`
          logger.error(errorMsg)
          throw new Error(errorMsg)
        }
        if (paramValue !== undefined) {
          bodyData[param.name] = paramValue
        }
      })

      if (Object.keys(bodyData).length > 0) {
        requestBody = JSON.stringify(bodyData) as any
        requestHeaders['Content-Type'] = 'application/json'
      }
    }

    // Send request to API server
    logger.info(`Calling API: ${method} ${url}`)
    logger.info(`[MCP] Final requestHeaders: ${JSON.stringify(requestHeaders)}`)

    if (requestBody) {
      logger.debug(`Request body: ${requestBody}`)
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders as any,
      body: requestBody,
    })

    // Get response content
    const contentType = response.headers.get('content-type') || ''
    let responseData: any

    // 检查HTTP状态码
    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`
      let errorMessage = `API请求失败: ${statusText}`

      try {
        // 尝试获取错误详情
        if (contentType.includes('application/json')) {
          const errorJson = (await response.json()) as Record<string, any>
          logger.error(`API错误响应: ${JSON.stringify(errorJson)}`)
          errorMessage = errorJson.message || errorJson.error || errorMessage
        } else {
          const errorText = await response.text()
          if (errorText) {
            logger.error(`API错误响应: ${errorText}`)
            errorMessage = `${errorMessage} - ${errorText}`
          }
        }
      } catch (parseError) {
        logger.error(
          `解析错误响应失败: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        )
      }

      logger.error(`${method} ${url} 失败: ${response.status} ${statusText}`)
      return { error: errorMessage, status: response.status }
    }

    if (contentType.includes('application/json')) {
      try {
        responseData = await response.json()
        logger.info(
          `API response status: ${response.status}, content type: application/json`,
        )

        // 检查是否有内容（即使状态码是200）
        if (
          responseData === null ||
          responseData === undefined ||
          (typeof responseData === 'object' &&
            Object.keys(responseData).length === 0)
        ) {
          logger.warn(
            `API返回了状态码 ${response.status}，但响应体为空或为空对象`,
          )
        } else {
          // 记录一些响应数据的摘要，太长的话就截断
          const responseStr = JSON.stringify(responseData)
          const truncated =
            responseStr.length > 500
              ? responseStr.substring(0, 500) + '...'
              : responseStr
          logger.info(`API响应数据: ${truncated}`)
        }
      } catch (jsonError) {
        logger.error(
          `解析JSON响应失败: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`,
        )
        return {
          error: `解析JSON响应失败: ${jsonError instanceof Error ? jsonError.message : String(jsonError)}`,
          status: response.status,
        }
      }
    } else {
      responseData = await response.text()
      logger.info(
        `API response status: ${response.status}, content type: ${contentType}`,
      )

      if (responseData) {
        const truncated =
          responseData.length > 500
            ? responseData.substring(0, 500) + '...'
            : responseData
        logger.info(`API响应数据: ${truncated}`)
      } else {
        logger.warn(`API返回了状态码 ${response.status}，但响应体为空`)
      }
    }

    // Process response template (if any)
    let formattedResponse = responseData

    // 添加响应模板前缀（如果有）
    if (
      tool.responseTemplate?.prependBody &&
      typeof responseData === 'string'
    ) {
      formattedResponse = tool.responseTemplate.prependBody + responseData
    }

    logger.info(`===== FINISHED API TOOL: ${toolName} =====`)
    return formattedResponse
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`===== API TOOL ERROR: ${toolName} =====`)
    logger.error(`Error message: ${msg}`)
    if (error instanceof Error && error.stack) {
      logger.error(`Stack trace: ${error.stack}`)
    }
    logger.error(`===== END API TOOL ERROR =====`)
    return { error: `Request processing failed: ${msg}` }
  }
}

// Set response headers
const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

// API to SSE gateway
export const apiToSse = async (args: ApiToSseArgs) => {
  const { logger } = args
  const app = express()

  // 保存活跃会话的传输和请求头信息
  const transports: Record<string, SSEServerTransport> = {}
  // 保存每个会话的客户端请求头
  const sessionHeaders: Record<string, Record<string, string | string[]>> = {}

  // 存储全局变量，跟踪当前正在处理的会话ID
  let currentSessionId = ''

  logger.info(`Initializing API->SSE gateway configuration:`)
  logger.info(`- API host: ${args.apiHost}`)
  logger.info(
    `- Config file: ${args.mcpTemplateFile} (supports OpenAPI and MCP template formats)`,
  )
  logger.info(`- Server port: ${args.port}`)
  logger.info(`- SSE path: ${args.ssePath}`)
  logger.info(`- Message path: ${args.messagePath}`)

  // Enable CORS to ensure cross-origin requests work correctly
  app.use(
    cors({
      origin: args.corsOrigin ? formatCorsOrigin(args.corsOrigin) : '*',
      methods: 'GET,POST,OPTIONS',
      allowedHeaders: 'Content-Type,Authorization,mcp-session-id,x-session-id',
      exposedHeaders: 'mcp-session-id,x-session-id',
      credentials: true,
      maxAge: 86400,
    }),
  )

  // Apply bodyParser middleware for non-message requests
  app.use((req, res, next) => {
    if (req.path !== args.messagePath) {
      bodyParser.json()(req, res, next)
    } else {
      // Save raw request body for message path requests
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
      })

      req.on('end', () => {
        // Store raw body for later use
        ;(req as any).rawBody = data
        next()
      })
    }
  })

  // Add health check routes
  app.get('/health', (req, res) => {
    res.send('ok')
  })

  app.get('/status', (req, res) => {
    res.json({ status: 'running' })
  })

  // Health check endpoints
  const healthEndpoints = args.healthEndpoints || []
  for (const ep of healthEndpoints) {
    app.get(ep, (req, res) => {
      if (args.headers) {
        setResponseHeaders({
          res,
          headers: args.headers,
        })
      }
      res.send('ok')
    })
  }

  // Load MCP template
  let mcpTemplate: McpTemplate
  try {
    mcpTemplate = await loadMcpTemplate(args.mcpTemplateFile, logger)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`Failed to load MCP template: ${msg}`)
    throw error
  }

  // Provide configuration info access
  app.get('/mcp-config', (req, res) => {
    res.json(mcpTemplate)
  })

  // Create MCP server
  const mcpServer = new McpServer({
    name: mcpTemplate.server.name,
    version: mcpTemplate.server.version || getVersion(),
  })

  // Add a debug tool that just logs the request
  mcpServer.tool(
    'debug',
    'Log the tool call for debugging',
    {
      message: z.string().optional().describe('Optional message to log'),
      data: z.any().optional().describe('Optional data to log'),
      testMode: z
        .boolean()
        .optional()
        .describe('If true, will return the input as output'),
    },
    async (params) => {
      const msg = params.message || 'Debug tool called'
      logger.info(`===== DEBUG TOOL CALL =====`)
      logger.info(`Message: ${msg}`)

      if (params.data !== undefined) {
        try {
          const dataStr =
            typeof params.data === 'object'
              ? JSON.stringify(params.data, null, 2)
              : String(params.data)
          logger.info(`Data: ${dataStr}`)
        } catch (e) {
          logger.info(
            `Data: [Error serializing data: ${e instanceof Error ? e.message : String(e)}]`,
          )
        }
      }

      logger.info(`===== END DEBUG TOOL CALL =====`)

      // For testing, we can echo back the input
      const responseData = params.testMode
        ? {
            message: msg,
            data: params.data,
            timestamp: new Date().toISOString(),
          }
        : { content: msg, timestamp: new Date().toISOString() }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseData, null, 2),
          },
        ],
      }
    },
  )

  // Register tools from template
  logger.info(`Registering ${mcpTemplate.tools.length} tools:`)
  for (const tool of mcpTemplate.tools) {
    logger.info(
      `Registering tool: ${tool.name} (${tool.args.length} parameters)`,
    )

    // Build parameter schema
    const paramSchema: Record<string, z.ZodType<any>> = {}

    if (tool.args && Array.isArray(tool.args)) {
      for (const arg of tool.args) {
        const paramType = (arg.type || 'string').toLowerCase()

        try {
          switch (paramType) {
            case 'string':
              paramSchema[arg.name] = arg.required
                ? z.string()
                : z.string().optional()
              break
            case 'number':
            case 'integer':
              paramSchema[arg.name] = arg.required
                ? z
                    .string()
                    .transform((val) => Number(val))
                    .pipe(z.number())
                : z
                    .string()
                    .transform((val) => (val ? Number(val) : undefined))
                    .pipe(z.number().optional())
              break
            case 'boolean':
              paramSchema[arg.name] = arg.required
                ? z.string().transform((val) => val === 'true' || val === '1')
                : z
                    .string()
                    .optional()
                    .transform((val) => val === 'true' || val === '1')
              break
            case 'array':
              paramSchema[arg.name] = arg.required
                ? z
                    .string()
                    .transform((val) => {
                      try {
                        return JSON.parse(val)
                      } catch (e) {
                        return val ? val.split(',') : []
                      }
                    })
                    .pipe(z.array(z.any()))
                : z
                    .string()
                    .optional()
                    .transform((val) => {
                      if (!val) return undefined
                      try {
                        return JSON.parse(val)
                      } catch (e) {
                        return val.split(',')
                      }
                    })
                    .pipe(z.array(z.any()).optional())
              break
            case 'object':
              paramSchema[arg.name] = arg.required
                ? z
                    .string()
                    .transform((val) => {
                      try {
                        return JSON.parse(val)
                      } catch (e) {
                        return {}
                      }
                    })
                    .pipe(z.record(z.any()))
                : z
                    .string()
                    .optional()
                    .transform((val) => {
                      if (!val) return undefined
                      try {
                        return JSON.parse(val)
                      } catch (e) {
                        return {}
                      }
                    })
                    .pipe(z.record(z.any()).optional())
              break
            default:
              paramSchema[arg.name] = arg.required
                ? z.string()
                : z.string().optional()
          }
        } catch (error) {
          logger.error(
            `Failed to create parameter validator: ${arg.name}`,
            error,
          )
          // Fallback to string
          paramSchema[arg.name] = arg.required
            ? z.string()
            : z.string().optional()
        }
      }
    }

    // Dump the full parameter schema for debugging
    logger.info(
      `Tool ${tool.name} parameter schema: ${JSON.stringify(Object.keys(paramSchema))}`,
    )

    // Register tool
    mcpServer.tool(
      tool.name,
      tool.description,
      paramSchema,
      async (toolParams, context) => {
        try {
          logger.info(`========== EXECUTING TOOL: ${tool.name} ==========`)
          logger.info(`Tool parameters: ${JSON.stringify(toolParams)}`)

          // 获取当前会话ID和相关头信息
          const sessionId = currentSessionId
          const clientHeaders = sessionId
            ? sessionHeaders[sessionId]
            : undefined

          if (clientHeaders) {
            logger.info(
              `Client headers found for session ${sessionId}: ${JSON.stringify(Object.keys(clientHeaders))}`,
            )
          } else {
            logger.info(`No client headers available for this request`)
          }

          const result = await handleMcpRequest(
            tool.name,
            toolParams,
            tool,
            args.apiHost,
            args.headers || {},
            logger,
            clientHeaders,
          )

          // Format response
          let responseText = ''

          if (typeof result === 'string') {
            responseText = result
          } else if (result && result.error) {
            // 如果API调用返回了错误，记录详细日志并返回格式化的错误消息
            logger.error(`API调用错误 (${tool.name}): ${result.error}`)
            responseText = JSON.stringify(
              {
                error: result.error,
                toolName: tool.name,
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            )
          } else if (
            result === null ||
            result === undefined ||
            (typeof result === 'object' && Object.keys(result).length === 0)
          ) {
            // 处理空结果或空对象情况
            logger.warn(`工具 ${tool.name} 返回了空结果或空对象`)
            responseText = JSON.stringify(
              {
                message: 'API调用成功但返回了空结果',
                toolName: tool.name,
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            )
          } else {
            try {
              responseText = JSON.stringify(result, null, 2)
            } catch (error) {
              responseText = `Unable to serialize result: ${String(result)}`
            }
          }

          logger.info(
            `Tool execution result for ${tool.name}: ${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}`,
          )
          logger.info(`========== FINISHED TOOL: ${tool.name} ==========`)

          // 确保空结果也能返回有意义的内容
          const isEmptyResult =
            responseText === '{}' ||
            responseText === '[]' ||
            responseText === 'null' ||
            responseText === ''

          if (isEmptyResult) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      message: 'API调用成功，但返回空结果或空对象',
                      toolName: tool.name,
                      timestamp: new Date().toISOString(),
                    },
                    null,
                    2,
                  ),
                },
              ],
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: responseText,
              },
            ],
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          logger.error(`Tool execution failed (${tool.name}): ${msg}`, error)
          logger.error(`========== FAILED TOOL: ${tool.name} ==========`)
          return {
            content: [
              {
                type: 'text' as const,
                text: `Execution failed: ${msg}`,
              },
            ],
          }
        }
      },
    )
  }

  // SSE endpoint
  app.get(args.ssePath, async (req: express.Request, res: express.Response) => {
    logger.info(`New SSE connection from: ${req.ip}`)

    if (args.headers) {
      setResponseHeaders({
        res,
        headers: args.headers,
      })
    }

    // Track response status to prevent multiple responses
    let responseHandled = false

    try {
      // Create new transport
      const sseTransport = new SSEServerTransport(`${args.messagePath}`, res)

      // Log registered tools by showing the template
      logger.info(
        `Server has ${mcpTemplate.tools.length} registered tools: ${mcpTemplate.tools.map((t) => t.name).join(', ')}`,
      )

      // Set session headers BEFORE connecting to avoid "headers already sent" error
      // The session ID will be available immediately after transport creation
      const sessionId = sseTransport.sessionId
      if (sessionId) {
        if (!res.headersSent) {
          // Send session info in headers
          res.setHeader('mcp-session-id', sessionId)
          res.setHeader('x-session-id', sessionId)
          // Ensure clients can read these headers
          res.setHeader(
            'Access-Control-Expose-Headers',
            'mcp-session-id,x-session-id',
          )
          logger.debug(`Set session headers for ${sessionId}`)
        } else {
          logger.warn(
            `Headers already sent, cannot set session ID headers for ${sessionId}`,
          )
        }

        // 保存客户端请求头信息
        const cleanHeaders: Record<string, string | string[]> = {}
        // 过滤掉undefined值
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) {
            cleanHeaders[key] = value
          }
        }

        // 特别记录并确认重要的认证头信息
        const authToken =
          req.headers['authorization'] || req.headers['bspa_access_token']
        if (authToken) {
          const headerName = req.headers['authorization']
            ? 'authorization'
            : 'bspa_access_token'
          logger.info(
            `保存了认证头信息 (session ${sessionId}): ${headerName}=${Array.isArray(authToken) ? authToken[0] : authToken}`,
          )
        } else {
          logger.warn(
            `警告：客户端连接缺少认证头 (session ${sessionId}), 这可能导致API调用失败`,
          )
        }

        sessionHeaders[sessionId] = cleanHeaders
        logger.info(
          `Saved client headers for session ${sessionId}: ${JSON.stringify(Object.keys(cleanHeaders))}`,
        )
      }

      // Connect to MCP server
      logger.info(`Connecting transport to MCP server...`)
      await mcpServer.connect(sseTransport)
      logger.info(`Transport connected to MCP server successfully`)

      if (sessionId) {
        transports[sessionId] = sseTransport
        logger.info(`SSE session established: ${sessionId}`)
        logger.info(`Active sessions: ${Object.keys(transports).length}`)
      } else {
        logger.warn(`SSE transport created but no sessionId assigned`)
      }

      // Cleanup on client disconnect
      req.on('close', () => {
        if (sessionId) {
          logger.info(`Client disconnected (session ${sessionId})`)
          delete transports[sessionId]
        } else {
          logger.info(`Client disconnected (no session ID)`)
        }
      })

      // Handle SSE errors
      sseTransport.onerror = (err) => {
        if (sessionId) {
          logger.error(`SSE error (session ${sessionId}):`, err)
          delete transports[sessionId]
        } else {
          logger.error(`SSE error (no session ID):`, err)
        }
      }

      // Handle SSE closure
      sseTransport.onclose = () => {
        if (sessionId) {
          logger.info(`SSE connection closed (session ${sessionId})`)
          delete transports[sessionId]
        } else {
          logger.info(`SSE connection closed (no session ID)`)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(`SSE connection failed: ${msg}`, error)

      // Prevent double response
      if (!res.headersSent && !responseHandled) {
        responseHandled = true
        res.status(500).end(`SSE connection failed: ${msg}`)
      }
    }
  })

  // Message endpoint handler function
  async function handleMessageRequest(
    req: express.Request,
    res: express.Response,
  ) {
    // Track response status to prevent multiple responses
    let responseHandled = false

    // Get session ID from request
    const sessionId =
      typeof req.query.sessionId === 'string'
        ? req.query.sessionId
        : (req.headers['mcp-session-id'] as string) ||
          (req.headers['x-session-id'] as string)

    logger.debug(`Message request for session: ${sessionId}`)
    logger.debug(`Request headers: ${JSON.stringify(req.headers)}`)

    // Log request body if present
    if (req.body) {
      logger.info(`Request body: ${JSON.stringify(req.body)}`)
    }

    // If raw body was saved during parsing, log it
    if ((req as any).rawBody) {
      logger.debug(`Raw request body: ${(req as any).rawBody}`)
    }

    if (args.headers && !res.headersSent) {
      setResponseHeaders({
        res,
        headers: args.headers,
      })
    }

    // Validate session
    if (!sessionId) {
      logger.error('Message request missing session ID')

      // Auto-select the only available session if there's exactly one
      const sessionIds = Object.keys(transports)
      if (sessionIds.length === 1) {
        const autoSessionId = sessionIds[0]
        logger.info(
          `Auto-selecting the only available session: ${autoSessionId}`,
        )

        // Continue with this session ID
        return await processMessageWithSession(
          autoSessionId,
          req,
          res,
          responseHandled,
        )
      }

      if (!res.headersSent && !responseHandled) {
        responseHandled = true
        return res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32602,
            message: 'Missing session ID',
          },
          id: null,
        })
      }
      return
    }

    return await processMessageWithSession(sessionId, req, res, responseHandled)
  }

  // Helper to process message with a validated session ID
  async function processMessageWithSession(
    sessionId: string,
    req: express.Request,
    res: express.Response,
    responseHandled: boolean,
  ) {
    const transport = transports[sessionId]
    if (!transport) {
      logger.error(`Session ${sessionId} not found`)

      if (!res.headersSent && !responseHandled) {
        return res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32602,
            message: `Session ${sessionId} not found or expired`,
          },
          id: null,
        })
      }
      return
    }

    try {
      // 设置当前处理的会话ID，让工具调用能找到正确会话的头信息
      currentSessionId = sessionId

      // Let the transport handle the message
      logger.info(
        `Handling message for session ${sessionId} using transport.handlePostMessage`,
      )

      try {
        // 确保请求体被正确解析
        let parsedBody

        // 如果req.body已经有了，说明已经被某个中间件解析过了
        if (req.body && typeof req.body === 'object') {
          parsedBody = req.body
          logger.debug(
            `Using already parsed request body: ${JSON.stringify(parsedBody)}`,
          )
        }
        // 否则从请求体中读取
        else {
          // 读取原始请求体
          let rawBody = ''

          // 如果之前保存过原始请求体，则直接使用
          if ((req as any).rawBody) {
            rawBody = (req as any).rawBody
            logger.debug(`Using stored raw body: ${rawBody}`)
          }
          // 否则直接从请求流中读取
          else {
            // 确保请求体存在
            if (!req.readable) {
              logger.error(`Request body stream is not readable`)
            } else {
              for await (const chunk of req) {
                rawBody += chunk.toString('utf8')
              }
              logger.debug(`Read raw body from request stream: ${rawBody}`)
            }
          }

          // 解析JSON请求体
          if (rawBody) {
            try {
              parsedBody = JSON.parse(rawBody)
              logger.info(`Parsed request body: ${JSON.stringify(parsedBody)}`)
            } catch (parseError) {
              logger.error(
                `Failed to parse JSON body: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              )
              throw new Error(
                `Failed to parse JSON request body: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
              )
            }
          } else {
            logger.warn(`Empty request body`)
            parsedBody = {}
          }
        }

        // 直接处理tools/call请求，拦截它们不传递给transport
        if (
          parsedBody &&
          parsedBody.method === 'tools/call' &&
          parsedBody.params
        ) {
          logger.info(`===== 直接拦截并处理tools/call请求 =====`)

          const { name, arguments: toolArgs = {} } = parsedBody.params
          logger.info(`工具名: ${name}, 参数: ${JSON.stringify(toolArgs)}`)

          // 查找工具
          const tool = mcpTemplate.tools.find((t) => t.name === name)
          if (!tool) {
            logger.error(`找不到工具: ${name}`)

            // 通过SSE传输发送错误响应
            try {
              await transport.send({
                jsonrpc: '2.0' as const,
                error: {
                  code: -32601,
                  message: `找不到工具: ${name}`,
                },
                id: parsedBody.id,
              })
              logger.info(`已通过SSE传输发送错误响应：找不到工具: ${name}`)
            } catch (sendError) {
              logger.error(
                `通过SSE传输发送错误响应失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              )
            }

            // 同时通过HTTP响应返回结果
            if (!res.headersSent) {
              return res.status(404).json({
                jsonrpc: '2.0' as const,
                error: {
                  code: -32601,
                  message: `找不到工具: ${name}`,
                },
                id: parsedBody.id,
              })
            }
            return
          }

          logger.info(`找到工具: ${name}, 开始执行`)

          // 设置超时处理
          const TIMEOUT_MS = 30000 // 30秒超时
          let isResponseSent = false
          const timeoutId = setTimeout(() => {
            if (isResponseSent) return
            isResponseSent = true
            logger.warn(`工具 ${name} 执行超时 (${TIMEOUT_MS}ms)`)

            // 通过SSE传输发送超时响应
            try {
              transport
                .send({
                  jsonrpc: '2.0' as const,
                  error: {
                    code: -32000,
                    message: `工具执行超时: ${name}`,
                  },
                  id: parsedBody.id,
                })
                .catch((e) => {
                  logger.error(
                    `发送超时响应失败: ${e instanceof Error ? e.message : String(e)}`,
                  )
                })
            } catch (sendError) {
              logger.error(
                `发送超时响应失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              )
            }

            // 通过HTTP也返回超时响应
            if (!res.headersSent) {
              res.status(504).json({
                jsonrpc: '2.0' as const,
                error: {
                  code: -32000,
                  message: `工具执行超时: ${name}`,
                },
                id: parsedBody.id,
              })
            }
          }, TIMEOUT_MS)

          try {
            // 执行API调用
            const result = await handleMcpRequest(
              name,
              toolArgs,
              tool,
              args.apiHost,
              args.headers || {},
              logger,
              sessionHeaders[sessionId],
            )

            // 清除超时
            clearTimeout(timeoutId)
            if (isResponseSent) {
              logger.warn(`工具 ${name} 在超时后返回结果，忽略`)
              return
            }
            isResponseSent = true

            // 处理结果
            let formattedResult
            if (typeof result === 'string') {
              try {
                // 尝试解析JSON字符串
                formattedResult = JSON.parse(result)
              } catch {
                // 如果不是有效的JSON，则保持字符串格式
                formattedResult = result
              }
            } else if (result && result.error) {
              formattedResult = {
                error: result.error,
                toolName: name,
                timestamp: new Date().toISOString(),
              }
            } else if (
              result === null ||
              result === undefined ||
              (typeof result === 'object' && Object.keys(result).length === 0)
            ) {
              formattedResult = {
                message: 'API调用成功但返回了空结果',
                toolName: name,
                timestamp: new Date().toISOString(),
              }
            } else {
              formattedResult = result
            }

            logger.info(
              `工具 ${name} 执行结果: ${JSON.stringify(formattedResult).substring(0, 200)}${JSON.stringify(formattedResult).length > 200 ? '...' : ''}`,
            )

            // 构造标准JSON-RPC响应
            const responseObj = {
              jsonrpc: '2.0' as const,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(formattedResult, null, 2),
                  },
                ],
              },
              id: parsedBody.id,
            }

            // 首先通过SSE传输发送响应
            try {
              await transport.send(responseObj)
              logger.info(`已通过SSE传输发送工具 ${name} 的响应结果`)
            } catch (sendError) {
              logger.error(
                `通过SSE传输发送响应失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              )

              // SSE发送失败时，尝试通过HTTP响应返回结果
              if (!res.headersSent) {
                return res.json(responseObj)
              }
            }

            // 完成HTTP响应
            if (!res.headersSent) {
              return res.json({
                jsonrpc: '2.0' as const,
                result: 'Success',
                id: parsedBody.id,
              })
            }

            return
          } catch (error) {
            // 清除超时
            clearTimeout(timeoutId)
            if (isResponseSent) return
            isResponseSent = true

            const msg = error instanceof Error ? error.message : String(error)
            logger.error(`工具执行失败 (${name}): ${msg}`, error)

            // 构造错误响应
            const errorResponse = {
              jsonrpc: '2.0' as const,
              error: {
                code: -32603,
                message: `内部错误: ${msg}`,
              },
              id: parsedBody.id,
            }

            // 首先通过SSE传输发送错误响应
            try {
              await transport.send(errorResponse)
              logger.info(`已通过SSE传输发送错误响应`)
            } catch (sendError) {
              logger.error(
                `通过SSE传输发送错误响应失败: ${sendError instanceof Error ? sendError.message : String(sendError)}`,
              )

              // SSE发送失败时，尝试通过HTTP响应返回错误
              if (!res.headersSent) {
                return res.status(500).json(errorResponse)
              }
            }

            // 完成HTTP响应
            if (!res.headersSent) {
              return res.status(500).json(errorResponse)
            }

            return
          }
        }

        logger.info(
          `Calling handlePostMessage with parsed body: ${JSON.stringify(parsedBody)}`,
        )
        await transport.handlePostMessage(req, res, parsedBody)
        logger.info(
          `handlePostMessage completed successfully for session ${sessionId}`,
        )
      } catch (postError) {
        const msg =
          postError instanceof Error ? postError.message : String(postError)
        logger.error(
          `Failed to handle message (session ${sessionId}): ${msg}`,
          postError,
        )

        // Return proper JSON-RPC error response if headers haven't been sent
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: `Internal error: ${msg}`,
            },
            id: null,
          })
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(
        `Failed to handle message (session ${sessionId}): ${msg}`,
        error,
      )

      // Return proper JSON-RPC error response if headers haven't been sent
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: `Internal error: ${msg}`,
          },
          id: null,
        })
      }
    }
  }

  // Register message endpoint
  app.post(args.messagePath, async (req, res) => {
    await handleMessageRequest(req, res)
  })

  // Additionally, register a tools/call handler to properly handle the general-purpose MCP tool call format
  mcpServer.tool(
    'tools/call',
    'Call a tool by name with arguments',
    {
      name: z.string().describe('Tool name to call'),
      arguments: z.record(z.any()).optional().describe('Tool arguments'),
    },
    async (params) => {
      try {
        logger.info(`========== TOOLS/CALL HANDLER ==========`)
        logger.info(
          `Received tools/call request with params: ${JSON.stringify(params)}`,
        )

        const { name, arguments: toolArgs = {} } = params

        // Find the tool by name
        const tool = mcpTemplate.tools.find((t) => t.name === name)
        if (!tool) {
          logger.error(`Tool not found: ${name}`)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: `Tool not found: ${name}`,
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }

        logger.info(
          `Found tool: ${name}, executing with arguments: ${JSON.stringify(toolArgs)}`,
        )

        // Get client headers
        const sessionId = currentSessionId
        const clientHeaders = sessionId ? sessionHeaders[sessionId] : undefined

        // Call the tool implementation
        const result = await handleMcpRequest(
          name,
          toolArgs,
          tool,
          args.apiHost, // Using the apiHost from the top-level args parameter
          args.headers || {}, // Using the headers from the top-level args parameter
          logger,
          clientHeaders,
        )

        // Process result
        let resultText = ''
        if (typeof result === 'string') {
          resultText = result
        } else if (result && result.error) {
          resultText = JSON.stringify(
            {
              error: result.error,
              toolName: name,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          )
        } else if (
          result === null ||
          result === undefined ||
          (typeof result === 'object' && Object.keys(result).length === 0)
        ) {
          resultText = JSON.stringify(
            {
              message: 'API调用成功但返回了空结果',
              toolName: name,
              timestamp: new Date().toISOString(),
            },
            null,
            2,
          )
        } else {
          try {
            resultText = JSON.stringify(result, null, 2)
          } catch (error) {
            resultText = `Unable to serialize result: ${String(result)}`
          }
        }

        logger.info(
          `tools/call result for ${name}: ${
            resultText.length > 200
              ? resultText.substring(0, 200) + '...'
              : resultText
          }`,
        )
        logger.info(`========== TOOLS/CALL HANDLER FINISHED ==========`)

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        logger.error(`tools/call execution failed: ${msg}`, error)
        logger.error(`========== TOOLS/CALL HANDLER FAILED ==========`)
        return {
          content: [
            {
              type: 'text',
              text: `Execution failed: ${msg}`,
            },
          ],
        }
      }
    },
  )

  // Start server
  const server = app.listen(args.port, () => {
    logger.info(`API->SSE Gateway started successfully:`)
    logger.info(`- Listening on port: ${args.port}`)
    logger.info(`- SSE endpoint: http://localhost:${args.port}${args.ssePath}`)
    logger.info(
      `- Message endpoint: http://localhost:${args.port}${args.messagePath}`,
    )
    logger.info(`- Health endpoint: http://localhost:${args.port}/health`)
    logger.info(`- Config endpoint: http://localhost:${args.port}/mcp-config`)
  })

  // Handle graceful shutdown
  const cleanup = () => {
    logger.info('Shutting down server...')

    server.close(() => {
      logger.info('Server closed')
      process.exit(0)
    })

    // Close all transports
    Object.keys(transports).forEach((sid) => {
      logger.info(`Closing session: ${sid}`)
      delete transports[sid]
    })

    // Force exit after 5 seconds
    setTimeout(() => {
      logger.warn('Force exit')
      process.exit(1)
    }, 5000)
  }

  // Register signal handlers
  onSignals({
    logger,
    cleanup,
  })

  return server
}
