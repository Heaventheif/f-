# ── Stage 1: Install production dependencies ─────────────────────
FROM oven/bun:1-alpine AS deps
WORKDIR /app

# Build tools needed for native modules (e.g. sqlite3)
RUN apk add --no-cache python3 make g++ gcc git

COPY package.json bun.lock* ./

RUN bun install --production

# ── Stage 2: Runtime image ───────────────────────────────────────
FROM oven/bun:1-alpine AS runner
WORKDIR /app

# ffmpeg required for media splitting
RUN apk add --no-cache ffmpeg

ENV NODE_ENV=production
ENV PORT=10000
ENV STATE_DIR=/app/data

# Non-privileged user — reduces attack surface
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

# Copy only what is needed from the deps stage
COPY --chown=botuser:botgroup --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=botuser:botgroup . .

# Writable runtime directories — appstate, db, tmp media
RUN mkdir -p /app/data /app/temp /app/Fca_Database \
    && chown -R botuser:botgroup /app/data /app/temp /app/Fca_Database

USER botuser

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:10000/health || exit 1

CMD ["bun", "run", "start"]
