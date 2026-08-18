# Cloudflare Tunnel Deployment

If you don't have a public IP (e.g., behind CGNAT or a restrictive ISP), you can use a Cloudflare Tunnel to expose the Svarla server to the internet for provider webhooks. This comes with significant limitations.

## When to use this

- You have **no public IP** or are behind CGNAT
- You're using **46elks only** (WebSocket-based audio)
- You can access the server over **LAN or VPN** for the Android app

## Limitations

::: danger Important limitations
- **WebRTC does not work through Cloudflare** — the Android app cannot connect for call audio via the tunnel
- **SIP does not work through Cloudflare** — Vonage and other SIP-based providers are not supported
- **The Android app must connect directly to the server** over LAN or VPN (not through the tunnel)
- Only **46elks** is supported as a provider (uses WebSocket audio, which Cloudflare can proxy)
:::

### What works through the tunnel

| Feature | Works? | Notes |
|---------|--------|-------|
| Provider webhooks (incoming calls/SMS) | ✅ | 46elks sends webhooks over HTTPS |
| Audio WebSocket (46elks) | ✅ | 46elks connects to the tunnel for call audio |
| Web interface | ✅ | If you access it through the tunnel URL |

### What does NOT work through the tunnel

| Feature | Works? | Why |
|---------|--------|-----|
| WebRTC audio (Android app) | ❌ | Cloudflare doesn't proxy arbitrary TCP/UDP on non-standard ports |
| SIP (Vonage) | ❌ | SIP requires direct UDP/TCP access to ports 5060-5062 |
| Android app signaling | ❌ | WebSocket connections from the app should go directly to the server |

### How the app connects

The Android app connects **directly to the server over your LAN or a VPN** — not through the Cloudflare Tunnel. This means:

- At home: the app connects via your local network (e.g., `https://192.168.1.50:3000` or a local DNS name)
- Away from home: you need a VPN (e.g., WireGuard, Tailscale) back to your home network

The Cloudflare Tunnel is used **only** for:
- 46elks webhooks (so the provider can reach your server)
- 46elks audio WebSocket (so the provider can stream call audio)

## Setup

### 1. Create a Cloudflare Tunnel

In the [Cloudflare Zero Trust dashboard](https://one.dash.cloudflare.com/):

1. Go to **Networks → Tunnels**
2. Create a new tunnel and note the tunnel token
3. Add a public hostname pointing to your Svarla server:
   - Hostname: `phone.example.com`
   - Service: `http://server:3000`
4. Add a second route for the audio WebSocket:
   - Hostname: `phone.example.com`
   - Path: `/audio/*`
   - Service: `http://mediabridge:9091`

### 2. Create `docker-compose.yml`

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
    ports:
      - "3000:3000"         # LAN access for the Android app
    environment:
      DATABASE_URL: postgresql://svarla:${POSTGRES_PASSWORD}@db:5432/svarla
      INITIAL_PASSWORD: ${INITIAL_PASSWORD}
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
      - "10443:10443"       # WebRTC — LAN/VPN only
      - "10443:10443/udp"
    environment:
      PUBLIC_IP: ${LAN_IP}
    depends_on:
      server:
        condition: service_started
    restart: unless-stopped

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    depends_on:
      - server
      - mediabridge
    restart: unless-stopped

volumes:
  pgdata:
```

Note:
- **No Caddy** — Cloudflare handles TLS termination
- **No SIP ports exposed** — SIP providers won't work through a tunnel
- **Port 9091 not exposed** — 46elks audio goes through the tunnel, not directly
- **Port 3000 exposed on LAN** — the Android app connects here directly
- **PUBLIC_IP is your LAN IP** — since the app connects over LAN/VPN, ICE candidates should advertise the local address

### 3. Create `.env`

```env
# Required
POSTGRES_PASSWORD=change-me-to-something-secure
INITIAL_PASSWORD=your-login-password
DOMAIN=phone.example.com
TUNNEL_TOKEN=your-cloudflare-tunnel-token
LAN_IP=192.168.1.50
```

| Variable | Purpose |
|----------|---------|
| `POSTGRES_PASSWORD` | Database password |
| `INITIAL_PASSWORD` | Login password |
| `DOMAIN` | Your domain routed through Cloudflare (for provider webhooks) |
| `TUNNEL_TOKEN` | Token from the Cloudflare Tunnel setup |
| `LAN_IP` | The server's LAN IP address (used in WebRTC ICE candidates for the app) |

### 4. Configure 46elks webhooks

On the 46elks dashboard, set webhooks to your tunnel domain:

| Webhook | URL |
|---------|-----|
| `voice_start` | `https://phone.example.com/webhooks/46elks/voice_start` |
| `sms_url` | `https://phone.example.com/webhooks/46elks/sms_incoming` |

### 5. Start it

```bash
docker compose up -d
```

## Connecting the Android app

The app must connect **directly** to the server — not through Cloudflare.

On the login screen, enter:
- **Server URL:** `http://192.168.1.50:3000` (your server's LAN IP)
- **Password:** The password set via `INITIAL_PASSWORD`

### Remote access

When away from home, use a VPN to reach your home network:

- [Tailscale](https://tailscale.com) — zero-config mesh VPN, easiest to set up
- [WireGuard](https://www.wireguard.com) — lightweight, self-hosted

With a VPN active, the app connects to the server's LAN IP as if you were at home. Calls and SMS work as normal.

## Comparison with standard deployment

| | Standard (public IP) | Cloudflare Tunnel |
|---|---|---|
| Providers supported | All (Vonage, 46elks) | 46elks only |
| App access | Anywhere (internet) | LAN or VPN only |
| WebRTC audio | Direct over internet | Direct over LAN/VPN |
| SIP audio | Direct over internet | ❌ Not supported |
| TLS | Caddy (Let's Encrypt) | Cloudflare |
| Public IP required | Yes | No |
| Incoming webhooks | Direct to server | Through tunnel |

## Troubleshooting

**Calls have no audio:**
- Verify the app is connected to the server via LAN/VPN, not through Cloudflare
- Check that `LAN_IP` in `.env` matches the server's actual LAN address
- Ensure port 10443 is reachable from the phone on the local network

**46elks webhooks not arriving:**
- Check the tunnel is running: `docker compose logs cloudflared`
- Verify the hostname in Cloudflare dashboard matches your domain
- Test the tunnel: `curl https://phone.example.com/api/health` from an external network

**App can't connect when away from home:**
- Confirm your VPN is active and routing traffic to the home network
- Try pinging the server's LAN IP from your phone
