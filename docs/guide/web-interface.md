# Web Interface

Svarla includes a lightweight web interface built with Preact and bundled with esbuild. It's served directly by the Fastify server.

## Accessing

The web interface is served by the Svarla server — it's already there when the server is running. Open your server's address in a browser:

- `https://phone.example.com` (if you set up a domain with TLS)
- `http://localhost:3000` (local/development access)

Log in with the password configured via `INITIAL_PASSWORD`.

## Features

- View and manage SMS conversations
- Browse call history
- Configure telephony providers and numbers
- Device management
- Real-time updates via WebSocket

## Building

The web interface is built as part of the standard build process:

```bash
npm run build:web
```

The output is placed in `dist/web/` and served as static files by the server.

::: info
The web interface currently supports messaging and configuration. Voice calls from the browser are not yet supported — use the Android app for calling.
:::
