# Notifications & Push Delivery

Svarla uses a privacy-respecting push notification system to wake the Android app when calls or messages arrive while it's not in the foreground.

## How it works

```
┌──────────┐       ┌──────────────┐       ┌───────────────────┐
│  Server  │──────►│ Push Server  │──────►│   Android App     │
│          │ POST  │  (e.g. ntfy) │ push  │                   │
│          │       └──────────────┘       │  ┌─────────────┐  │
│          │                              │  │ UP Receiver  │  │
│          │                              │  └──────┬──────┘  │
│          │◄─────────────────────────────│─────────┘         │
│          │  GET /api/notifications/:id  │  fetch content    │
└──────────┘                              └───────────────────┘
```

1. An event occurs (incoming call, SMS, etc.).
2. The server broadcasts a real-time update via WebSocket to any **connected** devices.
3. For **offline** devices (not connected via WebSocket), the server sends a **wake signal** to the device's registered push endpoint.
4. The wake signal is intentionally minimal — it contains only an ID and a priority level (`high` or `normal`). No message content, no sender info, no notification type.
5. The Android app wakes up, fetches the full notification content from the server via `GET /api/notifications/:id`, and displays it locally.

::: tip Privacy by design
The push channel (e.g., ntfy server) never sees the content of your notifications. It only relays a small opaque signal. All actual content is fetched directly from your Svarla server over your authenticated connection.
:::

## Delivery modes

The Android app supports three notification delivery modes, configurable in Settings → Notifications:

| Mode | How it works | Battery impact | Recommended |
|------|-------------|----------------|-------------|
| **UnifiedPush** | Uses a distributor app (e.g., ntfy) to receive push signals | Low — shares one connection across all UP-compatible apps | ✅ Yes |
| **Persistent WebSocket** | Maintains a background WebSocket connection to the server | Higher — keeps a dedicated connection alive | Fallback |
| **None** | No background delivery; notifications only arrive while the app is open | None | Not recommended |

### UnifiedPush (recommended)

[UnifiedPush](https://unifiedpush.org) is an open standard for push notifications that doesn't depend on Google Play Services or FCM. It works by having a "distributor" app on your phone that maintains a single connection to a push server and forwards messages to registered apps.

**Setup:**

1. Install a UnifiedPush distributor on your phone. The recommended option is [ntfy](https://ntfy.sh):
   - From [F-Droid](https://f-droid.org/packages/io.heckel.ntfy/)
   - Or from [GitHub releases](https://github.com/binwiederhier/ntfy/releases)
2. Open ntfy and connect it to a push server:
   - **Self-hosted ntfy** (recommended for privacy) — run `ntfy serve` on your server or use a container
   - **Public ntfy.sh** — works out of the box, no setup needed, but signals transit through a third party
3. Open Svarla → Settings → Notifications → select **UnifiedPush**
4. The app automatically discovers the distributor, registers, and sends the endpoint URL to your Svarla server

That's it. The app will now receive push notifications through ntfy with minimal battery usage.

::: info Self-hosted ntfy
If you run ntfy on the same local network as Svarla and are accessing it over LAN/VPN, set `push.allowPrivateEndpoints: true` in `server-config.yaml` to allow the server to POST to private/LAN endpoint URLs. By default, only HTTPS URLs resolving to public IPs are accepted (SSRF protection).
:::

### Persistent WebSocket (fallback)

If you don't want to install a UnifiedPush distributor, the app can maintain a background WebSocket connection directly to your Svarla server. This works without any additional software but uses more battery because the app must keep a connection alive in the background.

**Setup:**

1. Open Svarla → Settings → Notifications → select **Persistent connection**
2. When prompted, grant battery optimization exemption (required for the connection to survive in the background)

::: warning Battery impact
Android aggressively kills background connections. The battery exemption helps, but some manufacturers (Xiaomi, Samsung, etc.) may still restrict it. If you experience missed notifications, check your device's battery settings or switch to UnifiedPush.
:::

### None

No background delivery. Notifications only arrive while the app is actively open and connected via WebSocket. Incoming calls will be missed when the app is not in the foreground.

## Wake signal format

The server sends a minimal JSON payload to the push endpoint:

```json
{
  "id": "notification-uuid",
  "priority": "high"
}
```

| Field | Description |
|-------|-------------|
| `id` | UUID of the notification entity on the server |
| `priority` | `high` for incoming calls (triggers immediate wake + Telecom routing), `normal` for everything else (SMS, missed calls) |

No metadata about the notification type, sender, or content is included in the push payload. This is intentional — the push server (ntfy or otherwise) cannot infer what kind of event occurred.

## Server configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `push.allowPrivateEndpoints` | `false` | Allow push endpoint URLs on private/LAN networks. Enable if your ntfy instance is on the same LAN or server. |

This is set in `server-config.yaml`:

```yaml
push:
  allowPrivateEndpoints: false
```

## First-time setup flow

When the app connects to the server for the first time after login:

1. If a UnifiedPush distributor is detected on the device → UnifiedPush is auto-selected (no dialog shown)
2. If no distributor is found → a setup dialog appears offering WebSocket or None
3. The user can change the mode at any time in Settings → Notifications

## Notification types

The server generates notifications for:

| Type | Priority | Description |
|------|----------|-------------|
| `incoming_call` | high | A call is ringing — requires immediate wake |
| `missed_call` | normal | A call was missed |
| `incoming_sms` | normal | A new SMS was received |
| `blocked_call` | normal | A call was blocked |
| `new_device_login` | normal | Another device logged in |

## Troubleshooting

**Not receiving notifications:**

1. Check delivery mode in Settings → Notifications
2. For UnifiedPush: verify ntfy is running and connected to its server (open ntfy app → check status)
3. For WebSocket: check that battery optimization exemption is granted
4. Verify the server can reach your push endpoint: check server logs for "Sent wake signals to offline devices" or "Failed to send wake signals"

**Delayed notifications:**

- Normal-priority notifications may be batched by the push distributor for battery efficiency
- High-priority (incoming calls) are always delivered immediately
- If using persistent WebSocket: check if your device manufacturer restricts background connections

**ntfy on the same network:**

If you run ntfy alongside Svarla and the push endpoint URL is a private/LAN address (e.g., `http://ntfy:8080/...`), you must set `push.allowPrivateEndpoints: true` in your server config. Otherwise the server will reject the endpoint URL as a potential SSRF target.
