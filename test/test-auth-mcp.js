#!/usr/bin/env node

/**
 * Test script to verify authentication header passing through SuperGateway's MCP endpoint
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

async function main() {
  console.log(chalk.blue('Testing MCP endpoint with authentication headers...'))

  const authHeaders = {
    Authorization: 'Bearer test-auth-token-12345',
    bspa_access_token: 'test-bspa-token-54321',
    'X-Api-Key': 'test-api-key-abcde',
  }

  console.log(chalk.blue('Using headers:'))
  Object.entries(authHeaders).forEach(([key, value]) => {
    console.log(chalk.gray(`- ${key}: ${value}`))
  })

  try {
    // Create proper MCP request
    const sessionId =
      'test-session-' + Math.random().toString(36).substring(2, 10)
    console.log(chalk.blue(`Using session ID: ${sessionId}`))

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Session-ID': sessionId,
      ...authHeaders,
    }

    const payload = {
      jsonrpc: '2.0',
      method: 'startup',
      params: {},
      id: 'startup-' + Date.now().toString(),
    }

    console.log(chalk.blue('Making MCP startup request...'))

    // Make the request
    const response = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    })

    console.log(chalk.green(`Response status: ${response.status}`))

    // Log response headers
    console.log(chalk.blue('Response headers:'))
    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // Try to get response body
    try {
      const responseText = await response.text()
      console.log(chalk.blue('Response body:'))
      console.log(chalk.gray(responseText))

      try {
        const responseData = JSON.parse(responseText)
        if (responseData && responseData.result) {
          console.log(chalk.green('✅ Successful MCP response received'))
        } else if (responseData && responseData.error) {
          console.log(
            chalk.yellow(`⚠️ MCP error: ${responseData.error.message}`),
          )
        }
      } catch (parseError) {
        console.log(chalk.yellow('⚠️ Response is not valid JSON'))
      }
    } catch (e) {
      console.log(chalk.yellow(`⚠️ Could not read response: ${e.message}`))
    }

    console.log(chalk.blue('\n🔍 Check server logs for auth header handling:'))
    console.log(chalk.gray('Look for entries containing:'))
    console.log(chalk.gray('- "Request headers:" with your auth headers'))
    console.log(chalk.gray('- "Auth headers being stored" or similar'))
  } catch (error) {
    console.error(chalk.red('❌ Error during test:'))
    console.error(chalk.red(error.message))
    console.error(error)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(chalk.red('Unhandled error:'))
  console.error(error)
  process.exit(1)
})
