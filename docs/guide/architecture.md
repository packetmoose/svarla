# Architecture

Svarla's architecture separates signaling from media, keeping the Node.js server focused on orchestration while a Go sidecar handles the real-time audio path.

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Server Host / Docker                         │
│                                                                     │
│  ┌──────────────────────┐         ┌──────────────────────────────┐ │
│  │   Node.js / Fastify  │         │   MediaBridge (Pion / Go)    │ │
│  │                      │  REST   │                              │ │
│  │  Call Orchestrator   ─┼────────►  ControlAPI (port 9090)      │ │
│  │  Provider Registry    │         │  WebRTC Endpoint (10443/TCP) │ │
│  │  WebSocket + REST     │◄────────┤  Event WS (→ Server)        │ │
│  │  (client signaling)   │ events  │  SIP UAS (port 5060)        │ │
│  │                      │         │  Audio WS (port 9091)        │ │
│  └──────────────────────┘         └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         ▲                                    ▲              ▲
         │ WebSocket + REST                   │ WebRTC/TCP   │ SIP / Audio WS
         │                                    │              │
    ┌────┴─────┐                         ┌────┴────┐   ┌────┴──────────┐
    │ Android  │                         │ Android │   │ Provider      │
    │ (signal) │                         │ (audio) │   │ (Vonage/46elks│
    └──────────┘                         └─────────┘   │              )│
                                                       └───────────────┘
```

## Server (Node.js / Fastify)

The server is the control plane:

- **Call Orchestrator** — Manages call state machines, routes incoming calls to devices, instructs the MediaBridge to set up audio sessions.
- **Provider Registry** — Stores provider credentials and configuration, handles webhooks from telephony providers.
- **WebSocket** — Real-time sync with connected clients (call state, SMS, presence).
- **REST API** — CRUD for providers, numbers, call history, SMS conversations.
- **PostgreSQL** — Persistent storage for all state.

## MediaBridge (Go / Pion)

The MediaBridge is the media plane:

- **WebRTC Endpoint** — Accepts WebRTC connections from Android clients over TCP (port 10443). Uses DTLS-SRTP for encrypted audio.
- **SIP UAS** — Accepts SIP connections from providers (e.g., Vonage) for call audio.
- **Audio WebSocket** — Accepts raw audio streams from providers that use WebSocket-based audio delivery (e.g., 46elks).
- **ControlAPI** — HTTP API called by the Server to create/destroy sessions, transfer calls, etc.
- **Event WebSocket** — Pushes media events (DTMF, hangup, silence detection) back to the Server.

## Data flow for a call

1. Incoming webhook hits the Server from a provider.
2. Server creates a session on the MediaBridge via ControlAPI.
3. Server notifies the Android client via WebSocket push.
4. Android client connects WebRTC to the MediaBridge.
5. MediaBridge bridges the audio between client WebRTC and provider SIP/WS.
6. When the call ends, the MediaBridge notifies the Server, which updates state and syncs clients.
