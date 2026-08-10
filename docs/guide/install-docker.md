# Installation

Svarla runs as a set of Docker containers. You don't need to clone the source code — just create a compose file and start it.

## Prerequisites

- A Linux server (VPS, home server, etc.)
- Docker and Docker Compose installed
- A public IP address (for receiving calls and webhooks from cloud providers)

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
| `PUBLIC_IP` | Your server's public IP. Used in WebRTC ICE candidates so clients can connect for call audio. |
| `BASE_URL` | The public URL of your server (e.g. `https://phone.example.com`). Telephony providers send webhooks to this address. |
| `CORS_ORIGIN` | Usually the same as `BASE_URL`. Allows the web interface to make API requests. |
| `CONFIG_ENCRYPTION_KEY` | Optional. A key for encrypting provider secrets (API keys, tokens) at rest in the database. If omitted, secrets are stored in plaintext. |

## 4. Start it

```bash
docker compose up -d
```

That's it. The server is running at `http://your-server:3000`. Log in with the password you set in `INITIAL_PASSWORD`.

## Adding TLS

For HTTPS with automatic certificates, add Caddy as a reverse proxy. Create a `Caddyfile`:

```
your-domain.com {
    reverse_proxy server:3000
}
```

And add a Caddy service to your compose file, or use a separate Caddy instance. Set `BASE_URL` and `CORS_ORIGIN` in `.env` to your domain (e.g. `https://phone.example.com`).

::: tip
Port 10443 (WebRTC) doesn't go through the reverse proxy — it uses DTLS encryption directly between the client and MediaBridge.
:::

## Updating

```bash
docker compose pull
docker compose up -d
```

## Firewall / ports that must be open

These ports need to be accessible from the internet for Svarla to work:

| Port | Protocol | Why |
|------|----------|-----|
| 3000 (or 443) | TCP | Server API — clients connect here, providers send webhooks here |
| 10443 | TCP + UDP | WebRTC audio — the Android app connects here for call audio |
| 5060 | TCP + UDP | SIP — Vonage connects here to deliver call audio |
| 9091 | TCP | Audio WebSocket — 46elks connects here to deliver call audio |

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
