#!/usr/bin/env node
/**
 * 运行所有 Streamable HTTP 相关测试
 */

import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

// 获取当前目录
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 颜色输出助手
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
}

// 测试配置
const tests = [
  {
    name: 'stdio → Streamable HTTP',
    script: join(__dirname, 'test-streamable-http.js'),
  },
  {
    name: 'SSE → Streamable HTTP',
    script: join(__dirname, 'test-sse-to-streamable-http.js'),
  },
]

/**
 * 运行单个测试
 */
async function runTest(test) {
  console.log(`\n${colors.bright}=========================================`)
  console.log(`开始测试: ${test.name}`)
  console.log(`==========================================${colors.reset}\n`)

  return new Promise((resolve) => {
    const child = spawn('node', [test.script], {
      stdio: 'inherit',
      // 增加超时时间，因为测试可能需要下载依赖
      timeout: 60000,
    })

    let exitCode

    child.on('exit', (code) => {
      exitCode = code
      const success = code === 0
      console.log(
        `\n${success ? colors.green + '✅' : colors.red + '❌'} ${test.name} 测试${success ? '通过' : '失败'}${exitCode !== 0 ? ` (退出码: ${exitCode})` : ''}${colors.reset}\n`,
      )
      resolve(success)
    })
  })
}

/**
 * 主函数
 */
async function main() {
  // 确保测试目录存在
  const testDir = join(process.cwd(), 'test')

  console.log(`\n${colors.cyan}===========================================`)
  console.log(`   Supergateway Streamable HTTP 功能测试   `)
  console.log(`==========================================${colors.reset}\n`)

  console.log(`测试将按照以下顺序运行:`)
  tests.forEach((test, index) => {
    console.log(`${index + 1}. ${test.name}`)
  })

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  // 等待按键开始
  console.log('\n按 Enter 键开始测试...')
  await new Promise((resolve) => rl.question('', resolve))
  rl.close()

  // 运行测试
  const results = []
  for (const test of tests) {
    const success = await runTest(test)
    results.push({ test, success })
  }

  // 打印结果摘要
  console.log(`\n${colors.bright}===========================================`)
  console.log(`              测试结果总结                 `)
  console.log(`==========================================${colors.reset}\n`)

  results.forEach(({ test, success }) => {
    console.log(
      `${success ? colors.green + '✅' : colors.red + '❌'} ${test.name}: ${success ? '通过' : '失败'}`,
    )
  })

  const allPassed = results.every((r) => r.success)
  console.log(
    `\n${allPassed ? colors.green + '✅ 所有测试通过!' : colors.red + '❌ 有测试失败!'}`,
  )

  // 退出码
  process.exit(allPassed ? 0 : 1)
}

main().catch((error) => {
  console.error(`测试执行错误: ${error}`)
  process.exit(1)
})
