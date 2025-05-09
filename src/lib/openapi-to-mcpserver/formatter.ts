import yaml from 'js-yaml'
import { McpServerConfig, OutputFormat } from './types.js'

/**
 * Formats MCP server configuration as YAML or JSON
 */
export class Formatter {
  /**
   * Format a configuration object to string
   * @param config MCP server configuration
   * @param format Output format (yaml or json)
   * @returns Formatted configuration string
   */
  static format(
    config: McpServerConfig,
    format: OutputFormat = 'yaml',
  ): string {
    if (format === 'json') {
      return JSON.stringify(config, null, 2)
    } else {
      return yaml.dump(config, {
        indent: 2,
        lineWidth: 120,
        noRefs: true,
        sortKeys: false,
      })
    }
  }

  /**
   * Write configuration to a file
   * @param config MCP server configuration
   * @param filePath Path to write the file
   * @param format Output format (yaml or json)
   * @returns Promise that resolves when file is written
   */
  static async writeToFile(
    config: McpServerConfig,
    filePath: string,
    format: OutputFormat = 'yaml',
  ): Promise<void> {
    const fs = await import('fs/promises')
    const content = this.format(config, format)
    await fs.writeFile(filePath, content, 'utf-8')
  }

  /**
   * Parse a configuration string to object
   * @param content Configuration string
   * @param format Input format (yaml or json)
   * @returns Parsed configuration object
   */
  static parse(
    content: string,
    format: OutputFormat = 'yaml',
  ): McpServerConfig {
    if (format === 'json') {
      return JSON.parse(content) as McpServerConfig
    } else {
      return yaml.load(content) as McpServerConfig
    }
  }
}
