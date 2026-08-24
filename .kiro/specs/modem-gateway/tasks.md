# Implementation Plan: Modem Gateway Provider

## Overview

This plan implements the modem-gateway telephony provider for Svarla, consisting of: (1) removal of the legacy ModemManager provider from the Svarla server, (2) a new Go binary (`modem-gateway/`) that communicates with a USB modem via AT commands and streams audio via a dedicated PCM audio serial port, (3) a new `ModemGatewayTelephonyProvider` and WebSocket handler on the Svarla server, (4) build system integration for cross-compiled Go binary releases, and (5) provider documentation. The implementation uses TypeScript (Svarla server) and Go (modem-gateway binary).

## Tasks

- [ ] 1. Remove legacy ModemManager provider
  - [ ] 1.1 Create database migration `012_remove_modemmanager.ts` that deletes numbers and provider rows with type "modemmanager"
    - Add migration file under `src/migrations/` with sequential number after 011
    - `up`: delete from `numbers` where provider_id in modemmanager providers, then delete provider rows
    - `down`: no-op
    - _Requirements: 13.5_

  - [ ] 1.2 Remove ModemManager provider files and references
    - Delete `src/providers/modemmanager-telephony-provider.ts` and `src/providers/modemmanager-telephony-provider.test.ts`
    - Remove `modemmanagerConfigSchema` export and `modemmanager` entry from `schemasByType` in `src/validators/provider-config-validator.ts`
    - Remove `modemmanager` from `SENSITIVE_FIELDS` in `src/services/config-encryption.ts`
    - Remove `modemmanager` from `WEBHOOK_ENDPOINTS` in `src/services/provider-registry.ts`
    - Remove `case 'modemmanager'` from provider factory in `src/server.ts`
    - Remove all import statements referencing ModemManager from other source files
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [ ] 1.3 Remove `dbus-next` dependency from `package.json` and regenerate lock file
    - Run `npm uninstall dbus-next` (and `@types/dbus-next` if present)
    - Verify no other code references dbus-next
    - _Requirements: 13.3_

  - [ ] 1.4 Verify build and tests pass after ModemManager removal
    - Run `npm run build` and `npm run test`
    - Fix any remaining broken imports or references
    - _Requirements: 13.6_

- [ ] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 3. Set up Go binary project scaffolding
  - [ ] 3.1 Initialize Go module and directory structure
    - Create `modem-gateway/` at project root with `go.mod` (module name `github.com/packetmoose/svarla/modem-gateway`)
    - Create directory structure: `cmd/modem-gateway/`, `internal/config/`, `internal/modem/`, `internal/audio/`, `internal/signaling/`, `internal/bridge/`, `internal/sms/`, `internal/ussd/`, `internal/identity/`, `internal/buffer/`
    - Create `cmd/modem-gateway/main.go` entry point with `--version` and `--generate-config` flags, signal handling (SIGTERM, SIGINT)
    - Embed version/commit/buildDate variables with ldflags support
    - _Requirements: 15.2, 24.1, 29.4_

  - [ ] 3.2 Implement `internal/config` package
    - Define `Config`, `ConnectionConfig`, `ModemConfig`, `TLSConfig`, `LogConfig` structs with YAML tags
    - Implement YAML parsing and validation (required fields: endpoint, serialPort)
    - Implement `--generate-config` default file generation
    - Handle missing config file with helpful error message suggesting `--generate-config`
    - Handle invalid syntax / missing required fields with descriptive errors
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [ ]* 3.3 Write unit tests for `internal/config`
    - Test valid YAML parsing, invalid syntax errors, missing required fields
    - Test default generation output
    - Test all optional fields with defaults
    - _Requirements: 15.1, 15.3, 15.4, 15.5_

- [ ] 4. Implement Go binary identity and authentication
  - [ ] 4.1 Implement `internal/identity` package
    - Ed25519 keypair generation on first run
    - PEM file storage for private key (e.g., `modem-gateway.key` in config directory)
    - Load existing key from PEM file
    - Public key export (base64 for pairing message)
    - Challenge signing: accept 32-byte nonce, return Ed25519 signature
    - _Requirements: 2.1, 2.3, 2.4_

  - [ ]* 4.2 Write property test for Ed25519 signature verification round trip (Property 9)
    - **Property 9: Ed25519 Signature Verification Round Trip**
    - For any 32-byte nonce and valid keypair, sign and verify succeeds; verify with different key fails
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 2.3, 2.4, 2.5**

- [ ] 5. Implement Go binary modem communication
  - [ ] 5.1 Implement `internal/modem` package - AT command manager
    - Open serial port at configured path (115200 baud, 8N1)
    - Single-goroutine command queue (channel + mutex serialized, one AT command at a time)
    - Command timeout handling (30s default, 5s for VTS, 60s for CMGS)
    - Final result code parsing (OK, ERROR, +CME ERROR, +CMS ERROR)
    - _Requirements: 14.1, 14.5, 14.6_

  - [ ] 5.2 Implement URC parser and modem state machine
    - Background goroutine reading serial port for URCs
    - Parse and dispatch: RING, +CLIP, +CMTI, +CUSD, +DTMF, +CREG, +CDS
    - State machine: Disconnected → Initializing → Ready → InCall → Error
    - State transitions based on command results and URCs (ATD/ATA success → InCall, ATH/NO CARRIER → Ready)
    - _Requirements: 14.3, 11.1_

  - [ ] 5.3 Implement modem initialization sequence
    - `ATE0` (disable echo), verbose results, `+CLIP` enable, `+CMTI` enable
    - `AT+CMGF=1` (text mode, fallback to PDU if unsupported)
    - Modem detection with exponential backoff (2s → 30s) on USB disconnect/unresponsive
    - Query modem model (`AT+CGMM`), manufacturer (`AT+CGMI`), firmware (`AT+CGMR`)
    - _Requirements: 14.4, 11.1, 25.1_

  - [ ]* 5.4 Write property test for AT command serialization order (Property 10)
    - **Property 10: AT Command Serialization Order**
    - For any sequence of commands submitted concurrently, they are sent FIFO with no interleaving
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 14.1, 14.5**

  - [ ]* 5.5 Write unit tests for modem state machine and URC parsing
    - Test state transitions, URC parsing for all supported types
    - Test command timeout behavior
    - Test initialization sequence
    - _Requirements: 14.3, 14.4, 14.5_

- [ ] 6. Implement Go binary signaling WebSocket client
  - [ ] 6.1 Implement `internal/signaling` package - WebSocket client
    - Persistent WebSocket connection to Svarla server
    - JSON message send/receive with `type` field dispatch
    - Ping/pong handling (respond to server pings)
    - Message send queue for outbound messages
    - TLS configuration support (custom CA cert, skip-verify)
    - _Requirements: 3.1, 3.2, 3.5, 22.1, 22.2, 22.3_

  - [ ] 6.2 Implement authentication flow in signaling client
    - Initial pairing: send `auth_pair` with publicKey (base64) and pairingSecret
    - Reconnection: receive `auth_challenge`, sign nonce with Ed25519, send `auth_response`
    - Handle `auth_success` and `auth_error` messages
    - Remove pairing secret from config note after successful pairing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.4_

  - [ ] 6.3 Implement exponential backoff reconnection
    - Backoff: 1s → 2s → 4s → ... → 60s cap, indefinite retries
    - Re-authenticate on each reconnect
    - Track connection state (connected/disconnected)
    - _Requirements: 3.3, 3.4_

  - [ ]* 6.4 Write property test for exponential backoff bounds (Property 7)
    - **Property 7: Exponential Backoff Bounds**
    - For any N consecutive failures, delay = min(initial × 2^N, max) and never exceeds cap
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 3.3, 11.1**

  - [ ]* 6.5 Write property test for signaling message serialization round trip (Property 6)
    - **Property 6: Signaling Message Serialization Round Trip**
    - For any valid signaling message, serialize to JSON and deserialize produces identical type and fields
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 3.1, 3.2**

- [ ] 7. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 8. Implement Go binary SMS handling
  - [ ] 8.1 Implement `internal/sms` package - send and receive
    - SMS send via `AT+CMGS` (text mode default, PDU fallback)
    - SMS receive via `+CMTI` URC → `AT+CMGR` to read
    - Extract sender, recipient, body, timestamp from received messages
    - 60-second send timeout
    - Report success with message reference or failure with error reason
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ] 8.2 Implement concatenated SMS reassembly and UCS-2 encoding
    - Multi-part SMS reassembly: track parts by reference number, assemble when complete
    - UCS-2 detection: scan body for characters outside GSM-7, switch encoding
    - UCS-2 decoding for received messages
    - Delivery report request via `AT+CSMP` configuration
    - Delivery report parsing from `+CDS` URC
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 19.1, 19.2_

  - [ ]* 8.3 Write property test for concatenated SMS reassembly (Property 11)
    - **Property 11: Concatenated SMS Reassembly Completeness**
    - For any N-part SMS delivered in any order, reassembled message equals correct-sequence concatenation
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 18.1**

  - [ ]* 8.4 Write property test for UCS-2 detection (Property 12)
    - **Property 12: UCS-2 Detection Correctness**
    - For any string, if contains character outside GSM-7 → UCS-2 selected; otherwise → GSM-7
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 18.3**

- [ ] 9. Implement Go binary persistent buffer
  - [ ] 9.1 Implement `internal/buffer` package - disk-persisted ring buffer
    - JSON Lines format (one JSON object per line, append-only)
    - Max capacity: 1000 entries (shared SMS + missed calls)
    - FIFO eviction when full (discard oldest)
    - Flush to disk on every write (crash-safe)
    - Drain on reconnect: deliver all buffered items in chronological order
    - Truncate file after successful delivery
    - Generic type `PersistentBuffer[T any]` interface
    - _Requirements: 4.4, 4.5, 4.6, 4.8, 21.1, 21.2, 21.3, 21.4_

  - [ ]* 9.2 Write property test for SMS buffer serialization round trip (Property 3)
    - **Property 3: SMS Buffer Serialization Round Trip**
    - For any valid SMS notification with arbitrary Unicode, serialize/deserialize produces identical entry
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 4.5, 4.8**

  - [ ]* 9.3 Write property test for buffer capacity invariant (Property 4)
    - **Property 4: SMS Buffer Capacity Invariant**
    - For any N pushes on a capacity-1000 buffer, length never exceeds 1000; when N>1000, contains most recent 1000
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 4.4, 21.4**

  - [ ]* 9.4 Write property test for buffer drain ordering (Property 5)
    - **Property 5: SMS Buffer Drain Ordering**
    - For any sequence of pushed entries, drain returns them in push order (FIFO oldest first)
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 4.6, 21.3**

- [ ] 10. Implement Go binary audio pipeline
  - [ ] 10.1 Implement `internal/audio` package - PCM serial capture and playback
    - PCM audio serial port manager: opens the modem's dedicated PCM ttyUSB device
    - Issues `AT+CPCMFRM=1` to negotiate 16kHz; falls back to 8kHz if unsupported
    - Issues `AT+CPCMREG=1` to enable PCM streaming during call; `AT+CPCMREG=0` to disable on call end
    - Serial port read goroutine: read PCM frames from ttyUSB, write to channel
    - Serial port write goroutine: read from channel, write PCM frames to ttyUSB
    - Frame size: 640 bytes (320 samples × 16-bit = 20ms at 16kHz)
    - _Requirements: 6.1, 6.2, 26.1, 26.2, 26.5_

  - [ ] 10.2 Implement audio resampling (8kHz ↔ 16kHz)
    - Linear interpolation upsample 8→16kHz
    - Averaging downsample 16→8kHz
    - Conditional: only resample if native rate differs from 16kHz wire rate
    - _Requirements: 26.2, 26.3, 26.4_

  - [ ] 10.3 Implement `internal/bridge` package - Audio WebSocket client
    - Per-call WebSocket connection to MediaBridge (`/audio/{sessionId}`)
    - Bidirectional PCM frame pump: capture → WS send; WS receive → playback
    - 20ms timer-driven send interval
    - Respond to ping frames; detect dead connection (no pong within 60s)
    - Normal closure on call end
    - Apply same TLS configuration as signaling WS
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 22.4_

  - [ ]* 10.4 Write property test for audio resampling round trip (Property 1)
    - **Property 1: Audio Resampling Round Trip (8kHz → 16kHz → 8kHz)**
    - For any valid 8kHz PCM frame, upsample then downsample produces output within ±1 of original
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 26.2, 26.3**

  - [ ]* 10.5 Write property test for audio resampling frame size invariant (Property 2)
    - **Property 2: Audio Resampling Frame Size Invariant**
    - For N samples at 8kHz, upsample produces 2N samples; for M samples at 16kHz, downsample produces M/2
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 26.2, 26.3, 6.1**

- [ ] 11. Implement Go binary voice call handling and DTMF
  - [ ] 11.1 Implement voice call state management in signaling client
    - Handle `make_call` message: dial with `ATD`, report state transitions (RINGING, ANSWERED, COMPLETED, FAILED, BUSY)
    - Handle `answer_call` message: answer with `ATA`, open audio WS
    - Handle `end_call` message: hang up with `ATH`, close audio WS
    - Detect incoming calls (RING + +CLIP), send `incoming_call` message
    - Detect remote hangup (NO CARRIER), close audio WS, report COMPLETED
    - Single concurrent call enforcement; reject second call with FAILED
    - Call duration tracking: record answer timestamp, calculate duration on end
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.10, 5.11, 5.12, 20.1, 20.2, 20.3_

  - [ ] 11.2 Implement DTMF send and receive
    - Send DTMF via `AT+VTS` (5s timeout) on Svarla request
    - Receive DTMF via `+DTMF` URC, forward to Svarla
    - Reject DTMF when no call active
    - Report success/failure with digit info
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 11.3 Write property test for call duration calculation (Property 13)
    - **Property 13: Call Duration Calculation**
    - For any call with answer and hangup timestamps, duration = floor(hangup - answer) seconds; unanswered = null
    - Use `pgregory.net/rapid` library
    - **Validates: Requirements 20.1, 20.2, 20.3**

- [ ] 12. Implement Go binary USSD support
  - [ ] 12.1 Implement `internal/ussd` package
    - USSD session state machine: idle → pending → active → idle
    - Execute via `AT+CUSD=1,"code"`
    - Multi-step session support: forward intermediate responses, accept follow-up inputs
    - Cancel via `AT+CUSD=2`
    - 30-second timeout per step
    - Reject during active call
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [ ] 13. Implement Go binary status reporting and number discovery
  - [ ] 13.1 Implement periodic status reporting
    - Query `AT+CSQ`, `AT+CREG`, `AT+COPS` every 30 seconds
    - Send status immediately on connect/reconnect before periodic cycle
    - Report stale values if modem unresponsive within 5s
    - Include modem model, manufacturer, firmware in initial status
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 25.1, 25.2_

  - [ ] 13.2 Implement number discovery and reporting
    - Attempt `AT+CNUM` at startup for SIM phone number
    - Fall back to `phone_number` config field
    - Report discovered number (E.164) on connect/reconnect
    - Report `number_unavailable` if no number found
    - Report capabilities (VOICE and/or SMS based on actual availability)
    - _Requirements: 10.1, 10.2, 10.3, 5.13, 14.8, 14.9_

- [ ] 14. Implement Go binary resilience features
  - [ ] 14.1 Implement modem reconnection and error recovery
    - Detect USB disconnect / unresponsive modem (no response within 10s)
    - Exponential backoff retry (2s → 30s cap) until modem recovered
    - Reinitialize serial port and PCM audio port on recovery
    - Report `modem_disconnected` / `modem_connected` status to Svarla
    - Reject operations while modem unavailable
    - Handle modem lost during call: close audio WS, report COMPLETED with `modem_lost` reason
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_

  - [ ] 14.2 Implement network registration mode
    - Passive mode (default): no network registration management
    - Self-registration mode: `AT+COPS=0`, monitor `AT+CREG`
    - SIM PIN unlock: `AT+CPIN=<pin>` when SIM requires PIN
    - Error handling: report failure if PIN missing or rejected, never retry rejected PIN
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5_

  - [ ] 14.3 Implement graceful shutdown
    - Handle SIGTERM/SIGINT signals
    - If call active: ATH, close audio WS, notify Svarla
    - Flush SMS/missed call buffer to disk
    - Close signaling WS with normal closure code
    - Force-exit after 10 seconds if not complete
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5_

  - [ ] 14.4 Implement missed call buffering
    - Buffer missed calls when signaling WS disconnected (reject call with ATH, store caller + timestamp)
    - Share persistence mechanism with SMS buffer (same `internal/buffer` package)
    - Deliver buffered missed calls on reconnect in chronological order
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

  - [ ] 14.5 Implement logging and diagnostics
    - Configurable log levels: error, warn, info, debug, verbose
    - Default to stdout; optional file output
    - Redact sensitive info (pairing secrets, private keys, SIM PINs, message contents) at non-verbose levels
    - Verbose: log raw AT command exchanges
    - _Requirements: 23.1, 23.2, 23.3, 23.4, 23.5_

- [ ] 15. Checkpoint - Ensure all Go binary tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 16. Implement Svarla server ModemGatewayTelephonyProvider
  - [ ] 16.1 Create `src/providers/modem-gateway-telephony-provider.ts`
    - Implement `TelephonyProvider` interface with `providerId = 'modem-gateway'`
    - `makeCall`: send `make_call` message via WS handler with audioWsUrl, return CallInitResult
    - `endCall`: send `end_call` message via WS handler
    - `answerCall`: send `answer_call` message with audioWsUrl, return CallAnswerResult
    - `sendSms`: send `send_sms` message via WS handler, return SmsResult
    - `listNumbers`: return reported number with capabilities, or empty array if none
    - `getWebhookEndpoints`: return empty array
    - `handleWebhook`: return empty object
    - `start`: begin accepting WS connections
    - `stop`: close WS, reject pending promises, release resources
    - Request-response correlation with `requestId` and timeouts (30s calls, 60s SMS)
    - Pending operation rejection on disconnect with `ProviderUnavailableError`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11_

  - [ ] 16.2 Create `src/providers/modem-gateway-ws-handler.ts`
    - Manage signaling WebSocket endpoint for a single modem-gateway provider
    - Pairing flow: validate pairing secret (not expired <24h, not used, no existing key), store public key, invalidate secret
    - Challenge-response auth: issue 32-byte nonce (expires 30s), verify Ed25519 signature
    - Rate limiting: 1-second minimum between auth attempts from same provider
    - Handle all inbound message types (status, number_report, incoming_call, call_state, incoming_sms, sms_result, dtmf_received, dtmf_result, ussd_response, ussd_error, missed_calls, buffered_sms, delivery_report)
    - Ping/pong: send pings every 30s, close if no pong within 60s
    - `generatePairingSecret()`: 6-8 alphanumeric chars, case-insensitive
    - `resetPairing()`: delete key, generate new secret, close active WS
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 1.2, 1.6, 3.5, 3.6_

  - [ ]* 16.3 Write property test for pairing secret format (Property 8)
    - **Property 8: Pairing Secret Format Invariant**
    - For any generated secret: length 6-8 chars, only alphanumeric (a-z, 0-9, case-insensitive)
    - Use `fast-check` library
    - **Validates: Requirements 1.2**

  - [ ]* 16.4 Write unit tests for ModemGatewayTelephonyProvider
    - Mock WS handler, test all TelephonyProvider method behaviors
    - Test request timeout handling, disconnect rejection
    - Test event emission for incoming_sms, call_state_changed, sms_status_update
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_

  - [ ]* 16.5 Write unit tests for ModemGatewayWsHandler
    - Test pairing flow (valid secret, expired, already used, already paired)
    - Test challenge-response (valid/invalid signature, timeout)
    - Test rate limiting
    - Test message routing
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

- [ ] 17. Implement Svarla server integration (config, factory, feature flag, API)
  - [ ] 17.1 Add modem-gateway provider config validation and factory
    - Add `modemGatewayConfigSchema` to `src/validators/provider-config-validator.ts` (empty passthrough schema)
    - Add `'modem-gateway'` to `schemasByType` map
    - Add `'modem-gateway': []` to `SENSITIVE_FIELDS` in `config-encryption.ts`
    - Add `'modem-gateway': []` to `WEBHOOK_ENDPOINTS` in `provider-registry.ts`
    - Add `case 'modem-gateway'` to provider factory in `src/server.ts`
    - _Requirements: 1.1, 1.4, 1.5_

  - [ ] 17.2 Implement feature flag for EXPERIMENTAL_PROVIDERS
    - Check `process.env.EXPERIMENTAL_PROVIDERS === 'true'` in provider types listing endpoint
    - Exclude "modem-gateway" from UI list unless flag is set
    - Do NOT gate API creation or operation of existing providers
    - Existing modem-gateway providers operate regardless of flag
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

  - [ ] 17.3 Implement provider API endpoints for modem-gateway
    - POST `/api/providers` with type "modem-gateway": generate pairing_secret and ws_endpoint in response
    - POST `/api/providers/:id/reset`: close WS, delete stored key, generate new pairing secret
    - GET `/api/providers/:id/status`: return modem status JSON (signal, network, operator, modem info)
    - _Requirements: 1.2, 1.3, 2.6, 9.3, 25.3_

  - [ ] 17.4 Implement WebSocket route for signaling endpoint
    - Register WS upgrade handler at `/ws/providers/:id/signaling`
    - Route incoming WS connections to the appropriate `ModemGatewayWsHandler` instance
    - Handle provider not found, provider not modem-gateway type
    - _Requirements: 1.2, 3.1_

  - [ ]* 17.5 Write unit tests for feature flag and provider config
    - Test EXPERIMENTAL_PROVIDERS gating behavior
    - Test modem-gateway schema validation
    - Test provider factory new case
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

- [ ] 18. Checkpoint - Ensure all Svarla server tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 19. Build system and release integration
  - [ ] 19.1 Create `modem-gateway/Dockerfile.build` for cross-compilation
    - Base image: `golang:1.22-bookworm`
    - Build with CGO_ENABLED=0 (pure Go, no C dependencies), ldflags for version/commit/buildDate
    - Cross-compile for arm64 via GOARCH=arm64
    - _Requirements: 29.1, 29.5_

  - [ ] 19.2 Extend `.github/workflows/release.yml` with modem-gateway build job
    - New `modem-gateway` job that builds for both amd64 and arm64 via matrix strategy
    - Upload artifacts: `modem-gateway-linux-amd64`, `modem-gateway-linux-arm64`
    - Attach binaries to draft release in `create-draft-release` job
    - _Requirements: 29.2, 29.3, 29.4_

- [ ] 20. Documentation
  - [ ] 20.1 Create provider documentation page
    - Overview and architecture diagram
    - Supported modems (SIMCom SIM7600G-H as primary reference; Quectel EG25-G with UAC firmware as future option)
    - Hardware setup requirements (Raspberry Pi, USB modem, SIM card)
    - Go binary installation and configuration (including `--generate-config`)
    - Pairing flow walkthrough
    - Troubleshooting common issues
    - Note about `EXPERIMENTAL_PROVIDERS=true` requirement for UI provider creation
    - Required modem firmware features: PCM audio over USB serial port (`AT+CPCMREG` support) and AT command interface
    - _Requirements: 27.1, 27.2, 27.3_

  - [ ] 20.2 Add systemd service documentation section
    - Complete example systemd unit file with inline comments
    - Step-by-step installation instructions (copy, daemon-reload, enable, start)
    - Common management commands (status, logs, restart, stop)
    - Security hardening options (ProtectSystem=strict, PrivateTmp=true, device access)
    - Restart on failure with 5-second delay
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5_

- [ ] 21. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- The Go binary and Svarla server tracks can be developed in parallel after task 2
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Go binary uses `pgregory.net/rapid` for property-based testing
- The TypeScript server uses `fast-check` for property-based testing
- Testing configuration: minimum 100 iterations per property test
- Tag format for tests: `Feature: modem-gateway, Property {N}: {description}`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1"] },
    { "id": 1, "tasks": ["1.2", "3.2"] },
    { "id": 2, "tasks": ["1.3", "3.3", "4.1"] },
    { "id": 3, "tasks": ["1.4", "4.2", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "6.1", "9.1"] },
    { "id": 5, "tasks": ["5.4", "5.5", "6.2", "6.3", "8.1", "9.2", "9.3", "9.4", "10.1"] },
    { "id": 6, "tasks": ["6.4", "6.5", "8.2", "10.2", "10.3", "12.1"] },
    { "id": 7, "tasks": ["8.3", "8.4", "10.4", "10.5", "11.1", "13.1", "13.2"] },
    { "id": 8, "tasks": ["11.2", "11.3", "14.1", "14.2", "14.3", "14.4", "14.5"] },
    { "id": 9, "tasks": ["16.1", "16.2"] },
    { "id": 10, "tasks": ["16.3", "16.4", "16.5", "17.1"] },
    { "id": 11, "tasks": ["17.2", "17.3", "17.4"] },
    { "id": 12, "tasks": ["17.5", "19.1"] },
    { "id": 13, "tasks": ["19.2", "20.1"] },
    { "id": 14, "tasks": ["20.2"] }
  ]
}
```
