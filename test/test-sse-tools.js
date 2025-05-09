#!/usr/bin/env node

/**
 * 这个脚本用于测试API到SSE的MCP服务的工具格式
 * 可以直接运行: node test/test-sse-tools.js
 */

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { writeFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'

// 获取当前目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

console.log('='.repeat(80))
console.log('测试API到SSE的MCP工具格式')
console.log('='.repeat(80))

// 创建测试OpenAPI文件
const testOpenApiPath = join(__dirname, 'test-sse-tools-openapi.json')
if (!existsSync(testOpenApiPath)) {
  console.log('创建测试OpenAPI文件...')
  const openApiContent = {
    openapi: '3.0.0',
    info: {
      title: '测试API',
      version: '1.0.0',
      description: '用于测试SSE工具格式的API',
    },
    paths: {
      '/items': {
        get: {
          summary: '获取所有项目',
          description: '返回所有可用项目的列表',
          operationId: 'getItems',
          responses: {
            200: {
              description: '成功获取项目列表',
              content: {
                'application/json': {
                  schema: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: {
                          type: 'integer',
                          description: '项目ID',
                        },
                        name: {
                          type: 'string',
                          description: '项目名称',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          summary: '创建新项目',
          description: '创建一个新的项目',
          operationId: 'createItem',
          requestBody: {
            description: '新项目的详细信息',
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: {
                      type: 'string',
                      description: '项目名称',
                    },
                    description: {
                      type: 'string',
                      description: '项目描述',
                    },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: '项目创建成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'integer',
                        description: '新创建的项目ID',
                      },
                      name: {
                        type: 'string',
                        description: '项目名称',
                      },
                      description: {
                        type: 'string',
                        description: '项目描述',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/items/{id}': {
        get: {
          summary: '获取单个项目',
          description: '返回指定ID的项目',
          operationId: 'getItem',
          parameters: [
            {
              name: 'id',
              in: 'path',
              description: '项目ID',
              required: true,
              schema: {
                type: 'integer',
                format: 'int64',
              },
            },
          ],
          responses: {
            200: {
              description: '成功获取项目',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'integer',
                        description: '项目ID',
                      },
                      name: {
                        type: 'string',
                        description: '项目名称',
                      },
                      description: {
                        type: 'string',
                        description: '项目描述',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        put: {
          summary: '更新项目',
          description: '更新指定ID的项目',
          operationId: 'updateItem',
          parameters: [
            {
              name: 'id',
              in: 'path',
              description: '要更新的项目ID',
              required: true,
              schema: {
                type: 'integer',
                format: 'int64',
              },
            },
          ],
          requestBody: {
            description: '更新的项目数据',
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: {
                      type: 'string',
                      description: '项目名称',
                    },
                    description: {
                      type: 'string',
                      description: '项目描述',
                    },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: '项目更新成功',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: {
                        type: 'integer',
                        description: '项目ID',
                      },
                      name: {
                        type: 'string',
                        description: '项目名称',
                      },
                      description: {
                        type: 'string',
                        description: '项目描述',
                      },
                    },
                  },
                },
              },
            },
          },
        },
        delete: {
          summary: '删除项目',
          description: '删除指定ID的项目',
          operationId: 'deleteItem',
          parameters: [
            {
              name: 'id',
              in: 'path',
              description: '要删除的项目ID',
              required: true,
              schema: {
                type: 'integer',
                format: 'int64',
              },
            },
          ],
          responses: {
            204: {
              description: '项目删除成功',
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

console.log('\n测试命令说明:')
console.log('='.repeat(80))
console.log('1. 在一个终端窗口中运行以下命令启动SSE服务器:')
console.log(
  `node dist/index.js --api ${testOpenApiPath} --apiHost https://example.com --outputTransport sse --port 8010 --ssePath /sse --messagePath /message`,
)
console.log('\n2. 在另一个终端窗口中运行以下命令检查MCP配置:')
console.log('curl http://localhost:8010/mcp-config')
console.log('\n3. 使用curl测试SSE连接:')
console.log('curl -N http://localhost:8010/sse')
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
        '8010',
        '--ssePath',
        '/sse',
        '--messagePath',
        '/message',
      ],
      { stdio: 'inherit' },
    )
  } else {
    console.log('已取消。请手动运行上述测试命令。')
    process.exit(0)
  }
})
