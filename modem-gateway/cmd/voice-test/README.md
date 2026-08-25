# voice-test

Developer tool for testing voice call capabilities with a SIM7600 modem.
Bridges the modem's PCM audio directly to the laptop speaker and microphone
via PortAudio. Not a production tool.

## Prerequisites

```bash
sudo apt-get install -y libportaudio2 portaudio19-dev
```

## Build

```bash
cd modem-gateway
go build ./cmd/voice-test/
```

## Usage

```
voice-test [flags] [phone-number]
```

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `/dev/ttyUSB2` | Modem AT command serial port |
| `--pcm-port` | `/dev/ttyUSB1` | Modem PCM audio serial port |
| `--ring-delay` | `3s` | How long to let an incoming call ring before answering |

### Outbound call

Dial a number and bridge audio to your laptop:

```bash
./voice-test --port /dev/ttyUSB2 --pcm-port /dev/ttyUSB1 +15551234567
```

### Inbound call (wait and answer)

Start the tool, wait for someone to call the SIM, auto-answer after 3 seconds:

```bash
./voice-test --port /dev/ttyUSB2 --pcm-port /dev/ttyUSB1
```

With a longer ring delay:

```bash
./voice-test --ring-delay 5s +15551234567
```

### Hanging up

Press `Ctrl+C` at any time to hang up and exit cleanly. The tool also
exits automatically if the remote party hangs up (NO CARRIER).

## How it works

1. Opens the AT command port and runs the standard modem init sequence
2. Negotiates PCM sample rate with the modem (16kHz preferred, 8kHz fallback)
3. Either dials the provided number or waits for an incoming RING
4. Opens the PCM audio port and starts the audio pipeline (AT+CPCMREG=1)
5. Opens a full-duplex PortAudio stream on the default sound device
6. Bridges modem capture frames to the speaker, and mic frames to modem playback
7. On exit: sends ATH, disables PCM (AT+CPCMREG=0), closes all ports
