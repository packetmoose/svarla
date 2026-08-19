# Vonage

Vonage (formerly Nexmo) is a cloud communications provider that supports voice calls and SMS.

## Setup

### 1. Create a Vonage Application

Go to the [Vonage Dashboard](https://dashboard.nexmo.com/applications) and create an application with **Voice** and/or **Messages** capabilities.

### 2. Configure webhook URLs

Set these on the Vonage dashboard:

| Webhook | URL |
|---------|-----|
| Answer URL | `{BASE_URL}/webhooks/{PROVIDER_ID}/answer` |
| Event URL | `{BASE_URL}/webhooks/{PROVIDER_ID}/event` |
| Inbound SMS | `{BASE_URL}/webhooks/{PROVIDER_ID}/inbound-sms` |
| SMS Status | `{BASE_URL}/webhooks/{PROVIDER_ID}/sms-status` |

Replace `{BASE_URL}` with your server's public URL (the `BASE_URL` environment variable).
And `PROVIDER_ID` with the id shown in the management page after creating the provider. 

### 3. Add to Svarla

Via the web interface or API, add a Vonage provider with:

- API Key
- API Secret
- Application ID
- Private Key (the `.key` file content)

### Audio routing

Vonage call audio goes through the MediaBridge via SIP. When a call connects, the Server instructs Vonage (via NCCO) to use a `connect` action with type `sips`, pointing to the MediaBridge's SIPS port (5061), if not server is configured to use unencrypted SIP on port 5060.

::: tip
Make sure your MediaBridge's SIP port (5061) is accessible from Vonage's infrastructure.
:::
