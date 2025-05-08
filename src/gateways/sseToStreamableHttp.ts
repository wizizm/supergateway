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

interface Session {
  transport: StreamableHTTPServerTransport
  server: Server
  pendingResponses: Map<string | number, JSONRPCMessage>
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
  const sseTransport = new SSEClientTransport(new URL(sseUrl), {
    requestInit: { headers },
    eventSourceInit: {}, // EventSource不支持自定义headers
  })

  try {
    await client.connect(sseTransport)
    logger.info(`Connected to SSE server: ${sseUrl}`)
  } catch (error) {
    logger.error(`Failed to connect to SSE server: ${error}`)
    process.exit(1)
  }

  // 会话存储
  const sessions = new Map<string, Session>()

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

  // 注册Streamable HTTP处理程序
  app.all(httpPath, async (req, res) => {
    // 设置自定义响应头
    setResponseHeaders({
      res,
      headers,
    })

    // 从请求头获取会话ID
    const sessionId =
      (req.headers['mcp-session-id'] as string) || crypto.randomUUID()
    logger.info(`Handling request with session ID: ${sessionId} from ${req.ip}`)
    logger.info(`Request headers: ${JSON.stringify(req.headers)}`)
    logger.info(`Request body: ${JSON.stringify(req.body)}`)

    try {
      // 检查会话是否已存在
      let session = sessions.get(sessionId)

      if (!session) {
        logger.info(`Creating new session for ${sessionId}`)
        // 为新会话创建服务器实例
        const server = new Server(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        })

        // 存储会话
        session = {
          transport,
          server,
          pendingResponses: new Map(),
        }
        sessions.set(sessionId, session)
        logger.info(
          `Created new session ${sessionId}, total active sessions: ${sessions.size}`,
        )

        // 连接服务器和传输
        await server.connect(transport)
        logger.info(`Server connected for session ${sessionId}`)

        // 设置消息处理
        transport.onmessage = async (msg: JSONRPCMessage) => {
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
                  // 初始化请求 - 返回SSE服务器的能力
                  const serverCapabilities =
                    client.getServerCapabilities() || {}
                  const serverInfo = client.getServerVersion() || {
                    name: 'proxy-server',
                    version: '1.0.0',
                  }
                  response = {
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: {
                      protocolVersion: '2024-11-05',
                      capabilities: serverCapabilities,
                      serverInfo: serverInfo,
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

              // 记录待处理请求
              session.pendingResponses.set(msg.id, msg)
              logger.info(
                `Recorded pending request ${msg.id} for session ${sessionId}`,
              )

              // 将响应发送回Streamable HTTP客户端
              transport.send(response)
              session.pendingResponses.delete(msg.id)
              logger.info(
                `Response sent and request ${msg.id} cleared for session ${sessionId}`,
              )
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
            transport.send(errorResponse)
          }
        }

        transport.onclose = () => {
          logger.info(`StreamableHTTP connection closed (session ${sessionId})`)
          sessions.delete(sessionId)
          logger.info(
            `Session ${sessionId} deleted, remaining sessions: ${sessions.size}`,
          )
        }

        transport.onerror = (err) => {
          logger.error(`StreamableHTTP error (session ${sessionId}):`, err)
          logger.error(`Error stack: ${err.stack}`)
          sessions.delete(sessionId)
          logger.info(
            `Session ${sessionId} deleted due to error, remaining sessions: ${sessions.size}`,
          )
        }
      } else {
        logger.info(`Reusing existing session ${sessionId}`)
      }

      // 使用handleRequest方法处理请求
      logger.info(`Handling request for session ${sessionId}`)
      await session.transport.handleRequest(req, res, req.body)
      logger.info(`Request handled for session ${sessionId}`)
    } catch (error) {
      logger.error(
        `Error handling StreamableHTTP request for session ${sessionId}:`,
        error,
      )
      logger.error(`Error stack: ${(error as Error).stack}`)
      res.status(500).send(`Internal Server Error: ${error.message}`)
      sessions.delete(sessionId)
      logger.info(
        `Session ${sessionId} deleted due to error, remaining sessions: ${sessions.size}`,
      )
    }

    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      // 不要在请求结束时删除会话，因为同一个会话ID可能会继续使用
      logger.info(
        `Request closed for session ${sessionId}, total active sessions: ${sessions.size}`,
      )
    })
  })

  // 启动服务器
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  // 处理SSE服务器发送的通知消息
  const originalOnMessage = sseTransport.onmessage
  sseTransport.onmessage = (msg: JSONRPCMessage) => {
    // 如果是通知消息，广播给所有会话
    if ('method' in msg && !('id' in msg)) {
      logger.info(`SSE notification → StreamableHTTP: ${JSON.stringify(msg)}`)
      try {
        // 广播通知给所有活动会话
        for (const [sid, session] of sessions.entries()) {
          try {
            session.transport.send(msg)
          } catch (err) {
            logger.error(
              `Failed to forward notification to session ${sid}:`,
              err,
            )
          }
        }
      } catch (err) {
        logger.error(`Failed to forward notification:`, err)
      }
    }

    // 调用原始的onmessage处理程序
    if (originalOnMessage) {
      originalOnMessage(msg)
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
