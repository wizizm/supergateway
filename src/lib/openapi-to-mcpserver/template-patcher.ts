import fs from 'fs/promises'
import { McpServerConfig, TemplatePatchOptions } from './types.js'
import yaml from 'js-yaml'
import { Logger } from '../../types.js'

/**
 * Applies template patches to MCP server configuration
 */
export class TemplatePatcher {
  /**
   * Apply a template to a configuration
   * @param config Base configuration to patch
   * @param options Template options
   * @param logger Logger instance
   * @returns Patched configuration
   */
  static async applyTemplate(
    config: McpServerConfig,
    options: TemplatePatchOptions,
    logger: Logger,
  ): Promise<McpServerConfig> {
    if (!options.templatePath) {
      return config // No template to apply
    }

    try {
      // Load template file
      const templateContent = await fs.readFile(options.templatePath, 'utf-8')
      let template: Partial<McpServerConfig>

      // Parse template based on file extension
      if (options.templatePath.endsWith('.json')) {
        template = JSON.parse(templateContent)
      } else {
        template = yaml.load(templateContent) as Partial<McpServerConfig>
      }

      // Apply template patches
      return this.merge(config, template, logger)
    } catch (error) {
      logger.error(
        `Error applying template: ${error instanceof Error ? error.message : String(error)}`,
      )
      return config // Return original config on error
    }
  }

  /**
   * Merge template into configuration
   * @param config Base configuration
   * @param template Template to apply
   * @param logger Logger instance
   * @returns Merged configuration
   */
  private static merge(
    config: McpServerConfig,
    template: Partial<McpServerConfig>,
    logger: Logger,
  ): McpServerConfig {
    const result = { ...config }

    // Merge server config
    if (template.server) {
      result.server = {
        ...result.server,
        ...template.server,
      }
    }

    // Apply tool patches if available
    if (template.tools) {
      // If tools is an array, replace the entire tools list
      if (Array.isArray(template.tools)) {
        result.tools = template.tools
      }
      // Otherwise, it's a template that should be applied to all tools
      else if (typeof template.tools === 'object') {
        result.tools = result.tools.map((tool) => {
          return this.mergeToolWithTemplate(tool, template.tools as any)
        })
      }
    }

    return result
  }

  /**
   * Merge a tool with a template
   * @param tool Tool to merge
   * @param template Template to apply
   * @returns Merged tool
   */
  private static mergeToolWithTemplate(tool: any, template: any): any {
    const result = { ...tool }

    for (const key of Object.keys(template)) {
      if (key === 'args' && Array.isArray(result.args)) {
        // Don't merge args array, but apply to all args
        result.args = result.args.map((arg: any) => {
          return { ...arg, ...template.args }
        })
      } else if (key === 'requestTemplate' && result.requestTemplate) {
        // Merge request template
        result.requestTemplate = {
          ...result.requestTemplate,
          ...template.requestTemplate,
        }

        // Special handling for headers
        if (
          template.requestTemplate.headers &&
          result.requestTemplate.headers
        ) {
          result.requestTemplate.headers = [
            ...result.requestTemplate.headers,
            ...template.requestTemplate.headers,
          ]
        }
      } else if (key === 'responseTemplate' && result.responseTemplate) {
        // Merge response template
        result.responseTemplate = {
          ...result.responseTemplate,
          ...template.responseTemplate,
        }
      } else {
        // Direct merge for other properties
        result[key] = template[key]
      }
    }

    return result
  }
}
