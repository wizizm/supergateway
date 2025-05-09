import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import fetch from 'node-fetch'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import yaml from 'js-yaml'

interface ApiToStreamableHttpArgs {
  apiHost: string
  mcpTemplateFile: string // Changed to MCP template file path
  port: number
  httpPath: string
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

// MCP tool request template
interface RequestTemplate {
  url: string
  method: string
  headers?: Array<{ key: string; value: string }>
}

// MCP tool response template
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

// Serialize CORS origin to the correct format
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
      // Decide parsing method based on file extension
      const parsedContent = templatePath.endsWith('.json')
        ? JSON.parse(fileContent)
        : yaml.load(fileContent)

      // Check if it's an OpenAPI specification
      if (parsedContent && typeof parsedContent === 'object') {
        // OpenAPI specification has openapi field
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
      throw new Error('Unable to create valid MCP template from file')
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
  tools: McpTool[],
  apiHost: string,
  headers: Record<string, string> = {},
  logger: Logger,
) {
  // Create MCP server
  const server = new McpServer({
    name: 'API Gateway',
    version: getVersion(),
  })

  logger.info(
    `Created MCP server instance, handling request: ${req.method} ${req.path}`,
  )

  // Register tools/call handler
  server.tool(
    'apiCallHandler',
    'Handle API calls',
    {
      name: z.string().describe('API tool name'),
      arguments: z.record(z.any()).optional().describe('API call parameters'),
    },
    async (toolParams) => {
      const { name, arguments: args = {} } = toolParams

      // Find tool
      const tool = tools.find((t) => t.name === name)
      if (!tool) {
        throw new Error(`Tool not found: ${name}`)
      }

      // Process path parameters
      const pathParams: Record<string, string> = {}
      const queryParams: Record<string, any> = {}
      const bodyParams: Record<string, any> = {}
      const headerParams: Record<string, string> = {}

      for (const arg of tool.args) {
        const value = args[arg.name]
        if (value !== undefined) {
          switch (arg.position) {
            case 'path':
              pathParams[arg.name] = String(value)
              break
            case 'query':
              queryParams[arg.name] = value
              break
            case 'body':
              bodyParams[arg.name] = value
              break
            case 'header':
              headerParams[arg.name] = String(value)
              break
          }
        } else if (arg.required) {
          throw new Error(`Required parameter ${arg.name} is missing`)
        }
      }

      // Process path parameters
      let url = tool.requestTemplate.url
      for (const [paramName, paramValue] of Object.entries(pathParams)) {
        url = url.replace(
          `{${paramName}}`,
          encodeURIComponent(String(paramValue)),
        )
      }

      // Complete URL - check if URL is already a complete URL
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        // Ensure apiHost doesn't end with slash and url starts with slash
        const baseUrl = apiHost.endsWith('/') ? apiHost.slice(0, -1) : apiHost
        const pathUrl = url.startsWith('/') ? url : `/${url}`
        url = `${baseUrl}${pathUrl}`
      } else {
        logger.info(`Using complete URL: ${url}`)
      }

      // Add query parameters
      if (Object.keys(queryParams).length > 0) {
        const queryParts = []
        for (const [key, value] of Object.entries(queryParams)) {
          if (value !== undefined) {
            queryParts.push(
              `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
            )
          }
        }
        if (queryParts.length > 0) {
          url += `?${queryParts.join('&')}`
        }
      }

      logger.info(`Calling API: ${tool.requestTemplate.method} ${url}`)

      // Prepare request headers
      const requestHeaders: Record<string, string> = {
        ...headers,
        ...headerParams,
      }

      // Add Content-Type header
      if (
        ['POST', 'PUT', 'PATCH'].includes(tool.requestTemplate.method) &&
        Object.keys(bodyParams).length > 0
      ) {
        requestHeaders['Content-Type'] = 'application/json'
      }

      // Add headers defined in the tool
      if (tool.requestTemplate.headers) {
        for (const header of tool.requestTemplate.headers) {
          requestHeaders[header.key] = header.value
        }
      }

      // Request body
      const body =
        Object.keys(bodyParams).length > 0
          ? JSON.stringify(bodyParams)
          : undefined

      // Send API request
      try {
        const response = await fetch(url, {
          method: tool.requestTemplate.method,
          headers: requestHeaders,
          body,
        })

        // Handle response
        const contentType = response.headers.get('content-type') || ''
        let result: any

        if (contentType.includes('application/json')) {
          result = await response.json()
          logger.info(
            `API response status: ${response.status}, content type: application/json`,
          )
        } else {
          result = await response.text()
          logger.info(
            `API response status: ${response.status}, content type: ${contentType}`,
          )
        }

        // Build response content
        let resultText = ''

        // Add response prefix
        if (tool.responseTemplate?.prependBody) {
          resultText += tool.responseTemplate.prependBody
        }

        // Add original response
        resultText +=
          typeof result === 'string' ? result : JSON.stringify(result, null, 2)

        return {
          content: [
            {
              type: 'text',
              text: resultText,
            },
          ],
        }
      } catch (error) {
        logger.error(`API call failed:`, error)
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error.message}`,
            },
          ],
        }
      }
    },
  )

  // Register MCP tools
  for (const tool of tools) {
    logger.info(`Registering MCP tool: ${tool.name}`)

    // Create tool parameter schema
    const paramSchema: Record<string, any> = {}

    // Create corresponding schema for each tool parameter
    for (const arg of tool.args) {
      let schema

      switch (arg.type) {
        case 'integer':
          schema = arg.required ? z.number().int() : z.number().int().optional()
          break
        case 'boolean':
          schema = arg.required ? z.boolean() : z.boolean().optional()
          break
        case 'array':
          schema = arg.required ? z.array(z.any()) : z.array(z.any()).optional()
          break
        case 'object':
          schema = arg.required
            ? z.record(z.any())
            : z.record(z.any()).optional()
          break
        default: // string
          schema = arg.required ? z.string() : z.string().optional()
      }

      paramSchema[arg.name] = schema.describe(arg.description || arg.name)
    }

    // Register tool
    server.tool(tool.name, tool.description, paramSchema, async (params) => {
      try {
        // Categorize parameters
        const pathParams: Record<string, string> = {}
        const queryParams: Record<string, any> = {}
        const bodyParams: Record<string, any> = {}
        const headerParams: Record<string, string> = {}

        for (const arg of tool.args) {
          const value = params[arg.name]
          if (value !== undefined) {
            switch (arg.position) {
              case 'path':
                pathParams[arg.name] = String(value)
                break
              case 'query':
                queryParams[arg.name] = value
                break
              case 'body':
                bodyParams[arg.name] = value
                break
              case 'header':
                headerParams[arg.name] = String(value)
                break
            }
          } else if (arg.required) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Error: Required parameter ${arg.name} is missing`,
                },
              ],
            }
          }
        }

        // Process path parameters
        let url = tool.requestTemplate.url
        for (const [paramName, paramValue] of Object.entries(pathParams)) {
          url = url.replace(
            `{${paramName}}`,
            encodeURIComponent(String(paramValue)),
          )
        }

        // Complete URL - check if URL is already a complete URL
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
          // Ensure apiHost doesn't end with slash and url starts with slash
          const baseUrl = apiHost.endsWith('/') ? apiHost.slice(0, -1) : apiHost
          const pathUrl = url.startsWith('/') ? url : `/${url}`
          url = `${baseUrl}${pathUrl}`
        } else {
          logger.info(`Using complete URL: ${url}`)
        }

        // Add query parameters
        if (Object.keys(queryParams).length > 0) {
          const queryParts = []
          for (const [key, value] of Object.entries(queryParams)) {
            if (value !== undefined) {
              queryParts.push(
                `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
              )
            }
          }
          if (queryParts.length > 0) {
            url += `?${queryParts.join('&')}`
          }
        }

        logger.info(`Calling API: ${tool.requestTemplate.method} ${url}`)

        // Prepare request headers
        const requestHeaders: Record<string, string> = {
          ...headers,
          ...headerParams,
        }

        // Add Content-Type header
        if (
          ['POST', 'PUT', 'PATCH'].includes(tool.requestTemplate.method) &&
          Object.keys(bodyParams).length > 0
        ) {
          requestHeaders['Content-Type'] = 'application/json'
        }

        // Add headers defined in the tool
        if (tool.requestTemplate.headers) {
          for (const header of tool.requestTemplate.headers) {
            requestHeaders[header.key] = header.value
          }
        }

        // Request body
        const body =
          Object.keys(bodyParams).length > 0
            ? JSON.stringify(bodyParams)
            : undefined

        // Send API request
        const response = await fetch(url, {
          method: tool.requestTemplate.method,
          headers: requestHeaders,
          body,
        })

        // Handle response
        const contentType = response.headers.get('content-type') || ''
        let result: any

        if (contentType.includes('application/json')) {
          result = await response.json()
          logger.info(
            `API response status: ${response.status}, content type: application/json`,
          )
        } else {
          result = await response.text()
          logger.info(
            `API response status: ${response.status}, content type: ${contentType}`,
          )
        }

        // Build response content
        let resultText = ''

        // Add response prefix
        if (tool.responseTemplate?.prependBody) {
          resultText += tool.responseTemplate.prependBody
        }

        // Add original response
        resultText +=
          typeof result === 'string' ? result : JSON.stringify(result, null, 2)

        return {
          content: [
            {
              type: 'text' as const,
              text: resultText,
            },
          ],
        }
      } catch (error) {
        logger.error(`Tool call error (${tool.name}):`, error)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error.message}`,
            },
          ],
        }
      }
    })
  }

  // Create transport instance for the request
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })

  try {
    // Connect server and transport
    await server.connect(transport)
    logger.info('Server and transport connected successfully')

    // Handle request
    await transport.handleRequest(req, res, req.body)

    // Clean up resources when connection closes
    res.on('close', () => {
      transport.close()
      server.close()
      logger.info('Connection closed, resources cleaned up')
    })
  } catch (error) {
    logger.error('Error handling MCP request:', error)
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: null,
      })
    }
  }
}

export const apiToStreamableHttp = async (args: ApiToStreamableHttpArgs) => {
  const { logger } = args
  const app = express()

  logger.info(`Initializing API->StreamableHTTP gateway configuration:`)
  logger.info(`- API host: ${args.apiHost}`)
  logger.info(
    `- Config file: ${args.mcpTemplateFile} (supports OpenAPI and MCP template formats)`,
  )
  logger.info(`- Server port: ${args.port}`)
  logger.info(`- HTTP path: ${args.httpPath}`)

  // Enable CORS to ensure cross-domain requests work properly
  app.use(
    cors({
      origin: formatCorsOrigin(args.corsOrigin) || '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'x-session-id',
        'mcp-session-id',
        'Accept',
      ],
      exposedHeaders: ['x-session-id', 'mcp-session-id'],
      credentials: true,
      maxAge: 86400,
    }),
  )

  // Apply bodyParser middleware for non-MCP requests
  app.use((req, res, next) => {
    if (req.path !== args.httpPath) {
      bodyParser.json()(req, res, next)
    } else {
      next()
    }
  })

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
    })
  })

  // Status check endpoint
  app.get('/status', (req, res) => {
    res.status(200).json({
      status: 'ok',
      version: getVersion(),
      uptime: process.uptime(),
      timestamp: Date.now(),
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
      },
    })
  })

  // User-defined health check endpoints
  for (const ep of args.healthEndpoints || []) {
    app.get(ep, (req, res) => {
      res.status(200).send('ok')
    })
  }

  // Load MCP template
  const mcpTemplate = await loadMcpTemplate(args.mcpTemplateFile, logger)

  // Create MCP config file endpoint (for debugging)
  app.get('/mcp-config', (req, res) => {
    res.status(200).json(mcpTemplate)
  })

  // Handle MCP requests
  app.post(args.httpPath, async (req, res) => {
    await handleMcpRequest(
      req,
      res,
      mcpTemplate.tools,
      args.apiHost,
      args.headers,
      logger,
    )
  })

  // Handle GET requests - return method not allowed
  app.get(args.httpPath, async (_req, res) => {
    logger.info('Received GET MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  // Handle DELETE requests - return method not allowed
  app.delete(args.httpPath, async (_req, res) => {
    logger.info('Received DELETE MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  // Start server
  try {
    const server = app.listen(args.port, () => {
      logger.info(`Server started successfully:`)
      logger.info(`- Listening on port: ${args.port}`)
      logger.info(
        `- StreamableHTTP endpoint: http://localhost:${args.port}${args.httpPath}`,
      )
      logger.info(
        `- Health check endpoint: http://localhost:${args.port}/health`,
      )
      logger.info(
        `- Status check endpoint: http://localhost:${args.port}/status`,
      )
      logger.info(`- MCP config file: http://localhost:${args.port}/mcp-config`)
      logger.info(
        `- Supports automatic detection and conversion of OpenAPI specification files`,
      )
    })

    // Add error handling
    server.on('error', (error) => {
      logger.error(`Server error: ${error.message}`, error)
    })

    // Ensure resources are cleaned up when process exits
    const cleanup = () => {
      logger.info('Cleaning up resources...')
      server.close(() => {
        logger.info('Server closed')
      })
    }

    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)

    return {
      server,
    }
  } catch (error) {
    logger.error(`Server startup failed: ${error.message}`, error)
    throw error
  }
}
