FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine
WORKDIR /app
RUN apk add --no-cache ffmpeg \
    && addgroup -S botgroup && adduser -S botuser -G botgroup
ENV NODE_ENV=production \
    PORT=10000 \
    STATE_DIR=/tmp \
    TMPDIR=/tmp/sunkenbot-media
COPY --from=deps --chown=botuser:botgroup /app/node_modules ./node_modules
COPY --chown=botuser:botgroup . .
RUN mkdir -p /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database \
    && chown -R botuser:botgroup /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database
USER botuser
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q --spider http://localhost:10000/health || exit 1
CMD ["bun", "run", "start"]
