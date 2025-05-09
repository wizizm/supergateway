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

// MCP tool parameters
interface ToolArg {
  name: string
  description: string
  type: string
  required: boolean
  position: 'path' | 'query' | 'body' | 'header'
}

// MCP request template
interface RequestTemplate {
  url: string
  method: string
  headers?: Array<{ key: string; value: string }>
}

// MCP response template
interface ResponseTemplate {
  prependBody?: string
}

// MCP tool definition
interface McpTool {
  name: string
  description: string
  args: ToolArg[]
  requestTemplate: RequestTemplate
  responseTemplate: ResponseTemplate
}

// MCP server configuration
interface McpTemplate {
  server: {
    name: string
    version?: string
  }
  tools: McpTool[]
}

// Format CORS origin into the correct format
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
 * Load MCP template file
 * If it's an OpenAPI specification, automatically convert it to MCP template
 */
async function loadMcpTemplate(
  templatePath: string,
  logger: Logger,
): Promise<McpTemplate> {
  try {
    logger.info(`Loading file: ${templatePath}`)

    try {
      await fs.access(templatePath)
    } catch (err) {
      logger.error(`File does not exist: ${templatePath}`)
      throw new Error(`File does not exist: ${templatePath}`)
    }

    // Read file content
    const fileContent = await fs.readFile(templatePath, 'utf-8')
    let template: McpTemplate | null = null
    let isOpenApi = false

    // Try to parse the file
    try {
      // Choose parsing method based on file extension
      const parsedContent = templatePath.endsWith('.json')
        ? JSON.parse(fileContent)
        : yaml.load(fileContent)

      // Check if it's an OpenAPI specification
      if (parsedContent && typeof parsedContent === 'object') {
        // OpenAPI specification has an openapi field
        if (parsedContent.openapi && parsedContent.paths) {
          logger.info(
            `Detected OpenAPI specification, version: ${parsedContent.openapi}`,
          )
          isOpenApi = true
        }
        // MCP template has server and tools fields
        else if (parsedContent.server && parsedContent.tools) {
          logger.info('Detected MCP template document')
          template = parsedContent as McpTemplate
        }
        // Doesn't match any known format
        else {
          logger.warn(
            'Document format not recognized, trying to process as MCP template',
          )
          template = parsedContent as McpTemplate
        }
      }
    } catch (parseError) {
      logger.error(`Failed to parse file: ${parseError.message}`, parseError)
      throw new Error(`Failed to parse file: ${parseError.message}`)
    }

    // If it's an OpenAPI specification, convert to MCP template
    if (isOpenApi) {
      try {
        logger.info('Converting OpenAPI specification to MCP template...')
        const { convertOpenApiToMcpServer } = await import(
          '../lib/openapi-to-mcpserver/index.js'
        )

        // Convert OpenAPI to MCP template
        const mcpTemplateContent = await convertOpenApiToMcpServer(
          { input: templatePath },
          {},
          templatePath.endsWith('.json') ? 'json' : 'yaml',
          logger,
        )

        // Parse the generated template
        if (templatePath.endsWith('.json')) {
          template = JSON.parse(mcpTemplateContent) as McpTemplate
        } else {
          template = yaml.load(mcpTemplateContent) as McpTemplate
        }

        logger.info(
          'OpenAPI specification successfully converted to MCP template',
        )
      } catch (conversionError) {
        logger.error(
          `OpenAPI specification conversion failed: ${conversionError.message}`,
          conversionError,
        )
        throw new Error(
          `OpenAPI specification conversion failed: ${conversionError.message}`,
        )
      }
    }

    // Ensure template is not null and contains necessary fields
    if (!template) {
      throw new Error('Unable to create a valid MCP template from file')
    }

    // Ensure template has necessary fields
    if (!template.server) {
      template.server = { name: 'API Gateway' }
    }

    if (!template.tools || !Array.isArray(template.tools)) {
      template.tools = []
    }

    logger.info(
      `MCP template loaded successfully: contains ${template.tools.length} tools`,
    )
    return template
  } catch (error) {
    logger.error(`Failed to load MCP template: ${error.message}`, error)
    throw error
  }
}

/**
 * Handle MCP request
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

    // Get tool configuration
    const tool = req.body.metadata?.tool

    if (!tool) {
      return {
        status: 400,
        result: { error: 'Missing tool configuration' },
      }
    }

    // Build request URL
    const apiPath = tool.requestTemplate?.url || ''
    if (!apiPath) {
      return {
        status: 400,
        result: { error: 'Missing URL in request template' },
      }
    }

    // Parse path parameters
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

    // Create complete URL (handle relative paths)
    let url = processedPath
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url =
        apiHost +
        (apiHost.endsWith('/') ? '' : '/') +
        processedPath.replace(/^\//, '')
    }

    // Build query parameters
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

    // Get request method
    const method = (tool.requestTemplate?.method || 'GET').toUpperCase()

    // Build request headers
    const requestHeaders: Record<string, string> = { ...headers }

    // Add headers defined in the tool template
    if (
      tool.requestTemplate?.headers &&
      Array.isArray(tool.requestTemplate.headers)
    ) {
      tool.requestTemplate.headers.forEach((header) => {
        if (header.key && header.value !== undefined) {
          // Support UUID template variable
          let value = header.value
          value = value.replace('{{uuidv4}}', randomUUID())
          requestHeaders[header.key] = value
        }
      })
    }

    // Add header parameters
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

    // Process request body
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

    // Send request to API server
    logger.info(`[${sessionId}] Sending request: ${method} ${url}`)
    logger.info(
      `[${sessionId}] Request headers: ${JSON.stringify(requestHeaders)}`,
    )
    if (requestBody) {
      logger.info(`[${sessionId}] Request body: ${requestBody}`)
    }

    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body: requestBody,
    })

    // Get response content
    const contentType = response.headers.get('content-type') || ''
    let responseData: any

    if (contentType.includes('application/json')) {
      responseData = await response.json()
    } else {
      responseData = await response.text()
    }

    logger.info(`[${sessionId}] Response status: ${response.status}`)
    logger.info(`[${sessionId}] Response content type: ${contentType}`)
    logger.info(
      `[${sessionId}] Response data: ${JSON.stringify(responseData).substring(0, 1000)}${JSON.stringify(responseData).length > 1000 ? '...' : ''}`,
    )

    // Process response template (if any)
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
    logger.error(
      `[${sessionId}] Request processing failed: ${error.message}`,
      error,
    )
    return {
      status: 500,
      result: { error: `Request processing failed: ${error.message}` },
    }
  }
}

// Set response headers
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

// API to SSE gateway
export const apiToSse = async (args: ApiToSseArgs) => {
  const { logger } = args
  const app = express()

  logger.info(`Initializing API->SSE gateway configuration:`)
  logger.info(`- API host: ${args.apiHost}`)
  logger.info(
    `- Config file: ${args.mcpTemplateFile} (supports OpenAPI and MCP template formats)`,
  )
  logger.info(`- Server port: ${args.port}`)
  logger.info(`- SSE path: ${args.ssePath}`)
  logger.info(`- Message path: ${args.messagePath}`)

  // Enable CORS to ensure cross-origin requests work correctly
  app.use(
    cors({
      origin: args.corsOrigin ? formatCorsOrigin(args.corsOrigin) : '*',
      methods: 'GET,POST',
      allowedHeaders: 'Content-Type,Authorization',
    }),
  )

  // Parse JSON request body
  app.use((req, res, next) => {
    if (req.path === args.messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  // Add CORS preflight request handler
  app.options('*', (req, res) => {
    // Set CORS response headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, x-session-id, Accept, Origin, X-Requested-With',
    )
    res.setHeader('Access-Control-Max-Age', '86400') // 24 hours
    res.setHeader(
      'Access-Control-Expose-Headers',
      'mcp-session-id, x-session-id',
    )

    // If there are custom headers, add them as well
    if (args.headers) {
      setResponseHeaders({
        res,
        headers: args.headers,
      })
    }

    // Return success status
    res.status(204).end()
  })

  // Add health check routes
  app.get('/health', (req, res) => {
    res.send('ok')
  })

  app.get('/status', (req, res) => {
    res.json({ status: 'running' })
  })

  // Health check endpoints
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

  // Load MCP template
  let mcpTemplate: McpTemplate
  try {
    mcpTemplate = await loadMcpTemplate(args.mcpTemplateFile, logger)
  } catch (error) {
    logger.error(`Failed to load MCP template: ${error.message}`)
    throw error
  }

  // Provide configuration info access
  app.get('/mcp-config', (req, res) => {
    res.json(mcpTemplate)
  })

  // Store active SSE sessions
  const sessions: Record<
    string,
    { transport: SSEServerTransport; server: McpServer }
  > = {}

  // SSE endpoint
  app.get(args.ssePath, (req, res) => {
    ;(async () => {
      logger.info(`New SSE connection: ${req.ip}`)

      if (args.headers) {
        setResponseHeaders({
          res,
          headers: args.headers,
        })
      }

      try {
        // Get session ID from request or generate new ID
        const sessionId =
          (req.headers['mcp-session-id'] as string) ||
          (req.headers['x-session-id'] as string) ||
          randomUUID()

        logger.info(`Using session ID: ${sessionId}`)

        // Configure CORS headers
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

        // Pass session ID to client
        res.setHeader('mcp-session-id', sessionId)
        res.setHeader('x-session-id', sessionId)

        // Create SSE transport, explicitly including session ID in URL to ensure transport layer uses correct ID
        const messagePath = `${args.messagePath}?sessionId=${sessionId}`
        logger.info(`SSE message path: ${messagePath}`)

        const sseTransport = new SSEServerTransport(
          `${req.protocol}://${req.headers.host}${messagePath}`,
          res,
        )

        // Create MCP server, one instance per connection
        const mcpServer = new McpServer({
          name: mcpTemplate.server.name,
          version: mcpTemplate.server.version || getVersion(),
        })

        // Save session
        sessions[sessionId] = {
          transport: sseTransport,
          server: mcpServer,
        }

        logger.info(`New session created: ${sessionId}`)
        logger.info(`Active session count: ${Object.keys(sessions).length}`)
        logger.info(`Active session list: ${Object.keys(sessions).join(', ')}`)

        // Print tool information
        logger.info(`Registering ${mcpTemplate.tools.length} tools:`)

        // Register tool processing function for each tool
        for (const tool of mcpTemplate.tools) {
          logger.info(
            `Registering tool: ${tool.name} (${tool.args.length} parameters)`,
          )

          // Print parameter information
          tool.args.forEach((arg) => {
            logger.info(
              `   Parameter: ${arg.name} (${arg.type}) [${arg.position}] ${arg.required ? 'Required' : 'Optional'}`,
            )
          })

          // Register tool
          mcpServer.tool(
            tool.name,
            tool.description,
            // Build parameter validation object
            (() => {
              // Create parameter validation object
              const paramSchema: Record<string, z.ZodType<any>> = {}

              // Process tool parameters
              if (tool.args && Array.isArray(tool.args)) {
                for (const arg of tool.args) {
                  // Choose correct zod validator based on parameter type
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
                        // Default to string processing
                        paramSchema[arg.name] = arg.required
                          ? z.string()
                          : z.string().optional()
                    }
                  } catch (error) {
                    logger.error(
                      `Failed to create parameter validator: ${arg.name}`,
                      error,
                    )
                    // If error, use string as fallback
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
                // Record tool parameter information
                logger.info(`Executing tool: ${tool.name}`)
                logger.info(`Passed parameters: ${JSON.stringify(toolParams)}`)

                // Build parameters to use for API request
                const requestParams = {
                  name: tool.name,
                  args: toolParams,
                  metadata: {
                    tool: tool,
                  },
                }

                // Construct a request object
                const customReq = {
                  body: requestParams,
                  headers: req.headers,
                  protocol: req.protocol,
                  ip: req.ip,
                }

                // Handle API request
                const result = await handleMcpRequest(
                  customReq as any,
                  res,
                  String(sessionId),
                  args.apiHost,
                  args.headers || {},
                  logger,
                )

                // Format response
                let responseText = ''

                if (typeof result.result === 'string') {
                  responseText = result.result
                } else {
                  try {
                    responseText = JSON.stringify(result.result, null, 2)
                  } catch (error) {
                    responseText = `Unable to serialize result: ${String(result.result)}`
                  }
                }

                // Record response information
                logger.info(
                  `Tool execution result: ${responseText.length > 200 ? responseText.substring(0, 200) + '...' : responseText}`,
                )

                // Return standard format response
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
                  `Tool execution failed (${tool.name}): ${error.message}`,
                  error,
                )
                return {
                  content: [
                    {
                      type: 'text',
                      text: `Execution failed: ${error.message}`,
                    },
                  ],
                }
              }
            },
          )
        }

        // Connect transport
        try {
          await mcpServer.connect(sseTransport)
          logger.info(`SSE session connection established: ${sessionId}`)
        } catch (error) {
          logger.error(
            `Failed to establish SSE session connection: ${error.message}`,
            error,
          )
          delete sessions[sessionId]
          return res
            .status(500)
            .end(`Failed to establish SSE session connection: ${error.message}`)
        }

        // Handle connection closure
        req.on('close', () => {
          logger.info(`Client disconnected (session ${sessionId})`)
          delete sessions[sessionId]
        })

        // Handle SSE error
        sseTransport.onerror = (err) => {
          logger.error(`SSE error (session ${sessionId}):`, err)
          delete sessions[sessionId]
        }

        // Handle SSE closure
        sseTransport.onclose = () => {
          logger.info(`SSE connection closed (session ${sessionId})`)
          delete sessions[sessionId]
        }
      } catch (error) {
        logger.error(
          `SSE connection processing failed: ${error.message}`,
          error,
        )
        res
          .status(500)
          .end(`SSE connection processing failed: ${error.message}`)
      }
    })()
  })

  // Message endpoint
  app.post(args.messagePath, (req, res) => {
    ;(async () => {
      // Get session ID, prioritize query parameters, then request headers
      const sessionId =
        typeof req.query.sessionId === 'string'
          ? req.query.sessionId
          : (req.headers['mcp-session-id'] as string) ||
            (req.headers['x-session-id'] as string)

      // Print request information, help with debugging
      console.log('********** Message request **********')
      console.log('Request path:', req.path)
      console.log('Request query parameters:', req.query)
      console.log('Request headers:', req.headers)
      console.log('Extracted session ID:', sessionId)
      console.log('Active session list:', Object.keys(sessions))
      console.log('******************************')

      if (args.headers) {
        setResponseHeaders({
          res,
          headers: args.headers,
        })
      }

      // Set CORS headers
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

      // Validate session ID
      if (!sessionId || typeof sessionId !== 'string') {
        logger.error('Message request missing session ID parameter')
        return res.status(400).send('Missing session ID parameter')
      }

      // If we can't find the session, it's possible because the client used its own generated ID instead of the server generated ID
      // Try to see if there's any active session that might be newly created
      if (!sessions[sessionId] && Object.keys(sessions).length > 0) {
        // Record active session, this will help us diagnose problems
        logger.warn(
          `Session ${sessionId} does not exist, but there are ${Object.keys(sessions).length} active sessions`,
        )
        logger.warn(`Active session list: ${Object.keys(sessions).join(', ')}`)

        // If there's only one active session and it's recently created (within 10 seconds), try to use it
        const activeSessionIds = Object.keys(sessions)
        if (activeSessionIds.length === 1) {
          const existingSessionId = activeSessionIds[0]
          logger.warn(
            `Trying to use current only active session ${existingSessionId} instead of requested session ${sessionId}`,
          )

          // Pass correct session ID to client so it can use it in subsequent requests
          res.setHeader('mcp-session-id', existingSessionId)
          res.setHeader('x-session-id', existingSessionId)

          // Use found session
          const session = sessions[existingSessionId]

          // Handle request
          try {
            logger.info(
              `Handling message request from replacement session ${existingSessionId}`,
            )
            const result = await session.transport.handlePostMessage(req, res)
            logger.info(
              `Successfully handled message request from replacement session`,
            )
            return
          } catch (error) {
            logger.error(
              `Failed to handle SSE message (replacement session): ${error.message}`,
              error,
            )
            return res
              .status(500)
              .send(`Failed to handle message: ${error.message}`)
          }
        }
      }

      logger.info(`Handling message request from session ${sessionId}`)

      const session = sessions[sessionId]

      // Check if session exists
      if (!session) {
        logger.error(
          `Session ${sessionId} does not exist, possibly expired or closed`,
        )
        return res
          .status(404)
          .send(
            `Session ${sessionId} does not exist, possibly expired or closed`,
          )
      }

      // Check if session has available transport
      if (!session.transport || !session.transport.handlePostMessage) {
        logger.error(`Session ${sessionId} transport unavailable`)
        return res
          .status(500)
          .send(`Session ${sessionId} transport unavailable`)
      }

      try {
        logger.info(`Handling SSE message (session ${sessionId})`)
        logger.info(`Active session count: ${Object.keys(sessions).length}`)
        logger.info(`Active session list: ${Object.keys(sessions).join(', ')}`)

        const originalMessage = req.body
        logger.debug(`Received message: ${JSON.stringify(originalMessage)}`)

        // Special handling for startup request
        if (originalMessage && originalMessage.method === 'startup') {
          logger.info(`Handling startup request (session ${sessionId})`)

          // Send successful startup response
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

          // Return success status
          return res.status(200).send('Startup message processed')
        }
        // Special handling for tools/list request
        else if (originalMessage && originalMessage.method === 'tools/list') {
          logger.info(`Handling tools/list request (session ${sessionId})`)

          // Collect all tool information
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
            `Sending tool list (${tools.length} tools) to session ${sessionId}`,
          )
          logger.debug(`Tool list details: ${JSON.stringify(tools)}`)

          // Send tool list response
          session.transport.send({
            jsonrpc: '2.0',
            id: originalMessage.id,
            result: {
              tools: tools,
            },
          })

          // Return success status
          return res.status(200).send('Tool list request processed')
        }
        // If it's a tool call request, handle API request
        else if (originalMessage && originalMessage.method === 'tools/call') {
          const result = await handleMcpRequest(
            req,
            res,
            sessionId,
            args.apiHost,
            args.headers || {},
            logger,
          )

          // Manually send response
          if (originalMessage.id) {
            session.transport.send({
              jsonrpc: '2.0',
              id: originalMessage.id,
              result: result.result,
            })
          }

          // Send successful response
          res.status(200).send('Message processed')
        } else {
          // Normal processing for other types of messages
          await session.transport.handlePostMessage(req, res)
        }
      } catch (error) {
        logger.error(
          `Failed to handle SSE message (session ${sessionId}): ${error.message}`,
          error,
        )
        res.status(500).send(`Failed to handle message: ${error.message}`)
      }
    })()
  })

  // Start server
  const server = app.listen(args.port, () => {
    logger.info(`Server started successfully:`)
    logger.info(`- Listening port: ${args.port}`)
    logger.info(`- SSE endpoint: http://localhost:${args.port}${args.ssePath}`)
    logger.info(
      `- Message endpoint: http://localhost:${args.port}${args.messagePath}`,
    )
    logger.info(`- Health check endpoint: http://localhost:${args.port}/health`)
    logger.info(`- Status check endpoint: http://localhost:${args.port}/status`)
    logger.info(`- MCP config file: http://localhost:${args.port}/mcp-config`)
    logger.info(
      `- Supports automatic detection and conversion of OpenAPI specification files`,
    )
  })

  // Graceful shutdown
  const cleanup = () => {
    logger.info('Shutting down server...')
    server.close(() => {
      logger.info('Server closed')
      process.exit(0)
    })

    // Close all sessions
    Object.keys(sessions).forEach((sid) => {
      logger.info(`Closing session: ${sid}`)
      delete sessions[sid]
    })

    // Exit forcefully after 5 seconds
    setTimeout(() => {
      logger.warn('Force exit')
      process.exit(1)
    }, 5000)
  }

  // Handle process signals
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  return server
}
