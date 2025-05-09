#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { spawnSync } from 'child_process'

// Get current directory
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Define paths
const openApiPath = join(__dirname, '..', 'openapi.json')
const outputPath = join(__dirname, '..', 'mcp-template-generated.json')
const templatePath = join(__dirname, 'template-example.yaml')

// Define a simple logger
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args),
}

// Create a simple template file if it doesn't exist
if (!existsSync(templatePath)) {
  const templateContent = `
server:
  config:
    apiKey: ""

tools:
  requestTemplate:
    headers:
      - key: Authorization
        value: "Bearer {{config.apiKey}}"
      - key: X-Test-Header
        value: "test-value"
`
  writeFileSync(templatePath, templateContent, 'utf-8')
  logger.info(`Created template file: ${templatePath}`)
}

// Check if OpenAPI file exists
if (!existsSync(openApiPath)) {
  logger.error(`OpenAPI file not found: ${openApiPath}`)
  process.exit(1)
}

// Run the CLI command
logger.info('Running openapi-to-mcp CLI command...')

// Build path to CLI script
const cliPath = join(__dirname, '..', 'dist', 'cmd', 'openapi-to-mcp.js')

const result = spawnSync(
  'node',
  [
    cliPath,
    '--input',
    openApiPath,
    '--output',
    outputPath,
    '--server-name',
    'test-server',
    '--format',
    'json',
    '--template',
    templatePath,
  ],
  {
    stdio: 'inherit',
  },
)

if (result.status !== 0) {
  logger.error(`CLI command failed with exit code: ${result.status}`)
  process.exit(1)
}

// Verify the output file
logger.info(`Verifying output file: ${outputPath}`)

if (!existsSync(outputPath)) {
  logger.error(`Output file not found: ${outputPath}`)
  process.exit(1)
}

try {
  const outputContent = readFileSync(outputPath, 'utf-8')
  const outputData = JSON.parse(outputContent)

  // Verify server name
  if (outputData.server.name !== 'test-server') {
    logger.error(`Server name doesn't match: ${outputData.server.name}`)
    process.exit(1)
  }

  // Verify tools array
  if (!Array.isArray(outputData.tools)) {
    logger.error('Tools is not an array')
    process.exit(1)
  }

  // Check if we have tools
  if (outputData.tools.length === 0) {
    logger.warn('No tools found in the generated output')
  } else {
    logger.info(
      `Found ${outputData.tools.length} tools in the generated output`,
    )

    // Check first tool
    const firstTool = outputData.tools[0]
    logger.info(`First tool: ${firstTool.name}`)

    // Check if template was applied
    const headers = firstTool.requestTemplate?.headers || []
    const authHeader = headers.find((h) => h.key === 'Authorization')

    if (authHeader) {
      logger.info(
        'Template was successfully applied (found Authorization header)',
      )
    } else {
      logger.warn(
        'Template might not have been applied (Authorization header not found)',
      )
    }
  }

  logger.info('Test completed successfully')
} catch (error) {
  logger.error(`Error verifying output: ${error.message}`)
  process.exit(1)
}

// Test direct API usage
logger.info('Testing direct API usage...')

try {
  // Import the library
  const { convertOpenApiToMcpServer } = await import(
    '../dist/lib/openapi-to-mcpserver/index.js'
  )

  // Convert OpenAPI to MCP server configuration
  const result = await convertOpenApiToMcpServer(
    { input: openApiPath, serverName: 'direct-api-test' },
    { templatePath },
    'json',
    logger,
  )

  // Simple validation
  if (!result || !result.includes('"name":"direct-api-test"')) {
    logger.error('Direct API test failed: unexpected output')
    process.exit(1)
  }

  logger.info('Direct API test successful')
} catch (error) {
  logger.error(`Direct API test failed: ${error.message}`)
  process.exit(1)
}

// Final success message
logger.info('All tests passed!')
