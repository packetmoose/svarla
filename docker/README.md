# Docker Deployment Examples

These compose files use the **pre-built images** from GitHub Container Registry. No source code checkout is needed.

## Quick Start

```bash
cp .env.example .env
# Edit .env with your values

# Copy config files (adjust as needed)
cp ../server-config.yaml .
cp ../mediabridge/mediabridge-config.yaml .

docker compose up -d
```

## Available Configurations

| File | Description |
|------|-------------|
| `docker-compose.yml` | Server and mediabridge as separate containers |
| `docker-compose.caddy.yml` | Add TLS termination via Caddy (layer on top) |

## Adding TLS

```bash
docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
```

## Updating

```bash
docker compose pull
docker compose up -d
```
