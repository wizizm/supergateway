![Supergateway: Run stdio MCP servers over SSE and WS](https://raw.githubusercontent.com/supercorp-ai/supergateway/main/supergateway.png)

**Supergateway** 不仅可以运行 **MCP stdio-based servers** 通过 **SSE (Server-Sent Events)**、**WebSockets (WS)** 或 **Streamable HTTP**，还支持将 OpenAPI 3.0.1 格式的 API 接口定义转换为 MCP 工具。

Supergateway provides complete interoperability between different MCP transport protocols, allowing seamless conversion between stdio, SSE, WS, and Streamable HTTP (the latest MCP standard).

Supported by [Supermachine](https://supermachine.ai) (hosted MCPs), [Superinterface](https://superinterface.ai), and [Supercorp](https://supercorp.ai).

## 功能特点

1. 协议转换

   - 支持 stdio、SSE、WS 和 Streamable HTTP 之间的相互转换
   - 提供完整的 MCP 协议兼容性

2. API 转换

   - 支持将 OpenAPI 3 格式的接口定义转换为 MCP 工具
   - 自动生成工具名称、描述和参数定义
   - 支持复杂的参数类型和验证规则

3. 会话管理
   - 支持多会话并发
   - 自动会话超时清理
   - 详细的会话状态日志

## Installation & Usage

Run Supergateway via `npx`:

```bash
npx -y supergateway --stdio "uvx mcp-server-git"
```

- **`--stdio "command"`**: Command that runs an MCP server over stdio
- **`--sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"`**: SSE URL to connect to (SSE→stdio mode)
- **`--outputTransport stdio | sse | ws | streamable-http`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse`)
- **`--port 8000`**: Port to listen on (stdio→SSE/WS/Streamable-HTTP mode, default: `8000`)
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE, WS, or Streamable HTTP clients (optional)
- **`--ssePath "/sse"`**: Path for SSE subscriptions (stdio→SSE mode, default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (stdio→SSE/WS mode, default: `/message`)
- **`--httpPath "/mcp"`**: Path for Streamable HTTP (stdio→Streamable-HTTP mode, default: `/mcp`)
- **`--header "x-user-id: 123"`**: Add one or more headers (can be used multiple times)
- **`--oauth2Bearer "some-access-token"`**: Adds an `Authorization` header with the provided Bearer token
- **`--logLevel info | none`**: Controls logging level (default: `info`). Use `none` to suppress all logs.
- **`--cors`**: Enable CORS. Use `--cors` with no values to allow all origins, or supply one or more allowed origins (e.g. `--cors "http://example.com"` or `--cors "/example\\.com$/"` for regex matching).
- **`--healthEndpoint /healthz`**: Register one or more endpoints that respond with `"ok"`

## stdio → SSE

Expose an MCP stdio server as an SSE server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

- **Subscribe to events**: `GET http://localhost:8000/sse`
- **Send messages**: `POST http://localhost:8000/message`

## stdio → Streamable HTTP

Expose an MCP stdio server as a Streamable HTTP server (the new MCP protocol standard):

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --outputTransport streamable-http --httpPath /mcp
```

- **Streamable HTTP endpoint**: `http://localhost:8000/mcp`

## SSE → stdio

Connect to a remote SSE server and expose locally via stdio:

```bash
npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
```

Useful for integrating remote SSE MCP servers into local command-line environments.

You can also pass headers when sending requests. This is useful for authentication:

```bash
npx -y supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --oauth2Bearer "some-access-token" \
    --header "X-My-Header: another-header-value"
```

## SSE → Streamable HTTP

Convert a remote SSE MCP server to Streamable HTTP:

```bash
npx -y supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

- **Streamable HTTP endpoint**: `http://localhost:8000/mcp`

## stdio → WS

Expose an MCP stdio server as a WebSocket server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport ws --messagePath /message
```

- **WebSocket endpoint**: `ws://localhost:8000/message`

## Example with MCP Inspector (stdio → SSE mode)

1. **Run Supergateway**:

```bash
npx -y supergateway --port 8000 \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /Users/MyName/Desktop"
```

2. **Use MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector
```

You can now list tools, resources, or perform MCP actions via Supergateway.

## Using with ngrok

Use [ngrok](https://ngrok.com/) to share your local MCP server publicly:

```bash
npx -y supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:
ngrok http 8000
```

ngrok provides a public URL for remote access.

MCP server will be available at URL similar to: https://1234-567-890-12-456.ngrok-free.app/sse

## Running with Docker

A Docker-based workflow avoids local Node.js setup. A ready-to-run Docker image is available here:
[supercorp/supergateway](https://hub.docker.com/r/supercorp/supergateway). Also on GHCR: [ghcr.io/supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway/pkgs/container/supergateway)

### Using the Official Image

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
```

Docker pulls the image automatically. The MCP server runs in the container's root directory (`/`). You can mount host directories if needed.

### Using Streamable HTTP with Docker

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

This exposes the MCP server as a Streamable HTTP server on `http://localhost:8000/mcp`.

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

The Docker image includes all necessary dependencies and runs Supergateway directly from the container without requiring installation from npm.

## Using with Claude Desktop (SSE → stdio mode)

Claude Desktop can use Supergateway's SSE→stdio mode.

### NPX-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

## Using with Cursor (SSE → stdio mode)

Cursor can also integrate with Supergateway in SSE→stdio mode. The configuration is similar to Claude Desktop.

### NPX-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

**Note:** Although the setup supports sending headers via the `--header` flag, if you need to pass an Authorization header (which typically includes a space, e.g. `"Bearer 123"`), you must use the `--oauth2Bearer` flag due to a known Cursor bug with spaces in command-line arguments.

## Using with Modern MCP Clients (Streamable HTTP)

Newer MCP clients support the Streamable HTTP transport, which is recommended for all new integrations. Supergateway makes it easy to connect these clients to any MCP server, regardless of the transport it uses.

### Using with Modern Cursor (Streamable HTTP mode)

Cursor can use Supergateway's stdio→Streamable HTTP mode for more efficient communication:

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

Run Supergateway on your local machine:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

### Backwards Compatibility

Supergateway automatically manages compatibility between different MCP transport mechanisms, allowing you to:

- Connect legacy SSE clients to stdio servers
- Connect modern Streamable HTTP clients to stdio servers
- Connect stdio clients to SSE servers
- Convert SSE servers to Streamable HTTP servers

This ensures smooth transitions as the MCP ecosystem evolves.

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. Supergateway converts between different MCP transport types (stdio, SSE, WS, and Streamable HTTP), simplifying integration and debugging with various clients.

The Streamable HTTP transport is the latest MCP standard, offering improved performance and better compatibility with modern web infrastructure. Supergateway makes it easy to use this transport with any MCP server, regardless of the transport it natively supports.

## Advanced Configuration

Supergateway emphasizes modularity:

- Automatically manages JSON-RPC versioning.
- Retransmits package metadata where possible.
- stdio→SSE or stdio→WS mode logs via standard output; SSE→stdio mode logs via stderr.

## Additional resources

- [Superargs](https://github.com/supercorp-ai/superargs) - provide arguments to MCP servers during runtime.

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

## OpenAPI 转 MCP 服务功能

SuperGateway 现在支持将 OpenAPI 文档转换为 MCP 服务，并提供自动检测文件类型的功能。无论输入是 OpenAPI 规范还是已有的 MCP 模板，系统都能正确识别并处理。

### 使用方法

1. 准备 OpenAPI 文档（JSON 或 YAML 格式）或 MCP 模板文件

2. 使用以下命令启动服务：

```bash
npx -y supergateway --api ./openapi.json --apiHost https://your-api-host.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp --logLevel info
```

SuperGateway 将自动检测文件类型：

- 如果是 OpenAPI 文档，会自动转换为 MCP 模板并提供服务
- 如果是 MCP 模板文件，会直接使用该模板提供服务

### 参数说明

- `--api`: OpenAPI 文档或 MCP 模板文件路径（JSON 或 YAML 格式）
- `--apiHost`: API 服务的基础 URL
- `--outputTransport`: 输出传输方式，使用 streamable-http
- `--port`: 服务监听端口
- `--httpPath`: HTTP 路径前缀
- `--logLevel`: 日志级别

### 功能特点

- **自动检测文件类型**：智能识别输入是 OpenAPI 规范还是 MCP 模板
- 支持直接从 OpenAPI 文档生成 MCP 工具定义
- 支持预生成的 MCP 模板文件（JSON 或 YAML 格式）
- 自动处理路径参数、查询参数、请求体参数和头参数
- 提供详细的请求和响应模板
- 支持所有标准 HTTP 方法（GET, POST, PUT, DELETE, PATCH）
- 提供 `/mcp-config` 调试端点查看加载的 MCP 配置
- 优化的 URL 路径参数处理，支持正确的 URL 编码

### OpenAPI to MCP 转换工具

SuperGateway 还提供了独立的 `openapi-to-mcp` 命令行工具，用于将 OpenAPI 文档转换为 MCP 模板文件：

```bash
# 使用 npx 运行
npx -y supergateway openapi-to-mcp --input openapi.json --output mcp-template.json

# 或者直接使用二进制命令
openapi-to-mcp --input openapi.json --output mcp-template.json
```

#### 参数说明

- `--input, -i`: OpenAPI 规范文件路径 (JSON 或 YAML)
- `--output, -o`: 输出的 MCP 配置文件路径
- `--server-name, -n`: MCP 服务器名称（默认: "openapi-server"）
- `--tool-prefix, -p`: 工具名称前缀（默认: ""）
- `--format, -f`: 输出格式 (yaml 或 json)（默认: "yaml"）
- `--validate, -v`: 验证 OpenAPI 规范（默认: false）
- `--template, -t`: 用于修补输出的模板文件路径（默认: ""）

#### 模板格式

模板文件可以用于自定义生成的 MCP 配置，例如添加通用的请求头或配置变量：

```yaml
server:
  config:
    apiKey: ''

tools:
  requestTemplate:
    headers:
      - key: Authorization
        value: 'Bearer {{.config.apiKey}}'
      - key: X-Ca-Nonce
        value: '{{uuidv4}}'
```

### 使用指南

#### 直接使用 OpenAPI 文档

```bash
npx -y supergateway --api ./openapi.json --apiHost https://api.example.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

#### 使用预生成的 MCP 模板

```bash
# 首先生成 MCP 模板
openapi-to-mcp --input openapi.json --output mcp-template.json

# 然后使用模板启动服务
npx -y supergateway --api ./mcp-template.json --apiHost https://api.example.com \
    --outputTransport streamable-http --port 8000 --httpPath /mcp
```

### 注意事项

- 确保 OpenAPI 文档格式正确
- API Host URL 必须是有效的 HTTPS/HTTP URL
- 所有必需参数都必须提供
- 请求和响应的 Content-Type 默认为 application/json
- 可以通过访问 `/mcp-config` 端点查看加载的 MCP 工具配置
