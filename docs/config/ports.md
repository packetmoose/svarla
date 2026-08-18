# Port Requirements

Svarla exposes several ports. Configure your firewall accordingly.

## Port map

| Port | Protocol | Service | Direction | Purpose |
|------|----------|---------|-----------|---------|
| 3000 | TCP | Server | Inbound (clients + webhooks) | REST API and WebSocket signaling |
| 10443 | TCP + UDP | MediaBridge | Inbound (clients) | WebRTC ICE/DTLS/SRTP audio |
| 5060 | UDP + TCP | MediaBridge | Inbound (Vonage) | SIP signaling |
| 5061 | TCP | MediaBridge | Inbound (Vonage) | SIP-over-TLS (SIPS) |
| 5062 | UDP | MediaBridge | Inbound (Vonage) | RTP media (SIP call audio) |
| 9091 | TCP | MediaBridge | Inbound (46elks) | WebSocket audio stream (proxied through Caddy/TLS) |
| 9090 | TCP | MediaBridge | Internal only | ControlAPI (server ↔ mediabridge) |

::: info
Ports 5060, 5061, and 5062 are only required if you use a SIP-based provider (Vonage). If you only use 46elks, you can leave them closed — 46elks audio goes through the WebSocket proxy on port 443.
:::

## Exposure guidelines

### Public (internet-facing)

- **443** (via Caddy) — Clients, provider webhooks, and 46elks audio WebSocket
- **10443** — Android app WebRTC connections

### Provider-facing (Vonage only)

- **5060** — SIP signaling. Restrict to provider IPs if possible.
- **5061** — SIP TLS for encrypted SIP.
- **5062** — RTP media for SIP calls.

### Internal only

- **3000** — Server HTTP (accessed by Caddy, not exposed directly)
- **9090** — MediaBridge ControlAPI (server ↔ mediabridge communication only)
- **9091** — Audio WebSocket (proxied through Caddy on port 443)

::: tip
When using Caddy, port 443 handles both the server API and the 46elks audio WebSocket. Port 10443 uses DTLS encryption natively and doesn't need a reverse proxy.
:::

::: warning
If port 10443 is not reachable from the internet, calls will have no audio. If using Vonage and ports 5060-5062 are blocked, SIP calls will fail.
:::
