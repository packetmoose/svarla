# Implementation Plan: Vonage Softphone

## Overview

This plan implements a native Android softphone application with a Node.js/TypeScript backend server. The system uses Vonage APIs for voice calling and SMS, PostgreSQL for persistent storage, WebSocket for real-time sync across up to 5 registered devices, and ntfy for push notifications. The Android app uses Jetpack Compose with Material3 and the Vonage Client SDK for WebRTC voice.

## Tasks

- [x] 1. Set up backend project structure and core interfaces
  - [x] 1.1 Initialize Node.js/TypeScript project with Fastify, Kysely, Zod, and Pino
    - Create project directory structure: `src/`, `src/routes/`, `src/services/`, `src/providers/`, `src/models/`, `src/websocket/`, `src/notifications/`, `migrations/`
    - Configure `tsconfig.json`, `package.json` with dependencies (Fastify 4.x, Kysely 0.27+, Zod 3.x, Pino 8.x, ws 8.x, @vonage/server-sdk 3.x, pg 8.x, bcrypt, vitest, fast-check)
    - Set up Fastify server bootstrap with plugin registration and Pino logging
    - Create server config schema with Zod for environment variables and `server-config.yaml` parsing
    - _Requirements: All (infrastructure)_

  - [x] 1.2 Create PostgreSQL database migrations
    - Write Kysely migration files for all tables: `vonage_numbers`, `device_registry`, `call_history`, `conversations`, `messages`, `auth`, `notification_queue`
    - Include all indexes (`idx_call_history_timestamp`, `idx_messages_conversation`, `idx_notification_queue_device`)
    - Include all CHECK constraints for `call_type`, `direction`, `status`
    - Implement the `auth` table single-row constraint (`id = 1`)
    - _Requirements: 6.1, 7.1, 9.2, 4.6, 5.5_

  - [x] 1.3 Define TelephonyProvider interface and types
    - Create `src/providers/telephony-provider.ts` with the `TelephonyProvider` interface, `CallInitResult`, `CallAnswerResult`, `SmsResult`, `ProviderNumber`, `TelephonyEvent`, `CallState`, `SmsDeliveryStatus` types
    - Create `src/providers/vonage-telephony-provider.ts` skeleton implementing the interface
    - _Requirements: 1.1, 2.1, 3.1, 11.1_

  - [x] 1.4 Define shared validation utilities
    - Create `src/validators/phone-number-validator.ts` — E.164 validation (`^\+[1-9]\d{1,14}$`)
    - Create `src/validators/password-validator.ts` — password strength validation (12+ chars, uppercase, lowercase, digit, special character)
    - Create `src/validators/label-validator.ts` — Vonage number label validation (1-30 characters)
    - Create `src/validators/message-validator.ts` — SMS body validation (1-1600 chars, not whitespace-only)
    - Create `src/formatters/duration-formatter.ts` — call duration formatting (HH:MM:SS and Xm Ys)
    - Create `src/formatters/message-preview.ts` — message preview truncation (first 100 chars for notifications, first 50 chars for thread list)
    - _Requirements: 1.5, 3.4, 3.5, 6.2, 9.2, 11.3_

  - [ ]* 1.5 Write property tests for validators and formatters
    - **Property 1: E.164 Phone Number Validation**
    - **Property 2: Call Duration Formatting Round-Trip**
    - **Property 10: SMS Body Validation**
    - **Property 11: Message Preview Truncation**
    - **Property 21: Password Strength Validation**
    - **Property 27: Vonage Number Label Validation**
    - **Validates: Requirements 1.3, 1.5, 3.4, 3.5, 6.2, 9.2, 11.3**

- [x] 2. Implement authentication and device registration
  - [x] 2.1 Implement AuthController and session management
    - Create `src/services/auth-service.ts` — password hashing with bcrypt, session token generation with `crypto.randomBytes`, lockout logic (5 attempts → 15 min lock), session expiry (configurable, default 30 days)
    - Create `src/routes/auth-routes.ts` — `POST /api/auth/login` (validate credentials, register device, return token), `POST /api/auth/logout` (invalidate session, deregister device)
    - Implement session validation middleware for all protected routes
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 2.2 Implement DeviceRegistryManager
    - Create `src/services/device-registry-manager.ts` — CRUD for registered devices, enforce max 5 limit, track device connectivity (last_seen_at)
    - Create `src/routes/device-routes.ts` — `GET /api/devices` (list all registered devices), `DELETE /api/devices/{deviceId}` (remotely deregister)
    - Wire device registration into login flow and device deregistration into logout flow
    - _Requirements: 9.7, 9.8, 9.9, 9.10_

  - [ ]* 2.3 Write property tests for authentication
    - **Property 20: Authentication Gate**
    - **Property 22: Session Expiry**
    - **Property 23: Account Lockout State Machine**
    - **Property 24: Device Registry Size Cap**
    - **Validates: Requirements 9.1, 9.3, 9.4, 9.5, 9.9**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Implement Vonage number management
  - [x] 4.1 Implement NumberManagementService
    - Create `src/services/number-management-service.ts` — fetch numbers from `TelephonyProvider.listNumbers()`, store labels in DB, detect additions/removals, broadcast changes via WebSocket
    - Create `src/routes/number-routes.ts` — `GET /api/numbers` (list numbers with labels), `PUT /api/numbers/{number}/label` (update label), `POST /api/numbers/sync` (trigger sync)
    - Implement default number selection logic (most recently used via `last_used_at`)
    - Implement auto-select behavior when only one number exists
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [ ]* 4.2 Write property tests for number management
    - **Property 26: Outbound Caller ID Membership**
    - **Property 27: Vonage Number Label Validation**
    - **Property 28: Default Number Selection**
    - **Property 29: Event Display Includes Number Label**
    - **Validates: Requirements 1.1, 1.7, 3.1, 3.7, 11.3, 11.4, 11.7, 11.8**

- [x] 5. Implement voice call handling on the server
  - [x] 5.1 Implement VonageTelephonyProvider for voice
    - Complete `VonageTelephonyProvider` for voice operations: `makeCall()` using @vonage/server-sdk Voice API, `endCall()`, `answerCall()` with client token generation
    - Implement NCCO builder: `connect` action to phone endpoint with selected caller ID for outbound, `connect` action to app user for inbound
    - Wire up Vonage webhook handlers in `src/routes/webhook-routes.ts` — `GET/POST /webhooks/answer` (return NCCO), `POST /webhooks/event` (call state events)
    - Emit `TelephonyEvent` for incoming_call, call_state_changed
    - _Requirements: 1.1, 1.4, 1.8, 2.1_

  - [x] 5.2 Implement CallRouter for multi-device coordination
    - Create `src/services/call-router.ts` — ring-all-devices logic, first-answer-wins resolution, cancel-others on answer, stop-ringing on decline/timeout/caller-disconnect
    - Handle race condition: if multiple devices answer simultaneously, accept first API call received, cancel all others
    - Implement 30-second timeout for unanswered incoming calls
    - Track active call state per Vonage number (in-use flag for cross-device display)
    - _Requirements: 2.2, 2.4, 2.5, 2.8, 2.9, 1.9_

  - [x] 5.3 Implement CallHistoryService
    - Create `src/services/call-history-service.ts` — record calls (INCOMING, OUTGOING, MISSED, UNANSWERED), enforce 1000 entry cap (remove oldest on overflow), query paginated history
    - Create `src/routes/call-routes.ts` — `GET /api/calls/history` (paginated), `POST /api/calls/answer/{callId}`, `POST /api/calls/decline/{callId}`
    - Broadcast call history updates via WebSocket to all connected devices
    - _Requirements: 6.1, 6.2, 6.4, 6.5, 6.7_

  - [ ]* 5.4 Write property tests for call routing and history
    - **Property 3: Call State Machine Terminal Transitions**
    - **Property 5: First-Answer-Wins Call Routing**
    - **Property 6: Multi-Device Call Termination**
    - **Property 14: Call History Ordering**
    - **Property 15: Call History Size Cap**
    - **Validates: Requirements 1.4, 1.6, 2.2, 2.4, 2.5, 6.4, 6.5**

- [x] 6. Implement SMS handling on the server
  - [x] 6.1 Implement VonageTelephonyProvider for SMS
    - Complete `VonageTelephonyProvider` for SMS: `sendSms()` using Vonage Messages API with selected sender number
    - Wire up inbound SMS webhook handler in `src/routes/webhook-routes.ts` — `POST /webhooks/inbound-sms`
    - Wire up SMS status webhook — `POST /webhooks/sms-status` for delivery receipts
    - Emit `TelephonyEvent` for incoming_sms, sms_status_update
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.4_

  - [x] 6.2 Implement ConversationService
    - Create `src/services/conversation-service.ts` — store messages in conversation threads (keyed by E.164 normalized number), handle deduplication by `vonage_message_id`, manage message status transitions (PENDING → SENT/FAILED), implement retry logic (max 3 retries), reassemble multi-segment SMS
    - Create `src/routes/sms-routes.ts` — `POST /api/sms/send` (send outbound SMS), `GET /api/conversations` (list threads paginated), `GET /api/conversations/{number}` (last 100 messages)
    - Broadcast new messages and status updates via WebSocket
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.6_

  - [ ]* 6.3 Write property tests for SMS and conversations
    - **Property 8: Message Thread Assignment by Normalized Number**
    - **Property 9: SMS Retry Bound**
    - **Property 12: Multi-Segment SMS Reassembly Round-Trip**
    - **Property 13: Message Deduplication**
    - **Property 16: Conversation Thread List Ordering and Preview**
    - **Property 17: Thread Message Pagination**
    - **Validates: Requirements 3.1, 3.3, 4.4, 4.6, 7.1, 7.2, 7.3**

- [x] 7. Implement push notifications and real-time sync
  - [x] 7.1 Implement NtfyPublisher
    - Create `src/notifications/ntfy-publisher.ts` — publish to per-device ntfy topics using Node.js fetch, support priority levels (5 for calls, 3 for SMS/missed), include structured extras payload
    - Build notification payloads for incoming calls (with Vonage number label, answer/decline actions), incoming SMS (with preview, sender, number label), missed calls (with caller info and time)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 7.2 Implement NotificationQueueService
    - Create `src/services/notification-queue-service.ts` — queue notifications for offline devices, enforce 5-minute TTL for missed call notifications, deliver queued notifications when device reconnects, discard expired notifications
    - Implement logic: do NOT deliver incoming-call notification if call already ended, only deliver missed-call if unanswered and within TTL
    - _Requirements: 2.6, 2.11, 2.12, 2.13, 5.3, 5.5, 5.7, 5.8_

  - [x] 7.3 Implement WebSocketBroadcaster
    - Create `src/websocket/broadcaster.ts` — manage WebSocket connections per device using `@fastify/websocket`, broadcast events (new_message, message_status, call_event, call_cancelled, call_history_update, device_registered, device_deregistered, number_label_updated, numbers_changed)
    - Implement device authentication on WebSocket connect (validate session token)
    - Create `src/routes/sync-routes.ts` — `GET /api/sync/state` (full state sync fallback)
    - _Requirements: 6.7, 7.6, 11.2, 11.6_

  - [ ]* 7.4 Write property tests for notifications
    - **Property 4: Multi-Device Notification Delivery**
    - **Property 7: Missed Call Notification TTL Window**
    - **Validates: Requirements 2.1, 2.6, 4.1, 5.1, 5.2, 5.3**

- [x] 8. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Set up Android project structure
  - [x] 9.1 Initialize Android project with Kotlin, Jetpack Compose, and Hilt
    - Create Android project with Gradle Kotlin DSL, set `minSdk = 26`, `targetSdk = 34`
    - Configure dependencies: Jetpack Compose 1.6+, Material3 1.2+, Material3 Adaptive 1.0+, Compose Navigation 2.7+, Hilt 2.51+, Room 2.6+, Ktor Client 2.3+, OkHttp 4.12+, Vonage Client SDK, UnifiedPush 2.x, Jetpack WindowManager 1.2+, Coil 2.6+, Kotlinx Serialization 1.6+, Kotest 5.x
    - Set up Hilt application class and module structure
    - Create base package structure: `ui/`, `ui/theme/`, `ui/screens/`, `ui/components/`, `data/`, `data/local/`, `data/remote/`, `data/repository/`, `domain/`, `di/`
    - _Requirements: All (infrastructure)_

  - [x] 9.2 Create Room database and local cache entities
    - Define Room entities: `VonageNumber`, `CallHistoryEntry`, `Conversation`, `Message`, `DeviceState` matching the design's local cache schema
    - Create Room DAOs for each entity with query methods (insert, update, delete, query by various criteria)
    - Create the Room database class with all entity registrations
    - _Requirements: 6.1, 7.1, 4.3_

  - [x] 9.3 Implement Material3 theme and design tokens
    - Create `ui/theme/Theme.kt` — Material3 color scheme (light and dark), typography scale, shape system
    - Implement dynamic theme switching (system default, always light, always dark) with in-app setting
    - Define consistent spacing constants using 8dp grid
    - Configure touch target minimums (48dp × 48dp)
    - _Requirements: 13.1, 13.3, 13.4, 13.5, 13.10, 13.11, 13.12_

- [x] 10. Implement Android authentication and networking layer
  - [x] 10.1 Implement AuthManager and login UI
    - Create `AuthManager` — login/logout with backend API, session token storage (encrypted with EncryptedSharedPreferences), device registration on login, lockout display with countdown timer, session expiry handling
    - Create login screen composable with password field, error states, lockout timer display
    - Implement authentication gate — redirect to login if no valid session
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_

  - [x] 10.2 Implement REST API client and WebSocket sync
    - Create Ktor HTTP client configured with session token header injection, base URL, JSON serialization
    - Create `SyncManager` — OkHttp WebSocket connection with session token auth, reconnection with exponential backoff (max 60s), fallback polling (every 10s), event dispatching to repositories
    - Create API service interfaces for all backend endpoints (auth, devices, numbers, SMS, calls, sync)
    - _Requirements: 6.7, 7.6, 11.2_

- [x] 11. Implement Android voice calling
  - [x] 11.1 Implement VoiceCallManager
    - Create `VoiceCallManager` — Vonage Client SDK integration, call state machine (idle → dialing → connected → ended), outbound call initiation with selected Vonage number, inbound call answer/decline
    - Handle call events: connected, disconnected, failed, timeout (30s)
    - Implement connectivity loss detection — end call and show notification
    - _Requirements: 1.1, 1.4, 1.6, 1.8, 2.2, 2.3_

  - [x] 11.2 Implement AudioRouter
    - Create `AudioRouter` — audio device selection with priority order (wired > Bluetooth > earpiece), speakerphone toggle (within 500ms), device connect/disconnect detection during calls, microphone mute control
    - Request RECORD_AUDIO and audio output permissions before call initiation/acceptance
    - Handle permission denial — show error, prevent call
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 11.3 Implement call UI screens
    - Create active call screen composable — elapsed duration (HH:MM:SS), destination number, contact name, mute button, speakerphone button, end call button, in-call dial pad button
    - Create incoming call screen composable — caller number, contact name, Vonage number label, answer button, decline button
    - Create active call indicator banner for other devices — remote party, Vonage number label, device name, duration
    - Implement haptic feedback on answer, end call actions
    - _Requirements: 1.2, 1.3, 1.9, 1.10, 2.1, 2.3, 2.7, 2.8, 13.9_

  - [ ]* 11.4 Write property tests for audio routing
    - **Property 25: Audio Device Priority Selection**
    - **Validates: Requirements 10.3**

- [x] 12. Implement Android SMS and conversations
  - [x] 12.1 Implement SmsManager and message composition
    - Create `SmsManager` — send SMS via backend API with selected Vonage number, handle status transitions (PENDING → SENT/FAILED), retry on failure (up to 3 times), queue messages when offline (QUEUED status)
    - Create message composition screen — character count display (remaining of 1600), destination number validation, Vonage number selector, send button
    - Implement inline validation errors for empty body and invalid number
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [x] 12.2 Implement ConversationRepository and thread UI
    - Create `ConversationRepository` — sync threads from server, manage local cache, real-time updates via WebSocket
    - Create conversation list screen composable — threads sorted by most recent message, contact name or number, preview (50 chars), timestamp, Vonage number label
    - Create conversation detail screen composable — messages in chronological order (sent right, received left), real-time append on new messages within 2s, Vonage number label display
    - Load most recent 100 messages on thread open
    - _Requirements: 4.1, 4.2, 4.3, 4.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 13. Implement Android contact resolution
  - [x] 13.1 Implement ContactResolver
    - Create `ContactResolver` — query Android ContentResolver for contacts, E.164 normalization for matching, searchable contact list (by name and number), register ContentObserver for change detection (within 30s)
    - Request READ_CONTACTS permission with graceful fallback (display only phone numbers if denied, show notice)
    - Integrate contact resolution into call screens, conversation threads, call history, and notifications
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 13.2 Write property tests for contact resolution
    - **Property 18: Contact Name Resolution**
    - **Property 19: Contact Search**
    - **Validates: Requirements 7.4, 7.5, 8.1, 8.2**

- [x] 14. Implement Android push notifications
  - [x] 14.1 Implement NotificationHandler with UnifiedPush
    - Create `NotificationHandler` — UnifiedPush/ntfy subscription, handle incoming call notifications (high priority, heads-up with sound/vibration, ringtone for duration), SMS notifications, missed call notifications
    - Implement notification tap handling — open call screen or conversation thread
    - Implement notification dismissal when user views relevant content
    - Implement deduplication by notification ID
    - Handle stale call notifications (call already ended/answered)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 2.1, 2.3, 4.1, 4.2_

- [x] 15. Checkpoint - Ensure all Android tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Implement dial pad
  - [x] 16.1 Implement Dial Pad UI and DTMF
    - Create dial pad composable — digits 0-9, *, #, backspace, standard telephone grid layout, call button, SMS option
    - Implement number formatting (readable grouping based on numbering plan)
    - Implement long-press on 0 for + (500ms threshold)
    - Implement contact suggestion search (up to 5 matches as user types)
    - Implement contact selection populating number field
    - Create in-call dial pad overlay — DTMF tone transmission within 200ms, local audio feedback
    - Handle empty field + call button → show most recent outbound number from call history
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.11, 14.12, 14.13_

- [x] 17. Implement adaptive layout and form factor support
  - [x] 17.1 Implement FormFactorManager and AdaptiveLayoutHost
    - Create `FormFactorManager` — classify device (Phone < 600dp, Tablet ≥ 600dp, Foldable via hinge detection), observe fold state changes via Jetpack WindowManager, emit LayoutMode (SINGLE_PANE or LIST_DETAIL)
    - Implement orientation policy — portrait lock for Phone/Folded, all orientations for Tablet/Unfolded
    - Create `AdaptiveLayoutHost` — switch between single-pane and `ListDetailPaneScaffold`, manage pane proportions (30-40% list pane based on width), animate transitions within 500ms
    - Handle fold state transitions preserving navigation state and user input
    - Apply list-detail layout to Conversations and Call History screens on tablet/unfolded
    - Ensure minimum screen support (320dp × 480dp) with graceful error below minimum
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10_

  - [ ]* 17.2 Write property tests for form factor classification and layout
    - **Property 30: Form Factor Classification**
    - **Property 31: List Pane Width Proportion**
    - **Validates: Requirements 12.9, 12.10**

- [x] 18. Implement app badges and read state
  - [x] 18.1 Implement Global Read State and badge indicators
    - Implement server-side Global_Read_State tracking (missed calls viewed, messages read per thread)
    - Create API endpoints and WebSocket events for marking items as read and broadcasting to all devices
    - Implement Android App_Icon_Badge using NotificationManagerCompat notification channel badges — combined count of unseen missed calls and unread messages
    - Implement Navigation_Badge on Call History and Messages tabs in bottom navigation
    - Handle cross-device sync — viewing on one device updates badges on all devices within 10 seconds
    - Remove badges when counts reach zero
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 15.10, 15.11, 15.12_

- [x] 19. Implement UI polish, empty states, and error handling
  - [x] 19.1 Implement loading states, error states, and empty states
    - Add skeleton placeholders and progress indicators for loading content
    - Implement error states with descriptions and retry actions for all content views
    - Create empty states for: Call History (no entries), Conversations (no threads), search results (no matches) — with illustrations, messages, and call-to-actions
    - Implement smooth screen transition animations (200-500ms duration)
    - Implement screen density support (mdpi to xxxhdpi) with proper resource qualifiers
    - _Requirements: 13.2, 13.6, 13.7, 13.8, 6.6_

  - [x] 19.2 Implement Vonage number management UI on Android
    - Create number management screen — list all numbers with labels, edit label inline
    - Create NumberSelector composable — dropdown for choosing outbound number, auto-select behavior for single number
    - Integrate NumberSelector into call initiation and SMS composition flows
    - Display Vonage number label with in-use status indicator on other devices
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 1.7, 1.9, 3.7_

  - [x] 19.3 Implement device registry management UI
    - Create device list screen in account settings — show all registered devices, allow remote deregistration
    - _Requirements: 9.10_

- [x] 20. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 31 universal correctness properties defined in the design document
- Unit tests validate specific examples and edge cases
- Backend is TypeScript (Node.js/Fastify), Android is Kotlin (Jetpack Compose)
- The TelephonyProvider interface abstracts Vonage specifics — implementation is currently Vonage-only but designed for future extensibility

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "9.1"] },
    { "id": 2, "tasks": ["1.5", "2.1", "9.2", "9.3"] },
    { "id": 3, "tasks": ["2.2", "2.3", "4.1", "10.1"] },
    { "id": 4, "tasks": ["4.2", "5.1", "10.2"] },
    { "id": 5, "tasks": ["5.2", "5.3", "6.1"] },
    { "id": 6, "tasks": ["5.4", "6.2", "7.1"] },
    { "id": 7, "tasks": ["6.3", "7.2", "7.3"] },
    { "id": 8, "tasks": ["7.4", "11.1", "11.2"] },
    { "id": 9, "tasks": ["11.3", "11.4", "12.1"] },
    { "id": 10, "tasks": ["12.2", "13.1"] },
    { "id": 11, "tasks": ["13.2", "14.1"] },
    { "id": 12, "tasks": ["16.1", "17.1"] },
    { "id": 13, "tasks": ["17.2", "18.1"] },
    { "id": 14, "tasks": ["19.1", "19.2", "19.3"] }
  ]
}
```
