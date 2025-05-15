#!/usr/bin/env node

/**
 * A simpler test script to verify authentication header passing through SuperGateway
 *
 * This script:
 * 1. Makes requests to the health endpoint with authentication headers
 * 2. Outputs colored success/failure indicators
 * 3. Provides instructions for verifying the headers in server logs
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

// Configuration
const CONFIG = {
  // Gateway endpoint
  gatewayUrl: 'http://localhost:8000',
  healthEndpoint: '/health',
  // Authentication headers to test
  authHeaders: {
    Authorization: 'Bearer test-auth-token-12345',
    bspa_access_token: 'test-bspa-token-54321',
    'X-Api-Key': 'test-api-key-abcde',
  },
}

/**
 * Main test function
 */
async function runTest() {
  console.log(chalk.blue('🧪 Starting simple authentication header test'))
  console.log(chalk.gray(`Gateway: ${CONFIG.gatewayUrl}`))

  // Log the auth headers we're testing with
  console.log(chalk.blue('Using test authentication headers:'))
  Object.entries(CONFIG.authHeaders).forEach(([key, value]) => {
    console.log(chalk.gray(`- ${key}: ${value}`))
  })

  try {
    // Make the initial request to test header passing
    console.log(
      chalk.blue(
        '\n🔄 Making request to health endpoint with authentication headers...',
      ),
    )

    const response = await fetch(
      `${CONFIG.gatewayUrl}${CONFIG.healthEndpoint}`,
      {
        method: 'GET',
        headers: CONFIG.authHeaders,
      },
    )

    // Get response status
    console.log(
      chalk.green(`✅ Response received (Status: ${response.status})`),
    )

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
    } catch (e) {
      console.log(chalk.yellow(`⚠️ Could not read response: ${e.message}`))
    }

    // Verification instructions
    console.log(chalk.blue('\n🔍 To verify header passing:'))
    console.log(chalk.yellow('  1. Check server logs for entries containing:'))
    console.log(
      chalk.gray(
        `     - "Request headers:" alongside your authentication headers`,
      ),
    )
    console.log(
      chalk.gray(
        `     - "Authorization", "bspa_access_token", or "X-Api-Key" values`,
      ),
    )
    console.log(
      chalk.yellow(
        '  2. If the headers appear in the logs, authentication header passing is working',
      ),
    )

    console.log(chalk.blue('\n🏁 Test completed!'))
    console.log(
      chalk.green(
        'If the logs show your auth headers were received, the test is successful.',
      ),
    )
  } catch (error) {
    console.error(chalk.red('❌ Error during test:'))
    console.error(chalk.red(error.message))
    console.error(error)
    process.exit(1)
  }
}

// Run the test
runTest()
