### Enhanced version of https://github.com/supercorp-ai/supergateway, adding streamablehttp support and the ability to run MCP services based on both OpenAPI protocol interface documentation and [higress MCP template files](https://github.com/higress-group/openapi-to-mcpserver).

# SuperGateway

**SuperGateway** is a versatile protocol conversion tool for Model Context Protocol (MCP) servers, enabling:

1. Running **MCP stdio-based servers** over **SSE (Server-Sent Events)**, **WebSockets (WS)**, or **Streamable HTTP**
2. Converting **OpenAPI 3.0.1** interface definitions to **MCP tools**
3. Providing seamless interoperability between different MCP transport protocols

## Recent Updates

- **May 25, 2024**: Added robust reconnection mechanisms for both SSE and stdio services, implementing exponential backoff strategy and maximum retry limits to prevent service interruptions due to connection failures.
- **November 18, 2024**: Enhanced authentication header handling with improved fetch interception, centralized auth header management, and multi-layer auth propagation to solve "login timeout" errors.
- **May 20, 2024**: Optimized the apiToSse.ts module based on the official MCP SSE server example, improving code structure, error handling, and session management.
- **May 19, 2024**: Fixed OpenAPI to MCP URL building issues and verified cross-API compatibility.
- **May 18, 2024**: Improved MCP service generation by referencing the Higress openapi-to-mcpserver project.
- **May 16, 2024**: Fixed CherryStudio compatibility issues with the MCP service.

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

Available on Docker Hub: [michlyn/supergateway](https://hub.docker.com/r/michlyn/supergateway)

### Docker Examples for All Gateway Types

#### stdio → SSE

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000 --ssePath /sse --messagePath /message
```

#### stdio → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

#### stdio → WS

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --outputTransport ws --port 8000 --messagePath /message
```

#### SSE → stdio

```bash
docker run -it --rm michlyn/supergateway \
    --sse "https://mcp-server-example.supermachine.app" \
    --outputTransport stdio
```

#### SSE → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --sse "https://mcp-server-example.supermachine.app" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

#### API → SSE

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --api /path/to/openapi.json --apiHost https://api.example.com \
    --outputTransport sse --port 8000 --ssePath /sse --messagePath /message
```

#### API → Streamable HTTP

```bash
docker run -it --rm -p 8000:8000 michlyn/supergateway \
    --api /path/to/openapi.json --apiHost https://api.example.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

### Volume Mounting

To provide files from your host system:

```bash
docker run -it --rm -p 8000:8000 -v $(pwd):/workspace michlyn/supergateway \
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
npx -y @gfsopen/supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:

ngrok http 8000

````

The MCP server will be available at a URL similar to: https://1234-567-890-12-456.ngrok-free.app/sse

## Troubleshooting SSE Connections

If you encounter issues with SSE connections or tool calls not being processed:

1. **Check Session IDs**: Ensure the client is using the session ID returned by the server in the SSE response headers:
   ```javascript
   // Example JavaScript client code
   const sseConnection = new EventSource('/sse');
   let sessionId;

   sseConnection.onopen = (event) => {
     // Get session ID from response headers
     sessionId = event.target.getResponseHeader('mcp-session-id');
     console.log('Connected with session ID:', sessionId);
   };

   // Use that session ID for message requests
   async function callTool(toolName, parameters) {
     const response = await fetch('/message', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'mcp-session-id': sessionId
       },
       body: JSON.stringify({
         jsonrpc: '2.0',
         method: 'tools/call',
         params: { name: toolName, arguments: parameters },
         id: Date.now()
       })
     });
     return await response.json();
   }
````

2. **Standard MCP tools/call Format**: Use the standard MCP tools/call message format:

   ```json
   {
     "jsonrpc": "2.0",
     "method": "tools/call",
     "params": {
       "name": "toolName",
       "arguments": {
         "param1": "value1",
         "param2": "value2"
       }
     },
     "id": 1
   }
   ```

   Note: The `arguments` field is used instead of `parameters`. This is required for compatibility with the standard MCP tools/call format and direct-intercept mode.

3. **Use the Debug Tool**: The server includes a built-in debug tool to test tool invocation:

   ```bash
   curl -X POST \
     -H "Content-Type: application/json" \
     -H "mcp-session-id: YOUR_SESSION_ID" \
     http://localhost:8080/message \
     -d '{
       "jsonrpc": "2.0",
       "method": "tools/call",
       "params": {
         "name": "debug",
         "arguments": {
           "message": "Testing connection",
           "testMode": true
         }
       },
       "id": 1
     }'
   ```

4. **Check Server Logs**: Look for detailed logs showing:

   - SSE connection establishment
   - Session ID creation and tracking
   - JSON parsing of message bodies
   - Tool call processing
   - Direct interception of tools/call requests

5. **Common Issues**:

   - "Headers already sent" errors can occur if trying to modify response headers after sending data
   - Missing session ID in message requests
   - Incorrect JSON formatting in tool call requests
   - CORS issues when connecting from a different origin
   - "stream is not readable" errors when the request body is consumed before the SSE transport can process it
   - Tool calls not being executed (looking for "EXECUTING TOOL" in logs)

6. **Authentication Headers Handling**:

   - The gateway seamlessly passes authentication headers (Authorization, tokens, etc.) through the entire request chain
   - Authentication headers are automatically detected and preserved across all transport layers
   - Handles various authentication header formats: Authorization, bspa_access_token, api-key, etc.
   - When experiencing "登录信息超时" (login timeout) errors, check that:
     - Your client is sending proper authentication headers
     - The headers are being correctly passed through (see server logs)
     - The format of authentication headers matches what the API expects
   - You can test authentication header passing with a simple curl command:
     ```bash
     curl -X POST \
       -H "Content-Type: application/json" \
       -H "Authorization: Bearer YOUR_TOKEN" \
       -H "mcp-session-id: YOUR_SESSION_ID" \
       http://localhost:8000/message \
       -d '{
         "jsonrpc": "2.0",
         "method": "tools/call",
         "params": {
           "name": "debug",
           "arguments": {
             "message": "Testing auth headers",
             "testMode": true
           }
         },
         "id": 1
       }'
     ```
   - The authentication header will be passed to the SSE server and then to the API call

7. **tools/call Direct Interception**:

   - The apiToSse module uses direct interception for tools/call requests
   - These requests are intercepted before passing to the SSE transport
   - Direct interception logs will show: "===== 直接拦截并处理tools/call请求 ====="
   - If you don't see this log, check that your request format follows the standard MCP tools/call format
   - This approach bypasses any potential issues with the SSE transport's handling of tools/call requests

8. **Request Body Handling**:

   - The apiToSse module includes special handling for message path request bodies
   - For message endpoint requests, the raw request body is preserved for processing
   - Ensure that Content-Type header is set to "application/json" for message requests
   - When testing with curl, verify the full request body syntax matches JSON-RPC format
   - Use --logLevel debug flag when starting the server to see detailed request processing logs

9. **Request Headers Pass-through**:
   - Authentication headers (Authorization, bspa_access_token) from SSE connection are passed to API calls
   - Session headers are preserved and tracked throughout the connection lifecycle
   - To verify headers are passed correctly, check the RequestHeaders log entries

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. SuperGateway converts between different MCP transport types (stdio, SSE, WS, and Streamable HTTP), simplifying integration and debugging with various clients.

The Streamable HTTP transport is the latest MCP standard, offering improved performance and better compatibility with modern web infrastructure. SuperGateway makes it easy to use this transport with any MCP server, regardless of the transport it natively supports.

## Advanced Features

- **Automatic File Type Detection**: SuperGateway intelligently detects whether input files are OpenAPI specs or MCP templates
- **Parameter Type Validation**: Robust validation and conversion for different parameter types
- **Comprehensive CORS Support**: Configurable cross-origin resource sharing
- **Enhanced Session Management**: Robust handling of session IDs with fallback mechanisms
- **Detailed Logging**: Comprehensive logging for debugging and monitoring
- **Robust Error Handling**: Prevents common issues like "Headers already sent" errors in SSE connections
- **Tool Call Debugging**: Built-in debug tools to test and validate tool invocation chains
- **Auto-Session Detection**: Automatically selects the correct session when only one is active

## Contributors

- [@StefanBurscher](https://github.com/StefanBurscher)
- [@tarasyarema](https://github.com/tarasyarema)
- [@pcnfernando](https://github.com/pcnfernando)
- [@Areo-Joe](https://github.com/Areo-Joe)
- [@Joffref](https://github.com/Joffref)
- [@michaeljguarino](https://github.com/michaeljguarino)
- [@michaelyn](https://github.com/wizizm)

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions.

## License

[MIT License](./LICENSE)

## Contact

欢迎有兴趣的伙伴+v入群技术沟通：

<img src="mywxqrcode.jpg" alt="微信二维码" width="200"/>

```

```
