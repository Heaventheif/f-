# ── Stage 1: Build Rust shared library (libsunken.so) ────────────
# ICU 2.4 في Cargo.lock يعلن MSRV 1.88؛ Rust 1.85 يفشل قبل الترجمة.
FROM rust:1.88-alpine AS rust-builder
WORKDIR /build
RUN apk add --no-cache build-base musl-dev
# musl يبني بـ crt-static افتراضياً، وهذا يمنع إنتاج cdylib؛ نعطّله.
ENV RUSTFLAGS="-C target-feature=-crt-static"
COPY rust/ ./
# Cargo.lock موجود في الأرشيف؛ --locked يمنع تغييره أو حلّ نسخ مختلفة داخل Docker.
RUN cargo build --locked --release

# ── Stage 2: Install production dependencies ─────────────────────
FROM oven/bun:1-alpine AS deps
WORKDIR /app

# Build tools for native Node/Bun dependencies
RUN apk add --no-cache python3 make g++ gcc git

# bun.lock مطلوب: يثبّت نسخ كل الحزم (بما فيها الاعتماديات غير المباشرة) لبناء قابل للتكرار.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile --production

# ── Stage 3: Runtime image ───────────────────────────────────────
FROM oven/bun:1-alpine AS runner
WORKDIR /app

# ffmpeg required for media splitting
RUN apk add --no-cache ffmpeg libgcc

ENV NODE_ENV=production
ENV PORT=10000
ENV STATE_DIR=/tmp
ENV TMPDIR=/tmp/sunkenbot-media

# Non-privileged user — reduces attack surface
RUN addgroup -S botgroup && adduser -S botuser -G botgroup

# Copy only what is needed from the deps stage
COPY --chown=botuser:botgroup --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=botuser:botgroup . .

# مكتبة Rust المبنية (المسار يطابق rustBridge.js). إن غابت يعمل البوت بـ fallback JS.
COPY --chown=botuser:botgroup --from=rust-builder /build/target/release/libsunken.so ./rust/target/release/libsunken.so
# تحقق: يفشل البناء إن كانت أي مكتبة مشتركة مطلوبة غير موجودة في صورة runtime.
# (لا نستخدم `file`: غير مثبّت في alpine، وكان سيجعل `|| true` يخفي الفحص بصمت.)
RUN ldd ./rust/target/release/libsunken.so 2>&1 | tee /dev/stderr | (! grep -qiE "not found|error loading")

# Writable temporary runtime directories (Render Free has no persistent disk)
RUN mkdir -p /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database \
    && chown -R botuser:botgroup /tmp/broadcast /tmp/sunkenbot-media /app/temp /app/Fca_Database

USER botuser

EXPOSE 10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:10000/health || exit 1

CMD ["bun", "run", "start"]
