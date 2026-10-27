FROM node:22-alpine

# 商品图主色校验（可选）：Alpine 包名是 py3-pillow；装不上也继续构建（代码会自动跳过校验）
RUN apk add --no-cache python3 py3-pillow \
 || apk add --no-cache python3 \
 || true

WORKDIR /app
ENV NODE_ENV=production \
    PORT=4174 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai

COPY package.json server.mjs ./
COPY lib ./lib
COPY web ./web
# 色卡放进镜像，避免挂载空 data 目录后丢失（代码会优先读 data/catalog，再回退 /app/catalog）
COPY data/catalog ./catalog
COPY data/examples ./data/examples

EXPOSE 4174
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4174)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
