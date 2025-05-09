#!/usr/bin/env node

/**
 * 这个脚本测试API到SSE服务中的参数处理功能
 * 运行: node test/test-sse-params.js
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'

// 获取当前目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

console.log('='.repeat(80))
console.log('测试API到SSE的参数处理功能')
console.log('='.repeat(80))

// 测试文件路径
const testOpenApiPath = join(__dirname, 'test-sse-params-openapi.json')

// 创建测试OpenAPI文件，包含各种参数类型
if (!existsSync(testOpenApiPath)) {
  console.log('创建测试OpenAPI文件...')

  const openApiContent = {
    openapi: '3.0.0',
    info: {
      title: '参数测试API',
      version: '1.0.0',
      description: '用于测试各种参数类型处理的API',
    },
    paths: {
      '/test/parameters': {
        post: {
          summary: '测试各种参数类型',
          description: '测试字符串、数字、布尔值、数组和对象参数',
          operationId: 'testParameters',
          parameters: [
            {
              name: 'stringParam',
              in: 'query',
              description: '字符串参数',
              required: true,
              schema: {
                type: 'string',
              },
            },
            {
              name: 'numberParam',
              in: 'query',
              description: '数字参数',
              required: true,
              schema: {
                type: 'number',
              },
            },
            {
              name: 'integerParam',
              in: 'query',
              description: '整数参数',
              required: false,
              schema: {
                type: 'integer',
              },
            },
            {
              name: 'booleanParam',
              in: 'query',
              description: '布尔参数',
              required: true,
              schema: {
                type: 'boolean',
              },
            },
          ],
          requestBody: {
            description: '请求体参数',
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['arrayParam', 'objectParam'],
                  properties: {
                    arrayParam: {
                      type: 'array',
                      description: '数组参数',
                      items: {
                        type: 'string',
                      },
                    },
                    objectParam: {
                      type: 'object',
                      description: '对象参数',
                      properties: {
                        key1: {
                          type: 'string',
                        },
                        key2: {
                          type: 'number',
                        },
                      },
                    },
                    optionalParam: {
                      type: 'string',
                      description: '可选参数',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: '成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      result: {
                        type: 'string',
                        description: '结果消息',
                      },
                      params: {
                        type: 'object',
                        description: '接收到的参数',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }

  writeFileSync(
    testOpenApiPath,
    JSON.stringify(openApiContent, null, 2),
    'utf-8',
  )
  console.log(`创建测试OpenAPI文件成功: ${testOpenApiPath}`)
}

console.log('\n构建项目...')
const buildResult = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
if (buildResult.status !== 0) {
  console.error('构建失败！')
  process.exit(1)
}

console.log('\n测试说明:')
console.log('='.repeat(80))
console.log('1. 在一个终端窗口中运行以下命令启动SSE服务器:')
console.log(
  `node dist/index.js --api ${testOpenApiPath} --apiHost https://example.com --outputTransport sse --port 8030 --ssePath /sse --messagePath /message`,
)
console.log('\n2. 在另一个终端窗口中检查MCP配置，确认参数定义:')
console.log('curl http://localhost:8030/mcp-config')
console.log('\n3. 使用curl连接SSE并获取会话ID:')
console.log('curl -N http://localhost:8030/sse')
console.log(
  '\n4. 在收到SSE连接确认后，复制会话ID，然后使用以下命令测试参数处理:',
)
console.log(
  'curl -X POST "http://localhost:8030/message?sessionId=YOUR_SESSION_ID" \\',
)
console.log('  -H "Content-Type: application/json" \\')
console.log("  -d '")
console.log('    {')
console.log('      "jsonrpc": "2.0",')
console.log('      "method": "tools/call",')
console.log('      "params": {')
console.log('        "name": "testParameters",')
console.log('        "arguments": {')
console.log('          "stringParam": "测试字符串",')
console.log('          "numberParam": "123.45",')
console.log('          "integerParam": "42",')
console.log('          "booleanParam": "true",')
console.log('          "arrayParam": "[1, 2, 3]",')
console.log(
  '          "objectParam": "{\\"key1\\": \\"value1\\", \\"key2\\": 123}"',
)
console.log('        }')
console.log('      },')
console.log('      "id": "test-params-1"')
console.log('    }')
console.log("  '")
console.log('='.repeat(80))

console.log('\n要启动服务器吗？(Y/n)')
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  const input = data.trim().toLowerCase()
  if (input === 'y' || input === '') {
    console.log('\n启动SSE服务器...')
    spawnSync(
      'node',
      [
        'dist/index.js',
        '--api',
        testOpenApiPath,
        '--apiHost',
        'https://example.com',
        '--outputTransport',
        'sse',
        '--port',
        '8030',
        '--ssePath',
        '/sse',
        '--messagePath',
        '/message',
      ],
      { stdio: 'inherit' },
    )
  } else {
    console.log('已取消。请手动运行上述命令测试参数处理功能。')
    process.exit(0)
  }
})
