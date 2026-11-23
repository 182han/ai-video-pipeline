# ==========================================
# AI 长视频自动生成流水线 - 容器镜像
# ==========================================
# 推荐用法（服务器/交付）：用同目录的 docker-compose.yml
#   docker compose up -d --build
#
# 单容器手动跑：
#   docker build -t ai-video-pipeline .
#   docker run -d -p 3001:3001 --env-file .env ai-video-pipeline
#
# 端口口径：全仓库统一 3001（config.js 默认值 / .env / 启动脚本 / 本文档）。
# Hugging Face Spaces 部署时，README 的 app_port 也必须是 3001。
# ==========================================

FROM node:20-slim

# ffmpeg 是硬依赖（拼接/转码/质检都要用），必须装进镜像
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖，利用 Docker 层缓存。
#
# 已知缺口（2026-11-23 复核）：仓库里的 package-lock.json 停在 2026-10-13，
# 缺 pg 与 @aws-sdk/client-s3，因此：
#   · 不能用 npm ci（会报 lock 与 package.json 不同步，构建直接失败）
#   · 这里只 COPY package.json，由 npm install 按 package.json 解析依赖
# 想要可复现构建：先在装有 npm 的机器上重新生成锁文件，再把本行改回 npm ci。
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷代码。
# .dockerignore 已排除：node_modules、运行时产物（clips/output/data 下的用户数据）、
# 本机凭据（.env、data/users.json、data/budget.json）、Windows 专用二进制（tools/asr）。
COPY . .

# 运行时目录。
# 容器内是临时盘：正式部署请用 docker-compose.yml 的卷挂载，
# 或者接对象存储（STORAGE_DRIVER=supabase|s3）。
RUN mkdir -p clips output data/tasks data/trash data/library data/photos \
      data/projects data/thumbnails data/logs data/recycle data/tmp

ENV NODE_ENV=production
ENV PORT=3001
# 镜像内 ffmpeg 在 PATH 里，不要指定绝对路径
ENV FFMPEG_PATH=
ENV FFPROBE_PATH=

EXPOSE 3001

# 健康检查打 /healthz（只回 {"ok":true}）。
# 不要用 /api/status：它会返回 pid、启动时间、模型名，不适合作为对外探活端点。
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
