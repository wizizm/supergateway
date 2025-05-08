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

export interface Tool {
  name: string
  description: string
  parameters: {
    type: string
    properties: Record<string, any>
    required: string[]
    additionalProperties: boolean
    $schema: string
  }
  handler: (params: any) => Promise<any>
}

interface Session {
  server: McpServer
  transport: StreamableHTTPServerTransport
  initialized: boolean
  lastActivityTime: number
  pendingRequests: Map<string | number, any>
}

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
    }
    description?: string
    required?: boolean
  }>
  requestBody?: {
    content: {
      'application/json': {
        schema: {
          type: string
          properties?: Record<string, any>
          required?: string[]
        }
      }
    }
    required?: boolean
  }
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
}

// API输入数据接口
interface ApiInputData {
  query?: Record<string, string | number | boolean>
  headers?: Record<string, string>
  body?: Record<string, any>
  [key: string]: any
}

// 简化的API规范加载函数
async function loadOpenApiSpec(
  apiSpecPath: string,
  logger: Logger,
): Promise<OpenAPISpec> {
  try {
    logger.info(`加载 OpenAPI 规范: ${apiSpecPath}`)

    // 检查文件是否存在
    try {
      const fs = await import('fs/promises')
      await fs.access(apiSpecPath)
    } catch (err) {
      logger.warn(`OpenAPI规范文件不存在，使用空规范: ${apiSpecPath}`)
      return { paths: {} }
    }

    try {
      const fs = await import('fs/promises')
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
    // 出错时也返回空规范而不是抛出异常
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

export const apiToStreamableHttp = async (args: ApiToStreamableHttpArgs) => {
  const { logger } = args
  const app = express()

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

  app.post(args.httpPath, async (req, res) => {
    // 创建新的MCP服务器实例
    const server = new McpServer({
      name: 'API Gateway',
      version: getVersion(),
    })

    // 注册基础echo工具
    server.tool(
      'echo',
      '回显输入的消息',
      {
        message: z.string().describe('要回显的消息'),
      },
      async ({ message }) => {
        logger.info(`Echo工具被调用，消息: ${message}`)
        return {
          content: [
            {
              type: 'text' as const,
              text: `回显: ${message}`,
            },
          ],
        }
      },
    )

    try {
      // 尝试加载OpenAPI规范
      const openApiSpec = await loadOpenApiSpec(args.apiSpecPath, logger)

      // 注册API工具
      Object.entries(openApiSpec.paths || {}).forEach(
        ([specPath, pathItem]) => {
          Object.entries(pathItem as OpenAPIPathItem)
            .filter(([method]) =>
              ['get', 'post', 'put', 'delete', 'patch'].includes(
                method.toLowerCase(),
              ),
            )
            .forEach(([method, operation]) => {
              if (operation && typeof operation === 'object') {
                const op = operation as OpenAPIOperation
                const operationId =
                  op.operationId ||
                  `api_${method.toLowerCase()}_${specPath.replace(/[^a-zA-Z0-9]/g, '_')}`

                server.tool(
                  operationId,
                  op.summary ||
                    op.description ||
                    `${method.toUpperCase()} ${specPath}`,
                  {
                    input: z.string().describe('API请求的输入数据，JSON格式'),
                  },
                  async ({ input }) => {
                    try {
                      let inputData: ApiInputData = {}
                      try {
                        inputData = JSON.parse(input) as ApiInputData
                      } catch (e) {
                        return {
                          content: [
                            {
                              type: 'text' as const,
                              text: `解析输入JSON出错: ${e.message}`,
                            },
                          ],
                        }
                      }

                      // 构建API请求URL
                      let url = `${args.apiHost}${specPath}`
                      const queryParams = new URLSearchParams()

                      // 添加查询参数
                      if (inputData.query) {
                        for (const [key, value] of Object.entries(
                          inputData.query,
                        )) {
                          queryParams.append(key, String(value))
                        }
                        if (queryParams.toString()) {
                          url += `?${queryParams.toString()}`
                        }
                      }

                      // API调用
                      const response = await fetch(url, {
                        method: method.toUpperCase(),
                        headers: {
                          'Content-Type': 'application/json',
                          ...args.headers,
                          ...(inputData.headers || {}),
                        },
                        body: ['POST', 'PUT', 'PATCH'].includes(
                          method.toUpperCase(),
                        )
                          ? JSON.stringify(inputData.body || {})
                          : undefined,
                      })

                      const contentType =
                        response.headers.get('content-type') || ''
                      let result

                      if (contentType.includes('application/json')) {
                        result = await response.json()
                      } else {
                        result = await response.text()
                      }

                      return {
                        content: [
                          {
                            type: 'text' as const,
                            text:
                              typeof result === 'string'
                                ? result
                                : JSON.stringify(result, null, 2),
                          },
                        ],
                      }
                    } catch (error) {
                      logger.error(`API调用失败 (${operationId}):`, error)
                      return {
                        content: [
                          {
                            type: 'text' as const,
                            text: `API调用错误: ${error.message}`,
                          },
                        ],
                      }
                    }
                  },
                )
              }
            })
        },
      )
    } catch (error) {
      logger.error('加载API规范或注册工具时出错:', error)
      // 继续处理请求，即使没有API工具也至少提供echo工具
    }

    try {
      // 为每个请求创建新的传输实例
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      // 连接服务器和传输
      await server.connect(transport)

      // 处理请求
      await transport.handleRequest(req, res, req.body)

      // 在连接关闭时清理资源
      res.on('close', () => {
        transport.close()
        server.close()
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
