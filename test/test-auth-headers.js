#!/usr/bin/env node

/**
 * Test script for authentication header passing through the SuperGateway chain
 *
 * This script:
 * 1. Makes requests to the Streamable HTTP endpoint with authentication headers
 * 2. Verifies if those headers are properly passed to the SSE server
 * 3. Confirms whether the headers are then forwarded to API calls
 */

import fetch from 'node-fetch'
import { v4 as uuidv4 } from 'uuid'
import chalk from 'chalk'

// Configuration
const CONFIG = {
  // Gateway endpoint
  gatewayUrl: process.env.GATEWAY_URL || 'http://localhost:8000',
  httpPath: process.env.HTTP_PATH || '/mcp',
  // Authentication headers to test
  authHeaders: {
    Authorization: 'Bearer test-auth-token-' + uuidv4().substring(0, 8),
    bspa_access_token: 'test-bspa-token-' + uuidv4().substring(0, 8),
    'X-Api-Key': 'test-api-key-' + uuidv4().substring(0, 8),
  },
  // Test tool to call
  testTool: process.env.TEST_TOOL || 'debug',
  // Verbose output
  verbose: process.env.VERBOSE === 'true',
}

/**
 * Main test function
 */
async function runTests() {
  console.log(chalk.blue('🧪 Starting authentication header passing tests'))
  console.log(chalk.gray(`Gateway: ${CONFIG.gatewayUrl}${CONFIG.httpPath}`))

  // Generate a unique session ID for this test
  const sessionId = 'test-session-' + uuidv4()
  console.log(chalk.gray(`Session ID: ${sessionId}`))

  // Log the auth headers we're testing with
  console.log(chalk.blue('Using test authentication headers:'))
  Object.entries(CONFIG.authHeaders).forEach(([key, value]) => {
    // Mask the actual values for security in logs
    console.log(chalk.gray(`- ${key}: ${value.substring(0, 10)}...`))
  })

  try {
    // Make the initial request to test header passing
    console.log(
      chalk.blue('\n🔄 Making request with authentication headers...'),
    )

    const headers = {
      'Content-Type': 'application/json',
      'mcp-session-id': sessionId,
      ...CONFIG.authHeaders,
    }

    // Log full request details in verbose mode
    if (CONFIG.verbose) {
      console.log(chalk.gray('Request headers:'))
      Object.entries(headers).forEach(([key, value]) => {
        console.log(chalk.gray(`  ${key}: ${value}`))
      })
    }

    // Create tool call payload
    const payload = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: CONFIG.testTool,
        arguments: {
          message: 'Testing authentication header passing',
          testMode: true,
          data: {
            timestamp: new Date().toISOString(),
            requestInfo: {
              sessionId,
              headersUsed: Object.keys(CONFIG.authHeaders),
            },
          },
        },
      },
      id: Date.now(),
    }

    // Log payload in verbose mode
    if (CONFIG.verbose) {
      console.log(chalk.gray('Request payload:'))
      console.log(chalk.gray(JSON.stringify(payload, null, 2)))
    }

    // Make the actual request
    const response = await fetch(`${CONFIG.gatewayUrl}${CONFIG.httpPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    // Get response data
    const data = await response.json()

    // Log response status
    console.log(
      chalk.green(`✅ Response received (Status: ${response.status})`),
    )

    // Check if the response indicates success
    if (data && data.result && !data.error) {
      console.log(chalk.green('✅ Request successful!'))

      // Parse the response to see if our headers were properly passed
      // The debug tool will echo back the input data
      let content
      try {
        if (
          data.result.content &&
          data.result.content[0] &&
          data.result.content[0].text
        ) {
          content = JSON.parse(data.result.content[0].text)
        }
      } catch (e) {
        console.log(chalk.yellow('⚠️ Could not parse response content as JSON'))
      }

      // Log raw response in verbose mode
      if (CONFIG.verbose) {
        console.log(chalk.gray('Response data:'))
        console.log(chalk.gray(JSON.stringify(data, null, 2)))

        if (content) {
          console.log(chalk.gray('Parsed content:'))
          console.log(chalk.gray(JSON.stringify(content, null, 2)))
        }
      }

      // Verify if the headers were properly passed through the chain
      // This requires checking the server logs for confirmation
      console.log(chalk.blue('\n🔍 To verify header passing:'))
      console.log(
        chalk.yellow('  1. Check server logs for entries containing:'),
      )
      console.log(
        chalk.gray(`     - "Intercepting fetch request to SSE server"`),
      )
      console.log(
        chalk.gray(`     - "Added auth header Authorization to SSE request"`),
      )
      console.log(
        chalk.gray(`     - "Stored auth headers for session ${sessionId}"`),
      )
      console.log(
        chalk.yellow('  2. Confirm the SSE server received the headers:'),
      )
      console.log(
        chalk.gray(
          `     - Look for "Request headers" entries containing your auth headers`,
        ),
      )
      console.log(chalk.yellow('  3. Verify headers were passed to API calls:'))
      console.log(
        chalk.gray(`     - Check for "Adding session headers to tools/call"`),
      )
      console.log(
        chalk.gray(`     - "Embedded auth header ... into parameters"`),
      )

      console.log(chalk.blue('\n🏁 Test completed!'))
      console.log(
        chalk.green(
          'If the logs confirm header passing, the test is successful.',
        ),
      )
      console.log(
        chalk.green(
          'Make sure no "登录信息超时" (login timeout) errors appear in the response.',
        ),
      )
    } else {
      console.log(chalk.red('❌ Request failed!'))
      console.log(chalk.red('Error details:'))
      console.log(data.error || data)
      process.exit(1)
    }
  } catch (error) {
    console.error(chalk.red('❌ Error during test:'))
    console.error(chalk.red(error.message))
    console.error(error)
    process.exit(1)
  }
}

// Run the tests
runTests()
