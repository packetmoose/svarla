FROM node:20-slim AS builder

ARG BUILD_VERSION

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -n "$BUILD_VERSION" ]; then \
      node -e "const p=require('./package.json'); p.version='$BUILD_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n')"; \
    fi
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

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -n "$BUILD_VERSION" ]; then \
      node -e "const p=require('./package.json'); p.version='$BUILD_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p, null, 2)+'\n')"; \
    fi
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist/migrations ./migrations-compiled
COPY server-config.yaml ./
COPY public/ ./public/

# APK downloads directory.
# The APK is provisioned at runtime by ApkProvisioningService:
# - Production: fetched from GitHub release matching the server version
# - Development: volume-mounted from local build output
# - Self-builders: volume-mounted or provided via APK_SOURCE=local
RUN mkdir -p ./public/downloads

EXPOSE 3000

CMD ["node", "dist/index.js"]
