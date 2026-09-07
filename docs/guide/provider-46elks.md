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
| `voice_start` | `{BASE_URL}/webhooks/{PROVIDER_ID}/voice_start` |
| `sms_url` | `{BASE_URL}/webhooks/{PROVIDER_ID}/sms_incoming` |

Replace `{BASE_URL}` with your server's public URL, and `{PROVIDER_ID}` with the
id shown in the Svarla provider management view. After adding the provider,
Svarla shows the exact URLs to copy under **Webhook URLs** in the provider
detail view.

::: tip
There is no `voice_event` webhook to configure. Svarla sets the call-ended
callback (`whenhangup`) automatically for each call, so it does not appear in
the dashboard webhook list.
:::

### 4. Add to Svarla

Via the web interface or API, add a 46elks provider with:

- API Username
- API Password
- Webhook Base URL
- WebSocket Number — your 46elks WebSocket number (the `+4600…` number) used to
  route call audio via the Realtime Voice API

### 5. Register the audio WebSocket URL

46elks call audio goes through the MediaBridge over a WebSocket. In the 46elks
dashboard, set the WebSocket URL for your WebSocket (`+4600…`) number to the
audio WebSocket URL:

```
{BASE_URL as wss}/audio/
```

For example, if your base URL is `https://phone.example.com`, the audio
WebSocket URL is `wss://phone.example.com/audio/`. Svarla shows this exact value
under **Audio WebSocket URL** in the provider detail view. The `/audio/` path is
proxied to the MediaBridge audio WebSocket (port 9091) behind TLS — see the
[Docker install guide](/guide/install-docker) for the reverse-proxy setup.
