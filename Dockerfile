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

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dist/migrations ./migrations-compiled
COPY server-config.yaml ./
COPY public/ ./public/

# Copy the signed APK into the container for self-hosted distribution.
# - Release builds: APK_FILE points to the real signed APK (set by build-server.sh or CI)
# - Dev builds: defaults to .gitkeep placeholder (download page shows "not available")
ARG APK_FILE="public/downloads/.gitkeep"
RUN mkdir -p ./public/downloads
COPY ${APK_FILE} ./public/downloads/svarla.apk

EXPOSE 3000

CMD ["node", "dist/index.js"]
