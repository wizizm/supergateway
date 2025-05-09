import { Converter } from './converter.js'
import { Formatter } from './formatter.js'
import { TemplatePatcher } from './template-patcher.js'
import {
  McpServerConfig,
  McpTool,
  ToolArg,
  RequestTemplate,
  ResponseTemplate,
  ConverterOptions,
  OutputFormat,
  TemplatePatchOptions,
} from './types.js'
import { Logger } from '../../types.js'
import fs from 'fs/promises'
import path from 'path'

// Re-export types
export {
  McpServerConfig,
  McpTool,
  ToolArg,
  RequestTemplate,
  ResponseTemplate,
  ConverterOptions,
  OutputFormat,
  TemplatePatchOptions,
}

// Re-export classes
export { Converter, Formatter, TemplatePatcher }

/**
 * Main conversion function
 * Converts an OpenAPI specification to an MCP server configuration
 *
 * @param options Converter options
 * @param templateOptions Template options
 * @param outputFormat Output format
 * @param logger Logger instance
 * @returns MCP server configuration as a string
 */
export async function convertOpenApiToMcpServer(
  options: ConverterOptions,
  templateOptions: TemplatePatchOptions,
  outputFormat: OutputFormat = 'yaml',
  logger: Logger,
): Promise<string> {
  try {
    // Initialize converter
    const converter = new Converter(options, logger)

    // Load and convert OpenAPI document
    const config = await converter.convert()

    // Apply template if specified
    const patchedConfig = await TemplatePatcher.applyTemplate(
      config,
      templateOptions,
      logger,
    )

    // Format output
    return Formatter.format(patchedConfig, outputFormat)
  } catch (error) {
    logger.error(
      `Conversion failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}

/**
 * Converts an OpenAPI specification to an MCP server configuration and writes it to a file
 *
 * @param options Converter options
 * @param outputPath Output file path
 * @param templateOptions Template options
 * @param logger Logger instance
 */
export async function convertOpenApiToMcpServerFile(
  options: ConverterOptions,
  outputPath: string,
  templateOptions: TemplatePatchOptions,
  logger: Logger,
): Promise<void> {
  try {
    // Initialize converter
    const converter = new Converter(options, logger)

    // Load and convert OpenAPI document
    const config = await converter.convert()

    // Apply template if specified
    const patchedConfig = await TemplatePatcher.applyTemplate(
      config,
      templateOptions,
      logger,
    )

    // Determine format based on file extension
    const format: OutputFormat = outputPath.endsWith('.json') ? 'json' : 'yaml'

    // Create directory if it doesn't exist
    const dirName = path.dirname(outputPath)
    await fs.mkdir(dirName, { recursive: true })

    // Write to file
    await Formatter.writeToFile(patchedConfig, outputPath, format)

    logger.info(`MCP server configuration written to ${outputPath}`)
  } catch (error) {
    logger.error(
      `Failed to write MCP server configuration: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}
