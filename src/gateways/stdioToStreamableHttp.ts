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

// 重连参数
const INITIAL_RECONNECT_DELAY = 1000 // 1秒
const MAX_RECONNECT_DELAY = 30000 // 30秒
const RECONNECT_BACKOFF_FACTOR = 1.5
const MAX_RECONNECT_ATTEMPTS = 10

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

  // 会话存储
  const sessions = new Map<string, Session>()

  // 子进程变量
  let child: ChildProcessWithoutNullStreams | null = null
  let buffer = ''
  let childReady = false
  let isShuttingDown = false
  let reconnectAttempts = 0
  let reconnectDelay = INITIAL_RECONNECT_DELAY

  // 设置子进程的事件处理函数
  function setupChildProcessEventHandlers() {
    if (!child) return

    child.stdout.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8')
      logger.info(`Raw child stdout: ${data}`)

      // 标记子进程已就绪
      if (!childReady) {
        childReady = true
        logger.info('Child process initialized successfully')

        // 重置重连计数和延迟
        reconnectAttempts = 0
        reconnectDelay = INITIAL_RECONNECT_DELAY
      }

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
              id: 'unknown',
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

      // 启动子进程重连
      if (!isShuttingDown) {
        handleChildProcessFailure('error event')
      }
    })

    child.on('spawn', () => {
      logger.info('Child process spawned successfully')

      // 发送一个测试消息到子进程，尝试激活它
      try {
        logger.info('Sending test message to child process...')
        child?.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }) +
            '\n',
        )
      } catch (error) {
        logger.error('Failed to send test message to child process:', error)
      }
    })

    child.on('exit', (code, signal) => {
      logger.error(`Child exited: code=${code}, signal=${signal}`)

      // 处理子进程退出
      if (!isShuttingDown) {
        handleChildProcessFailure(`exit with code=${code}, signal=${signal}`)
      }
    })
  }

  // 启动子进程
  async function startChildProcess() {
    try {
      logger.info(`启动子进程: ${command} ${cmdArgs.join(' ')}`)

      // 以非shell模式启动子进程
      child = spawn(command, cmdArgs, {
        env: {
          ...process.env,
          NODE_ENV: 'production',
          FORCE_COLOR: '1',
          DEBUG: '*', // 启用所有调试日志
        },
        shell: false, // 明确设置为false，避免shell解析问题
      })

      // 设置事件处理器
      setupChildProcessEventHandlers()

      // 等待子进程初始化
      const childInitTimeout = 120000 // 120秒超时
      let initializationTimeout: NodeJS.Timeout | null = null

      const childReadyPromise = new Promise<void>((resolve, reject) => {
        // 设置初始化超时
        initializationTimeout = setTimeout(() => {
          if (!childReady) {
            reject(
              new Error(
                `Child process failed to initialize within ${childInitTimeout / 1000} seconds`,
              ),
            )
          }
        }, childInitTimeout)

        // 检查子进程是否已经就绪
        const checkInterval = setInterval(() => {
          if (childReady) {
            clearInterval(checkInterval)
            if (initializationTimeout) clearTimeout(initializationTimeout)
            resolve()
          }
        }, 100)
      })

      try {
        await childReadyPromise
        logger.info('Child process is ready to handle requests')
        return true
      } catch (error) {
        logger.error('Child process initialization failed:', error)

        // 清理可能的定时器
        if (initializationTimeout) clearTimeout(initializationTimeout)

        // 如果子进程仍在运行但未初始化，则终止它
        if (child && !childReady) {
          try {
            child.kill('SIGTERM')
            logger.info('Terminated unresponsive child process')
          } catch (killError) {
            logger.error('Failed to terminate child process:', killError)
          }
        }

        return false
      }
    } catch (error) {
      logger.error('Failed to start child process:', error)
      return false
    }
  }

  // 处理子进程失败并尝试重连
  function handleChildProcessFailure(reason: string) {
    if (isShuttingDown) return

    childReady = false

    // 清理当前子进程
    if (child) {
      try {
        child.removeAllListeners()
        child.kill('SIGTERM')
      } catch (error) {
        logger.error('Error while terminating child process:', error)
      }
      child = null
    }

    // 增加重连尝试计数
    reconnectAttempts++

    // 检查是否超过最大重试次数
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      logger.error(
        `Exceeded maximum reconnection attempts (${MAX_RECONNECT_ATTEMPTS}). Please restart the service manually.`,
      )

      // 通知所有会话
      for (const [sid, session] of sessions.entries()) {
        try {
          session.transport.send({
            jsonrpc: '2.0',
            error: {
              code: -32001,
              message: `Child process failed after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts. Service unstable.`,
            },
            id: null as unknown as string,
          })
        } catch (err) {
          logger.error(`Failed to send error to session ${sid}:`, err)
        }
      }

      return
    }

    logger.info(
      `Child process failed (${reason}). Attempting to reconnect in ${reconnectDelay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
    )

    // 使用指数退避策略延迟重连
    setTimeout(async () => {
      const success = await startChildProcess()

      if (success) {
        logger.info(
          `Successfully reconnected child process on attempt ${reconnectAttempts}`,
        )

        // 通知所有会话
        for (const [sid, session] of sessions.entries()) {
          try {
            session.transport.send({
              jsonrpc: '2.0',
              method: 'notifications/reconnected',
              params: {
                message: `Connection to child process restored after ${reconnectAttempts} attempts`,
              },
            })
          } catch (err) {
            logger.error(
              `Failed to send reconnection notification to session ${sid}:`,
              err,
            )
          }
        }
      } else {
        logger.error(
          `Failed to reconnect child process on attempt ${reconnectAttempts}`,
        )

        // 增加延迟（使用指数退避）
        reconnectDelay = Math.min(
          reconnectDelay * RECONNECT_BACKOFF_FACTOR,
          MAX_RECONNECT_DELAY,
        )

        // 再次尝试重连
        handleChildProcessFailure(
          `reconnect failure (attempt ${reconnectAttempts})`,
        )
      }
    }, reconnectDelay)
  }

  // 初始启动子进程
  const initialStartSuccess = await startChildProcess()
  if (!initialStartSuccess) {
    logger.error('Failed to start child process. Exiting.')
    process.exit(1)
  }

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
    // 合并 header 时，优先用客户端 header，其次 gateway header
    const lowerCaseHeaders = (obj: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]),
      )

    // 这里只合并 gateway header 和客户端 header
    const mergedHeaders = {
      ...lowerCaseHeaders(headers), // gateway header
      ...lowerCaseHeaders(req.headers), // 客户端 header，优先级最高
    }

    const requestHeaders: Record<string, string | string[]> = {}
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
    // 日志
    logger.info(`[MCP] Final requestHeaders: ${JSON.stringify(requestHeaders)}`)

    // 从请求头获取会话ID，如果没有则生成新的
    const sessionId =
      (req.headers['mcp-session-id'] as string) || crypto.randomUUID()
    logger.info(`Handling request with session ID: ${sessionId} from ${req.ip}`)
    logger.info(`Request headers: ${JSON.stringify(req.headers)}`)
    logger.info(`Request body: ${JSON.stringify(req.body)}`)

    try {
      // 检查子进程是否就绪，如果未就绪则返回503错误
      if (!child || !childReady) {
        logger.error('Child process is not ready. Cannot handle request.')
        res
          .status(503)
          .send(
            'Service Unavailable: Model service is initializing or not available',
          )
        return
      }

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

          // 检查子进程是否就绪
          if (!child || !childReady) {
            logger.error(
              `Cannot forward message to child process - process not ready`,
            )
            if (session && 'id' in msg) {
              try {
                session.transport.send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: {
                    code: -32603,
                    message: 'Model service is not available',
                  },
                })
              } catch (err) {
                logger.error(
                  `Failed to send error response to session ${sessionId}:`,
                  err,
                )
              }
            }
            return
          }

          // 确保消息以换行符结尾，使子进程能正确解析
          try {
            child.stdin.write(JSON.stringify(msg) + '\n')

            // 如果是请求消息，记录请求ID
            if ('method' in msg && 'id' in msg) {
              if (session) session.pendingResponses.set(msg.id, msg)
              logger.info(
                `Recorded pending request ${msg.id} for session ${sessionId}`,
              )
            }
          } catch (error) {
            logger.error(`Failed to write to child process stdin:`, error)

            // 如果写入失败且消息有ID，返回错误响应
            if ('id' in msg) {
              try {
                session?.transport.send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  error: {
                    code: -32603,
                    message: 'Failed to communicate with model service',
                  },
                })
              } catch (err) {
                logger.error(
                  `Failed to send error response to session ${sessionId}:`,
                  err,
                )
              }
            }

            // 尝试重启子进程
            handleChildProcessFailure('stdin write error')
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
      const msg = error instanceof Error ? error.message : String(error)
      logger.error(
        `Error handling StreamableHTTP request for session ${sessionId}:`,
        msg,
      )
      if (error instanceof Error && error.stack) {
        logger.error(`Error stack: ${error.stack}`)
      }
      res.status(500).send(`Internal Server Error: ${msg}`)
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

  const server = app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  // 实现优雅关闭
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))

  async function gracefulShutdown(signal: string) {
    logger.info(`接收到 ${signal} 信号，正在优雅关闭...`)
    isShuttingDown = true

    // 关闭HTTP服务器
    server.close(() => {
      logger.info('HTTP服务器已关闭')
    })

    // 终止子进程
    if (child) {
      try {
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', method: 'shutdown' }) + '\n',
        )
        logger.info('已发送关闭信号给子进程')

        // 给子进程一点时间处理关闭
        setTimeout(() => {
          if (child) {
            child.kill('SIGTERM')
            logger.info('子进程已终止')
          }
        }, 1000)
      } catch (error) {
        logger.error('关闭子进程时出错:', error)
        if (child) {
          child.kill('SIGKILL')
          logger.info('子进程已强制终止')
        }
      }
    }

    // 关闭所有会话连接
    for (const [sessionId, session] of sessions.entries()) {
      try {
        session.transport.close()
        logger.info(`已关闭会话 ${sessionId}`)
      } catch (error) {
        logger.error(`关闭会话 ${sessionId} 时出错:`, error)
      }
    }

    logger.info('优雅关闭完成')

    // 给一点时间让最终日志写入
    setTimeout(() => {
      process.exit(0)
    }, 1000)
  }
}
