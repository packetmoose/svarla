# Port Requirements

Svarla exposes several ports. Configure your firewall accordingly.

## Port map

| Port | Protocol | Service | Direction | Purpose |
|------|----------|---------|-----------|---------|
| 3000 | TCP | Server | Inbound (clients + webhooks) | REST API and WebSocket signaling |
| 10443 | TCP + UDP | MediaBridge | Inbound (clients) | WebRTC ICE/DTLS/SRTP audio |
| 5060 | UDP + TCP | MediaBridge | Inbound (Vonage) | SIP signaling and audio |
| 9091 | TCP | MediaBridge | Inbound (46elks) | WebSocket audio stream |
| 9090 | TCP | MediaBridge | Internal only | ControlAPI (server ↔ mediabridge) |

## Exposure guidelines

### Public (internet-facing)

- **3000** (or 443 via Caddy) — Clients and provider webhooks
- **10443** — Android app WebRTC connections

### Provider-facing

- **5060** — SIP from Vonage. Restrict to Vonage IPs if possible.
- **9091** — Audio WebSocket from 46elks.

### Internal only

- **9090** — Never expose to the internet. Used for communication between the Server and MediaBridge on the Docker bridge or localhost.

::: tip
When using Caddy TLS, port 443 replaces direct access to 3000. Port 10443 uses DTLS encryption natively and doesn't need a reverse proxy.
:::
