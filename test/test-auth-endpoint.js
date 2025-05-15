#!/usr/bin/env node

/**
 * Test script to verify authentication header passing through SuperGateway
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

async function main() {
  console.log(chalk.blue('Testing authentication header passing...'))

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
    // Create proper headers with content type and session ID
    const sessionId =
      'test-session-' + Math.random().toString(36).substring(2, 10)
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Session-ID': sessionId,
      ...authHeaders,
    }

    // First send a startup request to initialize the server
    console.log(
      chalk.blue('Step 1: Sending startup request to initialize server'),
    )
    const startupPayload = {
      jsonrpc: '2.0',
      method: 'startup',
      params: {},
      id: 'startup-' + Date.now().toString(),
    }

    const startupResponse = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(startupPayload),
    })

    console.log(
      chalk.green(`Startup response status: ${startupResponse.status}`),
    )

    // Log startup response
    try {
      const startupText = await startupResponse.text()
      console.log(
        chalk.gray(`Startup response: ${startupText.substring(0, 300)}`),
      )
    } catch (e) {
      console.log(chalk.yellow(`Could not read startup response: ${e.message}`))
    }

    // Wait a moment for server to initialize
    console.log(chalk.blue('Waiting 1 second for server to initialize...'))
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Now send the tools/list request
    console.log(chalk.blue('\nStep 2: Sending tools/list request'))
    const toolsPayload = {
      jsonrpc: '2.0',
      method: 'tools/list',
      id: 'tools-' + Date.now().toString(),
    }

    const toolsResponse = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(toolsPayload),
    })

    console.log(
      chalk.green(`Tools list response status: ${toolsResponse.status}`),
    )

    // Log response headers
    console.log(chalk.blue('Response headers:'))
    toolsResponse.headers.forEach((value, key) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // Try to read response
    try {
      const text = await toolsResponse.text()
      console.log(chalk.blue('Response:'))
      console.log(chalk.gray(text.substring(0, 1000)))

      if (
        text.includes('Authorization') ||
        text.includes('bspa_access_token') ||
        text.includes('X-Api-Key')
      ) {
        console.log(
          chalk.green('✅ Authentication headers detected in response'),
        )
      } else {
        console.log(
          chalk.yellow('⚠️ Authentication headers not found in response'),
        )
      }
    } catch (e) {
      console.log(chalk.yellow(`Could not read response: ${e.message}`))
    }
  } catch (error) {
    console.error(chalk.red('Error:'))
    console.error(chalk.red(error.message))
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(chalk.red('Unhandled error:'))
  console.error(error)
  process.exit(1)
})
