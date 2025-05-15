#!/usr/bin/env node

/**
 * 简单的认证头传递测试
 * 该脚本测试SuperGateway是否正确传递认证头到SSE服务
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

// 测试配置
const CONFIG = {
  // 测试网关端点
  gatewayUrl: 'http://localhost:8000',
  httpPath: '/mcp',
  // 测试认证头
  authHeaders: {
    Authorization: 'Bearer test-auth-token-12345',
    bspa_access_token: 'test-bspa-token-54321',
    'X-Api-Key': 'test-api-key-abcde',
    'x-custom-auth': 'custom-auth-value',
  },
}

/**
 * 主测试函数
 */
async function main() {
  console.log(chalk.blue('🧪 开始测试认证头传递'))
  console.log(chalk.blue('---------------------'))

  try {
    // 生成随机会话ID
    const sessionId = 'test-session-' + Date.now()
    console.log(chalk.blue(`使用会话ID: ${sessionId}`))

    // 准备请求头
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Session-ID': sessionId,
      ...CONFIG.authHeaders,
    }

    console.log(chalk.blue('请求头包含以下认证头:'))
    Object.entries(CONFIG.authHeaders).forEach(([key, value]) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 发送工具调用请求
    const toolCallRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: '1',
      params: {
        tool: 'test_auth_headers',
        arguments: {
          test: 'value',
        },
      },
    }

    console.log(
      chalk.blue(
        `\n发送工具调用请求到: ${CONFIG.gatewayUrl}${CONFIG.httpPath}`,
      ),
    )
    const response = await fetch(`${CONFIG.gatewayUrl}${CONFIG.httpPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toolCallRequest),
    })

    // 输出响应状态
    console.log(
      chalk.blue(`\n响应状态: ${response.status} ${response.statusText}`),
    )

    // 输出响应头
    console.log(chalk.blue('响应头:'))
    response.headers.forEach((value, key) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 读取并输出响应体
    const responseText = await response.text()
    try {
      const responseJson = JSON.parse(responseText)
      console.log(chalk.blue('\n响应体:'))
      console.log(chalk.gray(JSON.stringify(responseJson, null, 2)))

      // 检查响应中是否包含成功信息
      if (responseJson.error) {
        console.log(
          chalk.yellow(`⚠️ 请求返回错误: ${responseJson.error.message}`),
        )
      } else {
        console.log(chalk.green('✅ 请求成功完成'))
      }
    } catch (e) {
      console.log(chalk.blue('\n响应体 (非JSON):'))
      console.log(chalk.gray(responseText))
    }

    console.log(chalk.green('\n✅ 测试完成'))
    console.log(chalk.blue('请检查SSE服务器日志，确认认证头是否被接收'))
    console.log(
      chalk.blue(
        '查找类似 "Request headers:" 的日志行，确认其中包含 Authorization, bspa_access_token 和 X-Api-Key',
      ),
    )
  } catch (error) {
    console.error(chalk.red(`\n❌ 测试失败:`))
    console.error(chalk.red(error.message))

    if (error.code === 'ECONNREFUSED') {
      console.error(
        chalk.yellow(`\n⚠️ 无法连接到网关服务器，请确保服务器正在运行:`),
      )
      console.error(
        chalk.yellow(
          `  1. 在一个终端中启动SSE服务: node dist/index.js --stdio "cat" --port 8001`,
        ),
      )
      console.error(
        chalk.yellow(
          `  2. 在另一个终端中启动网关: node dist/index.js --sse "http://localhost:8001" --port 8000 --httpPath /mcp`,
        ),
      )
    }
  }
}

// 启动测试
main()
