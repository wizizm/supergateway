#!/usr/bin/env node

// SSE session management debugging script
// Usage: node test/test-client-session.js [--port 8030] [--ssePath /sse] [--messagePath /message]

import * as http from 'http'
import * as EventSource from 'eventsource'
import { randomUUID } from 'crypto'

// Parse command line arguments
const args = process.argv.slice(2)
const PORT = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8030'
const SSE_PATH = args.includes('--ssePath')
  ? args[args.indexOf('--ssePath') + 1]
  : '/sse'
const MESSAGE_PATH = args.includes('--messagePath')
  ? args[args.indexOf('--messagePath') + 1]
  : '/message'
const API_URL = `http://localhost:${PORT}`

// Generate unique session ID for testing
const CLIENT_SESSION_ID = randomUUID()
console.log(`\n=== SSE Session Management Debug ===`)
console.log(`Client-generated session ID: ${CLIENT_SESSION_ID}`)
console.log(`Server address: ${API_URL}`)
console.log(`SSE path: ${SSE_PATH}`)
console.log(`Message path: ${MESSAGE_PATH}\n`)

// We'll store the server-returned session ID here
let SERVER_SESSION_ID = null

// Test SSE connection
console.log(`1. Creating SSE connection and checking returned session ID...`)

// Set up custom request headers
const headers = {
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  'mcp-session-id': CLIENT_SESSION_ID,
}

// Create SSE connection, capture the actual URL used
let finalUrl = `${API_URL}${SSE_PATH}`
console.log(`Connecting to URL: ${finalUrl}`)

// Use custom request so we can get response headers
const req = http.request(
  finalUrl,
  {
    method: 'GET',
    headers: headers,
  },
  (res) => {
    console.log(`SSE connection status: ${res.statusCode}`)
    console.log(`SSE response headers: ${JSON.stringify(res.headers, null, 2)}`)

    // Get server-assigned session ID from response headers
    SERVER_SESSION_ID =
      res.headers['mcp-session-id'] || res.headers['x-session-id']

    if (SERVER_SESSION_ID) {
      console.log(`Server-assigned session ID: ${SERVER_SESSION_ID}`)
    } else {
      console.log(
        `Warning: Server did not return session ID, will use client ID: ${CLIENT_SESSION_ID}`,
      )
      SERVER_SESSION_ID = CLIENT_SESSION_ID
    }

    // Create SSE connection
    const es = new EventSource.EventSource(finalUrl, {
      headers: {
        ...headers,
        'mcp-session-id': SERVER_SESSION_ID, // Use server-assigned session ID
        'x-session-id': SERVER_SESSION_ID, // Use server-assigned session ID
      },
    })

    // Set up event handlers
    es.onopen = () => {
      console.log(`SSE connection opened`)

      // Send startup request to initialize session
      console.log(`\n2. Sending startup request...`)
      sendRequest('startup', {})
    }

    es.onerror = (err) => {
      console.error(`SSE connection error:`, err)
      es.close()
      process.exit(1)
    }

    es.onmessage = (event) => {
      try {
        console.log(`\nReceived SSE message:`, event.data)
        const data = JSON.parse(event.data)

        // If it's a startup response, get the tool list
        if (data.id && data.id.includes('init')) {
          console.log(`\n3. Sending tools/list request...`)
          sendRequest('tools/list', {})
        }

        // If it's a tool list response, try to call a tool
        if (data.id && data.id.includes('list')) {
          console.log(
            `Received tool list, containing ${data.result?.tools?.length || 0} tools`,
          )
          if (data.result?.tools?.length > 0) {
            console.log(
              `\n4. Attempting tool call ${data.result.tools[0].name}...`,
            )
            const tool = data.result.tools[0]
            const args = {}
            // Fill necessary parameters
            if (tool.parameters) {
              Object.entries(tool.parameters).forEach(([key, param]) => {
                if (param.required) {
                  // Create a basic value, depending on parameter type
                  if (param.type === 'string') args[key] = `TestValue${key}`
                  else if (param.type === 'number' || param.type === 'integer')
                    args[key] = 123
                  else if (param.type === 'boolean') args[key] = true
                  else if (param.type === 'array') args[key] = ['Test']
                  else if (param.type === 'object') args[key] = { key: 'Test' }
                  else args[key] = 'TestDefaultValue'
                }
              })
            }
            sendRequest('tools/call', { name: tool.name, arguments: args })
          } else {
            console.log(`\nNo tools available, test complete`)
            setTimeout(() => {
              es.close()
              process.exit(0)
            }, 1000)
          }
        }
      } catch (error) {
        console.error(`Error parsing SSE message:`, error)
      }
    }

    // Handle program exit
    process.on('SIGINT', () => {
      console.log('Program interrupted, closing connection')
      es.close()
      process.exit(0)
    })

    console.log('SSE connection created, waiting for events...')
  },
)

req.on('error', (error) => {
  console.error(`Connection error: ${error.message}`)
  process.exit(1)
})

req.end()

// Send request to message endpoint via HTTP POST
function sendRequest(method, params) {
  // Make sure SERVER_SESSION_ID has been obtained
  if (!SERVER_SESSION_ID) {
    console.error(
      'Error: Server session ID not yet obtained, cannot send request',
    )
    return
  }

  const requestId = `${method.replace('/', '-')}-${Date.now()}`
  const requestData = JSON.stringify({
    jsonrpc: '2.0',
    method: method,
    params: params,
    id: requestId,
  })

  const options = {
    hostname: 'localhost',
    port: PORT,
    path: `${MESSAGE_PATH}?sessionId=${SERVER_SESSION_ID}`, // Use server-assigned session ID
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestData),
      'mcp-session-id': SERVER_SESSION_ID, // Use server-assigned session ID
      'x-session-id': SERVER_SESSION_ID, // Use server-assigned session ID
    },
  }

  console.log(`Sending request: ${method} (ID: ${requestId})`)
  console.log(`Request session ID: ${SERVER_SESSION_ID}`)

  const req = http.request(options, (res) => {
    console.log(`Request status: ${res.statusCode}`)
    console.log(`Response headers: ${JSON.stringify(res.headers)}`)

    let responseData = ''
    res.on('data', (chunk) => {
      responseData += chunk
    })

    res.on('end', () => {
      if (responseData) {
        console.log(`Response content: ${responseData}`)
      }
    })
  })

  req.on('error', (error) => {
    console.error(`Request error: ${error.message}`)
  })

  req.write(requestData)
  req.end()
}

console.log('Test running, press Ctrl+C to interrupt...')
