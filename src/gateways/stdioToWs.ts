import express from 'express'
import cors from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { onSignals } from '../lib/onSignals.js'

export interface StdioToWsArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  messagePath: string
  logger: Logger
  enableCors: boolean
  healthEndpoints: string[]
}

export async function stdioToWs(args: StdioToWsArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    messagePath,
    logger,
    healthEndpoints,
    enableCors,
  } = args
  const hostname = baseUrl ? new URL(baseUrl).hostname : '0.0.0.0'
  logger.info('Starting...')
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - messagePath: ${messagePath}`)

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

  if (healthEndpoints.length > 0) {
    const app = express()
    if (enableCors) {
      app.use(cors())
    }
    for (const ep of healthEndpoints) {
      app.get(ep, (_req: express.Request, res: express.Response) => {
        if (child?.killed) {
          res.status(500).send('Child process has been killed')
        }
        if (!isReady) {
          res.status(500).send('Server is not ready')
        } else {
          res.send('OK')
        }
      })
    }
    app.listen(port, hostname, () => {
      logger.info(`Health endpoints listening on ${port}`)
    })
  }

  try {
    child = spawn(stdioCmd, { shell: true })
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

    wsTransport = new WebSocketServerTransport(
      hostname,
      port,
      messagePath,
      enableCors,
    )
    await server.connect(wsTransport)

    wsTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
      logger.info(`WebSocket → Child: ${line}`)
      child!.stdin.write(line + '\n')
    }

    wsTransport.onconnection = (clientId: string) => {
      logger.info(`New WebSocket connection: ${clientId}`)
    }

    wsTransport.ondisconnection = (clientId: string) => {
      logger.info(`WebSocket connection closed: ${clientId}`)
    }

    wsTransport.onerror = (err: Error) => {
      logger.error(`WebSocket error: ${err.message}`)
    }

    isReady = true
    const wsEndpoint = `ws://${hostname}:${port}${messagePath}`
    logger.info(`WebSocket endpoint: ${wsEndpoint}`)
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`)
    cleanup()
    process.exit(1)
  }
}
