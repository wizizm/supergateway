// Simple test client for the SSE server
const EventSource = require('eventsource')
const fetch = require('node-fetch')

// Configuration
const port = 8050
const baseUrl = `http://localhost:${port}`
const ssePath = '/sse'
const messagePath = '/message'
let sessionId = null

// Connect to SSE server
console.log(`Connecting to SSE endpoint: ${baseUrl}${ssePath}`)
const eventSource = new EventSource(`${baseUrl}${ssePath}`)

// Handle SSE events
eventSource.onopen = async () => {
  console.log('SSE connection established')

  // Save session ID from response headers if available
  try {
    // Make a test request to get session ID
    const response = await fetch(`${baseUrl}/health`)

    // Look for session ID in response headers
    const mcpSessionId =
      response.headers.get('mcp-session-id') ||
      response.headers.get('x-session-id')
    if (mcpSessionId) {
      sessionId = mcpSessionId
      console.log(`Retrieved session ID from server: ${sessionId}`)
    }

    // Send startup message
    await sendStartupRequest()

    // Get tool list
    await sendToolsListRequest()
  } catch (error) {
    console.error('Error during initialization:', error)
    eventSource.close()
    process.exit(1)
  }
}

eventSource.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data)
    console.log('Received SSE message:', JSON.stringify(data, null, 2))
  } catch (e) {
    console.log('Received non-JSON message:', event.data)
  }
}

eventSource.onerror = (error) => {
  console.error('SSE connection error:', error)
  eventSource.close()
  process.exit(1)
}

// Helper function to send a message to the server
async function sendMessage(method, params = {}, id = Date.now().toString()) {
  const query = sessionId ? `?sessionId=${sessionId}` : ''
  const headers = {
    'Content-Type': 'application/json',
  }

  // Add session ID to headers if available
  if (sessionId) {
    headers['mcp-session-id'] = sessionId
    headers['x-session-id'] = sessionId
  }

  console.log(`Sending ${method} request to ${baseUrl}${messagePath}${query}`)

  try {
    const response = await fetch(`${baseUrl}${messagePath}${query}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id,
      }),
    })

    // Check for session ID in response headers
    const responseMcpSessionId =
      response.headers.get('mcp-session-id') ||
      response.headers.get('x-session-id')
    if (responseMcpSessionId && responseMcpSessionId !== sessionId) {
      console.log(
        `Updating session ID from ${sessionId} to ${responseMcpSessionId}`,
      )
      sessionId = responseMcpSessionId
    }

    if (!response.ok) {
      console.error(`Error ${response.status}: ${response.statusText}`)
      const text = await response.text()
      console.error('Response body:', text)
      return null
    }

    // Check if response is JSON
    const contentType = response.headers.get('content-type')
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json()
      console.log('Response:', JSON.stringify(data, null, 2))
      return data
    } else {
      const text = await response.text()
      console.log('Text response:', text)
      return text
    }
  } catch (error) {
    console.error('Error sending message:', error)
    return null
  }
}

// Send startup request
async function sendStartupRequest() {
  console.log('Sending startup request...')
  return sendMessage('startup')
}

// Send tools/list request
async function sendToolsListRequest() {
  console.log('Requesting tool list...')
  return sendMessage('tools/list')
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('Closing SSE connection...')
  eventSource.close()
  process.exit(0)
})

// Keep process alive
console.log('Test client running. Press Ctrl+C to exit.')
