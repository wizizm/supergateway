#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE, convert between stdio, SSE, WS.
 *
 * Usage:
 *   # stdio→SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE→stdio
 *   npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
 *
 *   # stdio→WS
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /" --outputTransport ws
 *
 *   # stdio→Streamable HTTP
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /" --outputTransport streamable-http --httpPath /mcp
 *
 *   # SSE→Streamable HTTP
 *   npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" --outputTransport streamable-http --httpPath /mcp
 */

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Logger } from './types.js'
import { stdioToSse } from './gateways/stdioToSse.js'
import { sseToStdio } from './gateways/sseToStdio.js'
import { stdioToWs } from './gateways/stdioToWs.js'
import { stdioToStreamableHttp } from './gateways/stdioToStreamableHttp.js'
import { sseToStreamableHttp } from './gateways/sseToStreamableHttp.js'
import { headers } from './lib/headers.js'
import { corsOrigin } from './lib/corsOrigin.js'
import { apiToStreamableHttp } from './gateways/apiToStreamableHttp.js'
import { parseArgs } from './lib/parseArgs.js'

const log = (...args: any[]) => console.log('[supergateway]', ...args)
const logStderr = (...args: any[]) => console.error('[supergateway]', ...args)

const noneLogger: Logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
}

const getLogger = ({
  logLevel,
  outputTransport,
}: {
  logLevel: string
  outputTransport: string
}): Logger => {
  if (logLevel === 'none') {
    return noneLogger
  }

  if (outputTransport === 'stdio') {
    return {
      info: logStderr,
      error: logStderr,
      warn: logStderr,
      debug: logStderr,
    }
  }

  return {
    info: log,
    error: logStderr,
    warn: logStderr,
    debug: log,
  }
}

/**
 * 处理命令拆分，确保正确启动子进程
 */
function parseCommand(cmdString: string): { command: string; args: string[] } {
  const parts = cmdString.split(/\s+/).filter((part) => part.length > 0)
  return {
    command: parts[0],
    args: parts.slice(1),
  }
}

interface Args {
  stdio?: string
  sse?: string
  outputTransport?: string
  port?: number
  baseUrl?: string
  ssePath?: string
  messagePath?: string
  httpPath?: string
  logLevel?: 'info' | 'none'
  cors?: string[]
  healthEndpoint?: string[]
  header?: string[]
  oauth2Bearer?: string
  api?: string
  apiHost?: string
}

async function main() {
  const args = parseArgs<Args>({
    stdio: {
      type: String,
      description: 'Command to run an MCP server over Stdio',
    },
    sse: {
      type: String,
      description: 'SSE URL to connect to',
    },
    outputTransport: {
      type: String,
      choices: ['stdio', 'sse', 'ws', 'streamable-http'],
      default: () => {
        const argv = hideBin(process.argv)

        if (argv.includes('--stdio')) return 'sse'
        if (argv.includes('--sse')) return 'stdio'

        return undefined
      },
      description:
        'Transport for output. Default is "sse" when using --stdio and "stdio" when using --sse.',
    },
    port: {
      type: Number,
      default: 8000,
      description:
        '(stdio→SSE/WS/Streamable-HTTP, SSE→Streamable-HTTP) Port for output MCP server',
    },
    baseUrl: {
      type: String,
      default: '',
      description: '(stdio→SSE/Streamable-HTTP) Base URL for output MCP server',
    },
    ssePath: {
      type: String,
      default: '/sse',
      description: '(stdio→SSE) Path for SSE subscriptions',
    },
    messagePath: {
      type: String,
      default: '/message',
      description: '(stdio→SSE/WS) Path for messages',
    },
    httpPath: {
      type: String,
      default: '/mcp',
      description:
        '(stdio→Streamable-HTTP, SSE→Streamable-HTTP) Path for Streamable HTTP',
    },
    logLevel: {
      type: String,
      choices: ['info', 'none'] as const,
      default: 'info',
      description: 'Logging level',
    },
    cors: {
      type: Array,
      description:
        'Enable CORS. Use --cors with no values to allow all origins, or supply one or more allowed origins (e.g. --cors "http://example.com" or --cors "/example\\.com$/" for regex matching).',
    },
    healthEndpoint: {
      type: Array,
      default: [],
      description:
        'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz',
    },
    header: {
      type: Array,
      default: [],
      description:
        'Headers to be added to the request headers, e.g. --header "x-user-id: 123"',
    },
    oauth2Bearer: {
      type: String,
      description:
        'Authorization header to be added, e.g. --oauth2Bearer "some-access-token" adds "Authorization: Bearer some-access-token"',
    },
    api: {
      type: String,
      description: 'MCP模板文件路径（JSON或YAML格式）',
    },
    apiHost: {
      type: String,
      description: 'API 服务的基础 URL',
    },
  })

  const hasStdio = Boolean(args.stdio)
  const hasSse = Boolean(args.sse)
  const hasApi = Boolean(args.api)

  // 检查输入参数
  const inputCount = [hasStdio, hasSse, hasApi].filter(Boolean).length
  if (inputCount > 1) {
    logStderr('Error: 只能指定 --stdio、--sse 或 --api 中的一个参数')
    process.exit(1)
  }
  if (inputCount === 0) {
    logStderr('Error: 必须指定 --stdio、--sse 或 --api 参数之一')
    process.exit(1)
  }

  if (hasApi && !args.apiHost) {
    logStderr('Error: 使用 --api 时必须指定 --apiHost 参数')
    process.exit(1)
  }

  const logger = getLogger({
    logLevel: args.logLevel as string,
    outputTransport: args.outputTransport as string,
  })

  logger.info('Starting...')
  logger.info(
    'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai',
  )
  logger.info(`  - outputTransport: ${args.outputTransport}`)

  const argsWithDefaults = {
    ...args,
    cors: args.cors || [],
    header: args.header || [],
    healthEndpoint: args.healthEndpoint || [],
  }

  try {
    if (hasStdio) {
      if (args.outputTransport === 'sse') {
        await stdioToSse({
          stdioCmd: args.stdio!,
          port: args.port,
          baseUrl: args.baseUrl,
          ssePath: args.ssePath,
          messagePath: args.messagePath,
          logger,
          corsOrigin: corsOrigin({ argv: argsWithDefaults }),
          healthEndpoints: argsWithDefaults.healthEndpoint,
          headers: headers({
            argv: argsWithDefaults,
            logger,
          }),
        })
      } else if (args.outputTransport === 'ws') {
        await stdioToWs({
          stdioCmd: args.stdio!,
          port: args.port,
          messagePath: args.messagePath,
          logger,
          corsOrigin: corsOrigin({ argv: argsWithDefaults }),
          healthEndpoints: argsWithDefaults.healthEndpoint,
        })
      } else if (args.outputTransport === 'streamable-http') {
        await stdioToStreamableHttp({
          stdioCmd: args.stdio!,
          port: args.port,
          baseUrl: args.baseUrl,
          httpPath: args.httpPath,
          logger,
          corsOrigin: corsOrigin({ argv: argsWithDefaults }),
          healthEndpoints: argsWithDefaults.healthEndpoint,
          headers: headers({
            argv: argsWithDefaults,
            logger,
          }),
        })
      } else {
        logStderr(`Error: stdio→${args.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (hasSse) {
      if (args.outputTransport === 'stdio') {
        await sseToStdio({
          sseUrl: args.sse!,
          logger,
          headers: headers({
            argv: argsWithDefaults,
            logger,
          }),
        })
      } else if (args.outputTransport === 'streamable-http') {
        await sseToStreamableHttp({
          sseUrl: args.sse!,
          port: args.port,
          httpPath: args.httpPath,
          logger,
          corsOrigin: corsOrigin({ argv: argsWithDefaults }),
          healthEndpoints: argsWithDefaults.healthEndpoint,
          headers: headers({
            argv: argsWithDefaults,
            logger,
          }),
        })
      } else {
        logStderr(`Error: sse→${args.outputTransport} not supported`)
        process.exit(1)
      }
    } else if (args.api) {
      if (args.outputTransport !== 'streamable-http') {
        throw new Error('API 模式只支持 streamable-http 输出传输方式')
      }

      await apiToStreamableHttp({
        mcpTemplateFile: args.api,
        apiHost: args.apiHost!,
        port: args.port || 8000,
        httpPath: args.httpPath || '/mcp',
        logger,
        corsOrigin: corsOrigin({ argv: argsWithDefaults }),
        healthEndpoints: argsWithDefaults.healthEndpoint,
        headers: headers({
          argv: argsWithDefaults,
          logger,
        }),
      })
    } else {
      logStderr('Error: Invalid input transport')
      process.exit(1)
    }
  } catch (err) {
    logStderr('Fatal error:', err)
    process.exit(1)
  }
}

main()
