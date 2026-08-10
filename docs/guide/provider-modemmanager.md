# ModemManager

Use a physical USB modem with a SIM card for SMS. The server communicates with ModemManager over D-Bus.

::: info
ModemManager currently supports **SMS only** — voice calls are not supported through this provider.
:::

## Requirements

- Linux host with D-Bus access (not inside Docker)
- ModemManager installed and running
- USB modem with a SIM card inserted

::: warning
ModemManager requires the server to run directly on the host — not inside a Docker container. D-Bus access is needed for modem communication.
:::

## Setup

### 1. Install ModemManager

```bash
# Debian/Ubuntu
sudo apt install modemmanager

# Arch
sudo pacman -S modemmanager
```

### 2. Plug in the modem

Insert your USB modem. Verify it's detected:

```bash
mmcli -L
```

### 3. Configure in Svarla

The server auto-discovers modems via D-Bus. If your SIM doesn't self-report its number, add a number override in the provider settings keyed by the SIM's ICCID.
