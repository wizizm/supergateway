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
import yaml from 'js-yaml'

interface ApiToStreamableHttpArgs {
  apiHost: string
  mcpTemplateFile: string // 改为MCP模板文件路径
  port: number
  httpPath: string
  headers?: Record<string, string>
  corsOrigin?: any
  healthEndpoints?: string[]
  logger: Logger
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

// MCP服务器配置
interface McpTemplate {
  server: {
    name: string
    version?: string
  }
  tools: McpTool[]
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

/**
 * 加载MCP模板文件
 * 如果是OpenAPI规范，则自动转换为MCP模板
 */
async function loadMcpTemplate(
  templatePath: string,
  logger: Logger,
): Promise<McpTemplate> {
  try {
    logger.info(`加载文件: ${templatePath}`)

    try {
      await fs.access(templatePath)
    } catch (err) {
      logger.error(`文件不存在: ${templatePath}`)
      throw new Error(`文件不存在: ${templatePath}`)
    }

    // 读取文件内容
    const fileContent = await fs.readFile(templatePath, 'utf-8')
    let template: McpTemplate | null = null
    let isOpenApi = false

    // 尝试解析文件
    try {
      // 根据文件扩展名决定解析方式
      const parsedContent = templatePath.endsWith('.json')
        ? JSON.parse(fileContent)
        : yaml.load(fileContent)

      // 检查是否为OpenAPI规范
      if (parsedContent && typeof parsedContent === 'object') {
        // OpenAPI规范有openapi字段
        if (parsedContent.openapi && parsedContent.paths) {
          logger.info(`检测到OpenAPI规范文档，版本: ${parsedContent.openapi}`)
          isOpenApi = true
        }
        // MCP模板有server和tools字段
        else if (parsedContent.server && parsedContent.tools) {
          logger.info('检测到MCP模板文档')
          template = parsedContent as McpTemplate
        }
        // 不符合任何已知格式
        else {
          logger.warn('文档格式无法识别，尝试作为MCP模板处理')
          template = parsedContent as McpTemplate
        }
      }
    } catch (parseError) {
      logger.error(`解析文件失败: ${parseError.message}`, parseError)
      throw new Error(`解析文件失败: ${parseError.message}`)
    }

    // 如果是OpenAPI规范，转换为MCP模板
    if (isOpenApi) {
      try {
        logger.info('正在将OpenAPI规范转换为MCP模板...')
        const { convertOpenApiToMcpServer } = await import(
          '../lib/openapi-to-mcpserver/index.js'
        )

        // 转换OpenAPI到MCP模板
        const mcpTemplateContent = await convertOpenApiToMcpServer(
          { input: templatePath },
          {},
          templatePath.endsWith('.json') ? 'json' : 'yaml',
          logger,
        )

        // 解析生成的模板
        if (templatePath.endsWith('.json')) {
          template = JSON.parse(mcpTemplateContent) as McpTemplate
        } else {
          template = yaml.load(mcpTemplateContent) as McpTemplate
        }

        logger.info('OpenAPI规范成功转换为MCP模板')
      } catch (conversionError) {
        logger.error(
          `OpenAPI规范转换失败: ${conversionError.message}`,
          conversionError,
        )
        throw new Error(`OpenAPI规范转换失败: ${conversionError.message}`)
      }
    }

    // 确保template不为空并包含必要字段
    if (!template) {
      throw new Error('无法从文件创建有效的MCP模板')
    }

    // 确保模板有必要的字段
    if (!template.server) {
      template.server = { name: 'API Gateway' }
    }

    if (!template.tools || !Array.isArray(template.tools)) {
      template.tools = []
    }

    logger.info(`MCP模板加载成功: 包含 ${template.tools.length} 个工具`)
    return template
  } catch (error) {
    logger.error(`加载MCP模板失败: ${error.message}`, error)
    throw error
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
        if (tool.responseTemplate?.prependBody) {
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

  // 注册MCP工具
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

    // 注册工具
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
        if (tool.responseTemplate?.prependBody) {
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
  logger.info(`- 配置文件: ${args.mcpTemplateFile} (支持OpenAPI和MCP模板格式)`)
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

  // 加载MCP模板
  const mcpTemplate = await loadMcpTemplate(args.mcpTemplateFile, logger)

  // 创建MCP配置文件端点（用于调试）
  app.get('/mcp-config', (req, res) => {
    res.status(200).json(mcpTemplate)
  })

  // 处理MCP请求
  app.post(args.httpPath, async (req, res) => {
    await handleMcpRequest(
      req,
      res,
      mcpTemplate.tools,
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
      logger.info(`- 支持自动检测并转换OpenAPI规范文件`)
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
