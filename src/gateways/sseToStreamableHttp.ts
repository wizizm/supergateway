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

  // Connect to SSE server
  const client = new Client({ name: 'supergateway', version: getVersion() })
  const sseTransport = new SSEClientTransport(new URL(sseUrl), {
    requestInit: { headers },
    eventSourceInit: {}, // EventSource does not support custom headers
  })

  try {
    await client.connect(sseTransport)
    logger.info(`Connected to SSE server: ${sseUrl}`)
  } catch (error) {
    logger.error(`Failed to connect to SSE server: ${error}`)
    process.exit(1)
  }

  // Session storage
  const sessions = new Map<string, Session>()

  // Set up Express application
  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use(bodyParser.json())

  // Register health check endpoints
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  // Register Streamable HTTP handler
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

    // Get session ID from request headers
    const sessionId =
      (req.headers['mcp-session-id'] as string) || crypto.randomUUID()
    logger.info(`Handling request with session ID: ${sessionId} from ${req.ip}`)
    logger.info(`Request headers: ${JSON.stringify(req.headers)}`)
    logger.info(`Request body: ${JSON.stringify(req.body)}`)

    try {
      // Check if session already exists
      let session = sessions.get(sessionId)

      if (!session) {
        logger.info(`Creating new session for ${sessionId}`)
        // Create server instance for new session
        const server = new Server(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        })

        // Store session
        session = {
          transport,
          server,
          pendingResponses: new Map(),
        }
        sessions.set(sessionId, session)
        logger.info(
          `Created new session ${sessionId}, total active sessions: ${sessions.size}`,
        )

        // Connect server and transport
        await server.connect(transport)
        logger.info(`Server connected for session ${sessionId}`)

        // Set up message handling
        transport.onmessage = async (msg: JSONRPCMessage) => {
          logger.info(
            `StreamableHTTP → SSE (session ${sessionId}): ${JSON.stringify(msg)}`,
          )
          try {
            // Check message type, forward requests through Client interface instead of directly using transport layer
            if ('method' in msg && 'id' in msg) {
              // Request message
              const method = msg.method
              const params = (msg as any).params || {}

              // Use client interface to send requests
              let response: any
              switch (method) {
                case 'initialize':
                  // Initialize request - return SSE server's capabilities
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
                  // Tools list request
                  const toolsResult = await client.listTools()
                  response = {
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: toolsResult,
                  }
                  break
                case 'tools/call':
                  // Tool call request
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
                  // Resources list request
                  const resourcesResult = await client.listResources()
                  response = {
                    jsonrpc: '2.0',
                    id: msg.id,
                    result: resourcesResult,
                  }
                  break
                case 'resources/read':
                  // Resource read request
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
                  // For other requests, return method not found error
                  response = {
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: {
                      code: -32601,
                      message: `Method not found: ${method}`,
                    },
                  }
              }

              // Record pending request
              if (session) session.pendingResponses.set(msg.id, msg)
              logger.info(
                `Recorded pending request ${msg.id} for session ${sessionId}`,
              )

              // Send response back to Streamable HTTP client
              transport.send(response)
              if (session) session.pendingResponses.delete(msg.id)
              logger.info(
                `Response sent and request ${msg.id} cleared for session ${sessionId}`,
              )
            } else if ('method' in msg && !('id' in msg)) {
              // Notification message, no response needed
              logger.info(`Notification message: ${msg.method}`)
            } else {
              // Unknown message type
              logger.error(`Unknown message type: ${JSON.stringify(msg)}`)
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            logger.error(`Error forwarding message to SSE: ${msg}`)
            const errorResponse: JSONRPCMessage = {
              jsonrpc: '2.0',
              id: (msg as any).id,
              error: {
                code: -32603,
                message: `Internal error: ${msg}`,
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
          const msg = err instanceof Error ? err.message : String(err)
          logger.error(`StreamableHTTP error (session ${sessionId}):`, msg)
          if (err instanceof Error && err.stack) {
            logger.error(`Error stack: ${err.stack}`)
          }
          sessions.delete(sessionId)
          logger.info(
            `Session ${sessionId} deleted due to error, remaining sessions: ${sessions.size}`,
          )
        }
      } else {
        logger.info(`Reusing existing session ${sessionId}`)
      }

      // Use handleRequest method to process the request
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
      // Don't delete session when request ends, as the same session ID may continue to be used
      logger.info(
        `Request closed for session ${sessionId}, total active sessions: ${sessions.size}`,
      )
    })
  })

  // Start server
  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`Streamable HTTP endpoint: http://localhost:${port}${httpPath}`)
  })

  // Handle notification messages sent by SSE server
  const originalOnMessage = sseTransport.onmessage
  sseTransport.onmessage = (msg: JSONRPCMessage) => {
    // If it's a notification message, broadcast to all sessions
    if ('method' in msg && !('id' in msg)) {
      logger.info(`SSE notification → StreamableHTTP: ${JSON.stringify(msg)}`)
      try {
        // Broadcast notification to all active sessions
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

    // Call the original onmessage handler
    if (originalOnMessage) {
      originalOnMessage(msg)
    }
  }

  // Handle SSE connection errors
  sseTransport.onerror = (error) => {
    logger.error(`SSE connection error: ${error}`)
    process.exit(1)
  }

  // Handle SSE connection closure
  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }
}
