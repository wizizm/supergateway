import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger, CorsOptions } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import crypto from 'crypto'

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  baseUrl: string
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

// 会话管理
interface Session {
  transport: StreamableHTTPServerTransport
  server: Server
  pendingResponses: Map<string | number, JSONRPCMessage>
}

export async function stdioToStreamableHttp(args: StdioToStreamableHttpArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
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
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - httpPath: ${httpPath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // 解析命令和参数
  const cmdParts = stdioCmd.split(/\s+/).filter((part) => part.length > 0)
  const command = cmdParts[0]
  const cmdArgs = cmdParts.slice(1)

  logger.info(`启动子进程: ${command} ${cmdArgs.join(' ')}`)

  // 以非shell模式启动子进程
  const child: ChildProcessWithoutNullStreams = spawn(command, cmdArgs, {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      FORCE_COLOR: '1',
      DEBUG: '*', // 启用所有调试日志
    },
    shell: false, // 明确设置为false，避免shell解析问题
  })

  // 添加子进程就绪检查
  let childReady = false
  const childReadyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!childReady) {
        reject(new Error('Child process failed to initialize within timeout'))
      }
    }, 30000) // 30秒超时

    child.stdout.once('data', () => {
      childReady = true
      clearTimeout(timeout)
      resolve(true)
    })
  })

  child.on('spawn', () => {
    logger.info('Child process spawned successfully')
  })

  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    if (!childReady) {
      logger.error('Child process exited before initialization')
    }
    process.exit(code ?? 1)
  })

  // 等待子进程就绪
  try {
    await childReadyPromise
    logger.info('Child process initialized successfully')
  } catch (error) {
    logger.error('Child process initialization failed:', error)
    process.exit(1)
  }

  // 会话存储
  const sessions = new Map<string, Session>()

  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use(bodyParser.json())

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

    // 从请求头获取会话ID，如果没有则生成新的
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
        // 为新会话创建传输和服务器实例
        const server = new Server(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId, // 使用请求头中的会话ID
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
        transport.onmessage = (msg: JSONRPCMessage) => {
          logger.info(
            `StreamableHTTP → Child (session ${sessionId}): ${JSON.stringify(msg)}`,
          )
          // 确保消息以换行符结尾，使子进程能正确解析
          child.stdin.write(JSON.stringify(msg) + '\n')

          // 如果是请求消息，记录请求ID
          if ('method' in msg && 'id' in msg) {
            session.pendingResponses.set(msg.id, msg)
            logger.info(
              `Recorded pending request ${msg.id} for session ${sessionId}`,
            )
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
      // sessions.delete(sessionId)
      logger.info(
        `Request closed for session ${sessionId}, total active sessions: ${sessions.size}`,
      )
    })
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const data = chunk.toString('utf8')
    logger.info(`Raw child stdout: ${data}`)
    buffer += data
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    lines.forEach((line) => {
      if (!line.trim()) return
      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → StreamableHTTP (parsed):', jsonMsg)

        // 向所有活动会话发送消息
        for (const [sid, session] of sessions.entries()) {
          try {
            // 检查是否是响应消息
            if ('id' in jsonMsg) {
              // 只发送给有对应请求的会话
              const pendingRequest = session.pendingResponses.get(jsonMsg.id)
              if (pendingRequest) {
                logger.info(
                  `Found pending request ${jsonMsg.id} for session ${sid}, sending response`,
                )
                session.transport.send(jsonMsg)
                session.pendingResponses.delete(jsonMsg.id)
                logger.info(
                  `Response sent and request ${jsonMsg.id} cleared for session ${sid}`,
                )
              } else {
                logger.info(
                  `No pending request ${jsonMsg.id} found for session ${sid}, message might be stale`,
                )
              }
            } else {
              // 通知消息发送给所有会话
              logger.info(`Broadcasting notification to session ${sid}`)
              session.transport.send(jsonMsg)
            }
          } catch (err) {
            logger.error(`Failed to send to session ${sid}:`, err)
            logger.error(`Error stack: ${(err as Error).stack}`)
            sessions.delete(sid)
            logger.info(
              `Session ${sid} deleted due to send error, remaining sessions: ${sessions.size}`,
            )
          }
        }
      } catch (err) {
        // 非JSON输出，可能是启动信息或错误信息
        logger.info(`Child non-JSON output: ${line}`)
      }
    })
  })

  // 改进stderr处理
  child.stderr.on('data', (chunk: Buffer) => {
    const stderr = chunk.toString('utf8')
    logger.error(`Child stderr: ${stderr}`)
    // 尝试解析错误信息
    try {
      const errorObj = JSON.parse(stderr)
      logger.error(`Parsed stderr (JSON):`, errorObj)
      // 如果是JSON错误消息，尝试广播给所有会话
      for (const [sid, session] of sessions.entries()) {
        try {
          session.transport.send({
            jsonrpc: '2.0',
            error: {
              code: -32099,
              message: `Child process error: ${JSON.stringify(errorObj)}`,
            },
            id: null,
          })
        } catch (err) {
          logger.error(`Failed to send error to session ${sid}:`, err)
        }
      }
    } catch {
      // 如果不是JSON，记录原始错误
      logger.error(`Raw stderr output: ${stderr}`)
    }
  })

  // 添加子进程错误处理
  child.on('error', (error) => {
    logger.error(`Child process error:`, error)
    logger.error(`Error stack: ${error.stack}`)
  })
}
