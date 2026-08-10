# MediaBridge ControlAPI Specification

The ControlAPI is a REST interface exposed by the MediaBridge on localhost only
(default port 9090). The Node.js server uses it to manage audio sessions.

## Base URL

```
http://127.0.0.1:9090
```

The ControlAPI never binds to external interfaces. It is accessed only by the
co-located Node.js server.

---

## Endpoints

### POST /sessions

Create a new audio session. Allocates resources for one WebRTC client leg and
one provider leg (SIP, WebSocket, or pending).

**Request:**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "providerLeg": {
    "type": "sip",
    "uri": "sip:550e8400@mediabridge.example.com:5060"
  },
  "options": {
    "ringback": true,
    "audioTap": {
      "enabled": false,
      "endpoint": "ws://localhost:9092/tap/550e8400"
    }
  }
}
```

**Provider leg types:**

| Type | Description |
|------|-------------|
| `sip` | MediaBridge listens for a SIP INVITE matching the session ID |
| `websocket` | MediaBridge accepts an audio WebSocket on the audio WS port |
| `pending` | Provider leg unknown at creation time; connect later via PATCH |

**Response (201 Created):**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "CREATED",
  "sipUri": "sip:550e8400@203.0.113.10:5060",
  "audioWsUrl": "ws://203.0.113.10:9091/audio/550e8400"
}
```

---

### POST /sessions/:sessionId/offer

Pass the client's SDP offer to the MediaBridge. Returns an SDP answer and ICE
candidates for the WebRTC connection.

**Request:**

```json
{
  "sdpOffer": "v=0\r\no=- 12345 2 IN IP4 0.0.0.0\r\n..."
}
```

**Response (200 OK):**

```json
{
  "sdpAnswer": "v=0\r\no=- 67890 2 IN IP4 203.0.113.10\r\n...",
  "iceCandidates": [
    {
      "candidate": "candidate:1 1 TCP 2130706431 203.0.113.10 10443 typ host",
      "sdpMid": "0",
      "sdpMLineIndex": 0
    }
  ]
}
```

---

### PATCH /sessions/:sessionId

Update a session. Used to connect the provider leg after creation or toggle
ringback.

**Request:**

```json
{
  "providerLeg": {
    "type": "sip",
    "uri": "sip:session-id@provider.example.com:5060"
  },
  "ringback": false
}
```

All fields are optional. Only provided fields are updated.

**Response (200 OK):**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "BRIDGING"
}
```

---

### GET /sessions/:sessionId

Retrieve the current status of a session.

**Response (200 OK):**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ACTIVE",
  "clientConnected": true,
  "providerConnected": true,
  "durationSeconds": 45,
  "codec": "opus/48000/2"
}
```

**Session statuses:**

| Status | Description |
|--------|-------------|
| `CREATED` | Session allocated, no connections yet |
| `WAITING_CLIENT` | SDP answer generated, waiting for WebRTC connection |
| `CLIENT_CONNECTED` | WebRTC established, waiting for provider leg |
| `BRIDGING` | Provider leg connecting |
| `ACTIVE` | Both legs connected, audio flowing bidirectionally |
| `CLOSING` | Teardown in progress |
| `DESTROYED` | Session cleaned up |

---

### DELETE /sessions/:sessionId

Tear down a session. Sends SIP BYE on active SIP legs, closes the WebRTC
peer connection, and frees all resources.

**Response:** `204 No Content`

---

### GET /health

Health check endpoint. Returns operational status.

**Response (200 OK):**

```json
{
  "status": "ok",
  "activeSessions": 3,
  "uptime": 7200
}
```

---

## Error Responses

All endpoints return errors in a consistent format:

```json
{
  "error": "session_not_found",
  "message": "No session with ID 550e8400-e29b-41d4-a716-446655440000"
}
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Invalid request body or parameters |
| 404 | Session not found |
| 409 | Session already exists (duplicate sessionId on POST /sessions) |
| 500 | Internal server error |

---

## Event WebSocket (MediaBridge → Server)

The MediaBridge exposes a WebSocket endpoint at `GET /events` on the ControlAPI
port. The Server connects to this endpoint to receive asynchronous session events
and health updates. The Server does not send messages on this connection.

**Endpoint:** `ws://localhost:{controlApiPort}/events`

**Connection direction:** The Server connects to the MediaBridge (not the other
way around). This means the MediaBridge only needs inbound connectivity — it
never initiates outbound connections.

**Reconnection:** If the connection drops, the Server is responsible for
reconnecting. Events are buffered on the MediaBridge side (up to 256) until a
client reconnects.

### Event Types

#### session_event

Emitted when a session's state changes.

```json
{
  "type": "session_event",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "event": "client_connected"
}
```

**Event values:**

| Event | Description |
|-------|-------------|
| `client_connected` | WebRTC peer connection established |
| `client_disconnected` | WebRTC connection lost (includes `reason` field) |
| `provider_connected` | Provider SIP/WS leg connected |
| `provider_disconnected` | Provider leg disconnected (includes `reason` field) |
| `dtmf` | DTMF digit received from provider leg (includes `digit` field) |

**Disconnect reasons:**

| Reason | Description |
|--------|-------------|
| `ice_failed` | ICE connectivity check failed |
| `dtls_failed` | DTLS handshake failed |
| `timeout` | Connection timeout |
| `bye` | SIP BYE received from provider |
| `hangup` | Explicit hangup |

**DTMF event example:**

```json
{
  "type": "session_event",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "event": "dtmf",
  "digit": "5"
}
```

#### health

Periodic health status (sent every 30 seconds).

```json
{
  "type": "health",
  "activeSessions": 2,
  "uptime": 7200
}
```

---

## Audio Tap Format

When `options.audioTap.enabled = true` during session creation, the MediaBridge
streams raw audio to the configured tap endpoint.

**Transport:** WebSocket connection to `options.audioTap.endpoint`

**Frame format:** Binary WebSocket messages with a 1-byte direction header:

| Byte 0 | Meaning |
|--------|---------|
| `0x01` | Client → Provider audio |
| `0x02` | Provider → Client audio |

Remaining bytes are PCM 16-bit signed little-endian samples at 16kHz mono.
Each frame contains 20ms of audio (640 bytes of PCM data + 1 byte header = 641 bytes per frame).

The tap adds no latency to the main audio path — frames are copied asynchronously
in a separate goroutine with a non-blocking write to the tap endpoint.
