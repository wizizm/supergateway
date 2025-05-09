import { OpenAPIV3 } from 'openapi-types'

/**
 * MCP Server configuration interface
 */
export interface McpServerConfig {
  server: {
    name: string
    version?: string
    config?: Record<string, any>
  }
  tools: McpTool[]
}

/**
 * MCP Tool parameter/argument definition
 */
export interface ToolArg {
  name: string
  description: string
  type: string
  required: boolean
  position: 'path' | 'query' | 'body' | 'header'
}

/**
 * Request template for a MCP tool
 */
export interface RequestTemplate {
  url: string
  method: string
  headers?: Array<{ key: string; value: string }>
}

/**
 * Response template for a MCP tool
 */
export interface ResponseTemplate {
  prependBody?: string
}

/**
 * MCP Tool definition
 */
export interface McpTool {
  name: string
  description: string
  args: ToolArg[]
  requestTemplate: RequestTemplate
  responseTemplate: ResponseTemplate
}

/**
 * Options for converter
 */
export interface ConverterOptions {
  input: string | OpenAPIV3.Document
  serverName?: string
  toolPrefix?: string
  validate?: boolean
}

/**
 * Output format type
 */
export type OutputFormat = 'yaml' | 'json'

/**
 * Template patching options
 */
export interface TemplatePatchOptions {
  templatePath?: string
}

/**
 * Parameter location in OpenAPI specification
 */
export type ParameterLocation = 'path' | 'query' | 'header' | 'cookie' | 'body'

/**
 * Response description helper
 */
export interface ResponseDescription {
  contentType: string
  schema: OpenAPIV3.SchemaObject
  statusCode: string
  description: string
}

/**
 * Property description for schema documentation
 */
export interface PropertyDescription {
  path: string
  type: string
  description?: string
}

/**
 * Parameter schema for tool args
 */
export interface ParameterSchema {
  name: string
  description?: string
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
  required: boolean
  location: ParameterLocation
}
