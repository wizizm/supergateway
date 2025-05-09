#!/usr/bin/env node

/**
 * 这个脚本用于启动API到SSE的MCP服务器
 * 可以直接运行: node test/run-api-to-sse.js
 */

import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync } from 'fs'

// 获取当前目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 测试文件路径
const openApiPath = join(__dirname, 'openapi-sse-test.json')

// 确保测试文件存在
if (!existsSync(openApiPath)) {
  console.log('请先运行 node test/test-api-to-sse.js 生成测试文件')
  process.exit(1)
}

// 端口号
const PORT = 9003

console.log('='.repeat(80))
console.log('启动API到SSE的MCP服务器')
console.log(`使用OpenAPI文件: ${openApiPath}`)
console.log(`端口: ${PORT}`)
console.log('='.repeat(80))

// 启动服务器
const server = spawn(
  'node',
  [
    join(__dirname, '..', 'dist', 'index.js'),
    '--api',
    openApiPath,
    '--apiHost',
    'https://example.com',
    '--outputTransport',
    'sse',
    '--port',
    PORT.toString(),
    '--ssePath',
    '/sse',
    '--messagePath',
    '/message',
    '--logLevel',
    'info',
  ],
  {
    stdio: 'inherit',
  },
)

// 打印可用端点
setTimeout(() => {
  console.log('\n='.repeat(80))
  console.log('服务器已启动，以下端点可用:')
  console.log(`- 健康检查端点: http://localhost:${PORT}/health`)
  console.log(`- 状态端点: http://localhost:${PORT}/status`)
  console.log(`- MCP配置端点: http://localhost:${PORT}/mcp-config`)
  console.log(`- SSE端点: http://localhost:${PORT}/sse`)
  console.log(`- 消息端点: http://localhost:${PORT}/message`)
  console.log('\n测试命令:')
  console.log(`curl http://localhost:${PORT}/health`)
  console.log(`curl http://localhost:${PORT}/mcp-config`)
  console.log(`curl -N http://localhost:${PORT}/sse`)
  console.log('='.repeat(80))
}, 1000)

// 处理终止信号
process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...')
  server.kill()
  process.exit(0)
})

server.on('close', (code) => {
  console.log(`服务器已关闭，退出码: ${code}`)
  process.exit(code)
})
