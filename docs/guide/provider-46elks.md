# 46elks

[46elks](https://46elks.com) is a Swedish cloud communications provider with a simple API for voice and SMS.

## Setup

### 1. Create an account

Sign up at [46elks.com](https://46elks.com) and get your API credentials (username and password) from the dashboard.

### 2. Purchase a number

Buy a phone number from the 46elks dashboard.

### 3. Configure webhooks

On the 46elks dashboard, set these webhooks for your number:

| Webhook | URL |
|---------|-----|
| `voice_start` | `{BASE_URL}/webhooks/46elks/voice_start` |
| `sms_url` | `{BASE_URL}/webhooks/46elks/sms_incoming` |

Replace `{BASE_URL}` with your server's public URL.

### 4. Add to Svarla

Via the web interface or API, add a 46elks provider with:

- API Username
- API Password
- Webhook Base URL

### Audio routing

46elks call audio goes through the MediaBridge via WebSocket. The Server responds to 46elks webhooks with a `connect` action pointing to the MediaBridge's audio WebSocket port.
