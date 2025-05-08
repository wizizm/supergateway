export interface Logger {
  info: (...args: any[]) => void
  error: (...args: any[]) => void
  warn: (...args: any[]) => void
  debug: (...args: any[]) => void
}

export const logger: Logger = {
  info: console.info.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
}
