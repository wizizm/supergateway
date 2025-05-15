#!/usr/bin/env node

/**
 * Direct test script to verify authentication header passing through SuperGateway
 * This script checks the health endpoint and logging directly
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

async function main() {
  console.log(chalk.blue('Testing direct authentication header passing...'))

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
    // First check health endpoint
    console.log(chalk.blue('\nChecking /health endpoint with auth headers'))

    const healthResponse = await fetch('http://localhost:8000/health', {
      method: 'GET',
      headers: authHeaders,
    })

    console.log(chalk.green(`Health response status: ${healthResponse.status}`))

    try {
      const healthText = await healthResponse.text()
      console.log(chalk.gray(`Health response: ${healthText}`))
    } catch (e) {
      console.log(chalk.yellow(`Could not read health response: ${e.message}`))
    }

    // Try /status endpoint
    console.log(chalk.blue('\nChecking /status endpoint with auth headers'))

    const statusResponse = await fetch('http://localhost:8000/status', {
      method: 'GET',
      headers: authHeaders,
    })

    console.log(chalk.green(`Status response status: ${statusResponse.status}`))

    try {
      const statusText = await statusResponse.text()
      console.log(chalk.gray(`Status response (truncated):`))
      console.log(chalk.gray(statusText.substring(0, 300) + '...'))
    } catch (e) {
      console.log(chalk.yellow(`Could not read status response: ${e.message}`))
    }

    // Try MCP config endpoint
    console.log(chalk.blue('\nChecking /mcp-config endpoint with auth headers'))

    const configResponse = await fetch('http://localhost:8000/mcp-config', {
      method: 'GET',
      headers: authHeaders,
    })

    console.log(
      chalk.green(`MCP config response status: ${configResponse.status}`),
    )

    try {
      const configText = await configResponse.text()
      console.log(chalk.gray(`MCP config response (truncated):`))
      console.log(chalk.gray(configText.substring(0, 300) + '...'))
    } catch (e) {
      console.log(
        chalk.yellow(`Could not read MCP config response: ${e.message}`),
      )
    }
  } catch (error) {
    console.error(chalk.red('Error:'))
    console.error(chalk.red(error.message))
    process.exit(1)
  }

  console.log(chalk.blue('\nTest completed!'))
  console.log(
    chalk.green(
      '✅ Check your server logs to see if the auth headers were received',
    ),
  )
  console.log(
    chalk.gray(
      'Look for lines containing "Request headers:" or "Auth headers:"',
    ),
  )
}

main().catch((error) => {
  console.error(chalk.red('Unhandled error:'))
  console.error(error)
  process.exit(1)
})
