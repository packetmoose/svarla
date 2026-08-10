# Implementation Plan: Encrypted SIP

## Overview

This implementation adds encrypted SIP transport (TLS on port 5061) and SRTP media encryption (via SDES) to the mediabridge, along with SIP URI selection logic in the Svarla TypeScript server. The plan is organized to build foundational components first (configuration, certificates), then SIP transport, then media encryption, then the TypeScript integration layer, and finally Docker/logging concerns.

## Tasks

- [x] 1. Extend mediabridge configuration for TLS
  - [x] 1.1 Add TLS configuration struct and YAML parsing to `mediabridge/internal/config/config.go`
    - Add `TLSConfig` struct with `Port`, `CertPath`, `KeyPath` fields and YAML tags
    - Add `TLS TLSConfig` field to the main `Config` struct
    - Set defaults: port 5061, certPath "/etc/mediabridge/tls/cert.pem", keyPath "/etc/mediabridge/tls/key.pem"
    - Add validation: port must be in range [1, 65535], port must not conflict with SIP port
    - Treat empty string paths as absent (use defaults)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [ ]* 1.2 Write property tests for TLS configuration validation
    - **Property 9: Invalid Port Configuration Rejected**
    - **Property 10: Port Conflict Rejected**
    - Use `rapid` to generate out-of-range port integers and conflicting port pairs
    - **Validates: Requirements 6.5, 6.7**

  - [ ]* 1.3 Write unit tests for TLS configuration defaults and parsing
    - Test absent TLS section uses default paths and port
    - Test empty string paths fall back to defaults
    - Test valid YAML parsing with all fields specified
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_

- [x] 2. Implement Certificate Manager
  - [x] 2.1 Create `mediabridge/internal/sip/certmanager.go` with core certificate loading
    - Implement `CertManagerConfig`, `CertManager` struct, and `NewCertManager` constructor
    - Implement `LoadOrGenerate()`: try loading from configured paths, fall back to self-signed generation
    - Implement `GetCertificate()` for use in `tls.Config.GetCertificate` callback
    - Validate cert/key pair match on load (private key corresponds to certificate public key)
    - Log warning when falling back to self-signed, log error with reason on parse failure or key mismatch
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7_

  - [x] 2.2 Implement self-signed certificate generation in Certificate Manager
    - Generate ECDSA P-256 key pair
    - Create X.509 certificate with: EKU ServerAuth, SAN "localhost" + IP 127.0.0.1, validity 365 days
    - Log warning recommending mounting a trusted certificate for production
    - Generate fresh cert on each startup (no persistence)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 2.3 Implement certificate hot-reload polling in Certificate Manager
    - Implement `StartWatching(ctx)` with 30-second poll interval checking file modification times
    - Implement 2-second stabilization debounce after detecting change
    - Validate new cert+key pair before accepting (fall back to previous on failure)
    - Handle case where only one file changes: pair with existing counterpart
    - Log informational message on successful reload (subject + expiry), error on failure with reason
    - Implement `Stop()` to halt the watcher
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [ ]* 2.4 Write property tests for Certificate Manager
    - **Property 2: Certificate Pair Validation** — generate valid/invalid cert+key combos, verify accept/reject behavior
    - **Property 3: Self-Signed Certificate Correctness** — generate certs, inspect EKU, SAN, validity, key type
    - Use `rapid` for generating test inputs
    - **Validates: Requirements 2.2, 2.5, 2.6, 3.3, 3.6, 4.2, 4.3**

  - [ ]* 2.5 Write unit tests for Certificate Manager
    - Test loading valid cert+key from file
    - Test fallback to self-signed when cert missing
    - Test fallback to self-signed when key missing
    - Test hot-reload detects file change and loads new cert
    - Test debounce waits 2 seconds before loading
    - Test invalid cert on reload retains previous cert
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.4, 3.6_

- [x] 3. Checkpoint - Configuration and Certificate Manager
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement TLS Listener in UAS
  - [x] 4.1 Add TLS listener loop to `mediabridge/internal/sip/uas.go`
    - Extend `UASConfig` with `TLSPort` and `CertManager` fields
    - Implement `tlsLoop()` method: create `tls.Config` with MinVersion TLS 1.2, use CertManager.GetCertificate
    - Accept TLS connections, read SIP messages, pass to `handleMessage` with transport="tls"
    - Start TLS listener alongside existing UDP/TCP listeners
    - Handle TLS handshake failures gracefully (log and close connection)
    - Ensure fatal startup error if TLS port bind fails
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 4.2 Write property test for transport-independent processing
    - **Property 1: Transport-Independent SIP Processing**
    - Mock both transports, verify same SIP response codes and call-routing decisions for identical messages
    - Use `rapid` to generate valid SIP messages
    - **Validates: Requirements 1.3**

  - [ ]* 4.3 Write unit tests for TLS Listener
    - Test TLS listener binds and accepts connections
    - Test listener isolation: one fails, other continues
    - Test TLS handshake with self-signed cert succeeds
    - Test TLS handshake failure is logged and connection closed
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

- [x] 5. Implement SDES Negotiator
  - [x] 5.1 Create `mediabridge/internal/sip/sdes.go` with crypto attribute parsing
    - Implement `CryptoAttribute` struct and `SDESResult` struct
    - Implement `ParseCryptoAttributes(sdpBody)`: extract `a=crypto` lines, parse tag/suite/key-params
    - Skip malformed lines gracefully (preserve valid ones in order)
    - _Requirements: 5.1, 5.7_

  - [x] 5.2 Implement SDES negotiation and answer formatting
    - Implement `NegotiateSDES(offered)`: select first `AES_CM_128_HMAC_SHA1_80` entry, generate 30-byte local key
    - Return nil if no supported suite found
    - Implement `FormatCryptoAnswer(result)`: format `a=crypto` line for SDP answer
    - _Requirements: 5.2, 5.5, 5.6_

  - [ ]* 5.3 Write property tests for SDES Negotiator
    - **Property 4: SDES Crypto Attribute Parsing Round-Trip** — generate valid a=crypto strings, verify parse+format produces equivalent output
    - **Property 5: Suite Selection Picks First Supported** — generate random orderings of suites, verify first AES_CM_128 selected
    - **Property 7: Unsupported-Only Suites Produce No Selection** — generate lists with no AES_CM_128, verify nil result
    - **Property 8: Malformed Crypto Lines Are Skipped** — generate mixed valid/invalid lines, verify only valid ones returned in order
    - Use `rapid` for generating test inputs
    - **Validates: Requirements 5.1, 5.2, 5.5, 5.6, 5.7**

  - [ ]* 5.4 Write unit tests for SDES Negotiator
    - Test parsing a single valid a=crypto line
    - Test parsing multiple crypto offers, selecting first supported
    - Test SDP with no a=crypto returns empty list
    - Test malformed line is skipped, valid ones retained
    - Test FormatCryptoAnswer output format matches RFC 4568
    - _Requirements: 5.1, 5.2, 5.7_

- [x] 6. Implement SRTP Session
  - [x] 6.1 Create `mediabridge/internal/sip/srtp.go` with encrypt/decrypt wrapper
    - Implement `SRTPSession` struct wrapping `pion/srtp` contexts
    - Implement `NewSRTPSession(localKey, remoteKey, profile)`: create SRTP send/receive contexts
    - Implement `DecryptRTP(encrypted)`: decrypt incoming SRTP packet to plain RTP
    - Implement `EncryptRTP(plainRTP)`: encrypt outgoing RTP packet to SRTP
    - Implement `Close()`: release contexts and zero key material
    - _Requirements: 5.3, 5.8_

  - [x] 6.2 Integrate SDES negotiation and SRTP into SDP handling pipeline
    - When SDP offer contains `a=crypto`: call ParseCryptoAttributes → NegotiateSDES → create SRTPSession
    - Set media line to `RTP/SAVP` in SDP answer when SRTP negotiated
    - Keep `RTP/AVP` when no crypto offered
    - Reject with 488 when only unsupported suites offered
    - Wire SRTP encrypt/decrypt into existing RTP send/receive path
    - Zero key material on session termination
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8_

  - [ ]* 6.3 Write property test for SRTP encrypt/decrypt round-trip
    - **Property 6: SRTP Encrypt/Decrypt Round-Trip**
    - Generate random valid RTP payloads and 30-byte key+salt, verify encrypt then decrypt returns original
    - Use `rapid` for generating test inputs
    - **Validates: Requirements 5.3**

  - [ ]* 6.4 Write unit tests for SRTP Session
    - Test SRTP session creation with valid keys
    - Test encrypt then decrypt produces original payload
    - Test Close() zeros key material
    - Test SDP answer uses RTP/SAVP when crypto negotiated
    - Test SDP answer uses RTP/AVP when no crypto offered
    - _Requirements: 5.3, 5.4, 5.8_

- [x] 7. Checkpoint - Core encryption components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implement Control API dual URI response
  - [x] 8.1 Extend Control API session response with `sipsUri` field
    - Update `CreateSessionResponse` struct in `mediabridge/internal/controlapi/handler.go`
    - Add `SIPSUri` field formatted as `sips:<sessionId>@<publicIP>:<tlsPort>`
    - Ensure existing `SIPUri` field remains unchanged (backward-compatible)
    - Pass TLS port from config to control API handler
    - _Requirements: 9.1, 9.7_

  - [ ]* 8.2 Write property test for Control API dual URI construction
    - **Property 11: Control API Dual URI Construction**
    - Generate random session IDs, IPs, ports — verify both URI fields present with correct format
    - Use `rapid` for generating test inputs
    - **Validates: Requirements 9.1, 9.7**

  - [ ]* 8.3 Write unit tests for Control API dual URI response
    - Test response contains both sipUri and sipsUri fields
    - Test sipUri format: `sip:<sessionId>@<publicIP>:<sipPort>`
    - Test sipsUri format: `sips:<sessionId>@<publicIP>:<tlsPort>`
    - Test backward compatibility: existing fields unchanged
    - _Requirements: 9.1, 9.7_

- [x] 9. Implement SIP transport logging
  - [x] 9.1 Add transport-aware logging to SIP message handling
    - Log transport type ("UDP", "TCP", or "TLS") with SIP Call-ID on INVITE receipt
    - Log encrypted signaling + encrypted media when TLS + SRTP
    - Log encrypted signaling + unencrypted media when TLS without SRTP
    - Log unencrypted signaling with transport type when no TLS
    - Ensure timestamp with at most 1-second resolution in log entries
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 10. Extend Svarla server configuration for SIP TLS
  - [x] 10.1 Add `sip.tls` field to server config schema in `src/config.ts`
    - Add `sip` object with `tls` boolean field under `media_bridge` section in zod schema
    - Default `sip.tls` to `true` when not configured
    - Update `AppConfig` interface to include `mediaBridge.sip.tls`
    - _Requirements: 9.6_

  - [ ]* 10.2 Write unit tests for server config SIP TLS extension
    - Test `sip.tls` defaults to true when omitted
    - Test `sip.tls` can be explicitly set to false
    - Test config parsing with full sip section specified
    - _Requirements: 9.6_

- [x] 11. Extend Vonage provider config with `supportsSips`
  - [x] 11.1 Add `supportsSips` field to Vonage provider config in `src/providers/vonage-telephony-provider.ts`
    - Add optional `supportsSips` boolean to `VonageProviderConfig` interface
    - Default to `true` when not specified (Vonage supports TLS SIP)
    - _Requirements: 9.5_

  - [ ]* 11.2 Write unit tests for Vonage provider `supportsSips` config
    - Test `supportsSips` defaults to true when omitted
    - Test `supportsSips` can be explicitly set to false
    - _Requirements: 9.5_

- [x] 12. Implement SIP URI selector function
  - [x] 12.1 Create `src/services/sip-uri-selector.ts` with URI selection logic
    - Define `SipUriSelectionInput` interface with `sipUri`, `sipsUri`, `supportsSips`, `sipTlsEnabled`
    - Implement `selectSipUri(input)` pure function
    - Return `sipsUri` when both `supportsSips` AND `sipTlsEnabled` are true
    - Return `sipUri` in all other cases
    - _Requirements: 9.2, 9.3, 9.4_

  - [ ]* 12.2 Write property test for SIP URI selection logic
    - **Property 12: SIP URI Selection Logic**
    - Use `fast-check` to generate all boolean combinations of supportsSips/sipTlsEnabled
    - Verify correct URI selected per decision table
    - **Validates: Requirements 9.2, 9.3, 9.4**

  - [ ]* 12.3 Write unit tests for SIP URI selector
    - Test sipsUri chosen when supportsSips=true and sipTlsEnabled=true
    - Test sipUri chosen when sipTlsEnabled=false regardless of supportsSips
    - Test sipUri chosen when supportsSips=false regardless of sipTlsEnabled
    - _Requirements: 9.2, 9.3, 9.4_

- [x] 13. Integrate SIP URI selector into call orchestrator
  - [x] 13.1 Wire `selectSipUri` into the call orchestration flow in `src/services/call-orchestrator.ts`
    - After receiving Control API session response (which now includes `sipsUri`), call `selectSipUri`
    - Pass provider's `supportsSips` and server config's `sip.tls` as inputs
    - Use the selected URI when building the NCCO connect action
    - Update media-bridge-client to handle the new `sipsUri` field in session response
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 9.6_

  - [ ]* 13.2 Write unit tests for call orchestrator SIP URI integration
    - Test NCCO uses sipsUri when provider supports sips and sip.tls enabled
    - Test NCCO uses sipUri when sip.tls disabled
    - Test NCCO uses sipUri when provider does not support sips
    - Test backward compatibility: call flow works with existing sipUri-only response
    - _Requirements: 9.2, 9.3, 9.4_

- [x] 14. Update Docker configuration for TLS port exposure
  - [x] 14.1 Add port 5061/tcp exposure to Dockerfile
    - Add `EXPOSE 5061/tcp` to the root `Dockerfile` alongside existing port exposures
    - Ensure existing port 5060 UDP/TCP exposure remains unchanged
    - _Requirements: 7.1, 7.2_

- [x] 15. Final checkpoint - Full integration
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- Go property tests use `github.com/flyingmutant/rapid`
- TypeScript property tests use `fast-check` with `vitest`
- The implementation is additive: existing unencrypted SIP path remains unchanged throughout

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "10.1", "11.1", "14.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "10.2", "11.2", "12.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "12.2", "12.3"] },
    { "id": 3, "tasks": ["2.4", "2.5", "5.1"] },
    { "id": 4, "tasks": ["4.1", "5.2"] },
    { "id": 5, "tasks": ["4.2", "4.3", "5.3", "5.4", "6.1"] },
    { "id": 6, "tasks": ["6.2", "8.1"] },
    { "id": 7, "tasks": ["6.3", "6.4", "8.2", "8.3", "9.1"] },
    { "id": 8, "tasks": ["13.1"] },
    { "id": 9, "tasks": ["13.2"] }
  ]
}
```
