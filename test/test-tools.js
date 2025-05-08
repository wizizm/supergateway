import fetch from 'node-fetch'

async function parseResponse(response) {
  const contentType = response.headers.get('content-type')
  if (contentType && contentType.includes('text/event-stream')) {
    const text = await response.text()
    const lines = text.split('\n')
    const messages = []
    let currentMessage = ''

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        currentMessage = line.slice(6)
        if (currentMessage) {
          try {
            messages.push(JSON.parse(currentMessage))
          } catch (e) {
            console.warn('无法解析SSE消息:', currentMessage)
          }
        }
      }
    }

    return messages[0] // 返回第一个消息
  } else {
    try {
      return await response.json()
    } catch (e) {
      console.warn('无法解析JSON响应:', await response.text())
      return null
    }
  }
}

async function testTools() {
  try {
    // 首先初始化服务器
    console.log('发送初始化请求...')
    const initResponse = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'mcp-session-id': 'test-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      }),
    })

    console.log('初始化响应状态码:', initResponse.status)
    console.log('初始化响应头:', initResponse.headers.raw())
    const initResult = await parseResponse(initResponse)
    console.log('初始化结果：')
    console.log(JSON.stringify(initResult, null, 2))

    if (initResult?.error) {
      throw new Error(`初始化失败: ${JSON.stringify(initResult.error)}`)
    }

    // 发送notifications/initialized通知
    console.log('\n发送initialized通知...')
    const notifyResponse = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'mcp-session-id': 'test-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    })

    console.log('通知响应状态码:', notifyResponse.status)
    const notifyResult = await parseResponse(notifyResponse)
    if (notifyResult?.error) {
      console.warn('通知发送警告:', JSON.stringify(notifyResult.error))
    }

    // 发送tools/list请求
    console.log('\n发送tools/list请求...')
    const response = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'mcp-session-id': 'test-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      }),
    })

    console.log('tools/list响应状态码:', response.status)
    console.log('tools/list响应头:', response.headers.raw())
    const result = await parseResponse(response)
    console.log('\n可用工具列表：')
    console.log(JSON.stringify(result, null, 2))

    if (result?.error) {
      throw new Error(`获取工具列表失败: ${JSON.stringify(result.error)}`)
    }

    const tools = result?.result?.list || []
    if (tools.length === 0) {
      console.log('没有可用的工具')
      return
    }

    // 测试第一个工具
    const firstTool = tools[0]
    console.log('\n测试调用工具:', firstTool.name)
    const toolResponse = await fetch('http://localhost:8000/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'mcp-session-id': 'test-session',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: firstTool.name,
        params: {
          source: '4602655C484A467A84D16DDB933AA2C7',
          password: 'CAD6E6131258C5102A155E00AE6D999C',
          timeStamp: 1663296920376,
          fields: ['id', 'busi_date', 'secu_id'],
          conditions: [
            "in,secu_id,'135313.SZ'",
            "between,trd_dt,'2025-02-04'#'2025-04-16'",
          ],
          pageindex: '1',
          pagesize: '10',
        },
      }),
    })

    console.log('工具调用响应状态码:', toolResponse.status)
    console.log('工具调用响应头:', toolResponse.headers.raw())
    const toolResult = await parseResponse(toolResponse)
    console.log('\n调用工具测试结果：')
    console.log(JSON.stringify(toolResult, null, 2))

    if (toolResult?.error) {
      throw new Error(`工具调用失败: ${JSON.stringify(toolResult.error)}`)
    }
  } catch (error) {
    console.error('测试过程中出错：', error)
    process.exit(1)
  }
}

testTools()
