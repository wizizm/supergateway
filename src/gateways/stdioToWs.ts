import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { getVersion } from '../lib/getVersion.js'
import { Logger, CorsOptions } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToWsArgs {
  stdioCmd: string
  port: number
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

export async function stdioToWs(args: StdioToWsArgs) {
  const { stdioCmd, port, messagePath, logger, healthEndpoints, corsOrigin } =
    args

  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - messagePath: ${messagePath}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  let wsTransport: WebSocketServerTransport | null = null
  let child: ChildProcessWithoutNullStreams | null = null
  let isReady = false

  const cleanup = () => {
    if (wsTransport) {
      wsTransport.close().catch((err) => {
        logger.error(`Error stopping WebSocket server: ${err.message}`)
      })
    }
    if (child) {
      child.kill()
    }
  }

  onSignals({
    logger,
    cleanup,
  })

  try {
    // 解析命令和参数
    const cmdParts = stdioCmd.split(/\s+/).filter((part) => part.length > 0)
    const command = cmdParts[0]
    const cmdArgs = cmdParts.slice(1)

    logger.info(`启动子进程: ${command} ${cmdArgs.join(' ')}`)

    // 以非shell模式启动子进程
    child = spawn(command, cmdArgs, {
      env: process.env,
      shell: false, // 明确设置为false，避免shell解析问题
    })

    child.on('exit', (code, signal) => {
      logger.error(`Child exited: code=${code}, signal=${signal}`)
      cleanup()
      process.exit(code ?? 1)
    })

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )

    // Handle child process output
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`Child → WebSocket: ${JSON.stringify(jsonMsg)}`)
          // Broadcast to all connected clients
          wsTransport?.send(jsonMsg, jsonMsg.id).catch((err) => {
            logger.error('Failed to broadcast message:', err)
          })
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.info(`Child stderr: ${chunk.toString('utf8')}`)
    })

    const app = express()

    if (corsOrigin) {
      app.use(cors({ origin: corsOrigin }))
    }

    for (const ep of healthEndpoints) {
      app.get(ep, (_req, res) => {
        if (child?.killed) {
          res.status(500).send('Child process has been killed')
        }

        if (!isReady) {
          res.status(500).send('Server is not ready')
        }

        res.send('ok')
      })
    }

    const httpServer = createServer(app)

    wsTransport = new WebSocketServerTransport({
      path: messagePath,
      server: httpServer,
    })

    wsTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(`WebSocket → Child: ${JSON.stringify(msg)}`)
      child?.stdin.write(JSON.stringify(msg) + '\n')
    }

    wsTransport.onclose = () => {
      logger.info('WebSocket connection closed')
    }

    wsTransport.onerror = (err) => {
      logger.error(`WebSocket error: ${err.message}`)
    }

    await server.connect(wsTransport)

    isReady = true

    httpServer.listen(port, () => {
      logger.info(`Listening on port ${port}`)
      logger.info(`WebSocket endpoint: ws://localhost:${port}${messagePath}`)
    })
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`)
    cleanup()
    process.exit(1)
  }
}
