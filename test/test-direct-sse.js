#!/usr/bin/env node

/**
 * 测试脚本：直接使用fetch建立SSE连接并传递认证头
 * 这个测试验证认证头是否能正确传递到SSE服务端
 */

import fetch from 'node-fetch'
import chalk from 'chalk'

async function main() {
  console.log(chalk.blue('测试直接SSE连接与认证头传递...'))

  // 测试服务器配置
  const sseUrl = 'http://localhost:8001/sse' // 假设SSE服务运行在8001端口

  // 测试认证头
  const authHeaders = {
    Authorization: 'Bearer test-auth-token-direct-12345',
    bspa_access_token: 'test-bspa-token-direct-54321',
    'X-Api-Key': 'test-api-key-direct-abcde',
  }

  console.log(chalk.blue('使用认证头:'))
  Object.entries(authHeaders).forEach(([key, value]) => {
    console.log(chalk.gray(`- ${key}: ${value}`))
  })

  try {
    // 准备请求头
    const headers = {
      Accept: 'text/event-stream',
      ...authHeaders,
    }

    console.log(chalk.blue(`尝试连接到SSE服务: ${sseUrl}`))
    console.log(chalk.gray(`请求头: ${JSON.stringify(headers, null, 2)}`))

    // 使用fetch建立连接
    const response = await fetch(sseUrl, {
      method: 'GET',
      headers,
    })

    console.log(
      chalk.green(`连接状态: ${response.status} ${response.statusText}`),
    )

    // 输出响应头
    console.log(chalk.blue('响应头:'))
    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    if (response.status === 200) {
      console.log(chalk.green('✅ 成功建立SSE连接!'))
      console.log(
        chalk.blue('现在检查SSE服务器的日志，验证认证头是否被接收...'),
      )

      // 保持连接一段时间以便观察日志
      console.log(chalk.blue('保持连接5秒...'))
      await new Promise((resolve) => setTimeout(resolve, 5000))

      console.log(chalk.green('✅ 测试完成'))
      console.log(chalk.blue('请检查SSE服务器日志，查找包含以下内容的行:'))
      console.log(
        chalk.gray(
          '- "Request headers:" 后面应包含 Authorization, bspa_access_token, X-Api-Key',
        ),
      )
    } else {
      console.log(
        chalk.red(`❌ 连接失败: ${response.status} ${response.statusText}`),
      )

      // 尝试读取错误响应
      try {
        const text = await response.text()
        console.log(chalk.red(`错误响应: ${text}`))
      } catch (e) {
        console.log(chalk.red(`无法读取错误响应: ${e.message}`))
      }
    }
  } catch (error) {
    console.error(chalk.red(`❌ 测试出错:`))
    console.error(chalk.red(error.message))
    console.error(error)
  }
}

main().catch((error) => {
  console.error(chalk.red('未处理错误:'))
  console.error(error)
  process.exit(1)
})
