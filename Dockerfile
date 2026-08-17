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
# In CI, APK_FILE is set to the path of the APK within the build context.
# For local dev builds without an APK, omit the build-arg and no APK will be included.
ARG APK_FILE="public/downloads/.gitkeep"
RUN mkdir -p ./public/downloads
COPY ${APK_FILE} ./public/downloads/svarla.apk

EXPOSE 3000

CMD ["node", "dist/index.js"]
