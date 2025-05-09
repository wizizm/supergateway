#!/usr/bin/env node

import path from 'path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import {
  ConverterOptions,
  OutputFormat,
  TemplatePatchOptions,
  convertOpenApiToMcpServerFile,
} from '../lib/openapi-to-mcpserver/index.js'
import { Logger } from '../types.js'

// Simple console logger
const logger: Logger = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  debug: (...args) => console.debug('[DEBUG]', ...args),
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('openapi-to-mcp')
    .usage('Usage: $0 [options]')
    .options({
      input: {
        alias: 'i',
        describe: 'Path to the OpenAPI specification file (JSON or YAML)',
        type: 'string',
        demandOption: true,
      },
      output: {
        alias: 'o',
        describe: 'Path to the output MCP configuration file (YAML)',
        type: 'string',
        demandOption: true,
      },
      'server-name': {
        alias: 'n',
        describe: 'Name of the MCP server',
        type: 'string',
        default: 'openapi-server',
      },
      'tool-prefix': {
        alias: 'p',
        describe: 'Prefix for tool names',
        type: 'string',
        default: '',
      },
      format: {
        alias: 'f',
        describe: 'Output format (yaml or json)',
        type: 'string',
        choices: ['yaml', 'json'],
        default: 'yaml',
      },
      validate: {
        alias: 'v',
        describe: 'Validate the OpenAPI specification',
        type: 'boolean',
        default: false,
      },
      template: {
        alias: 't',
        describe: 'Path to a template file to patch the output',
        type: 'string',
        default: '',
      },
    })
    .example(
      '$0 --input petstore.json --output petstore-mcp.yaml',
      'Convert petstore.json to MCP server configuration',
    )
    .example(
      '$0 --input petstore.json --output petstore-mcp.json --format json',
      'Output as JSON',
    )
    .example(
      '$0 --input petstore.json --output petstore-mcp.yaml --server-name petstore',
      'Set server name',
    )
    .example(
      '$0 --input petstore.json --output petstore-mcp.yaml --template template.yaml',
      'Apply a template',
    )
    .wrap(null)
    .help()
    .alias('h', 'help')
    .version()
    .alias('V', 'version')
    .parseSync()

  // Create converter options
  const converterOptions: ConverterOptions = {
    input: path.resolve(argv.input),
    serverName: argv['server-name'],
    toolPrefix: argv['tool-prefix'],
    validate: argv.validate,
  }

  // Create template options
  const templateOptions: TemplatePatchOptions = {
    templatePath: argv.template ? path.resolve(argv.template) : undefined,
  }

  // Determine output format
  const outputFormat = argv.format as OutputFormat

  try {
    // Convert OpenAPI to MCP server configuration
    await convertOpenApiToMcpServerFile(
      converterOptions,
      path.resolve(argv.output),
      templateOptions,
      logger,
    )

    logger.info(
      `OpenAPI specification converted successfully to ${argv.output}`,
    )
    process.exit(0)
  } catch (error) {
    logger.error(
      `Conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }
}

main().catch((error) => {
  logger.error(
    `Unhandled error: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
})
