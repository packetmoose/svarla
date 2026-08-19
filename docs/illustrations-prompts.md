# Illustration Prompts

Prompts for generating consistent architecture diagrams for the Svarla docs site.

---

## Design System (include with every prompt)

```
I need a technical architecture diagram for a software project's documentation site.
It's used on a dark-themed VitePress docs site. Apply these design specifications:

- Style: Clean, minimal, flat design. No gradients, no drop shadows, no 3D effects.
  Think technical documentation, not marketing material.
- Background: Transparent (PNG) or solid dark (#1a1a2e)
- Color palette:
  - Primary/accent: #6C63FF (soft purple) — main components and connection lines
  - Secondary: #00D9A3 (teal/green) — external/client components
  - Tertiary: #FF6B6B (coral red) — provider/third-party components
  - Neutral: #E0E0E0 (light gray) — text labels
  - Container borders: #3A3A5C (muted purple-gray, dashed)
  - Internal connections: #8B85FF (lighter purple, thin lines)
  - Text: #FFFFFF for component names, #B0B0B0 for descriptions/ports
- Typography: Monospace font for port numbers and technical labels.
  Sans-serif (clean, geometric) for component names.
- Components: Rounded rectangles with 8px radius, 2px border, no fill
  (just border + label) or very subtle fill (#2A2A4A at 40% opacity)
- Connections: Thin lines (2px) with small arrowheads. Label connections
  with protocol/purpose in small text along the line.
- Grouping: Use a larger dashed rounded rectangle to group components
  that run on the same host/container.
- Dimensions: 1200×700px, optimized for web display at 2x resolution
  (render at 2400×1400 and export at logical 1200×700)
```

---

## Diagram 1: System Architecture Overview

```
[Include the design system above, then:]

Create a system architecture overview diagram showing the Svarla softphone system.

Inside a dashed container labeled "Server Host / Docker":
- "Server" (Node.js / Fastify) — purple (#6C63FF). Sub-labels inside:
  "Call Orchestrator", "Provider Registry", "WebSocket + REST", "PostgreSQL"
- "MediaBridge" (Go / Pion) — purple (#6C63FF). Sub-labels inside:
  "WebRTC Endpoint :10443", "SIP UAS :5060", "Audio WS :9091", "ControlAPI :9090"
- Bidirectional connection between Server and MediaBridge labeled
  "REST / Events (internal)"

Outside the container:
- "Android App" — teal (#00D9A3). Two connections from it:
  one to Server labeled "WebSocket + REST signaling"
  one to MediaBridge labeled "WebRTC audio :10443"
- "Web Interface" — teal (#00D9A3). One connection to Server labeled "HTTPS"
- "Telephony Provider" — coral (#FF6B6B). Label it "(Vonage / 46elks)".
  Two connections: one to Server labeled "Webhooks HTTPS"
  and one to MediaBridge labeled "SIP :5060 / Audio WS :9091"

Layout: Server host container in the center-top area. Clients (Android, Web)
on the left/bottom-left. Provider on the right/bottom-right.
```

---

## Diagram 2: Incoming Call Flow

```
[Include the design system above, then:]

Create a sequence/flow diagram showing an incoming phone call through the
Svarla system. Layout is left-to-right with vertical lifelines.

Actors (columns, each with their assigned color):
- Provider (coral #FF6B6B) — leftmost
- Server (purple #6C63FF) — center-left
- MediaBridge (purple #6C63FF) — center-right
- Android App (teal #00D9A3) — rightmost

Steps (top to bottom, numbered):
1. Provider → Server: "Webhook: incoming call"
2. Server → MediaBridge: "Create session (ControlAPI)"
3. Server → Android App: "Push wake signal"
4. Android App → Server: "Fetch notification"
5. Android App → MediaBridge: "WebRTC connect :10443"
6. Provider → MediaBridge: "SIP / Audio WS connect"
7. A bidirectional horizontal bar between Provider and Android App
   (passing through MediaBridge) labeled "Audio bridged"

Each actor has a vertical dashed lifeline in their color.
Arrows are solid lines with small arrowheads.
Step numbers are small circles to the left of each arrow.
```

---

## Diagram 3: Notification / Push Delivery Flow

```
[Include the design system above, then:]

Create a flow diagram showing how push notifications work in Svarla.
The key concept is that the push server never sees notification content —
only an opaque wake signal.

Components (left to right):
- "Svarla Server" (purple #6C63FF) — left
- "Push Server (e.g. ntfy)" (neutral #5A5A7A border, subtle fill) — center
- "Android App" (teal #00D9A3) — right

Flow arrows (numbered):
1. Server → Push Server: "POST {id, priority}" (label: "wake signal only")
2. Push Server → Android App: "Push delivery"
3. Android App → Server: "GET /api/notifications/:id" (label: "authenticated")
4. Server → Android App: "Full notification content"

Arrow 3 and 4 should bypass the Push Server (go directly between App and Server,
arcing above or below the Push Server).

Below the Push Server component, add a small annotation in #B0B0B0 italic text:
"Never sees message content — only relays opaque signal"

Keep the same dimensions and style as the other diagrams.
```

---

## Notes

- Generate one diagram at a time and review before requesting the next
- If the first result isn't right, iterate on it before moving to the next diagram
- These diagrams replace ASCII art in `docs/guide/architecture.md` and `docs/guide/notifications.md`
- Save final files as: `docs/public/architecture-overview.png`, `docs/public/call-flow.png`, `docs/public/push-flow.png`
