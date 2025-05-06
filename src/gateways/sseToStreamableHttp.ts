import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger, CorsOptions } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import crypto from 'crypto'

export interface SseToStreamableHttpArgs {
  sseUrl: string
  port: number
  httpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
}

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

export async function sseToStreamableHttp(args: SseToStreamableHttpArgs) {
  const {
    sseUrl,
    port,
    httpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - sseUrl: ${sseUrl}`)
  logger.info(`  - httpPath: ${httpPath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // 连接到SSE服务器
  const client = new Client({ name: 'supergateway', version: getVersion() })
  // @ts-ignore - SSEClientTransport 接口在当前版本中不完全匹配
  const sseTransport = new SSEClientTransport(new URL(sseUrl), { headers })

  try {
    await client.connect(sseTransport)
    logger.info(`Connected to SSE server: ${sseUrl}`)
  } catch (error) {
    logger.error(`Failed to connect to SSE server: ${error}`)
    process.exit(1)
  }

  // 创建Streamable HTTP服务器
  const server = new Server(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} },
  )

  // 设置Express应用
  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use(bodyParser.json())

  // 注册健康检查端点
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  // 创建Streamable HTTP传输
  // @ts-ignore - StreamableHTTPServerTransport 构造函数参数类型不匹配
  const streamableHttpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })

  await server.connect(streamableHttpTransport)

  // 处理从Streamable HTTP客户端发送的消息
  streamableHttpTransport.onmessage = async (msg: JSONRPCMessage) => {
    const sessionId = streamableHttpTransport.sessionId
    logger.info(
      `StreamableHTTP → SSE (session ${sessionId}): ${JSON.stringify(msg)}`,
    )
    try {
      // 检查消息类型，通过Client接口转发请求而不是直接使用传输层
      if ('method' in msg && 'id' in msg) {
        // 请求消息
        const method = msg.method
        const params = (msg as any).params || {}

        // 使用client接口发送请求
        let response: any
        switch (method) {
          case 'initialize':
            // 初始化请求 - 不需要重复连接，因为已经在初始化阶段连接过了
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: '2025-03-26',
                capabilities: client.getServerCapabilities() || {},
                serverInfo: client.getServerVersion() || {
                  name: 'proxy-server',
                  version: '1.0.0',
                },
              },
            }
            break
          case 'tools/list':
            // 工具列表请求
            const toolsResult = await client.listTools()
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: toolsResult,
            }
            break
          case 'tools/call':
            // 工具调用请求
            const callResult = await client.callTool({
              name: params.name,
              arguments: params.arguments,
            })
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: callResult,
            }
            break
          case 'resources/list':
            // 资源列表请求
            const resourcesResult = await client.listResources()
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: resourcesResult,
            }
            break
          case 'resources/read':
            // 资源读取请求
            const readResult = await client.readResource({
              uri: params.uri,
            })
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              result: readResult,
            }
            break
          default:
            // 对于其他请求，返回方法未找到错误
            response = {
              jsonrpc: '2.0',
              id: msg.id,
              error: {
                code: -32601,
                message: `Method not found: ${method}`,
              },
            }
        }

        // 将响应发送回Streamable HTTP客户端
        streamableHttpTransport.send(response)
      } else if ('method' in msg && !('id' in msg)) {
        // 通知消息，不需要响应
        logger.info(`Notification message: ${msg.method}`)
      } else {
        // 未知消息类型
        logger.error(`Unknown message type: ${JSON.stringify(msg)}`)
      }
    } catch (err) {
      logger.error(`Error forwarding message to SSE: ${err}`)
      const errorResponse: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: (msg as any).id,
        error: {
          code: -32603,
          message: `Internal error: ${err}`,
        },
      }
      streamableHttpTransport.send(errorResponse)
    }
  }

  streamableHttpTransport.onclose = () => {
    const sessionId = streamableHttpTransport.sessionId
    logger.info(`StreamableHTTP connection closed (session ${sessionId})`)
  }

  streamableHttpTransport.onerror = (err) => {
    const sessionId = streamableHttpTransport.sessionId
    logger.error(`StreamableHTTP error (session ${sessionId}):`, err)
  }

  // 注册Streamable HTTP中间件
  app.all(httpPath, async (req, res) => {
    // 设置自定义响应头
    setResponseHeaders({
      res,
      headers,
    })

    // 记录连接信息
    logger.info(`New Streamable HTTP connection from ${req.ip}`)

    try {
      // 使用handleRequest方法处理请求
      await streamableHttpTransport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error(`Error handling StreamableHTTP request: ${error}`)
      res.status(500).send(`Internal Server Error: ${error.message}`)
    }

    req.on('close', () => {
      logger.info(
        `Client disconnected (session ${streamableHttpTransport.sessionId})`,
      )
    })
  })

  // 启动服务器
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  // 处理SSE服务器发送的通知消息
  // @ts-ignore - SSEClientTransport 在当前SDK版本中支持但类型定义不完整
  sseTransport.onnotification = (notification: JSONRPCMessage) => {
    logger.info(
      `SSE notification → StreamableHTTP: ${JSON.stringify(notification)}`,
    )
    try {
      streamableHttpTransport.send(notification)
    } catch (err) {
      logger.error(`Failed to forward notification:`, err)
    }
  }

  // 处理SSE连接错误
  sseTransport.onerror = (error) => {
    logger.error(`SSE connection error: ${error}`)
    process.exit(1)
  }

  // 处理SSE连接关闭
  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }
}
