# Modem Gateway

The modem-gateway provider enables SMS and voice calls through a physical USB modem connected to a Raspberry Pi or similar single-board computer. A standalone Go gateway communicates with the modem via AT commands and streams PCM audio over a dedicated serial port, connecting back to your Svarla instance over WebSocket.

::: info Available from v0.6.0
The modem-gateway provider — both the Svarla server support and the gateway binary — ships with Svarla **v0.6.0**. Until that release is published, this provider isn't available: the download links won't resolve and the Modem Gateway type won't appear in the server.
:::

::: warning Experimental
The modem-gateway provider is experimental. To add a new modem-gateway provider via the web UI, start the Svarla server with `EXPERIMENTAL_PROVIDERS=true`. Existing providers operate normally regardless of this flag. API-based creation works without the flag.
:::

## Architecture

```
┌─────────────────────────────────────┐
│  Raspberry Pi / SBC                 │
│                                     │
│  ┌──────────────────────┐           │
│  │ modem-gateway binary │           │
│  │ (Go)                 │           │
│  └──────┬───────┬───────┘           │
│         │AT     │PCM Audio          │
│  ┌──────┴───────┴───────┐           │
│  │     USB Modem        │           │
│  │   (SIM7600G-H)       │           │
│  └──────────────────────┘           │
└──────────┬───────────────┬──────────┘
           │               │
  Signaling WS      Audio WS
  (persistent)      (per-call)
           │               │
┌──────────┴───────────────┴──────────┐
│         Svarla Server               │
│  ┌─────────────┐  ┌─────────────┐  │
│  │  Provider   │  │ MediaBridge │  │
│  │  Registry   │  │             │  │
│  └─────────────┘  └─────────────┘  │
└─────────────────────────────────────┘
```

The gateway initiates two outbound WebSocket connections:

- A **persistent signaling WebSocket** to Svarla for authentication, SMS, call control, USSD, and status reporting.
- An **ephemeral per-call audio WebSocket** to the MediaBridge for bidirectional 16kHz PCM audio streaming.

Since the gateway connects outbound, no port forwarding is needed on the Pi.

## Supported Modems

### SIMCom SIM7600G-H

The SIM7600G-H is the primary reference modem. It provides:

- Global LTE Cat-4 connectivity
- AT command interface over USB serial (`/dev/ttyUSB2` typically)
- PCM audio streaming over a dedicated USB serial port (`AT+CPCMREG` support)

Other SIMCom models in the SIM7600, SIM7500, and A7600 families are also supported.

### Compatibility Check

The gateway checks the modem model against a known-supported list (`SIM7600*`, `SIM7500*`, `A7600*`). If your modem is not recognized, you'll see a warning in the logs and provider status — but the gateway will continue operating. SIMCom-proprietary commands (`AT+CPCMREG`, `AT+CPCMFRM`) may not work on other modems.

### Required Modem Firmware Features

- **AT command interface** accessible over USB serial port
- **PCM audio over USB serial port** — enabled via `AT+CPCMREG=1` during calls

## Hardware Requirements

| Component | Notes |
|-----------|-------|
| Raspberry Pi 4/5 (or similar SBC) | Any Linux device with USB ports works |
| SIMCom SIM7600G-H USB modem | HAT form factor or USB dongle |
| Active SIM card | With voice and/or SMS service |
| Stable internet connection | For WebSocket connections to Svarla |

The modem typically exposes multiple USB serial ports:

| Port | Purpose |
|------|---------|
| `/dev/ttyUSB0` | Diagnostics |
| `/dev/ttyUSB1` | GPS NMEA (if available) |
| `/dev/ttyUSB2` | AT commands (default) |
| `/dev/ttyUSB3` | PPP data |
| `/dev/ttyUSB4` | PCM audio (varies by model) |

Check `dmesg` output after plugging in the modem to identify port assignments.

## Installation

### 1. Download the binary

Download the latest release for your architecture from the [GitHub Releases](https://github.com/packetmoose/svarla/releases) page:

```bash
# For Raspberry Pi (arm64)
wget https://github.com/packetmoose/svarla/releases/latest/download/modem-gateway-linux-arm64
chmod +x modem-gateway-linux-arm64
sudo mv modem-gateway-linux-arm64 /usr/local/bin/modem-gateway
```

```bash
# For x86_64 servers
wget https://github.com/packetmoose/svarla/releases/latest/download/modem-gateway-linux-amd64
chmod +x modem-gateway-linux-amd64
sudo mv modem-gateway-linux-amd64 /usr/local/bin/modem-gateway
```

Verify the installation:

```bash
modem-gateway --version
```

### 2. Generate a configuration file

```bash
modem-gateway --generate-config
```

This creates `modem-gateway.yaml` in the current directory with commented defaults. Move it to a permanent location:

```bash
sudo mkdir -p /etc/modem-gateway
sudo mv modem-gateway.yaml /etc/modem-gateway/modem-gateway.yaml
```

### 3. Create the provider in Svarla

Create the provider from the Svarla web interface:

1. Open **Settings → Providers** and click **Add Provider**.
2. Choose **Modem Gateway** as the type and give it a display name (e.g., "My USB Modem").

   ::: tip
   The Modem Gateway type only appears in the picker when the server is started with `EXPERIMENTAL_PROVIDERS=true`.
   :::
3. Save. Svarla creates the provider and displays a **one-time pairing secret** along with the **signaling WebSocket endpoint**.

Copy both values now — the pairing secret is shown only once and cannot be retrieved later. If you lose it, you can generate a new one with **Reset pairing** (see [Re-pairing](#re-pairing)).

### 4. Configure the gateway

Edit `/etc/modem-gateway/modem-gateway.yaml`:

```yaml
connection:
  endpoint: "wss://your-svarla-instance/ws/providers/provider-id-here/signaling"
  pairingSecret: "abc123xy"

modem:
  serialPort: "/dev/ttyUSB2"
```

### 5. Start the gateway

```bash
modem-gateway -config /etc/modem-gateway/modem-gateway.yaml
```

On first start, the gateway:
1. Generates an Ed25519 keypair (saved to `modem-gateway.key` alongside the config)
2. Connects to Svarla and pairs using the secret
3. Begins reporting modem status

After successful pairing, remove the `pairingSecret` line from your config — it's single-use.

## Configuration Reference

```yaml
# Connection to Svarla server
connection:
  # Required: Svarla signaling WebSocket endpoint URL.
  # Format: wss://<svarla-host>/ws/providers/<provider-id>/signaling
  endpoint: ""

  # One-time pairing secret from Svarla provider creation.
  # Remove this line after successful pairing.
  pairingSecret: ""

# Modem settings
modem:
  # Required: AT command serial port device path.
  serialPort: "/dev/ttyUSB2"

  # Optional: Phone number in E.164 format (e.g., +15551234567).
  # Used as fallback if AT+CNUM does not return a number.
  phoneNumber: ""

  # Enable voice calls (default: true).
  voiceEnabled: true

  # Optional: PCM audio serial port device path.
  # Auto-detected from modem USB interfaces if not specified.
  pcmAudioPort: ""

  # Enable self-managed network registration (default: false).
  # When false, assumes host OS handles cellular registration.
  networkRegistration: false

  # Optional: SIM PIN for automatic unlock.
  simPin: ""

# TLS settings
tls:
  # Optional: Path to custom CA certificate in PEM format.
  caCert: ""

  # Skip TLS certificate verification (default: false).
  # WARNING: Only use for development/testing.
  skipVerify: false

# Logging
log:
  # Log level: error, warn, info, debug, verbose (default: info).
  level: "info"

  # Optional: Log to file instead of stdout.
  file: ""
```

### Configuration Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `connection.endpoint` | Yes | — | Svarla signaling WebSocket URL |
| `connection.pairingSecret` | First run only | — | One-time pairing code from provider creation |
| `modem.serialPort` | Yes | `/dev/ttyUSB2` | AT command serial port |
| `modem.phoneNumber` | No | — | E.164 phone number override |
| `modem.voiceEnabled` | No | `true` | Enable/disable voice calls |
| `modem.pcmAudioPort` | No | auto-detected | PCM audio serial port for voice |
| `modem.networkRegistration` | No | `false` | Self-managed network registration |
| `modem.simPin` | No | — | SIM PIN for automatic unlock |
| `tls.caCert` | No | — | Path to custom CA certificate (PEM) |
| `tls.skipVerify` | No | `false` | Disable TLS cert verification |
| `log.level` | No | `info` | Log verbosity (error/warn/info/debug/verbose) |
| `log.file` | No | stdout | Log file path |

## Pairing Flow

The pairing flow establishes trust between the gateway and Svarla using Ed25519 public-key cryptography.

### Initial Pairing (one-time)

1. **Create provider** in Svarla (Settings → Providers) — Svarla shows a one-time pairing secret and the WebSocket endpoint
2. **Configure** the gateway with the endpoint and pairing secret
3. **Start** the gateway — it generates an Ed25519 keypair and connects to Svarla
4. **Pairing** — the gateway sends its public key + pairing secret; Svarla stores the key and invalidates the secret
5. **Done** — remove `pairingSecret` from your config file

### Subsequent Connections

After pairing, reconnections use challenge-response authentication:

1. Gateway connects to Svarla
2. Svarla sends a 32-byte random nonce (expires in 30s)
3. Gateway signs the nonce with its Ed25519 private key
4. Svarla verifies the signature against the stored public key
5. Connection authenticated

### Re-pairing

If you need to re-pair (lost key file, moved to a new device):

1. Open **Settings → Providers** and select the modem-gateway provider.
2. Click **Reset pairing**. Svarla generates and displays a new one-time pairing secret.
3. On the gateway device, delete the old key file (`modem-gateway.key`, alongside your config), then add the new `pairingSecret` to your config.
4. Restart the gateway. It generates a fresh keypair and pairs with the new secret.

Resetting invalidates the previously stored public key, so the old key file can no longer authenticate.

## Running as a Systemd Service

Create `/etc/systemd/system/modem-gateway.service`:

```ini
[Unit]
Description=Svarla Modem Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=modem-gateway
Group=modem-gateway

# Path to gateway and config
ExecStart=/usr/local/bin/modem-gateway -config /etc/modem-gateway/modem-gateway.yaml
WorkingDirectory=/etc/modem-gateway

# Restart on failure with 5-second delay
Restart=on-failure
RestartSec=5

# Graceful shutdown (gateway handles SIGTERM)
TimeoutStopSec=15

# Security hardening
ProtectSystem=strict
PrivateTmp=true
NoNewPrivileges=true
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true

# Allow access to serial ports
ReadWritePaths=/etc/modem-gateway
DeviceAllow=/dev/ttyUSB0 rw
DeviceAllow=/dev/ttyUSB1 rw
DeviceAllow=/dev/ttyUSB2 rw
DeviceAllow=/dev/ttyUSB3 rw
DeviceAllow=/dev/ttyUSB4 rw

# Logging to journal
StandardOutput=journal
StandardError=journal
SyslogIdentifier=modem-gateway

[Install]
WantedBy=multi-user.target
```

### Install and enable

```bash
# Create service user
sudo useradd -r -s /sbin/nologin modem-gateway
sudo usermod -a -G dialout modem-gateway

# Install service
sudo cp modem-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable modem-gateway
sudo systemctl start modem-gateway
```

## Troubleshooting

### Gateway cannot open serial port

**Symptom:** `failed to open serial port: permission denied`

**Fix:** Ensure the user running the gateway has access to the serial device:

```bash
sudo usermod -a -G dialout $USER
# Log out and back in, or restart the service
```

### Pairing fails

**Symptom:** `auth_error: invalid or expired pairing secret`

**Possible causes:**
- The pairing secret has expired (valid for 24 hours after creation)
- The secret was already used
- The provider already has a stored public key (already paired)

**Fix:** In **Settings → Providers**, select the provider and click **Reset pairing** to generate a new secret, then update your config and restart the gateway (see [Re-pairing](#re-pairing)).

### Modem not detected

**Symptom:** `modem unresponsive, retrying...`

**Check:**
1. Verify the modem is connected: `ls /dev/ttyUSB*`
2. Confirm the correct port in your config (try each ttyUSB port)
3. Check `dmesg | grep ttyUSB` for port assignments
4. Ensure no other process is using the port (e.g., ModemManager):
   ```bash
   sudo systemctl stop ModemManager
   sudo systemctl disable ModemManager
   ```

### No voice audio

**Symptom:** Calls connect but there's no audio

**Check:**
1. Verify `modem.voiceEnabled: true` in config
2. Check that the PCM audio port is correct (or let it auto-detect)
3. Look for `AT+CPCMREG` errors in verbose logs:
   ```yaml
   log:
     level: "verbose"
   ```
4. Ensure MediaBridge is reachable from the Pi

### Phone number not discovered

**Symptom:** Provider shows no number in Svarla

**Fix:** Many SIMs don't store the number on the SIM card. Set it manually:

```yaml
modem:
  phoneNumber: "+15551234567"
```

### TLS certificate errors

**Symptom:** `x509: certificate signed by unknown authority`

**Fix for self-signed certificates:**

```yaml
tls:
  caCert: "/path/to/your/ca.pem"
```

Or for development only:

```yaml
tls:
  skipVerify: true
```

### Unsupported modem warning

**Symptom:** Provider status shows a compatibility warning

This means your modem model wasn't recognized as a known-supported SIMCom device. The gateway will continue operating, but SIMCom-proprietary commands (`AT+CPCMREG` for PCM audio, `AT+CPCMFRM` for sample rate) may not work. Voice calls may not function if your modem doesn't support these commands.

### SIM PIN rejected

**Symptom:** `SIM PIN rejected, not retrying`

The gateway will never retry a rejected PIN to avoid locking your SIM. Verify the PIN is correct in your config, then restart the service.
