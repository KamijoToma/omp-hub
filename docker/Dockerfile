# syntax=docker/dockerfile:1
# omp-hub all-in-one image: collab relay + registry API + web UI on a single port.
#
# Build:  docker build -f docker/Dockerfile -t omp-hub .
# Run:    docker run --rm -p 127.0.0.1:8080:8080 -e HUB_TOKEN="$HUB_TOKEN" omp-hub
#
# The wrapper agent (packages/agent) is intentionally NOT in this image — it runs on the
# machines being controlled, where it needs the local filesystem, shell, and omp auth store.

# ── Stage 1: build the web UI ────────────────────────────────────────────────
FROM docker.io/oven/bun:1.3.14 AS web
WORKDIR /build
COPY packages/web/package.json packages/web/bun.lock* ./
RUN bun install --frozen-lockfile
COPY packages/web/ ./
RUN bun run build

# ── Stage 2: hub runtime ─────────────────────────────────────────────────────
FROM docker.io/oven/bun:1.3.14-slim
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIST=/app/web/dist

COPY LICENSE ./LICENSE
# Hub has zero runtime dependencies — sources are enough.
COPY packages/hub/package.json packages/hub/tsconfig.json ./packages/hub/
COPY packages/hub/src ./packages/hub/src
COPY --from=web /build/dist ./web/dist
# Preserve notices for libraries bundled into the static web assets.
COPY --from=web /build/node_modules/react/LICENSE ./licenses/react-LICENSE
COPY --from=web /build/node_modules/react-dom/LICENSE ./licenses/react-dom-LICENSE
COPY --from=web /build/node_modules/scheduler/LICENSE ./licenses/scheduler-LICENSE
COPY --from=web /build/node_modules/lucide-react/LICENSE ./licenses/lucide-react-LICENSE
COPY --from=web /build/node_modules/marked/LICENSE ./licenses/marked-LICENSE
USER bun

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# HUB_TOKEN is required; keep the published port private unless HTTPS/WSS and access control apply.
# Optional: HUB_PUBLIC_URL=https://hub.example.com  (mint wss/https links behind a proxy)
#           HUB_TLS_CERT=/certs/cert.pem HUB_TLS_KEY=/certs/key.pem
CMD ["bun", "packages/hub/src/server.ts"]
