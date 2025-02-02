#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE or SSE over stdio
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # sse -> stdio (local server with fallback to SSE)
 *   npx -y supergateway --sse "https://some-url"
 */

import express from 'express'
import bodyParser from 'body-parser'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

async function stdioToSse(
  stdioCmd: string,
  port: number,
  baseUrl: string,
  ssePath: string,
  messagePath: string
) {
  console.log('[supergateway] Mode: stdio to SSE')
  console.log(`[supergateway]  - stdio command: ${stdioCmd}`)
  console.log(`[supergateway]  - port: ${port}`)
  console.log(`[supergateway]  - baseUrl: ${baseUrl}`)
  console.log(`[supergateway]  - ssePath: ${ssePath}`)
  console.log(`[supergateway]  - messagePath: ${messagePath}`)

  // Spawn the child process that runs an MCP server over stdio
  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })

  child.on('exit', (code, signal) => {
    console.error(`[supergateway] Child process exited with code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  // Create an MCP server that will broadcast over SSE
  const server = new Server({ name: 'supergateway', version: '1.0.0' }, { capabilities: {} })

  // We'll keep a reference to the SSE transport once a client connects
  let sseTransport: SSEServerTransport | undefined

  // Set up an Express server to handle SSE connections + POST messages
  const app = express()

  // We only parse JSON on endpoints that aren't the /message broadcast
  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  // SSE endpoint for clients to subscribe
  app.get(ssePath, async (req, res) => {
    console.log(`[supergateway] New SSE connection on ${ssePath} from ${req.ip}`)
    sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    await server.connect(sseTransport)

    // When SSE receives a message, forward to child’s stdin
    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
      console.log('[supergateway] SSE -> Child:', line)
      child.stdin.write(line + '\n')
    }

    sseTransport.onclose = () => {
      console.log('[supergateway] SSE connection closed.')
    }

    sseTransport.onerror = err => {
      console.error('[supergateway] SSE transport error:', err)
    }
  })

  // POST endpoint for SSE connections to get data from the server
  app.post(messagePath, async (req, res) => {
    if (sseTransport?.handlePostMessage) {
      console.log(`[supergateway] POST ${messagePath} -> SSE transport`)
      await sseTransport.handlePostMessage(req, res)
    } else {
      res.status(503).send('No SSE connection active')
    }
  })

  // Start listening
  app.listen(port, () => {
    console.log(`[supergateway] Listening on port ${port}`)
    console.log(`  SSE endpoint:   http://localhost:${port}${ssePath}`)
    console.log(`  POST messages:  http://localhost:${port}${messagePath}`)
  })

  // Child -> SSE bridging
  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const jsonMsg = JSON.parse(line)
        console.log('[supergateway] Child -> SSE:', jsonMsg)
        sseTransport?.send(jsonMsg)
      } catch {
        console.error('[supergateway] Child produced non-JSON line:', line)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    console.log('[supergateway] [child stderr]', text)
  })
}

async function sseToStdio(sseUrl: string) {
  // Use process.stderr for logs to avoid interfering with stdio communication
  const log = (...args: any[]) => console.error('[supergateway]', ...args)

  log('Mode: SSE to stdio')
  log(`SSE URL: ${sseUrl}`)
  log('Connecting to SSE...')

  const sseTransport = new SSEClientTransport(new URL(sseUrl))
  const sseClient = new Client(
    { name: 'supergateway', version: '1.0.0' },
    { capabilities: {} }
  )

  sseTransport.onerror = err => {
    log('SSE client transport error:', err)
  }

  sseTransport.onclose = () => {
    log('SSE connection closed.')
    process.exit(1)
  }

  await sseClient.connect(sseTransport)
  log('SSE is connected.')

  const stdioServer = new Server(
    sseClient.getServerVersion() ?? { name: 'supergateway', version: '1.0.0' },
    { capabilities: sseClient.getServerCapabilities() }
  )

  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  stdioServer.transport!.onmessage = async (message: JSONRPCMessage) => {
    const isRequest = ('method' in message) && ('id' in message);

    if (isRequest) {
      log('Forwarding stdio request to SSE:', message);
      try {
        const req = message as JSONRPCRequest;
        const result = await sseClient.request(req, z.any())
        log('Received result from SSE:', result)

        let wrappedResponse: JSONRPCMessage;

        if (result && typeof result === 'object' && 'error' in result) {
          // Reconstruct a proper JSON‑RPC error envelope.
          const remoteError = result.error as { code: number; message: string; data?: any };
          wrappedResponse = {
            jsonrpc: '2.0',
            id: req.id,
            error: {
              code: remoteError.code,
              message: remoteError.message,
              data: remoteError.data
            }
          };
        } else {
          wrappedResponse = {
            jsonrpc: '2.0',
            id: req.id,
            result,
          }
        }
        log('Wrapped response:', wrappedResponse)
        process.stdout.write(JSON.stringify(wrappedResponse) + '\n')
      } catch (err) {
        log('Error forwarding request:', err)

        const errorResponse = {
          jsonrpc: '2.0',
          id: (message as JSONRPCRequest).id,
          error: {
            code: -32000,
            message: 'Internal error',
            data: err instanceof Error ? err.message : String(err)
          }
        }

        process.stdout.write(JSON.stringify(errorResponse) + '\n')
      }
    } else {
      log('Forwarding SSE message to stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
    }
  }

  log('Stdio server is now listening')
}

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('port', {
      type: 'number',
      default: 8000,
      description: 'Port to run on (default: 8000) - used only for stdio->SSE mode'
    })
    .option('stdio', {
      type: 'string',
      description: 'Command that runs an MCP server over stdio (stdio->SSE mode)'
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL (sse->stdio mode)'
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: 'Base URL for SSE clients (only for stdio->SSE mode)'
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: 'Path for SSE subscriptions (only for stdio->SSE mode)'
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: 'Path for SSE messages (only for stdio->SSE mode)'
    })
    .help()
    .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)

  if (hasStdio && hasSse) {
    console.error('[supergateway] Error: Specify only one of --stdio or --sse, not both.')
    process.exit(1)
  } else if (!hasStdio && !hasSse) {
    console.error('[supergateway] Error: You must specify one of --stdio or --sse.')
    process.exit(1)
  }

  if (hasStdio) {
    await stdioToSse(
      argv.stdio!,
      argv.port,
      argv.baseUrl,
      argv.ssePath,
      argv.messagePath
    )
  } else {
    await sseToStdio(argv.sse!)
  }
}

main().catch(err => {
  console.error('[supergateway] Fatal error:', err)
  process.exit(1)
})
