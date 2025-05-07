#!/bin/bash
# 构建Docker镜像的脚本

# 设置镜像名称和标签
IMAGE_NAME="supergateway"
TAG="latest"

# 显示构建信息
echo "===== 开始构建 Supergateway Docker 镜像 ====="
echo "镜像名称: $IMAGE_NAME:$TAG"

# 设置npm镜像源(使用淘宝镜像)
echo "配置npm镜像源为淘宝镜像..."
npm config set registry https://registry.npmmirror.com/

# 首先编译TypeScript
echo "步骤 1: 编译TypeScript..."
npm run build
if [ $? -ne 0 ]; then
  echo "编译失败，构建中止!"
  exit 1
fi
echo "编译成功!"

# 构建Docker镜像
echo "步骤 2: 构建Docker镜像..."
docker build --no-cache -t $IMAGE_NAME:$TAG .
if [ $? -ne 0 ]; then
  echo "Docker构建失败!"
  echo "可能的原因:"
  echo "1. 无法访问Docker镜像仓库，检查网络连接"
  echo "2. 尝试使用以下命令切换到国内镜像源:"
  echo "   sudo vi /etc/docker/daemon.json"
  echo "   添加: {\"registry-mirrors\": [\"https://docker.mirrors.ustc.edu.cn\", \"https://hub-mirror.c.163.com\"]}"
  echo "   然后重启Docker: sudo systemctl restart docker"
  echo "3. 如果使用的是Mac或者Windows，请在Docker Desktop设置中添加镜像源"
  exit 1
fi

echo "===== Supergateway Docker 镜像构建成功! ====="
echo ""
echo "使用示例:"
echo "1. stdio → Streamable HTTP:"
echo "   docker run -it --rm -p 8000:8000 $IMAGE_NAME:$TAG \\"
echo "       --stdio \"npx -y @modelcontextprotocol/server-filesystem /\" \\"
echo "       --outputTransport streamable-http --port 8000 --httpPath /mcp"
echo ""
echo "2. SSE → Streamable HTTP:"
echo "   docker run -it --rm -p 8000:8000 $IMAGE_NAME:$TAG \\"
echo "       --sse \"https://mcp-server-example.supermachine.app\" \\"
echo "       --outputTransport streamable-http --port 8000 --httpPath /mcp"
echo "" 