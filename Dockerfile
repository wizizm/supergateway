FROM node:20-alpine
# 设置工作目录
WORKDIR /app

# 设置npm镜像源
RUN npm config set registry https://registry.npmmirror.com/

# 复制package.json和package-lock.json
COPY package*.json ./

RUN echo '#!/bin/sh\nexit 0' > /usr/local/bin/husky && chmod +x /usr/local/bin/husky

# 安装依赖
RUN npm ci --only=production --ignore-scripts

# 复制源代码和编译后的文件
COPY dist/ ./dist/
COPY README.md ./
COPY LICENSE ./

# 全局安装当前包
RUN npm link --ignore-scripts

# 设置环境变量以确保supergateway命令可用
ENV PATH /app/node_modules/.bin:$PATH

# 暴露默认端口
EXPOSE 8000

# 设置入口点
ENTRYPOINT ["supergateway"]

# 默认命令
CMD ["--help"]
