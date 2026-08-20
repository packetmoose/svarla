# Svarla

> **Heads up:** Svarla is in active development and rough around the edges. APIs may change, and things might break.

A self-hosted softphone for making and receiving phone calls and SMS over a data connection. Runs on your own server with a native Android client and a web interface.

**Components:** Node.js/Fastify server · Go MediaBridge (Pion WebRTC) · Kotlin/Compose Android app · Preact web interface

Telephony providers (Vonage, 46elks, ModemManager) are managed at runtime — no restart needed to add or reconfigure numbers.

## Quick Start

Requires Docker and Docker Compose. The root compose file builds from source with sensible defaults:

```bash
git clone https://github.com/packetmoose/svarla.git && cd svarla
docker compose up -d
```

Server is at `http://localhost:3000` with password `dev`.

For production deployment with pre-built images, see the [installation guide](https://svarla.app/guide/install-docker).

## Building from Source

The project uses a **Makefile** as the primary build interface. All targets use Docker for reproducible builds — no local SDKs required.

| Target | Description |
|--------|-------------|
| `make apk` | Build unsigned Android APK in Docker |
| `make sign-apk` | Sign the APK with a local keystore |
| `make server` | Build the server container image |
| `make mediabridge` | Build the MediaBridge container image |
| `make all` | Build everything (APK + sign + containers) |
| `make clean` | Remove build artifacts |
| `make help` | Show all targets with descriptions |

```bash
# Build a debug APK
make apk BUILD_TYPE=debug

# Build server container with a specific tag
make server IMAGE_TAG=v1.2.0
```

For server development with hot-reload (requires Node.js 20+ and PostgreSQL):

```bash
npm install
cp .env.example .env   # edit DATABASE_URL and INITIAL_PASSWORD
npm run migrate
npm run dev
```

Full build instructions: [svarla.app/guide/install-manual](https://svarla.app/guide/install-manual)

## Creating a Release

Releases follow a two-phase flow:

1. **`make release-tag`** — Creates a signed git tag and pushes it, triggering CI to build container images.
2. **`make release-sign`** — Signs CI artifacts (APK + containers via Cosign) and publishes the GitHub release.

Or as a single command that handles both phases: **`make release`**

Release notes are driven by files in `docs/releases/` — create a `vX.Y.Z.md` file before running the release. See `scripts/release.sh` for details.

## Documentation

Full documentation is available at **[svarla.app](https://svarla.app)**:

- [Installation (Docker)](https://svarla.app/guide/install-docker) — Production deployment with pre-built images
- [Building from source](https://svarla.app/guide/install-manual) — Development setup without Docker
- [Architecture](https://svarla.app/guide/architecture) — How the components fit together
- [Server configuration](https://svarla.app/config/server) — server-config.yaml and environment variables
- [MediaBridge configuration](https://svarla.app/config/mediabridge) — mediabridge-config.yaml reference
- [Port requirements](https://svarla.app/config/ports) — Firewall and networking guide
- [Android app](https://svarla.app/guide/android) — Installing, building, and connecting
- [Providers](https://svarla.app/guide/providers-overview) — Setting up Vonage, 46elks, or ModemManager

## Project Structure

```
├── src/                    # Server source (TypeScript)
├── web/                    # Web interface (Preact)
├── migrations/             # PostgreSQL migrations (Kysely)
├── android/                # Android app (Kotlin/Compose)
├── mediabridge/            # MediaBridge sidecar (Go/Pion)
├── scripts/                # Build and release scripts
├── docker/                 # Production deployment (pre-built images)
├── docs/                   # Documentation site (VitePress)
├── public/                 # Static assets
├── Makefile                # Build system entry point
├── docker-compose.yml      # Dev compose (builds from source)
├── Dockerfile              # Server container image
├── server-config.yaml      # Server runtime config
└── .env.example            # Environment variable reference
```

## License

Licensed under the [GNU Affero General Public License v3.0](LICENSE).

## Trademark

"Svarla" is a trademark. The source code is freely licensed under AGPL-3.0, but the name and logo may not be used to market derivative works without permission.
