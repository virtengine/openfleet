# ── Bosun Docker Image ────────────────────────────────────────────────────────
# Multi-stage build: install deps in a builder stage, copy to slim runtime.
#
# Build:   docker build -t bosun .
# Run:     docker run -d -p 3080:3080 -v bosun-data:/data bosun
# Compose: docker compose up -d
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json* ./

# Install production deps only (skip optional / dev)
RUN npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-slim

# tini: lightweight init — reaps zombie processes and forwards signals
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends tini git openssh-client ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Reuse the built-in node user (UID 1000) — no need to create a new one
# Data directory — persistent volume mount point
RUN mkdir -p /data && chown node:node /data

WORKDIR /app

# Copy installed node_modules from builder
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY . .

# Default environment for container mode
ENV BOSUN_DOCKER=1 \
    BOSUN_HOME=/data \
    BOSUN_DIR=/data \
    NODE_ENV=production \
    # Bind to all interfaces so Docker port mapping works
    HOST=0.0.0.0

# Expose the unified UI/API port
EXPOSE 3080

# Health check using the /healthz endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -ksf https://localhost:3080/healthz || curl -sf http://localhost:3080/healthz || exit 1

# Switch to non-root
USER node

# tini as PID 1 — reaps orphaned processes and forwards SIGTERM/SIGINT
ENTRYPOINT ["tini", "--"]

# Start via the unified entrypoint
CMD ["node", "entrypoint.mjs"]
