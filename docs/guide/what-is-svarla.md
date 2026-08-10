# What is Svarla?

Svarla is a personal softphone application for making and receiving phone calls and SMS over a data connection. It consists of a self-hosted server, a native Android client, and a web interface.

## Why?

Most VoIP solutions are either locked to a single provider, run through someone else's cloud, or require complex PBX setups. Svarla gives you a simple, self-contained system where:

- You own the infrastructure
- You choose your telephony provider (or use multiple)
- Your call audio never touches a third-party server unnecessarily
- You can add or remove numbers at runtime

## Components

| Component | Tech | Role |
|-----------|------|------|
| **Server** | Node.js, TypeScript, Fastify | Call orchestration, API, WebSocket sync |
| **MediaBridge** | Go, Pion WebRTC | Terminates client WebRTC, bridges audio to providers |
| **Android App** | Kotlin, Jetpack Compose | Native calling and SMS client |
| **Web Interface** | Preact, esbuild | Browser-based management and messaging |

## How it works

1. The **Server** handles signaling, call state, SMS routing, and device sync.
2. The **MediaBridge** terminates WebRTC connections from clients and bridges the audio to telephony providers via SIP or WebSocket streams.
3. The **Android App** connects to the server over WebSocket for signaling and to the MediaBridge over WebRTC for audio.
4. **Telephony providers** (Vonage, 46elks, ModemManager) connect to the MediaBridge for audio and send webhooks to the Server for call/SMS events.

## Current status

Svarla is in active development. It works for personal use but is not production-hardened. Expect breaking changes, known security gaps, and rough edges.
