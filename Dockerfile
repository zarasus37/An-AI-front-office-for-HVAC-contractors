# ── Stage 1: install dependencies ──────────────────────────────────────────────
FROM node:22-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# Add a app user so the container doesn't run as root
RUN addgroup -g 1001 -S hvac && \
    adduser  -S hvac -u 1001 -G hvac

WORKDIR /app

# Copy installed node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source
COPY --chown=hvac:hvac . .

# Directory for queue JSONL + snapshot persistence
# Mount this as a volume so leads survive container restarts:
#   docker run -v ./data:/app/data ...
RUN mkdir -p /app/data && chown hvac:hvac /app/data

USER hvac

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Health check — just confirms the process is up
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Start the server; override CMD with arguments if you need a custom start command
CMD ["node", "src/server.js"]
