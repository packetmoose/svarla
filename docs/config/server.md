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
