#!/usr/bin/env node
/**
 * 测试 Streamable HTTP 功能的客户端
 *
 * 基于 Vercel AI 的 MCP 示例实现
 *
 * 用法:
 *   node streamable-http-client.js http://localhost:8000/mcp
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import fs from 'fs'

// 默认连接地址
const DEFAULT_URL = 'http://localhost:8000/mcp'

async function main() {
  // 获取命令行参数
  const url = process.argv[2] || DEFAULT_URL

  console.log(`connecting to ${url}`)

  try {
    // 创建客户端
    const client = new Client({
      name: 'test-client',
      version: '1.0.0',
    })

    // 创建 Streamable HTTP 传输并连接
    const transport = new StreamableHTTPClientTransport(new URL(url))

    // 连接到服务器
    await client.connect(transport)
    console.log('Connected using Streamable HTTP transport')

    // 请求服务器的能力
    const capabilities = await client.getCapabilities()
    console.log('Server Capabilities:', JSON.stringify(capabilities, null, 2))

    // 如果服务器支持资源功能，列出资源
    if (capabilities.resources) {
      try {
        console.log('Listing resources...')
        const resources = await client.listResources()
        console.log('Resources:', JSON.stringify(resources, null, 2))

        // 如果有资源，读取第一个资源
        if (resources.resources && resources.resources.length > 0) {
          const firstResource = resources.resources[0]
          console.log(`Reading resource: ${firstResource.uri}`)
          const content = await client.readResource({ uri: firstResource.uri })
          console.log('Resource content:', content)
        }
      } catch (error) {
        console.error('Error accessing resources:', error)
      }
    }

    // 如果服务器支持工具功能，列出工具
    if (capabilities.tools) {
      try {
        console.log('Listing tools...')
        const tools = await client.listTools()
        console.log('Tools:', JSON.stringify(tools, null, 2))

        // 如果有工具，尝试调用第一个工具
        if (tools.tools && tools.tools.length > 0) {
          const firstTool = tools.tools[0]
          console.log(`Tool available: ${firstTool.name}`)

          // 注意：这里需要根据实际工具参数调整
          console.log(
            `(Not calling tool ${firstTool.name} automatically since we don't know the required arguments)`,
          )
        }
      } catch (error) {
        console.error('Error accessing tools:', error)
      }
    }

    // 如果服务器支持提示功能，列出提示
    if (capabilities.prompts) {
      try {
        console.log('Listing prompts...')
        const prompts = await client.listPrompts()
        console.log('Prompts:', JSON.stringify(prompts, null, 2))
      } catch (error) {
        console.error('Error accessing prompts:', error)
      }
    }

    console.log('Test completed successfully!')
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

main()
