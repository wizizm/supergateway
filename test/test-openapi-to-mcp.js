#!/usr/bin/env node

/**
 * 测试OpenAPI到MCP的转换功能
 */

import fetch from 'node-fetch'

// 解析命令行参数
const args = process.argv.slice(2)
let serverPort = 8001
let apiHost = 'https://dsp.test.com.cn'
let verbose = false

// 处理命令行参数
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && i + 1 < args.length) {
    serverPort = parseInt(args[i + 1], 10)
    i++
  } else if (args[i] === '--apiHost' && i + 1 < args.length) {
    apiHost = args[i + 1]
    i++
  } else if (args[i] === '--verbose' || args[i] === '-v') {
    verbose = true
  }
}

// 配置
const SERVER_URL = `http://localhost:${serverPort}`
const MCP_ENDPOINT = `${SERVER_URL}/mcp`
const CONFIG_ENDPOINT = `${SERVER_URL}/mcp-config`

console.log(`使用以下配置:
- 服务器URL: ${SERVER_URL}
- MCP端点: ${MCP_ENDPOINT}
- API主机: ${apiHost}
- 详细模式: ${verbose ? '开启' : '关闭'}
`)

// 解析服务器发送的事件
function parseEventStream(text) {
  const events = []
  const lines = text.split('\n\n')

  for (const line of lines) {
    if (!line.trim()) continue

    const eventLines = line.split('\n')
    const event = {}

    for (const eventLine of eventLines) {
      const colonPosition = eventLine.indexOf(':')
      if (colonPosition === -1) continue

      const key = eventLine.substring(0, colonPosition).trim()
      const value = eventLine.substring(colonPosition + 1).trim()

      if (key === 'data') {
        try {
          event.data = JSON.parse(value)
        } catch (e) {
          event.data = value
        }
      } else {
        event[key] = value
      }
    }

    if (Object.keys(event).length > 0) {
      events.push(event)
    }
  }

  return events
}

// 分析API错误
function analyzeApiError(text) {
  if (text.includes('failed, reason:')) {
    console.log('\n检测到API请求失败:')
    const errorMatch = text.match(/request to ([^ ]+) failed, reason: (.+)/)
    if (errorMatch) {
      console.log('- 请求URL:', errorMatch[1])
      console.log('- 失败原因:', errorMatch[2])
      console.log('- 预期URL应以API主机开头:', apiHost)

      if (!errorMatch[1].startsWith(apiHost)) {
        console.log('\n问题诊断: API URL未使用提供的apiHost')
        console.log('- 请确保OpenAPI规范中的路径不包含完整URL')
        console.log('- 请检查apiToStreamableHttp.ts中的URL构建逻辑')
      }
    }
  }
}

async function main() {
  try {
    console.log('测试OpenAPI到MCP服务转换功能')
    console.log('==========================================')

    // 第1步: 测试健康检查端点
    console.log('测试健康检查端点...')
    const healthResponse = await fetch(`${SERVER_URL}/health`)
    const health = await healthResponse.json()
    console.log('健康检查响应:', JSON.stringify(health, null, 2))
    console.log(
      '健康检查状态:',
      healthResponse.status === 200 ? '通过' : '失败',
    )
    console.log('------------------------------------------')

    // 第2步: 测试MCP配置端点
    console.log('测试MCP配置端点...')
    const configResponse = await fetch(CONFIG_ENDPOINT)
    const config = await configResponse.json()
    console.log(`发现 ${config.tools?.length || 0} 个MCP工具`)

    if (!config.tools?.length) {
      console.error('错误: 未发现MCP工具!')
      process.exit(1)
    }

    // 获取第一个工具以进行测试
    const tool = config.tools[0]
    console.log('将测试工具:', tool.name)
    console.log('工具描述:', tool.description)
    console.log('参数数量:', tool.args?.length || 0)

    if (verbose) {
      console.log('\n工具详情:')
      console.log('- 工具名称:', tool.name)
      console.log('- 工具描述:', tool.description)
      console.log('- 请求模板URL:', tool.requestTemplate?.url)
      console.log('- 请求模板方法:', tool.requestTemplate?.method)
      console.log('- 参数列表:')
      for (const arg of tool.args || []) {
        console.log(
          `  - ${arg.name} (${arg.type}) ${arg.required ? '必需' : '可选'} - ${arg.description || '无描述'}`,
        )
      }
    }

    console.log('------------------------------------------')

    // 第3步: 构建请求参数
    const testParams = {}

    // 为必需参数提供测试值
    for (const arg of tool.args || []) {
      if (arg.required) {
        switch (arg.type) {
          case 'string':
            testParams[arg.name] = `test_${arg.name}`
            break
          case 'integer':
            testParams[arg.name] = 123
            break
          case 'array':
            testParams[arg.name] = [`test_${arg.name}_item`]
            break
          case 'object':
            testParams[arg.name] = { key: `test_${arg.name}_value` }
            break
          case 'boolean':
            testParams[arg.name] = true
            break
          default:
            testParams[arg.name] = `default_${arg.name}`
        }
      }
    }

    // 对于我们的示例，添加一些非必需但有用的参数
    if (tool.name.includes('api')) {
      testParams.timeStamp = Date.now()
      testParams.source = 'test_source'
    }

    console.log('测试参数:', JSON.stringify(testParams, null, 2))

    // 第4步: 发送MCP工具调用请求
    console.log('发送MCP工具调用请求...')
    const mcpRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: tool.name,
        arguments: testParams,
      },
      id: 'test-request-1',
    }

    console.log('请求主体:', JSON.stringify(mcpRequest, null, 2))

    const mcpResponse = await fetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(mcpRequest),
    })

    console.log('MCP响应状态码:', mcpResponse.status)
    console.log(
      'MCP响应头:',
      JSON.stringify(
        Object.fromEntries(mcpResponse.headers.entries()),
        null,
        2,
      ),
    )

    // 检查Content-Type，判断是否为事件流
    const contentType = mcpResponse.headers.get('content-type') || ''

    if (contentType.includes('text/event-stream')) {
      console.log('接收到事件流响应...')
      const responseText = await mcpResponse.text()

      // 解析事件流
      const events = parseEventStream(responseText)
      console.log(`解析到 ${events.length} 个事件`)

      if (events.length > 0) {
        for (let i = 0; i < events.length; i++) {
          const event = events[i]
          console.log(`事件 #${i + 1} 类型:`, event.event || '未知')

          if (event.data) {
            if (typeof event.data === 'object') {
              if (event.data.error) {
                console.error(
                  'MCP错误:',
                  JSON.stringify(event.data.error, null, 2),
                )
              } else if (event.data.result?.content?.[0]?.text) {
                const text = event.data.result.content[0].text
                console.log('内容长度:', text.length)
                console.log(
                  '内容预览:',
                  text.substring(0, 200) + (text.length > 200 ? '...' : ''),
                )
                analyzeApiError(text)
              } else {
                console.log('数据:', JSON.stringify(event.data, null, 2))
              }
            } else {
              console.log('数据:', event.data)
              if (typeof event.data === 'string') {
                analyzeApiError(event.data)
              }
            }
          }
        }
      } else {
        console.log('没有解析到事件')
        console.log('原始响应:', responseText)
      }
    } else if (contentType.includes('application/json')) {
      console.log('接收到JSON响应...')
      const mcpResult = await mcpResponse.json()

      if (mcpResult.error) {
        console.error('MCP错误:', JSON.stringify(mcpResult.error, null, 2))
      } else {
        console.log('MCP调用成功!')
        if (mcpResult.result?.content) {
          console.log('响应内容类型:', mcpResult.result.content[0]?.type)
          console.log(
            '响应内容长度:',
            mcpResult.result.content[0]?.text?.length || 0,
          )

          // 只显示响应的前200个字符，避免输出过长
          const text = mcpResult.result.content[0]?.text || ''
          console.log(
            '响应内容预览:',
            text.substring(0, 200) + (text.length > 200 ? '...' : ''),
          )
          analyzeApiError(text)
        }
      }
    } else {
      console.log('接收到未知类型响应...')
      const responseText = await mcpResponse.text()
      console.log(
        '响应预览:',
        responseText.substring(0, 200) +
          (responseText.length > 200 ? '...' : ''),
      )
      analyzeApiError(responseText)
    }

    console.log('------------------------------------------')
    console.log('测试完成!')
  } catch (error) {
    console.error('测试过程中出错:', error)
    process.exit(1)
  }
}

main()
