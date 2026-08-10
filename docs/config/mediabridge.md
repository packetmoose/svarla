# MediaBridge Configuration

The MediaBridge is configured via `mediabridge/mediabridge-config.yaml`.

## Full reference

```yaml
webrtcPort: 10443
controlApiPort: 9090
sipPort: 5060
audioWsPort: 9091
publicIp: 127.0.0.1

audio:
  ringbackCadence: eu      # "eu" or "us"
  opusMaxBitrate: 32000    # Opus max bitrate in bps
  sipCodec: g711_ulaw      # "g711_ulaw" or "opus"

logging:
  level: info              # debug / info / warn / error
  format: json             # "json" or "text"
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `webrtcPort` | 10443 | TCP port for client WebRTC connections. Must be publicly accessible. |
| `controlApiPort` | 9090 | HTTP port for the ControlAPI. Internal use only. |
| `sipPort` | 5060 | SIP port for provider audio. Must be reachable by your provider. |
| `audioWsPort` | 9091 | WebSocket port for hardware audio streams. |
| `publicIp` | 127.0.0.1 | The IP included in ICE candidates sent to clients. Set this to your server's public IP. |
| `audio.ringbackCadence` | eu | The ringback tone pattern played to callers while ringing. |
| `audio.opusMaxBitrate` | 32000 | Maximum bitrate for Opus codec negotiation. |
| `audio.sipCodec` | g711_ulaw | Codec used on the SIP leg with providers. |
| `logging.level` | info | Minimum log level. |
| `logging.format` | json | Log output format. Use `text` for development. |
