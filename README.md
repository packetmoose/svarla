# Svarla

> This project was built with the help of AI (Kiro). Much of the code, documentation, and configuration was generated or co-authored in collaboration with an AI assistant.

> **Heads up:** Svarla is still in active development and rough around the edges. APIs may change without notice, there are known security gaps, and things will break. Don't run this on the public internet expecting it to behave like a finished product — treat it as an experiment, not infrastructure.

A personal softphone application for making and receiving phone calls and SMS over a data connection. Runs a self-hosted server with a native Android client and a web interface.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Server Host / Docker                         │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐ │
│  │   Node.js / Fastify  │         │   MediaBridge (Pion / Go)    │ │
│  │                      │  REST   │                              │ │
│  │  Call Orchestrator   ─┼────────►  ControlAPI (port 9090)      │ │
│  │  Provider Registry    │         │  WebRTC Endpoint (10443/TCP) │ │
│  │  WebSocket + REST     │◄────────┤  Event WS (→ Server)        │ │
│  │  (client signaling)   │ events  │  SIP UAS (port 5060)        │ │
│  │                      │         │  Audio WS (port 9091)        │ │
│  └──────────────────────┘         └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲              ▲
         │ WebSocket + REST                   │ WebRTC/TCP   │ SIP / Audio WS
         │                                    │              │
    ┌────┴─────┐                         ┌────┴────┐   ┌────┴──────────┐
    │ Android  │                         │ Android │   │ Provider      │
    │ (signal) │                         │ (audio) │   │ (Vonage/46elks│
    └──────────┘                         └─────────┘   │  /Modem+Pi)  │
                                                       └───────────────┘
```

## Components

- **Server** — Node.js 20, TypeScript, Fastify, PostgreSQL, WebSocket real-time sync
- **MediaBridge** — Go sidecar (Pion WebRTC), terminates client WebRTC and bridges audio to providers via SIP or WebSocket
- **Android app** — Kotlin, Jetpack Compose, Material3, WebRTC audio (no provider SDKs)
- **Web interface** — Preact SPA bundled with esbuild, served by the server

Telephony providers (Vonage, 46elks, ModemManager) are managed through the API at runtime — no restart needed to add or reconfigure numbers. The Android client is fully provider-agnostic and connects all call audio through the MediaBridge.

---

## Getting Started with Docker (development)

The fastest path to a running instance. Requires Docker and Docker Compose. The root compose files build from source and have sensible defaults — no `.env` file needed.

### 1. Clone and run

```bash
git clone <repo-url> && cd svarla
docker compose up -d
```

That's it. The server is at `http://localhost:3000` with password `dev`.

### Production deployment (pre-built images)

For production, use the example compose files in `docker/`. These pull pre-built images from GitHub Container Registry — no source checkout needed:

```bash
cd docker
cp .env.example .env
# Edit .env with your values (POSTGRES_PASSWORD, INITIAL_PASSWORD, PUBLIC_IP)
docker compose up -d
```

To add TLS via Caddy:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

See `docker/README.md` for full details.

---

## Getting Started without Docker

### Prerequisites

- Node.js 20+
- PostgreSQL 16+
- npm

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

```bash
createdb svarla
cp .env.example .env
# Edit .env — set DATABASE_URL and INITIAL_PASSWORD at minimum
npm run migrate
```

### 3. Build and run

```bash
npm run build        # Compile server TypeScript
npm run build:web    # Bundle the web interface
npm start            # Start production server
```

Or for development with hot-reload:

```bash
npm run dev
```

---

## MediaBridge Setup

The MediaBridge is a Go sidecar that handles WebRTC audio termination and bridges audio to telephony providers via SIP or WebSocket streams. It runs alongside the Node.js server.

### Building the MediaBridge

```bash
cd mediabridge
go build -o mediabridge ./cmd/mediabridge/
```

For a static binary (Docker/production):

```bash
cd mediabridge
CGO_ENABLED=0 go build -o mediabridge ./cmd/mediabridge/
```

### Configuration

Edit `mediabridge/mediabridge-config.yaml`:

| Setting | Default | Description |
|---------|---------|-------------|
| `webrtcPort` | 10443 | TCP port for client WebRTC connections (public) |
| `controlApiPort` | 9090 | HTTP port for ControlAPI (localhost only) |
| `sipPort` | 5060 | SIP port for provider audio (public) |
| `audioWsPort` | 9091 | WebSocket port for provider audio streams (public) |
| `publicIp` | 127.0.0.1 | Public IP advertised in ICE candidates |
| `audio.ringbackCadence` | eu | Ringback pattern: "eu" or "us" |
| `audio.opusMaxBitrate` | 32000 | Opus max bitrate (bps) |
| `audio.sipCodec` | g711_ulaw | SIP codec: "g711_ulaw" or "opus" |
| `logging.level` | info | Log level: debug/info/warn/error |
| `logging.format` | json | Log format: "json" or "text" |

### Running

```bash
cd mediabridge
./mediabridge
```

The MediaBridge connects to the Server's internal event WebSocket on startup and begins accepting sessions via the ControlAPI.

### Port Requirements

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| 10443 | TCP | Inbound (clients) | WebRTC (ICE/DTLS/SRTP) |
| 9090 | HTTP | Localhost only | ControlAPI (Server → MediaBridge) |
| 5060 | UDP+TCP | Inbound (providers) | SIP for provider audio |
| 9091 | WebSocket | Inbound (providers) | Audio streams (modem/Pi) |

---

## Building the Android App in Docker

You can produce a release APK without installing Android Studio or the Android SDK locally.

### Build the APK

```bash
docker build -f android/Dockerfile.build -t svarla-android-builder android/
docker run --rm -v "$(pwd)/android/output:/output" svarla-android-builder
```

The signed (debug) APK will be at `android/output/app-debug.apk`.

For a release build, you'll need to supply a keystore. Mount it and set signing config in `app/build.gradle.kts`.

---

## Building the Android App Locally

### With Android Studio

1. Open the `android/` directory in Android Studio.
2. Sync Gradle when prompted.
3. Run on a device or emulator (minimum API 26).

### Command line

```bash
cd android
./gradlew assembleDebug
# APK → app/build/outputs/apk/debug/app-debug.apk

./gradlew installDebug   # Install on connected device
./gradlew test           # Run unit tests
```

Requires JDK 17 and the Android SDK with platform 34 installed.

---

## Connecting the Android App

On the login screen, enter:

- **Server URL** — Your server's address (e.g. `https://phone.example.com` or `http://192.168.1.50:3000`)
- **Password** — The password you set via `INITIAL_PASSWORD`

The app registers the device, syncs history via WebSocket, and is ready to make calls.

---

## Environment Variables

All variables are documented in `.env.example`. The key ones:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `INITIAL_PASSWORD` | First run | Seeds the login password |
| `POSTGRES_PASSWORD` | Docker | Database password for the Postgres container |
| `BASE_URL` | For providers | Public URL where telephony providers send callbacks |
| `PUBLIC_IP` | Production | Public IP for MediaBridge ICE candidates |
| `MEDIA_BRIDGE_URL` | Optional | MediaBridge URL (default: http://localhost:9090) |
| `CORS_ORIGIN` | Web interface | Comma-separated allowed origins |
| `CONFIG_ENCRYPTION_KEY` | Optional | Encrypts provider secrets at rest (AES-256-GCM) |
| `DOMAIN` | Caddy | Public domain for TLS |

---

## Server Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot-reload (tsx watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run build:web` | Bundle the web interface to `dist/web/` |
| `npm start` | Run compiled production server |
| `npm test` | Run tests (vitest) |
| `npm run lint` | Lint with ESLint |
| `npm run migrate` | Run database migrations |

---

## Adding a Telephony Provider

Providers are managed through the API (or the web interface under Settings → Providers).

### Vonage

1. Create a Vonage Application at https://dashboard.nexmo.com/applications with Voice and Messages capabilities.
2. Set webhook URLs on the Vonage dashboard:
   - Answer URL: `{WEBHOOK_BASE_URL}/webhooks/answer`
   - Event URL: `{WEBHOOK_BASE_URL}/webhooks/event`
   - Inbound SMS: `{WEBHOOK_BASE_URL}/webhooks/inbound-sms`
   - SMS Status: `{WEBHOOK_BASE_URL}/webhooks/sms-status`
3. Add the provider via the API or web interface with your API key, secret, application ID, and private key.

Audio for Vonage calls is routed through the MediaBridge via SIP (Vonage connects to the MediaBridge's SIP port using the NCCO `connect` action with type `sip`).

### 46elks

1. Create an account at https://46elks.com and get your API credentials (username and password).
2. Purchase a number and configure webhooks on the 46elks dashboard:
   - `voice_start`: `{WEBHOOK_BASE_URL}/webhooks/46elks/voice_start`
   - `sms_url`: `{WEBHOOK_BASE_URL}/webhooks/46elks/sms_incoming`
3. Add the provider via the API or web interface with your API username, API password, and webhook base URL.

Audio for 46elks calls is routed through the MediaBridge via SIP (46elks connects to the MediaBridge's SIP port using the `connect` action in webhook responses).

### ModemManager

Plug a USB modem with a SIM card into the host. The server auto-discovers modems via D-Bus. If your SIM doesn't self-report its number, configure an override in the provider settings keyed by ICCID.

Note: ModemManager requires the server to run directly on a Linux host with D-Bus access (not inside the Docker container).

---

## Project Structure

```
├── src/                    # Server source (TypeScript)
├── web/                    # Web interface (Preact)
├── migrations/             # PostgreSQL migrations (Kysely)
├── android/                # Android app (Kotlin/Compose)
├── mediabridge/            # MediaBridge sidecar (Go/Pion)
│   ├── cmd/mediabridge/    # Entry point
│   ├── internal/           # Internal packages
│   ├── Dockerfile          # MediaBridge container image
│   └── mediabridge-config.yaml
├── docker/                 # Production deployment examples (pre-built images)
│   ├── docker-compose.yml          # Server + MediaBridge (pre-built images)
│   ├── docker-compose.caddy.yml    # Caddy TLS overlay
│   ├── Caddyfile
│   ├── .env.example
│   └── README.md
├── public/                 # Static assets (icons, favicon)
├── docker-compose.yml      # Dev: builds from source
├── Dockerfile              # Server container image
├── server-config.yaml      # Runtime config
└── .env.example            # Environment variable reference
```

---

## Port Requirements

The full deployment exposes several ports. Ensure your firewall and hosting provider allow these:

| Port | Protocol | Service | Direction | Purpose |
|------|----------|---------|-----------|---------|
| 3000 | TCP | Server | Inbound (clients + webhooks) | REST API and WebSocket signaling |
| 10443 | TCP | MediaBridge | Inbound (clients) | WebRTC ICE/DTLS/SRTP audio transport |
| 5060 | UDP + TCP | MediaBridge | Inbound (providers) | SIP signaling and audio from telephony providers |
| 9091 | TCP | MediaBridge | Inbound (providers) | WebSocket audio stream (for hardware/Pi providers) |
| 9090 | TCP | MediaBridge | Internal only | ControlAPI + event WebSocket (server ↔ mediabridge, localhost/container network) |

### Exposure guidelines

- **Public (internet-facing):** 3000 (or 443 via Caddy), 10443
- **Provider-facing:** 5060, 9091 — restrict to your telephony provider IPs if possible
- **Internal only:** 9090 — never expose to the internet; communication between containers on the Docker bridge network

When using the Caddy TLS overlay, port 443 replaces direct access to port 3000. Port 10443 (WebRTC) is **not** proxied through Caddy — it uses DTLS encryption directly between the client and MediaBridge, so no additional TLS termination is needed.

---

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).

## Trademark

"Svarla" is a trademark. The source code is freely licensed under AGPL-3.0, but the name and logo may not be used to market derivative works without permission.
