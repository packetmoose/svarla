# Server Configuration

The server is configured via `server-config.yaml`. All settings can also be overridden with environment variables.

## Full reference

```yaml
server:
  port: 3000
  host: "0.0.0.0"
  sessionExpiryDays: 30
  web:
    enabled: true
  # baseUrl: "https://your-public-domain.com"

log:
  level: "info"
  json: false

database:
  url: "${DATABASE_URL}"
  maxConnections: 10

push:
  allowPrivateEndpoints: false

mediabridge:
  url: "http://localhost:9090"
  healthCheckInterval: 5000
```

## Settings

### server

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `port` | 3000 | `PORT` | HTTP port the server listens on |
| `host` | 0.0.0.0 | `HOST` | Bind address |
| `baseUrl` | — | `BASE_URL` | Public URL where providers send webhooks |
| `sessionExpiryDays` | 30 | — | How long login sessions last before requiring re-authentication |
| `web.enabled` | true | — | Whether to serve the built-in web interface |

### log

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `level` | info | `LOG_LEVEL` | Log level: debug / info / warn / error |
| `json` | false | — | Output logs as JSON (useful for log aggregation) |

### database

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `url` | — | `DATABASE_URL` | PostgreSQL connection string |
| `maxConnections` | 10 | — | Maximum database connection pool size |

### push

| Setting | Default | Description |
|---------|---------|-------------|
| `allowPrivateEndpoints` | false | Allow UnifiedPush endpoints on private/LAN networks. Enable if your push server (e.g. ntfy) is on the same LAN. When false, only HTTPS URLs resolving to public IPs are accepted. |

### mediabridge

| Setting | Default | Env Override | Description |
|---------|---------|-------------|-------------|
| `url` | http://localhost:9090 | `MEDIA_BRIDGE_URL` | URL of the MediaBridge ControlAPI |
| `healthCheckInterval` | 5000 | `MEDIA_BRIDGE_HEALTH_CHECK_INTERVAL` | How often (ms) the server checks if the MediaBridge is alive |

## Environment variable overrides

Any setting can be overridden by its corresponding env var. The config file also supports `${VAR_NAME}` placeholder syntax for referencing environment variables inline.

## Other environment variables

These don't have config file equivalents:

| Variable | Description |
|----------|-------------|
| `INITIAL_PASSWORD` | Seeds the login password on first run |
| `CONFIG_ENCRYPTION_KEY` | AES-256-GCM key for encrypting provider secrets at rest |
| `CORS_ORIGIN` | Comma-separated allowed origins for CORS |
| `CONFIG_PATH` | Path to the config file (default: `./server-config.yaml`) |

## APK distribution

The server can serve the Android APK directly to users, ensuring the app version always matches the server. This is configured via environment variables (no config file equivalent):

| Variable | Default | Description |
|----------|---------|-------------|
| `APK_SOURCE` | `auto` | How the APK is provided: `local` = serve a mounted file, `remote` = fetch from a URL on first start, `auto` = use local if the file exists, otherwise fetch remote |
| `APK_URL` | GitHub release URL | URL to download the APK from. Defaults to the GitHub release matching the server version. |
| `APK_CERT_FINGERPRINT` | *(none)* | Expected APK signing certificate SHA-256 fingerprint. If set, the downloaded APK is verified against this fingerprint. If unset, no verification (self-builder mode). |
| `APK_PATH` | `./public/downloads/svarla.apk` | Filesystem path where the APK is stored and served from. |

### Modes

- **Production (pre-built images):** The server container ships with the APK baked in. No configuration needed — it just works.
- **Self-hosted builds:** Mount your own signed APK and set `APK_SOURCE=local`:
  ```yaml
  volumes:
    - ./build-output/svarla-signed.apk:/app/public/downloads/svarla.apk:ro
  environment:
    APK_SOURCE: local
  ```
- **Custom URL:** Point at your own release infrastructure:
  ```yaml
  environment:
    APK_SOURCE: remote
    APK_URL: https://releases.example.com/svarla-latest.apk
  ```
