#!/usr/bin/env node

// 调试SSE会话管理测试脚本
// 用法: node test/test-client-session.js [--port 8030] [--ssePath /sse] [--messagePath /message]

import * as http from 'http'
import * as EventSource from 'eventsource'
import { randomUUID } from 'crypto'

// 解析命令行参数
const args = process.argv.slice(2)
const PORT = args.includes('--port') ? args[args.indexOf('--port') + 1] : '8030'
const SSE_PATH = args.includes('--ssePath')
  ? args[args.indexOf('--ssePath') + 1]
  : '/sse'
const MESSAGE_PATH = args.includes('--messagePath')
  ? args[args.indexOf('--messagePath') + 1]
  : '/message'
const API_URL = `http://localhost:${PORT}`

// 生成独特的会话ID用于测试
const CLIENT_SESSION_ID = randomUUID()
console.log(`\n=== SSE会话管理调试 ===`)
console.log(`客户端生成的会话ID: ${CLIENT_SESSION_ID}`)
console.log(`服务器地址: ${API_URL}`)
console.log(`SSE路径: ${SSE_PATH}`)
console.log(`消息路径: ${MESSAGE_PATH}\n`)

// 我们将在这里存储服务器返回的会话ID
let SERVER_SESSION_ID = null

// 测试SSE连接
console.log(`1. 创建SSE连接并检查返回的会话ID...`)

// 设置自定义请求头
const headers = {
  Accept: 'text/event-stream',
  'Cache-Control': 'no-cache',
  'mcp-session-id': CLIENT_SESSION_ID,
}

// 创建SSE连接，捕获实际使用的URL
let finalUrl = `${API_URL}${SSE_PATH}`
console.log(`连接到URL: ${finalUrl}`)

// 使用自定义请求以便我们可以获取响应头
const req = http.request(
  finalUrl,
  {
    method: 'GET',
    headers: headers,
  },
  (res) => {
    console.log(`SSE连接状态: ${res.statusCode}`)
    console.log(`SSE响应头: ${JSON.stringify(res.headers, null, 2)}`)

    // 从响应头中获取服务器分配的会话ID
    SERVER_SESSION_ID =
      res.headers['mcp-session-id'] || res.headers['x-session-id']

    if (SERVER_SESSION_ID) {
      console.log(`服务器分配的会话ID: ${SERVER_SESSION_ID}`)
    } else {
      console.log(
        `警告: 服务器未返回会话ID，将使用客户端ID: ${CLIENT_SESSION_ID}`,
      )
      SERVER_SESSION_ID = CLIENT_SESSION_ID
    }

    // 创建SSE连接
    const es = new EventSource.EventSource(finalUrl, {
      headers: {
        ...headers,
        'mcp-session-id': SERVER_SESSION_ID, // 使用服务器分配的会话ID
        'x-session-id': SERVER_SESSION_ID, // 使用服务器分配的会话ID
      },
    })

    // 设置事件处理器
    es.onopen = () => {
      console.log(`SSE连接已打开`)

      // 发送startup请求以初始化会话
      console.log(`\n2. 发送startup请求...`)
      sendRequest('startup', {})
    }

    es.onerror = (err) => {
      console.error(`SSE连接错误:`, err)
      es.close()
      process.exit(1)
    }

    es.onmessage = (event) => {
      try {
        console.log(`\n收到SSE消息:`, event.data)
        const data = JSON.parse(event.data)

        // 如果是startup响应，获取工具列表
        if (data.id && data.id.includes('init')) {
          console.log(`\n3. 发送tools/list请求...`)
          sendRequest('tools/list', {})
        }

        // 如果是工具列表响应，尝试调用一个工具
        if (data.id && data.id.includes('list')) {
          console.log(
            `收到工具列表，包含 ${data.result?.tools?.length || 0} 个工具`,
          )
          if (data.result?.tools?.length > 0) {
            console.log(`\n4. 尝试工具调用 ${data.result.tools[0].name}...`)
            const tool = data.result.tools[0]
            const args = {}
            // 填充必要的参数
            if (tool.parameters) {
              Object.entries(tool.parameters).forEach(([key, param]) => {
                if (param.required) {
                  // 创建一个基本值，取决于参数类型
                  if (param.type === 'string') args[key] = `测试值${key}`
                  else if (param.type === 'number' || param.type === 'integer')
                    args[key] = 123
                  else if (param.type === 'boolean') args[key] = true
                  else if (param.type === 'array') args[key] = ['测试']
                  else if (param.type === 'object') args[key] = { key: '测试' }
                  else args[key] = '测试默认值'
                }
              })
            }
            sendRequest('tools/call', { name: tool.name, arguments: args })
          } else {
            console.log(`\n没有可用的工具，测试完成`)
            setTimeout(() => {
              es.close()
              process.exit(0)
            }, 1000)
          }
        }
      } catch (error) {
        console.error(`解析SSE消息错误:`, error)
      }
    }

    // 处理程序退出
    process.on('SIGINT', () => {
      console.log('程序中断，关闭连接')
      es.close()
      process.exit(0)
    })

    console.log('SSE连接已创建，等待事件...')
  },
)

req.on('error', (error) => {
  console.error(`连接错误: ${error.message}`)
  process.exit(1)
})

req.end()

// 通过HTTP POST发送请求到消息端点
function sendRequest(method, params) {
  // 确保SERVER_SESSION_ID已获取
  if (!SERVER_SESSION_ID) {
    console.error('错误: 尚未获取服务器会话ID，无法发送请求')
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
    path: `${MESSAGE_PATH}?sessionId=${SERVER_SESSION_ID}`, // 使用服务器分配的会话ID
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestData),
      'mcp-session-id': SERVER_SESSION_ID, // 使用服务器分配的会话ID
      'x-session-id': SERVER_SESSION_ID, // 使用服务器分配的会话ID
    },
  }

  console.log(`发送请求: ${method} (ID: ${requestId})`)
  console.log(`请求会话ID: ${SERVER_SESSION_ID}`)

  const req = http.request(options, (res) => {
    console.log(`请求状态: ${res.statusCode}`)
    console.log(`响应头: ${JSON.stringify(res.headers)}`)

    let responseData = ''
    res.on('data', (chunk) => {
      responseData += chunk
    })

    res.on('end', () => {
      if (responseData) {
        console.log(`响应内容: ${responseData}`)
      }
    })
  })

  req.on('error', (error) => {
    console.error(`请求错误: ${error.message}`)
  })

  req.write(requestData)
  req.end()
}

console.log('测试运行中，按Ctrl+C中断...')
