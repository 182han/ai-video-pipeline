# ==========================================
# AI 长视频自动生成流水线 - 容器镜像
# ==========================================
# 本地构建运行：
#   docker build -t ai-video-pipeline .
#   docker run -p 3000:3000 --env-file .env ai-video-pipeline
#
# 部署到 Hugging Face Spaces / Railway / Fly.io 时直接使用本文件。
# ==========================================

FROM node:20-slim

# ffmpeg 是硬依赖（拼接/转码/质检都要用），必须装进镜像
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
# 注意：不用 npm ci —— 本项目主要用 pnpm，package-lock.json 可能与
# package.json 不同步，npm ci 会因此报错退出，导致构建失败。
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷代码
COPY . .

# 运行时目录（容器里是临时盘，正式部署请挂载持久卷或接对象存储）
RUN mkdir -p clips output data/tasks data/trash

ENV NODE_ENV=production
ENV PORT=3000
# 镜像内 ffmpeg 在 PATH 里，不要指定绝对路径
ENV FFMPEG_PATH=
ENV FFPROBE_PATH=

EXPOSE 3000

# 健康检查：命中 /api/status
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
