# MediaBridge Setup

The MediaBridge is a Go sidecar that handles WebRTC audio termination and bridges audio to telephony providers via SIP or WebSocket streams. It runs alongside the Node.js server.

## Building

```bash
cd mediabridge
go build -o mediabridge ./cmd/mediabridge/
```

For a static binary (Docker/production):

```bash
cd mediabridge
CGO_ENABLED=0 go build -o mediabridge ./cmd/mediabridge/
```

## Configuration

Edit `mediabridge/mediabridge-config.yaml`:

| Setting | Default | Description |
|---------|---------|-------------|
| `webrtcPort` | 10443 | TCP port for client WebRTC connections (public) |
| `controlApiPort` | 9090 | HTTP port for ControlAPI (localhost only) |
| `sipPort` | 5060 | SIP port for provider audio (public) |
| `audioWsPort` | 9091 | WebSocket port for provider audio streams (public) |
| `publicIp` | 127.0.0.1 | Public IP advertised in ICE candidates |
| `audio.ringbackCadence` | eu | Ringback pattern: `eu` or `us` |
| `audio.opusMaxBitrate` | 32000 | Opus max bitrate (bps) |
| `audio.sipCodec` | g711_ulaw | SIP codec: `g711_ulaw` or `opus` |
| `logging.level` | info | Log level: debug/info/warn/error |
| `logging.format` | json | Log format: `json` or `text` |

## Running

```bash
cd mediabridge
./mediabridge
```

The MediaBridge connects to the Server's internal event WebSocket on startup and begins accepting sessions via the ControlAPI.

::: warning
Port 9090 (ControlAPI) should **never** be exposed to the internet. It's for internal communication between the Server and MediaBridge only.
:::

## Docker

When using Docker Compose, the MediaBridge runs as a separate container and is configured automatically. You only need to set `PUBLIC_IP` in your `.env` file.
