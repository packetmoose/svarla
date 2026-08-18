# Port Requirements

Svarla exposes several ports. Configure your firewall accordingly.

## Port map

| Port | Protocol | Service | Direction | Purpose |
|------|----------|---------|-----------|---------|
| 3000 | TCP | Server | Inbound (clients + webhooks) | REST API and WebSocket signaling |
| 10443 | TCP + UDP | MediaBridge | Inbound (clients) | WebRTC ICE/DTLS/SRTP audio |
| 5060 | UDP + TCP | MediaBridge | Inbound (providers) | SIP signaling |
| 5061 | TCP | MediaBridge | Inbound (providers) | SIP-over-TLS (SIPS) |
| 5062 | UDP | MediaBridge | Inbound (providers) | RTP media (SIP call audio) |
| 9091 | TCP | MediaBridge | Inbound (providers) | WebSocket audio stream (proxy via Caddy/TLS) |
| 9090 | TCP | MediaBridge | Internal only | ControlAPI (server ↔ mediabridge) |

## Exposure guidelines

### Public (internet-facing)

- **3000** (or 443 via Caddy) — Clients and provider webhooks
- **10443** — Android app WebRTC connections

### Provider-facing

- **5060** — SIP signaling from providers. Restrict to provider IPs if possible.
- **5061** — SIP TLS from providers that support encrypted SIP.
- **5062** — RTP media for SIP calls.
- **9091** — Audio WebSocket from 46elks. Should go through a TLS reverse proxy (e.g. Caddy) rather than being exposed directly.

### Internal only

- **9090** — Never expose to the internet. Used for communication between the Server and MediaBridge on the Docker bridge or localhost.

::: tip
When using Caddy TLS, port 443 replaces direct access to 3000. Port 10443 uses DTLS encryption natively and doesn't need a reverse proxy.
:::

::: warning
If ports 10443, 5060/5061/5062, and 9091 are not reachable from the internet, calls will fail silently — signaling works but no audio flows.
:::
