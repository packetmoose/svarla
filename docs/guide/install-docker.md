# Installation

Svarla runs as a set of Docker containers. You don't need to clone the source code — just create a compose file and start it.

## Prerequisites

- A Linux server (VPS, home server, etc.)
- Docker and Docker Compose installed
- **A public IP address** — required for WebRTC audio and provider SIP connections
- **A domain name with TLS (HTTPS)** — required for provider webhooks and the web interface
- A DNS A record pointing your domain to the server's public IP

::: warning Required: Public IP + TLS
Svarla **will not work** without a public IP and TLS. Telephony providers (Vonage, 46elks) require HTTPS callback URLs for incoming calls and SMS. The MediaBridge needs a public IP so clients can connect for call audio and providers can reach it via SIP. Without these, signaling may appear to work but calls will have no audio and incoming events won't arrive.
:::

## 1. Create the deployment directory

```bash
mkdir svarla && cd svarla
```

## 2. Create `docker-compose.yml`

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: svarla
      POSTGRES_USER: svarla
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U svarla"]
      interval: 5s
      timeout: 3s
      retries: 5

  server:
    image: ghcr.io/packetmoose/svarla-server:latest
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgresql://svarla:${POSTGRES_PASSWORD}@db:5432/svarla
      INITIAL_PASSWORD: ${INITIAL_PASSWORD}
      PUBLIC_IP: ${PUBLIC_IP}
      MEDIA_BRIDGE_URL: http://mediabridge:9090
      BASE_URL: ${BASE_URL:-}
      CORS_ORIGIN: ${CORS_ORIGIN:-}
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  mediabridge:
    image: ghcr.io/packetmoose/svarla-mediabridge:latest
    ports:
      - "10443:10443"       # WebRTC (TCP)
      - "10443:10443/udp"   # WebRTC (UDP)
      - "5060:5060/udp"     # SIP (UDP)
      - "5060:5060/tcp"     # SIP (TCP)
      - "5061:5061/tcp"     # SIP TLS (SIPS)
      - "5062:5062/udp"     # RTP media (SIP audio)
      - "9091:9091"         # Audio WebSocket
    environment:
      PUBLIC_IP: ${PUBLIC_IP}
    depends_on:
      server:
        condition: service_started
    restart: unless-stopped

volumes:
  pgdata:
```

## 3. Create `.env`

```env
# Required
POSTGRES_PASSWORD=change-me-to-something-secure
INITIAL_PASSWORD=your-login-password
PUBLIC_IP=203.0.113.10
BASE_URL=https://phone.example.com
CORS_ORIGIN=https://phone.example.com

# Optional — encrypts provider credentials (API keys etc.) at rest
CONFIG_ENCRYPTION_KEY=
```

| Variable | Purpose |
|----------|---------|
| `POSTGRES_PASSWORD` | Database password. Pick something strong, you won't need to type it. |
| `INITIAL_PASSWORD` | The password you log in with. Can be changed later from the web interface. |
| `PUBLIC_IP` | Your server's public IP. Used in WebRTC ICE candidates and SIP so clients and providers can connect for call audio. |
| `BASE_URL` | The public HTTPS URL of your server (e.g. `https://phone.example.com`). Telephony providers send webhooks to this address — **must be HTTPS**. |
| `CORS_ORIGIN` | Usually the same as `BASE_URL`. Allows the web interface to make API requests. |
| `CONFIG_ENCRYPTION_KEY` | Optional. A key for encrypting provider secrets (API keys, tokens) at rest in the database. If omitted, secrets are stored in plaintext. |

## 4. Set up TLS

TLS is required for Svarla to function — providers will not send webhooks to plain HTTP URLs, and browsers restrict features on insecure origins.

The simplest approach is Caddy as a reverse proxy with automatic Let's Encrypt certificates. Create a `Caddyfile`:

```
phone.example.com {
    reverse_proxy server:3000
}
```

And a `docker-compose.caddy.yml` overlay:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - server
    restart: unless-stopped

volumes:
  caddy_data:
  caddy_config:
```

Then start everything together:

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Set `BASE_URL` and `CORS_ORIGIN` in `.env` to your domain (e.g. `https://phone.example.com`).

::: tip
Port 10443 (WebRTC) is **not** proxied through Caddy — it uses DTLS encryption directly between the client and MediaBridge. No additional TLS termination is needed for audio.
:::

::: info Alternative: existing reverse proxy
If you already have a reverse proxy (nginx, Traefik, etc.), point it at port 3000 and configure TLS there. The key requirement is that `BASE_URL` resolves to an HTTPS endpoint that providers can reach.
:::

## 5. Start it

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

Your server is now running at `https://phone.example.com`. Log in with the password you set in `INITIAL_PASSWORD`.

## Updating

```bash
docker compose pull
docker compose up -d
```

Each new server image includes the matching Android APK. After updating your server, open the app — it will detect the new version and prompt you to update from your instance's download page.

See [Android App — Updating](/guide/android#updating-the-app) for details.

## Building from source

If you prefer to build and run everything locally without pulling from GHCR:

```bash
make all
```

This builds the APK (signed with your own keystore), bakes it into the server container, and builds the mediabridge container. Then update your `docker-compose.yml` to use the local images:

```yaml
services:
  server:
    image: svarla-server:dev
  mediabridge:
    image: svarla-mediabridge:dev
```

See [Building from Source](/guide/install-manual) for full details on the build system.

## Firewall / ports that must be open

These ports need to be accessible from the internet for Svarla to work:

| Port | Protocol | Why |
|------|----------|-----|
| 443 (or 3000) | TCP | Server API — clients connect here, providers send webhooks here |
| 10443 | TCP + UDP | WebRTC audio — the Android app connects here for call audio |
| 5060 | TCP + UDP | SIP — provider connects here for call signaling |
| 5061 | TCP | SIP TLS — provider secure SIP |
| 5062 | UDP | RTP media — SIP call audio |
| 9091 | TCP | Audio WebSocket — 46elks connects here for call audio (should be proxied through Caddy for TLS) |

These ports can stay **closed** to the internet:

| Port | Purpose |
|------|---------|
| 5432 | PostgreSQL (internal only) |
| 9090 | MediaBridge ControlAPI (internal only) |

::: warning
If ports 10443, 5060, and 9091 are not reachable from the internet, calls will fail silently — the signaling works but no audio flows.
:::

## Next steps

- [Connect the Android app](/guide/android)
- [Add a telephony provider](/guide/providers-overview)
