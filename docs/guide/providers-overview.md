# Telephony Providers

Svarla is provider-agnostic. You can add, remove, and reconfigure telephony providers at runtime through the API or web interface — no restart required.

## Supported providers

| Provider | Type | Audio Transport | Features |
|----------|------|-----------------|----------|
| [Vonage](/guide/provider-vonage) | Cloud VoIP | SIP → MediaBridge | Voice + SMS |
| [46elks](/guide/provider-46elks) | Cloud VoIP | Audio WS → MediaBridge | Voice + SMS |
| [ModemManager](/guide/provider-modemmanager) | Hardware | — | SMS only (physical SIM) |

## How providers work

1. You configure a provider with credentials and assign one or more phone numbers to it.
2. For **outgoing calls/SMS**, the Server routes through the appropriate provider based on the number you're calling from.
3. For **incoming calls/SMS**, the provider sends a webhook to the Server, which routes the event to your connected devices.
4. **Call audio** is always handled by the MediaBridge — the provider connects to it directly via SIP or WebSocket.

## Adding a provider

Providers are managed via:

- **Web interface** — Settings → Providers → Add Provider
- **REST API** — `POST /api/providers`

Each provider type has its own configuration requirements. See the individual provider pages for details.
