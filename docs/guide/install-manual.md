# Building from Source

If you want to develop Svarla or run it without pulling pre-built images, you can build everything from source.

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Go 1.22+ (for MediaBridge, only if building without Docker)
- Docker (for container builds and APK builds)
- Make

## Using the Makefile

The project provides a **Makefile** as the primary build interface. All container and APK builds use Docker for reproducibility — no local Android SDK or Go toolchain required.

```bash
git clone https://github.com/packetmoose/svarla.git
cd svarla
make help    # show all available targets
```

### Key targets

| Target | Description |
|--------|-------------|
| `make apk` | Build unsigned Android APK in Docker |
| `make sign-apk` | Sign the APK with a local keystore |
| `make server` | Build server container image |
| `make mediabridge` | Build MediaBridge container image |
| `make all` | Build everything (APK + sign + containers) |
| `make release-apk` | Build and sign APK locally (no tag, no publish) |
| `make clean` | Remove build artifacts |

### Environment overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILD_TYPE` | `release` | APK build type (`debug` or `release`) |
| `IMAGE_TAG` | `dev` | Docker image tag |
| `KEYSTORE_PATH` | `~/.android/release.keystore` | Path to Android signing keystore |
| `REGISTRY` | *(empty)* | Container registry prefix |
| `PUSH` | `false` | Push images to registry after build |
| `PLATFORM` | *(native)* | Docker platform(s) for cross-compilation |

### Examples

```bash
# Build a debug APK
make apk BUILD_TYPE=debug

# Build server container with a version tag
make server IMAGE_TAG=v1.2.0

# Build everything with your own signing key
KEYSTORE_PATH=~/my.keystore make all
```

## Server development (without Docker)

For day-to-day server development with hot-reload:

```bash
npm install
cp .env.example .env
# Edit .env — set DATABASE_URL and INITIAL_PASSWORD at minimum
npm run migrate
npm run dev
```

### npm scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:web` | Bundle the web interface to `dist/web/` |
| `npm start` | Run compiled production server |
| `npm test` | Run tests (vitest) |
| `npm run lint` | Lint with ESLint |
| `npm run migrate` | Run database migrations |

## MediaBridge development (without Docker)

If you need to work on the MediaBridge directly (requires Go 1.22+):

```bash
cd mediabridge
go build -o mediabridge ./cmd/mediabridge/
./mediabridge
```

Edit `mediabridge-config.yaml` to set `network.publicIp` to your server's public IP.

## Development with Docker Compose

The root `docker-compose.yml` (in the repo root, not `docker/`) builds everything from source with sensible defaults — no `.env` file needed:

```bash
git clone https://github.com/packetmoose/svarla.git
cd svarla
docker compose up -d
```

Server is at `http://localhost:3000` with password `dev`.

::: info
The dev compose setup is for local development only. For production deployment with TLS, a public IP, and a domain, see [Installation](/guide/install-docker).
:::
