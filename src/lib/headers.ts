import { Logger } from '../types.js'

interface HeadersArgs {
  argv: {
    header?: string[]
    oauth2Bearer?: string
  }
  logger: Logger
}

export function headers({ argv, logger }: HeadersArgs): Record<string, string> {
  const headers: Record<string, string> = {}

  // 处理自定义头部
  if (argv.header) {
    for (const header of argv.header) {
      const [key, value] = header.split(':').map((s) => s.trim())
      if (key && value) {
        headers[key] = value
      }
    }
  }

  // 处理 OAuth2 Bearer 令牌
  if (argv.oauth2Bearer) {
    headers['Authorization'] = `Bearer ${argv.oauth2Bearer}`
  }

  return headers
}
