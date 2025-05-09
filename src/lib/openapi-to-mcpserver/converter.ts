import fs from 'fs/promises'
import path from 'path'
import { OpenAPIV3 } from 'openapi-types'
import yaml from 'js-yaml'

import {
  McpServerConfig,
  McpTool,
  ToolArg,
  ParameterLocation,
  ParameterSchema,
  PropertyDescription,
  ResponseDescription,
  ConverterOptions,
} from './types.js'
import { Logger } from '../../types.js'

/**
 * OpenAPI to MCP Server converter
 */
export class Converter {
  private document: OpenAPIV3.Document | null = null
  private serverName: string
  private toolPrefix: string
  private logger: Logger

  /**
   * Create a new converter instance
   * @param options Converter options
   * @param logger Logger instance
   */
  constructor(
    private options: ConverterOptions,
    logger: Logger,
  ) {
    this.serverName = options.serverName || 'openapi-server'
    this.toolPrefix = options.toolPrefix || ''
    this.logger = logger
  }

  /**
   * Load OpenAPI document from file or use provided document
   */
  async loadDocument(): Promise<void> {
    try {
      if (typeof this.options.input === 'string') {
        const content = await fs.readFile(this.options.input, 'utf-8')
        if (this.options.input.endsWith('.json')) {
          this.document = JSON.parse(content) as OpenAPIV3.Document
        } else {
          this.document = yaml.load(content) as OpenAPIV3.Document
        }
      } else {
        this.document = this.options.input
      }

      if (this.options.validate) {
        this.validateDocument()
      }
    } catch (error) {
      this.logger.error(
        `Error loading OpenAPI document: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  /**
   * Validate the OpenAPI document
   */
  private validateDocument(): void {
    if (!this.document) {
      throw new Error('No OpenAPI document loaded')
    }

    // Minimal validation
    if (!this.document.openapi) {
      throw new Error('Invalid OpenAPI document: missing openapi field')
    }

    if (!this.document.paths) {
      throw new Error('Invalid OpenAPI document: missing paths field')
    }
  }

  /**
   * Convert OpenAPI document to MCP server configuration
   */
  async convert(): Promise<McpServerConfig> {
    if (!this.document) {
      await this.loadDocument()
    }

    if (!this.document) {
      throw new Error('Failed to load OpenAPI document')
    }

    const tools: McpTool[] = []

    // Process each path
    for (const [path, pathItem] of Object.entries(this.document.paths || {})) {
      if (!pathItem) continue

      // Skip reference objects for now
      if ('$ref' in pathItem) continue

      // Process operations (HTTP methods)
      const operations = [
        'get',
        'post',
        'put',
        'delete',
        'options',
        'head',
        'patch',
        'trace',
      ] as const

      for (const method of operations) {
        const operation = pathItem[method]
        if (!operation) continue

        const tool = this.convertOperation(path, method, operation)
        tools.push(tool)
      }
    }

    // Create MCP server configuration
    const config: McpServerConfig = {
      server: {
        name: this.serverName,
        version: this.document.info?.version,
      },
      tools,
    }

    return config
  }

  /**
   * Convert an OpenAPI operation to an MCP tool
   */
  private convertOperation(
    path: string,
    method: string,
    operation: OpenAPIV3.OperationObject,
  ): McpTool {
    // Get operation ID or generate one
    const operationId =
      operation.operationId || this.generateOperationId(path, method)

    // Create tool name with optional prefix
    const toolName = this.toolPrefix
      ? `${this.toolPrefix}_${operationId}`
      : operationId

    // Get operation description
    const description =
      operation.description ||
      operation.summary ||
      `${method.toUpperCase()} ${path}`

    // Process parameters
    const parameters = this.getParameters(path, method, operation)

    // Convert parameters to tool args
    const args = this.convertParameters(parameters)

    // Create request template
    const requestTemplate = {
      url: path,
      method: method.toUpperCase(),
      headers: operation.requestBody
        ? [{ key: 'Content-Type', value: 'application/json' }]
        : undefined,
    }

    // Create response template with prependBody
    const responseTemplate = {
      prependBody: this.generateResponseTemplate(operation),
    }

    return {
      name: toolName,
      description,
      args,
      requestTemplate,
      responseTemplate,
    }
  }

  /**
   * Generate an operation ID from path and method
   */
  private generateOperationId(path: string, method: string): string {
    // Convert path format like /users/{id} to users_id
    const pathPart = path
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\//g, '_')
      .replace(/[{}]/g, '')
      .replace(/-/g, '_')

    return `${method}${pathPart.charAt(0).toUpperCase() + pathPart.slice(1)}`
  }

  /**
   * Get parameters from an OpenAPI operation
   */
  private getParameters(
    path: string,
    method: string,
    operation: OpenAPIV3.OperationObject,
  ): ParameterSchema[] {
    const parameters: ParameterSchema[] = []

    // Add path parameters
    const pathParams = this.extractPathParameters(path)
    const operationParameters = operation.parameters || []

    // Process regular parameters (path, query, header)
    for (const param of operationParameters) {
      // Skip references for now
      if ('$ref' in param) continue

      parameters.push({
        name: param.name,
        description: param.description,
        schema: param.schema || { type: 'string' },
        required: param.required || false,
        location: param.in as ParameterLocation,
      })
    }

    // Process request body if present
    if (operation.requestBody && !('$ref' in operation.requestBody)) {
      const content = operation.requestBody.content || {}
      const jsonSchema = content['application/json']?.schema

      if (jsonSchema) {
        // For request body, add parameters from the schema properties
        if (!('$ref' in jsonSchema) && jsonSchema.properties) {
          for (const [propName, propSchema] of Object.entries(
            jsonSchema.properties,
          )) {
            parameters.push({
              name: propName,
              description:
                typeof propSchema === 'object' && !('$ref' in propSchema)
                  ? propSchema.description
                  : undefined,
              schema: propSchema,
              required: jsonSchema.required?.includes(propName) || false,
              location: 'body',
            })
          }
        }
      }
    }

    return parameters
  }

  /**
   * Extract path parameters from a path template
   */
  private extractPathParameters(path: string): string[] {
    const matches = path.match(/\{([^}]+)\}/g) || []
    return matches.map((match) => match.slice(1, -1))
  }

  /**
   * Convert parameters to tool args
   */
  private convertParameters(parameters: ParameterSchema[]): ToolArg[] {
    return parameters.map((param) => {
      let type = 'string'

      // Get type from schema if available
      if ('type' in param.schema) {
        type = param.schema.type as string
      }

      return {
        name: param.name,
        description: param.description || param.name,
        type,
        required: param.required,
        position: this.mapParameterLocation(param.location),
      }
    })
  }

  /**
   * Map OpenAPI parameter location to MCP position
   */
  private mapParameterLocation(
    location: ParameterLocation,
  ): ToolArg['position'] {
    switch (location) {
      case 'path':
        return 'path'
      case 'query':
        return 'query'
      case 'header':
        return 'header'
      case 'cookie':
        return 'header' // Map cookies to headers
      case 'body':
        return 'body'
      default:
        return 'query' // Default to query
    }
  }

  /**
   * Generate response template with field descriptions
   */
  private generateResponseTemplate(
    operation: OpenAPIV3.OperationObject,
  ): string {
    // Get successful response (200, 201, etc.)
    const responses = operation.responses || {}
    const successResponses = [
      '200',
      '201',
      '202',
      '203',
      '204',
      '205',
      '206',
      '207',
      '208',
      '226',
    ]

    let responseDescription: ResponseDescription | null = null

    // Find first successful response with content
    for (const statusCode of successResponses) {
      const response = responses[statusCode]
      if (!response) continue

      // Skip references
      if ('$ref' in response) continue

      const content = response.content || {}
      const jsonContent = content['application/json']

      if (jsonContent?.schema) {
        responseDescription = {
          contentType: 'application/json',
          schema: jsonContent.schema as OpenAPIV3.SchemaObject,
          statusCode,
          description: response.description || '',
        }
        break
      }
    }

    if (!responseDescription) {
      return '' // No suitable response found
    }

    // Generate response template
    return this.generateResponseDocumentation(responseDescription)
  }

  /**
   * Generate response documentation from a response description
   */
  private generateResponseDocumentation(response: ResponseDescription): string {
    let template = '# API Response Information\n\n'
    template +=
      "Below is the response from an API call. To help you understand the data, I've provided:\n\n"
    template +=
      '1. A detailed description of all fields in the response structure\n'
    template += '2. The complete API response\n\n'

    template += '## Response Structure\n\n'
    template += `> Content-Type: ${response.contentType}\n\n`

    // Add property descriptions
    const propertyDescriptions = this.generatePropertyDescriptions(
      response.schema,
    )
    for (const prop of propertyDescriptions) {
      template += `- **${prop.path}**: ${prop.description || ''} (Type: ${prop.type})\n`
    }

    template += '\n## Original Response\n\n'

    return template
  }

  /**
   * Generate property descriptions from a schema
   */
  private generatePropertyDescriptions(
    schema: OpenAPIV3.SchemaObject,
    parentPath = '',
  ): PropertyDescription[] {
    const descriptions: PropertyDescription[] = []

    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (typeof propSchema !== 'object' || '$ref' in propSchema) continue

        const path = parentPath ? `${parentPath}.${propName}` : propName

        descriptions.push({
          path,
          type: propSchema.type || 'object',
          description: propSchema.description,
        })

        // Recursively process nested objects
        if (propSchema.type === 'object' && propSchema.properties) {
          descriptions.push(
            ...this.generatePropertyDescriptions(propSchema, path),
          )
        }

        // Process array items
        if (
          propSchema.type === 'array' &&
          propSchema.items &&
          typeof propSchema.items === 'object' &&
          !('$ref' in propSchema.items)
        ) {
          if (
            propSchema.items.type === 'object' &&
            propSchema.items.properties
          ) {
            descriptions.push(
              ...this.generatePropertyDescriptions(
                propSchema.items,
                `${path}[]`,
              ),
            )
          }
        }
      }
    }

    return descriptions
  }
}
