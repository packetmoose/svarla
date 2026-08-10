# Building from Source

If you want to develop Svarla or run it without Docker, you can build everything from source.

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- Go 1.22+ (for MediaBridge)

## Server

```bash
git clone https://github.com/packetmoose/svarla.git
cd svarla
npm install
cp .env.example .env
# Edit .env — set DATABASE_URL and INITIAL_PASSWORD
npm run migrate
npm run build
npm run build:web
npm start
```

For development with hot-reload:

```bash
npm run dev
```

## MediaBridge

```bash
cd mediabridge
go build -o mediabridge ./cmd/mediabridge/
./mediabridge
```

Edit `mediabridge-config.yaml` to set `publicIp` to your server's public IP.

## Development with Docker Compose

The root `docker-compose.yml` (in the repo root, not `docker/`) builds everything from source with sensible defaults:

```bash
git clone https://github.com/packetmoose/svarla.git
cd svarla
docker compose up -d
```

Server is at `http://localhost:3000` with password `dev`.
