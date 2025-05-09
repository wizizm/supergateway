### Enhanced version of https://github.com/supercorp-ai/supergateway, adding streamablehttp support and the ability to run MCP services based on both OpenAPI protocol interface documentation and [higress MCP template files](https://github.com/higress-group/openapi-to-mcpserver).

# SuperGateway

**SuperGateway** is a versatile protocol conversion tool for Model Context Protocol (MCP) servers, enabling:

1. Running **MCP stdio-based servers** over **SSE (Server-Sent Events)**, **WebSockets (WS)**, or **Streamable HTTP**
2. Converting **OpenAPI 3.0.1** interface definitions to **MCP tools**
3. Providing seamless interoperability between different MCP transport protocols

Supported by [Supermachine](https://supermachine.ai) (hosted MCPs), [Superinterface](https://superinterface.ai), and [Supercorp](https://supercorp.ai).

## Key Features

### Protocol Conversion

- Convert between stdio, SSE, WS, and Streamable HTTP (bidirectionally)
- Support multiple concurrent sessions with proper session management
- Provide comprehensive MCP protocol compatibility

### API Integration

- Convert OpenAPI 3 specifications to MCP tools automatically
- Generate tool names, descriptions, and parameter definitions from API specs
- Support complex parameter types with validation rules
- Automatically detect OpenAPI specs or MCP templates

### Session Management

- Robust session tracking with unique session IDs
- Automatic session timeout cleanup
- Detailed session status logging
- Fallback mechanisms for session ID mismatches

## Installation & Usage

Run SuperGateway via `npx`:

```bash
npx -y @gfsopen/supergateway --stdio "uvx mcp-server-git"
```

### Common Options

- **`--stdio "command"`**: Command that runs an MCP server over stdio
- **`--sse "https://mcp-server-url.example.com"`**: SSE URL to connect to (SSE→stdio mode)
- **`--outputTransport stdio | sse | ws | streamable-http`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse`)
- **`--port 8000`**: Port to listen on (default: `8000`)
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE, WS, or Streamable HTTP clients (optional)
- **`--header "x-user-id: 123"`**: Add custom headers (can be used multiple times)
- **`--oauth2Bearer "some-access-token"`**: Add an `Authorization` header with the provided Bearer token
- **`--logLevel info | none`**: Control logging level (default: `info`)
- **`--cors`**: Enable CORS (use with no values to allow all origins, or specify allowed origins)
- **`--healthEndpoint /healthz`**: Register endpoints that respond with `"ok"`

### Path Options

- **`--ssePath "/sse"`**: Path for SSE subscriptions (default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (default: `/message`)
- **`--httpPath "/mcp"`**: Path for Streamable HTTP (default: `/mcp`)

### API Integration Options

- **`--api "./openapi.json"`**: OpenAPI document or MCP template file (JSON or YAML)
- **`--apiHost "https://api.example.com"`**: Base URL for the API server

## Usage Scenarios

### stdio → SSE

Expose an MCP stdio server as an SSE server:

```bash
npx -y @gfsopen/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

- **Subscribe to events**: `GET http://localhost:8000/sse`
- **Send messages**: `POST http://localhost:8000/message`

### stdio → Streamable HTTP

Expose an MCP stdio server as a Streamable HTTP server:

```bash
npx -y @gfsopen/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --outputTransport streamable-http --httpPath /mcp
```

- **Streamable HTTP endpoint**: `http://localhost:8000/mcp`

### SSE → stdio

Connect to a remote SSE server and expose locally via stdio:

```bash
npx -y @gfsopen/supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
```

You can add authentication headers:

```bash
npx -y @gfsopen/supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --oauth2Bearer "some-access-token" \
    --header "X-My-Header: another-header-value"
```

### SSE → Streamable HTTP

Convert a remote SSE MCP server to Streamable HTTP:

```bash
npx -y @gfsopen/supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

- **Streamable HTTP endpoint**: `http://localhost:8000/mcp`

### stdio → WS

Expose an MCP stdio server as a WebSocket server:

```bash
npx -y @gfsopen/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport ws --messagePath /message
```

- **WebSocket endpoint**: `ws://localhost:8000/message`

### API → SSE or Streamable HTTP

Convert an OpenAPI specification to an MCP server:

```bash
# Using Streamable HTTP
npx -y @gfsopen/supergateway \
    --api ./openapi.json --apiHost https://api.example.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp

# Using SSE
npx -y @gfsopen/supergateway \
    --api ./openapi.json --apiHost https://api.example.com \
    --outputTransport sse --port 8000 --ssePath /sse --messagePath /message
```

SuperGateway automatically detects whether the input file is an OpenAPI specification or an MCP template:

- If it's an OpenAPI spec, it converts it to an MCP template and provides the service
- If it's already an MCP template, it uses it directly

## OpenAPI to MCP Conversion Tool

SuperGateway includes a standalone tool to convert OpenAPI documents to MCP templates:

```bash
# Using npx
npx -y @gfsopen/supergateway openapi-to-mcp --input openapi.json --output mcp-template.json

# Or use the direct command
openapi-to-mcp --input openapi.json --output mcp-template.json
```

### Parameters

- `--input, -i`: Path to OpenAPI spec file (JSON or YAML)
- `--output, -o`: Path for output MCP config file
- `--server-name, -n`: MCP server name (default: "openapi-server")
- `--tool-prefix, -p`: Tool name prefix (default: "")
- `--format, -f`: Output format (yaml or json) (default: "yaml")
- `--validate, -v`: Validate OpenAPI spec (default: false)
- `--template, -t`: Template file path for patching output (default: "")

## Client Integrations

### Example with MCP Inspector (stdio → SSE mode)

1. Run SuperGateway:

```bash
npx -y @gfsopen/supergateway --port 8000 \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /Users/MyName/Desktop"
```

2. Use MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

### Using with Cursor (SSE → stdio mode)

Cursor can integrate with SuperGateway in SSE→stdio mode:

```json
{
  "mcpServers": {
    "cursorExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "@gfsopen/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Using with Modern Cursor (Streamable HTTP mode)

Cursor can use SuperGateway's stdio→Streamable HTTP mode:

```json
{
  "mcpServers": {
    "modernCursorExample": {
      "type": "streamableHttp",
      "url": "http://localhost:8000/mcp"
    }
  }
}
```

Run SuperGateway on your local machine:

```bash
npx -y @gfsopen/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

## Docker Support

SuperGateway is available as a Docker image, making it easy to run without installing Node.js locally.

### Docker Image

Available on Docker Hub: [supercorp/supergateway](https://hub.docker.com/r/supercorp/supergateway)  
Also on GitHub Container Registry: [ghcr.io/supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway/pkgs/container/supergateway)

### Docker Examples for All Gateway Types

#### stdio → SSE

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000 --ssePath /sse --messagePath /message
```

#### stdio → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

#### stdio → WS

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --outputTransport ws --port 8000 --messagePath /message
```

#### SSE → stdio

```bash
docker run -it --rm supercorp/supergateway \
    --sse "https://mcp-server-example.supermachine.app" \
    --outputTransport stdio
```

#### SSE → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --sse "https://mcp-server-example.supermachine.app" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

#### API → SSE

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --api /path/to/openapi.json --apiHost https://api.example.com \
    --outputTransport sse --port 8000 --ssePath /sse --messagePath /message
```

#### API → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --api /path/to/openapi.json --apiHost https://api.example.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

### Volume Mounting

To provide files from your host system:

```bash
docker run -it --rm -p 8000:8000 -v $(pwd):/workspace supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /workspace" \
    --port 8000
```

### Building the Image Yourself

```bash
# 1. Compile TypeScript
npm run build

# 2. Build Docker image
docker build -t supergateway .

# 3. Run the container
docker run -it --rm -p 8000:8000 supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
```

## Public Access with ngrok

Share your local MCP server publicly:

```bash
npx -y @gfsopen/supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:
ngrok http 8000
```

The MCP server will be available at a URL similar to: https://1234-567-890-12-456.ngrok-free.app/sse

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. SuperGateway converts between different MCP transport types (stdio, SSE, WS, and Streamable HTTP), simplifying integration and debugging with various clients.

The Streamable HTTP transport is the latest MCP standard, offering improved performance and better compatibility with modern web infrastructure. SuperGateway makes it easy to use this transport with any MCP server, regardless of the transport it natively supports.

## Advanced Features

- **Automatic File Type Detection**: SuperGateway intelligently detects whether input files are OpenAPI specs or MCP templates
- **Parameter Type Validation**: Robust validation and conversion for different parameter types
- **Comprehensive CORS Support**: Configurable cross-origin resource sharing
- **Enhanced Session Management**: Robust handling of session IDs with fallback mechanisms
- **Detailed Logging**: Comprehensive logging for debugging and monitoring

## Contributors

- [@StefanBurscher](https://github.com/StefanBurscher)
- [@tarasyarema](https://github.com/tarasyarema)
- [@pcnfernando](https://github.com/pcnfernando)
- [@Areo-Joe](https://github.com/Areo-Joe)
- [@Joffref](https://github.com/Joffref)
- [@michaeljguarino](https://github.com/michaeljguarino)

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions.

## License

[MIT License](./LICENSE)
