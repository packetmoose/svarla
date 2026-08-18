# MediaBridge Configuration

The MediaBridge is configured via `mediabridge/mediabridge-config.yaml`. Environment variables can override specific settings (noted below).

## Full reference

```yaml
webrtc:
  port: 10443

server:
  controlPort: 9090

network:
  publicIp: "127.0.0.1"

sip:
  port: 5060
  mediaPort: 5062
  tls:
    port: 5061
    certPath: ""
    keyPath: ""

audioWs:
  port: 9091

audio:
  ringbackCadence: "eu"
  sipCodec: "g711_ulaw"

log:
  level: "info"
  json: false
```

## Settings

### webrtc

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | 10443 | TCP port for client WebRTC connections (ICE/DTLS/SRTP). Must be publicly accessible. |

### server

| Setting | Default | Description |
|---------|---------|-------------|
| `controlPort` | 9090 | HTTP port for the ControlAPI. Internal use only — never expose to the internet. |

### network

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `publicIp` | 127.0.0.1 | `PUBLIC_IP` | The address included in ICE candidates sent to clients. Can be an IP address or a domain name — if a hostname is given, the MediaBridge resolves it via DNS and re-resolves every 2 minutes (handles dynamic IPs). |

### sip

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | 5060 | SIP signaling port (UDP + TCP). Must be reachable by your telephony provider. |
| `mediaPort` | 5062 | RTP media port (UDP). Used for SIP call audio. |
| `tls.port` | 5061 | SIP-over-TLS (SIPS) port. Used by providers that support encrypted SIP. |
| `tls.certPath` | *(empty)* | Path to TLS certificate PEM file. If empty, a self-signed certificate is auto-generated. |
| `tls.keyPath` | *(empty)* | Path to TLS private key PEM file. If empty, a self-signed key is auto-generated. |

### audioWs

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | 9091 | WebSocket port for provider audio streams (e.g., 46elks). Should be proxied through TLS in production. |

### audio

| Setting | Default | Description |
|---------|---------|-------------|
| `ringbackCadence` | eu | Ringback tone pattern played to callers while ringing. Options: `eu` (425 Hz, 1s on / 4s off) or `us` (440+480 Hz, 2s on / 4s off). |
| `sipCodec` | g711_ulaw | Codec used on the SIP leg with providers. Options: `g711_ulaw` (standard PSTN, 8 kHz) or `opus` (if provider supports it). |

### log

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `level` | info | `LOG_LEVEL` | Minimum log level: `debug`, `info`, `warn`, `error`. |
| `json` | false | — | Output logs as structured JSON. Use `true` for production log aggregation, `false` for human-readable development output. |

## Environment variable overrides

| Variable | Overrides |
|----------|-----------|
| `PUBLIC_IP` | `network.publicIp` |
| `LOG_LEVEL` | `log.level` |
| `CONFIG_PATH` | Path to the config file (default: `./mediabridge-config.yaml`) |
