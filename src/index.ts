#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE
 *
 * Usage:
 *   npx -y supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder"
 */

import express from 'express'
import bodyParser from 'body-parser'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('port', {
      type: 'number',
      default: 8000,
      description: 'Port to run on (default: 8000)'
    })
    .option('stdio', {
      type: 'string',
      demandOption: true,
      description: 'Command that runs an MCP server over stdio'
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: 'Base URL for the server'
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: 'Path for the SSE connection endpoint (default: /sse)'
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: 'Path for the message broadcast endpoint (default: /message)'
    })
    .help()
    .parseSync()

  const PORT = argv.port
  const STDIO_CMD = argv.stdio
  const BASE_URL = argv.baseUrl
  const SSE_PATH = argv.ssePath
  const MESSAGE_PATH = argv.messagePath

  console.log('[supergateway] Starting...')
  console.log('[supergateway] Supergateway is supported by Superinterface - https://superinterface.ai')
  console.log(`[supergateway]  - port: ${PORT}`)
  console.log(`[supergateway]  - stdio: ${STDIO_CMD}`)

  if (BASE_URL) {
    console.log(`[supergateway]  - baseUrl: ${BASE_URL}`)
  }

  console.log(`[supergateway]  - ssePath: ${SSE_PATH}`)
  console.log(`[supergateway]  - messagePath: ${MESSAGE_PATH}`)

  const child: ChildProcessWithoutNullStreams = spawn(STDIO_CMD, { shell: true })

  child.on('exit', (code, signal) => {
    console.error(`[supergateway] Child process exited with code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  const server = new Server(
    { name: 'supergateway', version: '1.0.0' },
    { capabilities: {} }
  )

  let sseTransport: SSEServerTransport | undefined

  const app = express()

  app.use((req, res, next) => {
    if (req.path === MESSAGE_PATH) {
      return next()
    }

    return bodyParser.json()(req, res, next)
  })

  app.get(SSE_PATH, async (req, res) => {
    console.log(`[supergateway] New SSE connection on ${SSE_PATH} from ${req.ip}`)

    sseTransport = new SSEServerTransport(`${BASE_URL}${MESSAGE_PATH}`, res)
    await server.connect(sseTransport)

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

  app.post(MESSAGE_PATH, async (req, res) => {
    if (sseTransport?.handlePostMessage) {
      console.log(`[supergateway] POST ${MESSAGE_PATH} -> SSE transport`)
      await sseTransport.handlePostMessage(req, res)
    } else {
      res.status(503).send('No SSE connection active')
    }
  })

  let buffer = ''

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')

    let lines = buffer.split(/\r?\n/)

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

  app.listen(PORT, () => {
    console.log(`[supergateway] Listening on port ${PORT}`)
    console.log(`  SSE endpoint:   http://localhost:${PORT}${SSE_PATH}`)
    console.log(`  POST messages:  http://localhost:${PORT}${MESSAGE_PATH}`)
  })
}

main().catch(err => {
  console.error('[supergateway] Fatal error:', err)
  process.exit(1)
})
