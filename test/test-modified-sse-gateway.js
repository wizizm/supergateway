#!/usr/bin/env node

/**
 * 测试脚本：通过SuperGateway测试认证头传递到SSE服务
 * 该脚本通过SuperGateway连接并验证认证头是否传递
 */

import fetch from 'node-fetch'
import chalk from 'chalk'
import { createInterface } from 'readline'
import { once } from 'events'

// 配置
const CONFIG = {
  // SuperGateway端点
  gatewayUrl: 'http://localhost:8000',
  httpPath: '/mcp',
  // 测试认证头
  authHeaders: {
    Authorization: 'Bearer test-auth-token-12345',
    bspa_access_token: 'test-bspa-token-54321',
    'X-Api-Key': 'test-api-key-abcde',
  },
}

/**
 * 通过SuperGateway连接测试
 */
async function testGatewayConnection() {
  console.log(chalk.blue('\n=== 通过SuperGateway连接测试 ==='))
  console.log(chalk.blue(`连接到: ${CONFIG.gatewayUrl}${CONFIG.httpPath}`))

  try {
    // 创建随机会话ID
    const sessionId =
      'test-session-' + Math.random().toString(36).substring(2, 10)
    console.log(chalk.blue(`使用会话ID: ${sessionId}`))

    // 构建请求头
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
      'MCP-Session-ID': sessionId,
      ...CONFIG.authHeaders,
    }

    console.log(chalk.blue('请求头:'))
    Object.entries(headers).forEach(([key, value]) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 构建初始化请求数据
    const initRequest = {
      jsonrpc: '2.0',
      method: 'startup',
      id: '1',
      params: {
        client: 'test-client',
        version: '1.0.0',
      },
    }

    // 发送请求
    console.log(chalk.blue('发送初始化请求...'))
    const response = await fetch(`${CONFIG.gatewayUrl}${CONFIG.httpPath}`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(initRequest),
    })

    console.log(
      chalk.green(`收到响应: ${response.status} ${response.statusText}`),
    )

    // 输出响应头
    console.log(chalk.blue('响应头:'))
    const responseHeaders = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 如果成功建立连接，读取流
    if (response.status === 200) {
      console.log(chalk.green('✅ 成功建立连接'))
      console.log(chalk.blue('开始读取事件流...'))

      // 创建读取流
      const reader = response.body

      // 设置超时
      const timeout = setTimeout(() => {
        console.log(chalk.yellow('⚠️ 读取超时，结束测试'))
        reader.destroy()
      }, 10000)

      // 设置流事件处理
      reader.on('data', (chunk) => {
        console.log(chalk.green(`收到数据: ${chunk.toString()}`))
      })

      reader.on('end', () => {
        console.log(chalk.blue('流结束'))
        clearTimeout(timeout)
      })

      reader.on('error', (error) => {
        console.log(chalk.red(`❌ 流错误: ${error}`))
        clearTimeout(timeout)
      })

      // 等待用户输入继续
      console.log(chalk.blue('\n按回车键结束测试...'))
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      })

      await once(rl, 'line')
      rl.close()

      // 清理
      clearTimeout(timeout)
      reader.destroy()
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

    console.log(chalk.green('✅ SuperGateway连接测试完成'))
    console.log(chalk.blue('请检查SSE服务日志中是否显示认证头'))
  } catch (error) {
    console.error(chalk.red(`❌ SuperGateway连接测试失败:`))
    console.error(chalk.red(error.message))
    console.error(error)
  }
}

/**
 * 发送API调用测试，采用POST方式
 */
async function testApiCall() {
  console.log(chalk.blue('\n=== 测试API调用和认证头传递 ==='))
  console.log(chalk.blue(`连接到: ${CONFIG.gatewayUrl}${CONFIG.httpPath}`))

  try {
    // 创建随机会话ID
    const sessionId =
      'test-session-' + Math.random().toString(36).substring(2, 10)
    console.log(chalk.blue(`使用会话ID: ${sessionId}`))

    // 构建请求头
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'MCP-Session-ID': sessionId,
      ...CONFIG.authHeaders,
    }

    console.log(chalk.blue('请求头:'))
    Object.entries(headers).forEach(([key, value]) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 构建API调用请求
    const apiRequest = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: '2',
      params: {
        tool: 'test_tool',
        arguments: {
          param1: 'value1',
          param2: 'value2',
        },
      },
    }

    // 发送请求
    console.log(chalk.blue('发送API调用请求...'))
    const response = await fetch(`${CONFIG.gatewayUrl}${CONFIG.httpPath}`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(apiRequest),
    })

    console.log(
      chalk.green(`收到响应: ${response.status} ${response.statusText}`),
    )

    // 输出响应头
    console.log(chalk.blue('响应头:'))
    response.headers.forEach((value, key) => {
      console.log(chalk.gray(`- ${key}: ${value}`))
    })

    // 读取响应内容
    const content = await response.text()
    console.log(chalk.blue('响应内容:'))
    console.log(chalk.gray(content))

    console.log(chalk.green('✅ API调用测试完成'))
    console.log(chalk.blue('请检查SSE服务日志中是否显示认证头'))
  } catch (error) {
    console.error(chalk.red(`❌ API调用测试失败:`))
    console.error(chalk.red(error.message))
    console.error(error)
  }
}

/**
 * 主函数
 */
async function main() {
  console.log(chalk.blue('开始SSE认证头传递测试'))
  console.log(chalk.blue('------------------------'))

  // 打印测试配置
  console.log(chalk.blue('测试配置:'))
  console.log(chalk.gray(`- 网关URL: ${CONFIG.gatewayUrl}${CONFIG.httpPath}`))
  console.log(chalk.blue('认证头:'))
  Object.entries(CONFIG.authHeaders).forEach(([key, value]) => {
    console.log(chalk.gray(`- ${key}: ${value}`))
  })

  // 运行测试
  await testGatewayConnection()
  await testApiCall()

  console.log(chalk.green('\n✅ 所有测试完成'))
}

// 启动主函数
main().catch((error) => {
  console.error(chalk.red('未处理错误:'))
  console.error(error)
  process.exit(1)
})
