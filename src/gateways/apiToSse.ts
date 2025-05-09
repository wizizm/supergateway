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
  sessionId: string,
  apiHost: string,
  headers: Record<string, string> = {},
  logger: Logger,
) {
  try {
    const { name, args } = req.body

    if (!name) {
      return {
        status: 400,
        result: { error: 'Missing tool name' },
      }
    }

    // 获取工具配置
    const tool = req.body.metadata?.tool

    if (!tool) {
      return {
        status: 400,
        result: { error: 'Missing tool configuration' },
      }
    }

    // 构建请求URL
    const apiPath = tool.requestTemplate?.url || ''
    if (!apiPath) {
      return {
        status: 400,
        result: { error: 'Missing URL in request template' },
      }
    }

    // 解析路径参数
    let processedPath = apiPath
    const pathParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'path') || []

    pathParams.forEach((param: ToolArg) => {
      const paramValue = args[param.name]
      if (param.required && paramValue === undefined) {
        throw new Error(`Missing required path parameter: ${param.name}`)
      }
      if (paramValue !== undefined) {
        processedPath = processedPath.replace(
          `{${param.name}}`,
          encodeURIComponent(String(paramValue)),
        )
      }
    })

    // 创建完整的URL（处理相对路径）
    let url = processedPath
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url =
        apiHost +
        (apiHost.endsWith('/') ? '' : '/') +
        processedPath.replace(/^\//, '')
    }

    // 构建查询参数
    const queryParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'query') || []
    if (queryParams.length > 0) {
      const searchParams = new URLSearchParams()
      queryParams.forEach((param: ToolArg) => {
        const paramValue = args[param.name]
        if (param.required && paramValue === undefined) {
          throw new Error(`Missing required query parameter: ${param.name}`)
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

    // 获取请求方法
    const method = (tool.requestTemplate?.method || 'GET').toUpperCase()

    // 构建请求头
    const requestHeaders: Record<string, string> = { ...headers }

    // 添加工具模板中定义的请求头
    if (
      tool.requestTemplate?.headers &&
      Array.isArray(tool.requestTemplate.headers)
    ) {
      tool.requestTemplate.headers.forEach((header) => {
        if (header.key && header.value !== undefined) {
          // 支持UUID模板变量
          let value = header.value
          value = value.replace('{{uuidv4}}', randomUUID())
          requestHeaders[header.key] = value
        }
      })
    }

    // 添加header参数
    const headerParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'header') || []
    headerParams.forEach((param: ToolArg) => {
      const paramValue = args[param.name]
      if (param.required && paramValue === undefined) {
        throw new Error(`Missing required header parameter: ${param.name}`)
      }
      if (paramValue !== undefined) {
        requestHeaders[param.name] = String(paramValue)
      }
    })

    // 处理请求体
    let requestBody = undefined
    const bodyParams =
      tool.args?.filter((arg: ToolArg) => arg.position === 'body') || []
    if (bodyParams.length > 0) {
      const bodyData: Record<string, any> = {}
      bodyParams.forEach((param: ToolArg) => {
        const paramValue = args[param.name]
        if (param.required && paramValue === undefined) {
          throw new Error(`Missing required body parameter: ${param.name}`)
        }
        if (paramValue !== undefined) {
          bodyData[param.name] = paramValue
        }
      })

      if (Object.keys(bodyData).length > 0) {
        requestBody = JSON.stringify(bodyData)
        requestHeaders['Content-Type'] = 'application/json'
      }
    }

    // 发送请求到API服务器
    logger.info(`[${sessionId}] 发送请求: ${method} ${url}`)
    logger.info(`[${sessionId}] 请求头: ${JSON.stringify(requestHeaders)}`)
    if (requestBody) {
      logger.info(`[${sessionId}] 请求体: ${requestBody}`)
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
    })

    // 获取响应内容
    const contentType = response.headers.get('content-type') || ''
    let responseData: any

    if (contentType.includes('application/json')) {
      responseData = await response.json()
    } else {
      responseData = await response.text()
    }

    logger.info(`[${sessionId}] 响应状态: ${response.status}`)
    logger.info(`[${sessionId}] 响应内容类型: ${contentType}`)
    logger.info(
      `[${sessionId}] 响应数据: ${JSON.stringify(responseData).substring(0, 1000)}${JSON.stringify(responseData).length > 1000 ? '...' : ''}`,
    )

    // 处理响应模板（如果有）
    let formattedResponse = responseData
    if (
      tool.responseTemplate?.prependBody &&
      typeof responseData === 'string'
    ) {
      formattedResponse = tool.responseTemplate.prependBody + responseData
    }

    return {
      status: response.status,
      result: formattedResponse,
    }
  } catch (error) {
    logger.error(`[${sessionId}] 请求处理失败: ${error.message}`, error)
    return {
      status: 500,
      result: { error: `处理请求失败: ${error.message}` },
    }
  }
}

// 设置响应头
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

// API到SSE网关
export const apiToSse = async (args: ApiToSseArgs) => {
  const { logger } = args
  const app = express()

  logger.info(`初始化API->SSE网关配置:`)
  logger.info(`- API主机: ${args.apiHost}`)
  logger.info(`- 配置文件: ${args.mcpTemplateFile} (支持OpenAPI和MCP模板格式)`)
  logger.info(`- 服务端口: ${args.port}`)
  logger.info(`- SSE路径: ${args.ssePath}`)
  logger.info(`- 消息路径: ${args.messagePath}`)

  // 启用CORS，确保跨域请求正常工作
  app.use(
    cors({
      origin: args.corsOrigin ? formatCorsOrigin(args.corsOrigin) : '*',
      methods: 'GET,POST',
      allowedHeaders: 'Content-Type,Authorization',
    }),
  )

  // 解析JSON请求体
  app.use((req, res, next) => {
    if (req.path === args.messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  // 添加CORS预检请求处理
  app.options('*', (req, res) => {
    // 设置CORS响应头
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, x-session-id, Accept, Origin, X-Requested-With',
    )
    res.setHeader('Access-Control-Max-Age', '86400') // 24小时
    res.setHeader(
      'Access-Control-Expose-Headers',
      'mcp-session-id, x-session-id',
    )

    // 如果有自定义头，也添加它们
    if (args.headers) {
      setResponseHeaders({
        res,
        headers: args.headers,
      })
    }

    // 返回成功状态
    res.status(204).end()
  })

  // 添加运行状态检查路由
  app.get('/health', (req, res) => {
    res.send('ok')
  })

  app.get('/status', (req, res) => {
    res.json({ status: 'running' })
  })

  // 健康检查端点
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

  // 加载MCP模板
  let mcpTemplate: McpTemplate
  try {
    mcpTemplate = await loadMcpTemplate(args.mcpTemplateFile, logger)
  } catch (error) {
    logger.error(`加载MCP模板失败: ${error.message}`)
    throw error
  }

  // 提供配置信息访问
  app.get('/mcp-config', (req, res) => {
    res.json(mcpTemplate)
  })

  // 存储活动的SSE会话
  const sessions: Record<
    string,
    { transport: SSEServerTransport; server: McpServer }
  > = {}

  // SSE端点
  app.get(args.ssePath, (req, res) => {
    ;(async () => {
      logger.info(`新的SSE连接: ${req.ip}`)

      if (args.headers) {
        setResponseHeaders({
          res,
          headers: args.headers,
        })
      }

      try {
        // 从请求中获取会话ID或生成新ID
        const sessionId =
          (req.headers['mcp-session-id'] as string) ||
          (req.headers['x-session-id'] as string) ||
          randomUUID()

        logger.info(`使用会话ID: ${sessionId}`)

        // 配置CORS头
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Authorization, mcp-session-id, x-session-id',
        )
        res.setHeader(
          'Access-Control-Expose-Headers',
          'mcp-session-id, x-session-id',
        )

        // 回传会话ID到客户端
        res.setHeader('mcp-session-id', sessionId)
        res.setHeader('x-session-id', sessionId)

        // 创建SSE传输，在URL中明确包含会话ID以确保传输层使用正确的ID
        const messagePath = `${args.messagePath}?sessionId=${sessionId}`
        logger.info(`SSE消息路径: ${messagePath}`)

        const sseTransport = new SSEServerTransport(
          `${req.protocol}://${req.headers.host}${messagePath}`,
          res,
        )

        // 创建MCP服务器，每个连接一个实例
        const mcpServer = new McpServer({
          name: mcpTemplate.server.name,
          version: mcpTemplate.server.version || getVersion(),
        })

        // 保存会话
        sessions[sessionId] = {
          transport: sseTransport,
          server: mcpServer,
        }

        logger.info(`已创建新会话: ${sessionId}`)
        logger.info(`活动会话数量: ${Object.keys(sessions).length}`)
        logger.info(`活动会话列表: ${Object.keys(sessions).join(', ')}`)

        // 打印工具信息
        logger.info(`注册 ${mcpTemplate.tools.length} 个工具:`)

        // 为每个工具注册处理函数
        for (const tool of mcpTemplate.tools) {
          logger.info(`注册工具: ${tool.name} (${tool.args.length} 个参数)`)

          // 打印参数信息
          tool.args.forEach((arg) => {
            logger.info(
              `  参数: ${arg.name} (${arg.type}) [${arg.position}] ${arg.required ? '必需' : '可选'}`,
            )
          })

          // 注册工具
          mcpServer.tool(
            tool.name,
            tool.description,
            // 构建参数验证对象
            (() => {
              // 创建参数验证对象
              const paramSchema: Record<string, z.ZodType<any>> = {}

              // 处理工具参数
              if (tool.args && Array.isArray(tool.args)) {
                for (const arg of tool.args) {
                  // 根据参数类型设置正确的zod验证器
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
                              .transform((val) =>
                                val ? Number(val) : undefined,
                              )
                              .pipe(z.number().optional())
                        break
                      case 'boolean':
                        paramSchema[arg.name] = arg.required
                          ? z
                              .string()
                              .transform((val) => val === 'true' || val === '1')
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
                        // 默认当做字符串处理
                        paramSchema[arg.name] = arg.required
                          ? z.string()
                          : z.string().optional()
                    }
                  } catch (error) {
                    logger.error(`创建参数验证器失败: ${arg.name}`, error)
                    // 如果出错，使用字符串作为降级方案
                    paramSchema[arg.name] = arg.required
                      ? z.string()
                      : z.string().optional()
                  }
                }
              }

              return paramSchema
            })(),
            async (toolParams) => {
              try {
                // 记录工具参数信息
                logger.info(`执行工具: ${tool.name}`)
                logger.info(`传入参数: ${JSON.stringify(toolParams)}`)

                // 构建请求使用的参数
                const requestParams = {
                  name: tool.name,
                  args: toolParams,
                  metadata: {
                    tool: tool,
                  },
                }

                // 构造一个请求对象
                const customReq = {
                  body: requestParams,
                  headers: req.headers,
                  protocol: req.protocol,
                  ip: req.ip,
                }

                // 处理API请求
                const result = await handleMcpRequest(
                  customReq as any,
                  res,
                  String(sessionId),
                  args.apiHost,
                  args.headers || {},
                  logger,
                )

                // 格式化响应
                let responseText = ''

                if (typeof result.result === 'string') {
                  responseText = result.result
                } else {
                  try {
                    responseText = JSON.stringify(result.result, null, 2)
                  } catch (error) {
                    responseText = `无法序列化的结果: ${String(result.result)}`
                  }
                }

                // 记录响应信息
                logger.info(
                  `工具执行结果: ${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}`,
                )

                // 返回标准格式的响应
                return {
                  content: [
                    {
                      type: 'text',
                      text: responseText,
                    },
                  ],
                }
              } catch (error) {
                logger.error(
                  `工具执行出错 (${tool.name}): ${error.message}`,
                  error,
                )
                return {
                  content: [
                    {
                      type: 'text',
                      text: `执行工具时出错: ${error.message}`,
                    },
                  ],
                }
              }
            },
          )
        }

        // 连接传输
        try {
          await mcpServer.connect(sseTransport)
          logger.info(`已建立SSE会话连接: ${sessionId}`)
        } catch (error) {
          logger.error(`建立SSE会话连接失败: ${error.message}`, error)
          delete sessions[sessionId]
          return res.status(500).end(`建立SSE会话连接失败: ${error.message}`)
        }

        // 处理连接关闭
        req.on('close', () => {
          logger.info(`客户端断开连接（会话 ${sessionId}）`)
          delete sessions[sessionId]
        })

        // 处理SSE错误
        sseTransport.onerror = (err) => {
          logger.error(`SSE错误（会话 ${sessionId}）:`, err)
          delete sessions[sessionId]
        }

        // 处理SSE关闭
        sseTransport.onclose = () => {
          logger.info(`SSE连接关闭（会话 ${sessionId}）`)
          delete sessions[sessionId]
        }
      } catch (error) {
        logger.error(`SSE连接处理失败: ${error.message}`, error)
        res.status(500).end(`SSE连接处理失败: ${error.message}`)
      }
    })()
  })

  // 消息端点
  app.post(args.messagePath, (req, res) => {
    ;(async () => {
      // 获取会话ID，优先使用查询参数，然后是请求头
      const sessionId =
        typeof req.query.sessionId === 'string'
          ? req.query.sessionId
          : (req.headers['mcp-session-id'] as string) ||
            (req.headers['x-session-id'] as string)

      // 打印请求信息，帮助调试
      console.log('********** 消息请求 **********')
      console.log('请求路径:', req.path)
      console.log('请求查询参数:', req.query)
      console.log('请求头:', req.headers)
      console.log('提取的会话ID:', sessionId)
      console.log('活动会话列表:', Object.keys(sessions))
      console.log('******************************')

      if (args.headers) {
        setResponseHeaders({
          res,
          headers: args.headers,
        })
      }

      // 设置CORS头
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, mcp-session-id, x-session-id',
      )
      res.setHeader(
        'Access-Control-Expose-Headers',
        'mcp-session-id, x-session-id',
      )

      // 验证会话ID
      if (!sessionId || typeof sessionId !== 'string') {
        logger.error('消息请求缺少会话ID参数')
        return res.status(400).send('缺少会话ID参数')
      }

      // 如果我们找不到会话，可能因为客户端使用了自己生成的ID而不是服务器生成的ID
      // 尝试查看是否有任何活动会话可能是刚刚创建的
      if (!sessions[sessionId] && Object.keys(sessions).length > 0) {
        // 记录活动会话，这将帮助我们诊断问题
        logger.warn(
          `会话 ${sessionId} 不存在，但有 ${Object.keys(sessions).length} 个活动会话`,
        )
        logger.warn(`活动会话列表: ${Object.keys(sessions).join(', ')}`)

        // 如果只有一个活动会话且是最近创建的(10秒内)，尝试使用它
        const activeSessionIds = Object.keys(sessions)
        if (activeSessionIds.length === 1) {
          const existingSessionId = activeSessionIds[0]
          logger.warn(
            `尝试使用当前唯一活动会话 ${existingSessionId} 代替请求的会话 ${sessionId}`,
          )

          // 向客户端返回正确的会话ID，以便它可以在后续请求中使用
          res.setHeader('mcp-session-id', existingSessionId)
          res.setHeader('x-session-id', existingSessionId)

          // 使用找到的会话
          const session = sessions[existingSessionId]

          // 处理请求
          try {
            logger.info(`处理来自替代会话 ${existingSessionId} 的消息请求`)
            const result = await session.transport.handlePostMessage(req, res)
            logger.info(`成功处理来自替代会话的消息请求`)
            return
          } catch (error) {
            logger.error(`处理SSE消息失败（替代会话）: ${error.message}`, error)
            return res.status(500).send(`处理消息失败: ${error.message}`)
          }
        }
      }

      logger.info(`处理来自会话 ${sessionId} 的消息请求`)

      const session = sessions[sessionId]

      // 检查会话是否存在
      if (!session) {
        logger.error(`会话 ${sessionId} 不存在，可能已经过期或关闭`)
        return res
          .status(404)
          .send(`会话 ${sessionId} 不存在，可能已经过期或关闭`)
      }

      // 检查会话是否有可用的传输
      if (!session.transport || !session.transport.handlePostMessage) {
        logger.error(`会话 ${sessionId} 的传输不可用`)
        return res.status(500).send(`会话 ${sessionId} 的传输不可用`)
      }

      try {
        logger.info(`处理SSE消息（会话 ${sessionId}）`)
        logger.info(`活动会话数量: ${Object.keys(sessions).length}`)
        logger.info(`活动会话列表: ${Object.keys(sessions).join(', ')}`)

        const originalMessage = req.body
        logger.debug(`收到消息: ${JSON.stringify(originalMessage)}`)

        // 特殊处理 startup 请求
        if (originalMessage && originalMessage.method === 'startup') {
          logger.info(`处理 startup 请求（会话 ${sessionId}）`)

          // 发送成功启动响应
          session.transport.send({
            jsonrpc: '2.0',
            id: originalMessage.id,
            result: {
              name: mcpTemplate.server.name,
              version: mcpTemplate.server.version || getVersion(),
              capabilities: {
                tools: {
                  listChanged: true,
                },
              },
            },
          })

          // 返回成功状态
          return res.status(200).send('启动消息已处理')
        }
        // 特殊处理 tools/list 请求
        else if (originalMessage && originalMessage.method === 'tools/list') {
          logger.info(`处理 tools/list 请求（会话 ${sessionId}）`)

          // 收集所有工具信息
          const tools = mcpTemplate.tools.map((tool) => {
            return {
              name: tool.name,
              description: tool.description,
              parameters: Object.fromEntries(
                tool.args.map((arg) => [
                  arg.name,
                  {
                    type: arg.type || 'string',
                    description: arg.description || '',
                    required: arg.required,
                  },
                ]),
              ),
            }
          })

          logger.info(
            `发送工具列表（${tools.length}个工具）到会话 ${sessionId}`,
          )
          logger.debug(`工具列表详情: ${JSON.stringify(tools)}`)

          // 发送工具列表响应
          session.transport.send({
            jsonrpc: '2.0',
            id: originalMessage.id,
            result: {
              tools: tools,
            },
          })

          // 返回成功状态
          return res.status(200).send('工具列表请求已处理')
        }
        // 如果是工具调用请求，处理API请求
        else if (originalMessage && originalMessage.method === 'tools/call') {
          const result = await handleMcpRequest(
            req,
            res,
            sessionId,
            args.apiHost,
            args.headers || {},
            logger,
          )

          // 手动发送响应
          if (originalMessage.id) {
            session.transport.send({
              jsonrpc: '2.0',
              id: originalMessage.id,
              result: result.result,
            })
          }

          // 发送成功的响应
          res.status(200).send('消息已处理')
        } else {
          // 正常处理其他类型的消息
          await session.transport.handlePostMessage(req, res)
        }
      } catch (error) {
        logger.error(
          `处理SSE消息失败（会话 ${sessionId}）: ${error.message}`,
          error,
        )
        res.status(500).send(`处理消息失败: ${error.message}`)
      }
    })()
  })

  // 启动服务器
  const server = app.listen(args.port, () => {
    logger.info(`服务器启动成功:`)
    logger.info(`- 监听端口: ${args.port}`)
    logger.info(`- SSE端点: http://localhost:${args.port}${args.ssePath}`)
    logger.info(`- 消息端点: http://localhost:${args.port}${args.messagePath}`)
    logger.info(`- 健康检查端点: http://localhost:${args.port}/health`)
    logger.info(`- 状态检查端点: http://localhost:${args.port}/status`)
    logger.info(`- MCP配置文件: http://localhost:${args.port}/mcp-config`)
    logger.info(`- 支持自动检测并转换OpenAPI规范文件`)
  })

  // 优雅关闭
  const cleanup = () => {
    logger.info('正在关闭服务器...')
    server.close(() => {
      logger.info('服务器已关闭')
      process.exit(0)
    })

    // 关闭所有会话
    Object.keys(sessions).forEach((sid) => {
      logger.info(`关闭会话: ${sid}`)
      delete sessions[sid]
    })

    // 5秒后强制退出
    setTimeout(() => {
      logger.warn('强制退出')
      process.exit(1)
    }, 5000)
  }

  // 处理进程信号
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return server
}
