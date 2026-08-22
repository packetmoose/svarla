FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY tsconfig.migrations.json ./
COPY src/ ./src/
COPY web/ ./web/
COPY public/ ./public/
COPY migrations/ ./migrations/

RUN npm run build
RUN npm run build:web
COPY tsconfig.migrations.json ./
RUN npx tsc --project tsconfig.migrations.json

# Production image
FROM node:20-slim

ARG BUILD_VERSION
ARG GIT_REF
ARG BUILD_REF

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist/migrations ./migrations-compiled
COPY server-config.yaml ./
COPY public/ ./public/

# Generate version.json from build args
RUN printf '{"version":"%s","gitRef":"%s","buildRef":"%s","buildDate":"%s"}\n' \
    "${BUILD_VERSION:-999.0.0-dev}" \
    "${GIT_REF:-}" \
    "${BUILD_REF:-}" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > version.json

# APK downloads directory.
# The APK is provisioned at runtime by ApkProvisioningService:
# - Production: fetched from GitHub release matching the server version
# - Development: volume-mounted from local build output
# - Self-builders: volume-mounted or provided via APK_SOURCE=local
RUN mkdir -p ./public/downloads

EXPOSE 3000

CMD ["node", "dist/index.js"]
