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
    env: process.env,
    shell: false, // 明确设置为false，避免shell解析问题
  })

  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  const server = new Server(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} },
  )

  // 创建Streamable HTTP传输
  const streamableHttpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  })

  await server.connect(streamableHttpTransport)

  streamableHttpTransport.onmessage = (msg: JSONRPCMessage) => {
    const sessionId = streamableHttpTransport.sessionId
    logger.info(
      `StreamableHTTP → Child (session ${sessionId}): ${JSON.stringify(msg)}`,
    )
    // 确保消息以换行符结尾，使子进程能正确解析
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  streamableHttpTransport.onclose = () => {
    const sessionId = streamableHttpTransport.sessionId
    logger.info(`StreamableHTTP connection closed (session ${sessionId})`)
  }

  streamableHttpTransport.onerror = (err) => {
    const sessionId = streamableHttpTransport.sessionId
    logger.error(`StreamableHTTP error (session ${sessionId}):`, err)
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

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    lines.forEach((line) => {
      if (!line.trim()) return
      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → StreamableHTTP:', jsonMsg)
        try {
          streamableHttpTransport.send(jsonMsg)
        } catch (err) {
          logger.error(`Failed to send message:`, err)
        }
      } catch {
        logger.error(`Child non-JSON: ${line}`)
      }
    })
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}
