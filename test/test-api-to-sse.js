#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'

// Get current directory
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Create a simple logger
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args),
}

// Test file paths
const openApiPath = join(__dirname, 'openapi-sse-test.json')
const mcpTemplatePath = join(__dirname, 'mcp-template-sse-test.json')

// Create test OpenAPI file if it doesn't exist
if (!existsSync(openApiPath)) {
  logger.info('Creating test OpenAPI file...')
  const openApiContent = {
    openapi: '3.0.0',
    info: {
      title: 'Test API for SSE',
      version: '1.0.0',
      description: 'A test API for SSE functionality',
    },
    paths: {
      '/test': {
        get: {
          summary: 'Test endpoint',
          responses: {
            200: {
              description: 'Success',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      message: {
                        type: 'string',
                        description: 'A success message',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }
  writeFileSync(openApiPath, JSON.stringify(openApiContent, null, 2), 'utf-8')
  logger.info(`Created OpenAPI file: ${openApiPath}`)
}

// Create test MCP template file if it doesn't exist
if (!existsSync(mcpTemplatePath)) {
  logger.info('Creating test MCP template file...')
  const mcpTemplateContent = {
    server: {
      name: 'test-sse-server',
      version: '1.0.0',
    },
    tools: [
      {
        name: 'testTool',
        description: 'A test tool for SSE',
        args: [
          {
            name: 'param',
            description: 'A test parameter',
            type: 'string',
            required: false,
            position: 'query',
          },
        ],
        requestTemplate: {
          url: '/api/test',
          method: 'GET',
        },
        responseTemplate: {
          prependBody: '# Test SSE response\n\n',
        },
      },
    ],
  }
  writeFileSync(
    mcpTemplatePath,
    JSON.stringify(mcpTemplateContent, null, 2),
    'utf-8',
  )
  logger.info(`Created MCP template file: ${mcpTemplatePath}`)
}

// Test API to SSE functionality
logger.info('\nAPI to SSE functionality test script')
logger.info('\nTest files have been created:')
logger.info(`1. OpenAPI file: ${openApiPath}`)
logger.info(`2. MCP template file: ${mcpTemplatePath}`)

logger.info(
  '\nTo test the API to SSE functionality, run the following commands in separate terminals:',
)
logger.info('\nTerminal 1 - Start the server with OpenAPI file:')
logger.info(
  `node dist/index.js --api ${openApiPath} --apiHost https://example.com --outputTransport sse --port 9003 --ssePath /sse --messagePath /message`,
)

logger.info('\nTerminal 2 - Test the health endpoint:')
logger.info('curl http://localhost:9003/health')

logger.info('\nTerminal 3 - Test the MCP config endpoint:')
logger.info('curl http://localhost:9003/mcp-config')

logger.info('\nTerminal 4 - Test the SSE endpoint:')
logger.info('curl -N http://localhost:9003/sse')

logger.info('\nYou can also start the server with the MCP template file:')
logger.info(
  `node dist/index.js --api ${mcpTemplatePath} --apiHost https://example.com --outputTransport sse --port 9003 --ssePath /sse --messagePath /message`,
)

logger.info('\nManual testing instructions:')
logger.info('1. Start the server using one of the commands above')
logger.info('2. Verify that the server starts successfully')
logger.info('3. Test the health endpoint to confirm the server is running')
logger.info(
  '4. Test the MCP config endpoint to verify the MCP tools are loaded',
)
logger.info('5. Test the SSE endpoint to confirm SSE connections work')
logger.info(
  '6. The server should automatically detect whether you provided an OpenAPI document or MCP template',
)
