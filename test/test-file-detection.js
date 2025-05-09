#!/usr/bin/env node

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'

// Get current directory
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Define test files
const openApiPath = join(__dirname, 'openapi-test.json')
const mcpTemplatePath = join(__dirname, 'mcp-template-test.json')

// Create a simple logger
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args),
}

// Create test OpenAPI file
logger.info('Creating test OpenAPI file...')
const openApiContent = {
  openapi: '3.0.0',
  info: {
    title: 'Test API',
    version: '1.0.0',
    description: 'A test API for file detection',
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

// Create test MCP template file
logger.info('Creating test MCP template file...')
const mcpTemplateContent = {
  server: {
    name: 'test-server',
    version: '1.0.0',
  },
  tools: [
    {
      name: 'testTool',
      description: 'A test tool',
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
        prependBody: '# Test response\n\n',
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

// Test file detection
logger.info('\nTesting file detection...')

// 1. Start server with OpenAPI file (should detect and convert)
logger.info('\n1. Testing with OpenAPI file:')
logger.info(
  'Starting server process (this will terminate after a few seconds)...',
)
const openApiTest = spawnSync(
  'node',
  [
    join(__dirname, '..', 'dist', 'index.js'),
    '--api',
    openApiPath,
    '--apiHost',
    'https://example.com',
    '--outputTransport',
    'streamable-http',
    '--port',
    '9001',
    '--httpPath',
    '/mcp',
  ],
  {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5000, // 5 second timeout
  },
)

// Log the output from the server
if (openApiTest.stdout) {
  logger.info('Server output:')
  console.log(
    openApiTest.stdout
      .split('\n')
      .filter((line) => line.includes('检测到OpenAPI') || line.includes('转换'))
      .join('\n'),
  )
}

// 2. Start server with MCP template file (should detect and use directly)
logger.info('\n2. Testing with MCP template file:')
logger.info(
  'Starting server process (this will terminate after a few seconds)...',
)
const mcpTest = spawnSync(
  'node',
  [
    join(__dirname, '..', 'dist', 'index.js'),
    '--api',
    mcpTemplatePath,
    '--apiHost',
    'https://example.com',
    '--outputTransport',
    'streamable-http',
    '--port',
    '9002',
    '--httpPath',
    '/mcp',
  ],
  {
    stdio: 'pipe',
    encoding: 'utf-8',
    timeout: 5000, // 5 second timeout
  },
)

// Log the output from the server
if (mcpTest.stdout) {
  logger.info('Server output:')
  console.log(
    mcpTest.stdout
      .split('\n')
      .filter((line) => line.includes('检测到MCP') || line.includes('模板'))
      .join('\n'),
  )
}

logger.info('\nTest completed. Both files should have been detected correctly.')
logger.info(
  'You can review the logs above to verify the auto-detection functionality.',
)
