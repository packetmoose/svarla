# Installation

Svarla runs as a set of Docker containers. You don't need to clone the source code — just create a compose file and start it.

## Prerequisites

- A Linux server (VPS, home server, etc.)
- Docker and Docker Compose installed
- **A public IP address** — required for WebRTC audio and provider SIP connections
- **A domain name** — required for TLS certificates and provider webhooks
- A DNS A record pointing your domain to the server's public IP

::: warning Required: Public IP + Domain + TLS
Svarla **will not work** without a public IP and TLS. Telephony providers (Vonage, 46elks) require HTTPS callback URLs for incoming calls and SMS. The MediaBridge needs a public IP so clients can connect for call audio and providers can reach it via SIP. Without these, signaling may appear to work but calls will have no audio and incoming events won't arrive.
:::

::: tip No public IP?
If you're behind CGNAT or don't have a static public IP, see the [Cloudflare Tunnel deployment guide](/guide/cloudflare-tunnel) for an alternative (46elks only, with limitations).
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
    restart: unless-stopped

  server:
    image: ghcr.io/packetmoose/svarla-server:latest
    environment:
      DATABASE_URL: postgresql://svarla:${POSTGRES_PASSWORD}@db:5432/svarla
      INITIAL_PASSWORD: ${INITIAL_PASSWORD}
      PUBLIC_IP: ${PUBLIC_IP}
      MEDIA_BRIDGE_URL: http://mediabridge:9090
      BASE_URL: https://${DOMAIN}
      CORS_ORIGIN: https://${DOMAIN}
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
    environment:
      PUBLIC_IP: ${PUBLIC_IP}
    depends_on:
      server:
        condition: service_started
    restart: unless-stopped

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
  pgdata:
  caddy_data:
  caddy_config:
```

## 3. Create `Caddyfile`

```
{$DOMAIN} {
    # Audio WebSocket proxy (46elks connects here for call audio over TLS)
    handle /audio/* {
        reverse_proxy mediabridge:9091
    }

    # All other traffic goes to the server
    handle {
        reverse_proxy server:3000
    }

    header {
        Strict-Transport-Security "max-age=63072000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }
}
```

This handles both the server API and the 46elks audio WebSocket behind TLS. Caddy automatically obtains and renews Let's Encrypt certificates for your domain.

## 4. Create `.env`

```env
# Required
POSTGRES_PASSWORD=change-me-to-something-secure
INITIAL_PASSWORD=your-login-password
PUBLIC_IP=203.0.113.10
DOMAIN=phone.example.com
```

::: tip
`PUBLIC_IP` can be a domain name instead of an IP address (e.g. `PUBLIC_IP=phone.example.com`). The MediaBridge resolves it via DNS and re-resolves every 2 minutes, so it handles dynamic IPs automatically.
:::

| Variable | Purpose |
|----------|---------|
| `POSTGRES_PASSWORD` | Database password. Pick something strong, you won't need to type it. |
| `INITIAL_PASSWORD` | The password you log in with. Can be changed later from the web interface. |
| `PUBLIC_IP` | Your server's public IP address or domain name. Used in WebRTC ICE candidates and SIP so clients and providers can connect for call audio. Can be an IP (e.g. `203.0.113.10`) or a hostname (e.g. `phone.example.com`) — the MediaBridge resolves it. |
| `DOMAIN` | Your domain name (e.g. `phone.example.com`). Caddy automatically obtains a Let's Encrypt certificate for it. |

::: info Optional variables
| Variable | Purpose |
|----------|---------|
| `CONFIG_ENCRYPTION_KEY` | Encrypts provider secrets (API keys, tokens) at rest in the database. If omitted, secrets are stored in plaintext. |
:::

## 5. Open firewall ports and verify DNS

Before starting, ensure your firewall allows the necessary ports and your DNS is configured.

**Required ports:**

| Port | Protocol | Why |
|------|----------|-----|
| 80 | TCP | Caddy — HTTP → HTTPS redirect and Let's Encrypt challenge |
| 443 | TCP | Caddy — HTTPS for clients, provider webhooks, and 46elks audio WebSocket |
| 10443 | TCP + UDP | WebRTC audio — the Android app connects here for call audio |
| 5060 | TCP + UDP | SIP signaling (Vonage only) |
| 5061 | TCP | SIP TLS (Vonage only) |
| 5062 | UDP | RTP media — SIP call audio (Vonage only) |

::: info
Ports 5060, 5061, and 5062 are only required if you use a SIP-based provider (Vonage). If you only use 46elks, you can leave them closed — 46elks audio goes through the WebSocket proxy on port 443.
:::

**Ports that stay closed:**

| Port | Purpose |
|------|---------|
| 3000 | Server (only accessed by Caddy internally) |
| 5432 | PostgreSQL (internal only) |
| 9090 | MediaBridge ControlAPI (internal only) |
| 9091 | Audio WebSocket (proxied through Caddy on port 443, not exposed directly) |

**Verify DNS resolves correctly:**

```bash
dig +short phone.example.com
# Should return your server's public IP
```

::: warning
Caddy will immediately attempt to obtain a Let's Encrypt certificate on startup. If DNS doesn't resolve to this server or port 80 is blocked, the ACME challenge fails and repeated attempts can **rate-limit your domain** for up to a week.
:::

## 6. Start it

```bash
docker compose up -d
```

Caddy will automatically obtain a TLS certificate from Let's Encrypt. Your server is now running at `https://phone.example.com`.

Log in with the password you set in `INITIAL_PASSWORD`.

::: tip
Port 10443 (WebRTC) is **not** proxied through Caddy — it uses DTLS encryption directly between the client and MediaBridge. No additional TLS termination is needed for audio.
:::

::: warning
If port 10443 is not reachable from the internet, calls will have no audio — signaling works but the audio path fails.
:::

## Using your own reverse proxy

If you already have a reverse proxy (nginx, Traefik, etc.), remove the `caddy` service from the compose file and:

1. Point your proxy at the server container's port 3000
2. Set `BASE_URL` and `CORS_ORIGIN` environment variables on the server to your HTTPS URL
3. Ensure your proxy passes WebSocket connections (used for real-time sync)

The key requirement is that `BASE_URL` resolves to an HTTPS endpoint that providers can reach.

## Updating

```bash
docker compose pull
docker compose up -d
```

Each new server image includes the matching Android APK. After updating your server, open the app — it will detect the new version and prompt you to update from your instance's download page.

See [Android App — Updating](/guide/android#updating-the-app) for details.

## Building from source

If you prefer to build everything yourself without pulling from GHCR:

```bash
make all
```

This builds the APK (signed with your own keystore), the server container, and the mediabridge container. Then update your `docker-compose.yml` to use the local images:

```yaml
services:
  server:
    image: svarla-server:dev
  mediabridge:
    image: svarla-mediabridge:dev
```

See [Building from Source](/guide/install-manual) for full details on the build system.

## Next steps

- [Connect the Android app](/guide/android)
- [Add a telephony provider](/guide/providers-overview)
