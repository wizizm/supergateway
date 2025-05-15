#!/usr/bin/env node

/**
 * Test script to check if the server is running and what endpoints are available
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

const serverUrl = 'http://localhost:8001'
const endpoints = ['/', '/mcp', '/health', '/status', '/mcp-config']

async function testEndpoint(endpoint) {
  const url = `${serverUrl}${endpoint}`
  console.log(chalk.blue(`Testing endpoint: ${url}`))

  try {
    // Try GET first
    const getResponse = await fetch(url)
    console.log(chalk.green(`✅ GET ${url}: Status ${getResponse.status}`))

    try {
      const text = await getResponse.text()
      if (text.length < 1000) {
        console.log(chalk.gray(`Response: ${text.substring(0, 500)}`))
      } else {
        console.log(chalk.gray(`Response length: ${text.length} characters`))
      }
    } catch (e) {
      console.log(chalk.yellow(`⚠️ Could not read response text: ${e.message}`))
    }
  } catch (error) {
    console.log(chalk.red(`❌ GET ${url} failed: ${error.message}`))
  }
}

async function main() {
  console.log(chalk.blue('🔍 Testing server endpoints'))
  console.log(chalk.blue(`Server: ${serverUrl}`))

  for (const endpoint of endpoints) {
    await testEndpoint(endpoint)
    console.log('') // Blank line for separation
  }

  console.log(chalk.blue('🏁 Endpoint tests completed'))
}

main().catch((error) => {
  console.error(chalk.red('❌ Test failed:'))
  console.error(error)
  process.exit(1)
})
