FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ gcc git
COPY package.json bun.lock bunfig.toml ./
RUN bun install --production
FROM oven/bun:1.3-alpine AS runner
WORKDIR /app
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
ENV PORT=10000
ENV STATE_DIR=/tmp
ENV TMPDIR=/tmp/sunkenbot-media
RUN addgroup -S botgroup && adduser -S botuser -G botgroup
COPY --chown=botuser:botgroup --from=deps /app/node_modules ./node_modules
COPY --chown=botuser:botgroup . .
RUN mkdir -p /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database \
    && chown -R botuser:botgroup /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database
USER botuser
STOPSIGNAL SIGTERM
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-10000}/health || exit 1
CMD ["bun", "--smol", "main.js"]
