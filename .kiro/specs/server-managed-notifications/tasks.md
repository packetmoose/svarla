# Implementation Plan: Server-Managed Notifications

## Overview

This plan implements a server-authoritative notification system that replaces the existing `notification_queue` table and ad-hoc notification routes. The work proceeds in layers: database schema first, then server-side service logic, then integration with existing call/SMS/device flows, then API routes, startup cleanup, legacy removal, and finally Android client refactoring.

## Tasks

- [ ] 1. Database migrations and type definitions
  - [ ] 1.1 Create the `notifications` table migration (`migrations/009_notifications_table.ts`)
    - Create table with columns: `id` (UUID PK, default gen_random_uuid()), `type` (TEXT NOT NULL), `status` (TEXT NOT NULL DEFAULT 'pending'), `source_entity_id` (TEXT NOT NULL), `source_entity_type` (TEXT NOT NULL), `payload` (JSONB NOT NULL DEFAULT '{}'), `created_at` (TIMESTAMPTZ NOT NULL DEFAULT now()), `updated_at` (TIMESTAMPTZ NOT NULL DEFAULT now())
    - Create partial index `idx_notifications_status_pending` on `(created_at ASC) WHERE status = 'pending'`
    - Create index `idx_notifications_source_entity_id` on `(source_entity_id)`
    - Add unique index on `(source_entity_id, type)` for idempotent creation
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 1.2 Update Kysely `Database` interface and add `NotificationsTable` type
    - Add `NotificationsTable` interface to `src/database.ts` with `Generated<>` wrappers for defaulted columns
    - Add `notifications: NotificationsTable` to the `Database` interface
    - _Requirements: 1.1_

  - [ ] 1.3 Add `notification_created` and `notification_updated` to `WebSocketEventType` union
    - Update the `WebSocketEventType` type in `src/websocket/broadcaster.ts`
    - _Requirements: 4.3_

- [ ] 2. Implement NotificationService core
  - [ ] 2.1 Create `src/services/notification-service.ts` with types and constructor
    - Define `NotificationType`, `NotificationStatus`, `NotificationPayload`, `NotificationEntity`, `CreateNotificationInput` interfaces
    - Define `NotificationServiceDeps` interface (db, wsBroadcaster, wakeSignalPublisher, deviceRegistryManager, logger)
    - Implement constructor wiring dependencies
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ] 2.2 Implement `createNotification` method
    - Check for existing notification with same `source_entity_id` and `type` (idempotent guard)
    - INSERT into notifications table, return the created entity
    - Broadcast `notification_created` event via WebSocketBroadcaster to all connected devices
    - Send wake signal to offline devices: priority `high` for `incoming_call`, `normal` for all other types
    - Return `null` if duplicate detected
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 4.1, 5.1, 5.2, 6.1_

  - [ ]* 2.3 Write property test for notification creation (Property 1)
    - **Property 1: Notification creation produces correct entity for any event type**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7**

  - [ ]* 2.4 Write property test for idempotent creation (Property 2)
    - **Property 2: Notification creation is idempotent**
    - **Validates: Requirements 2.8, 6.1**

  - [ ]* 2.5 Write property test for SMS message preview truncation (Property 3)
    - **Property 3: SMS message preview truncation**
    - **Validates: Requirements 2.6**

  - [ ] 2.6 Implement `markRead` method
    - UPDATE notification status to `read` and `updated_at` to now WHERE id matches AND status = 'pending'
    - Broadcast `notification_updated` event if update occurred
    - No-op if notification doesn't exist or already read (no error, no broadcast)
    - _Requirements: 3.1, 3.2, 3.6, 4.2_

  - [ ] 2.7 Implement `markCallResolved` method
    - Find notification by `source_entity_id` with type `incoming_call` and status `pending`
    - UPDATE status to `read`, set `updated_at`
    - Broadcast `notification_updated` event if update occurred
    - No-op if not found or already resolved
    - _Requirements: 3.1, 3.2, 3.6_

  - [ ]* 2.8 Write property test for call resolution (Property 4)
    - **Property 4: Call resolution marks notification as read**
    - **Validates: Requirements 3.1, 3.2**

  - [ ] 2.9 Implement `transitionToMissed` method
    - UPDATE type from `incoming_call` to `missed_call` WHERE `source_entity_id` matches AND type = 'incoming_call'
    - Keep status as `pending`, update `updated_at`
    - Broadcast `notification_updated` event with new type
    - _Requirements: 3.3, 6.2_

  - [ ]* 2.10 Write property test for missed call transition (Property 5)
    - **Property 5: Missed call transition mutates type without changing status**
    - **Validates: Requirements 3.3, 6.2**

  - [ ] 2.11 Implement `markAllRead` method
    - Accept optional `types` filter (array of NotificationType)
    - UPDATE all matching pending notifications to status `read`
    - Broadcast `notification_updated` for each affected notification
    - _Requirements: 3.4, 3.5, 8.3_

  - [ ]* 2.12 Write property test for batch read (Property 6)
    - **Property 6: Batch read marks only matching notifications**
    - **Validates: Requirements 3.4, 3.5, 8.3**

  - [ ]* 2.13 Write property test for no-op mutations (Property 7)
    - **Property 7: Mutations on non-existent or already-terminal notifications are no-ops**
    - **Validates: Requirements 3.6**

  - [ ]* 2.14 Write property test for broadcast correctness (Property 8)
    - **Property 8: Every state change triggers a broadcast with correct event type**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ] 2.15 Implement `markConversationRead` method
    - Find all `incoming_sms` notifications with status `pending` whose `source_entity_id` maps to messages in the given conversation
    - Mark them as `read` and broadcast updates
    - _Requirements: 3.4_

  - [ ] 2.16 Implement `getPendingNotifications` method
    - SELECT all from notifications WHERE status = 'pending' ORDER BY created_at ASC
    - _Requirements: 8.1, 5.5_

  - [ ]* 2.17 Write property test for pending notifications query (Property 10)
    - **Property 10: Pending notifications API returns only pending, ordered chronologically**
    - **Validates: Requirements 8.1, 5.5**

  - [ ] 2.18 Implement `deliverPendingToDevice` method
    - Called on WebSocket reconnect: send all pending notifications to the device as `notification_created` events
    - _Requirements: 5.3_

  - [ ]* 2.19 Write property test for wake signal priority (Property 9)
    - **Property 9: Wake signal priority matches notification type for offline devices**
    - **Validates: Requirements 5.1, 5.2**

- [ ] 3. Checkpoint - Ensure all NotificationService tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Integrate NotificationService with existing event sources
  - [x] 4.1 Integrate with CallOrchestrator for inbound calls
    - In `handleInbound`, after recording call history, call `notificationService.createNotification` with type `incoming_call`
    - Populate payload with caller number, provider number, provider label (from number lookup), contact name, and timestamp
    - Remove the existing direct `wsBroadcaster.broadcast` call_event for ringing (notification_created replaces it)
    - Remove the existing direct `wakeSignalPublisher.sendToAllDevices` call (NotificationService handles delivery)
    - _Requirements: 2.1, 2.5, 5.1, 6.1_

  - [x] 4.2 Integrate with CallOrchestrator for call resolution (answer/decline)
    - In `answerCall`, call `notificationService.markCallResolved(callId)` after marking answered
    - In `endCall`, when caller hangs up (inbound, not answered), call `notificationService.transitionToMissed(callId)` instead of sending missed_call push directly
    - Remove direct missed-call wake signal sending from `endCall`
    - _Requirements: 3.1, 3.2, 3.3, 6.1, 6.2_

  - [x] 4.3 Integrate with SMS handling for incoming messages
    - After storing an incoming SMS, call `notificationService.createNotification` with type `incoming_sms`
    - Populate payload with sender number, provider number, provider label, contact name, message preview (truncated to 160 chars), and timestamp
    - _Requirements: 2.2, 2.6_

  - [x] 4.4 Integrate with call blocking for blocked calls
    - When the server blocks an inbound call, call `notificationService.createNotification` with type `blocked_call`
    - Populate payload with caller number, provider number, provider label, contact name, and timestamp
    - _Requirements: 2.3, 2.5_

  - [x] 4.5 Integrate with DeviceRegistryManager for new device login
    - After a new device is registered, call `notificationService.createNotification` with type `new_device_login`
    - Populate payload with device ID, device label, and timestamp
    - _Requirements: 2.4, 2.7_

  - [x] 4.6 Integrate with WebSocket reconnection for pending notification delivery
    - When a device reconnects via WebSocket, call `notificationService.deliverPendingToDevice(deviceId)`
    - _Requirements: 5.3_

- [x] 5. Implement notification API routes
  - [x] 5.1 Rewrite `src/routes/notification-routes.ts` with new endpoints
    - `GET /api/notifications` — call `notificationService.getPendingNotifications()`, return JSON array
    - `POST /api/notifications/:id/read` — validate ID exists, call `notificationService.markRead(id)`, return 200 or 404
    - `POST /api/notifications/read-all` — validate optional `type` query param against NotificationType enum, call `notificationService.markAllRead(types)`, return 200 or 400
    - All endpoints require valid session (existing auth middleware), return 401 on invalid token
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 5.2 Write unit tests for notification API routes
    - Test GET returns pending only, ordered by created_at
    - Test POST /:id/read returns 404 for non-existent ID
    - Test POST /read-all with invalid type returns 400
    - Test 401 for unauthenticated requests
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_

- [x] 6. Implement StartupCleanupService
  - [x] 6.1 Create `src/services/startup-cleanup-service.ts`
    - Mark all `call_history` entries with `call_type = 'INCOMING'` and `answered_by_device IS NULL` as `MISSED`
    - Mark all `call_history` entries with `call_type = 'OUTGOING'` and `duration_seconds IS NULL` as `UNANSWERED`
    - UPDATE all notifications with `type = 'incoming_call'` and `status = 'pending'` to `type = 'missed_call'` (retain `pending` status)
    - Throw on database errors to abort startup
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 6.2 Integrate StartupCleanupService into server bootstrap
    - Call `startupCleanupService.run()` in `src/bootstrap.ts` or `src/index.ts` after migrations but before accepting connections
    - If it throws, abort process with logged error
    - _Requirements: 7.4, 7.5_

  - [ ]* 6.3 Write property test for startup cleanup (Property 11)
    - **Property 11: Startup cleanup transitions all stale entries to terminal states**
    - **Validates: Requirements 7.1, 7.2, 7.3**

- [x] 7. Checkpoint - Ensure server-side implementation compiles and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Remove legacy notification infrastructure
  - [x] 8.1 Create migration `migrations/010_drop_notification_queue.ts`
    - Migrate undelivered, non-expired entries from `notification_queue` to `notifications` table (map fields per design)
    - Drop the `notification_queue` table
    - If no undelivered entries exist, skip insert and drop directly
    - _Requirements: 9.1, 9.2_

  - [ ]* 8.2 Write property test for data migration (Property 12)
    - **Property 12: Data migration preserves all undelivered queue entries**
    - **Validates: Requirements 9.1, 9.2**

  - [x] 8.3 Remove `NotificationQueueService` and old notification route logic
    - Delete `src/services/notification-queue-service.ts`
    - Remove all imports and instantiations of `NotificationQueueService` across the codebase
    - Remove the old `GET /api/notifications/:id` route, `autoDetectNotification`, and `lookupByType` functions (already replaced by new route file in task 5.1)
    - Remove `NotificationQueueTable` from `src/database.ts` and the `notification_queue` key from the `Database` interface
    - _Requirements: 9.3, 9.4_

  - [x] 8.4 Verify server compiles and all tests pass after removal
    - Run TypeScript compiler, fix any dangling references
    - Run test suite, confirm no failures from removed code
    - _Requirements: 9.6_

- [x] 9. Refactor Android ClientNotificationHandler
  - [x] 9.1 Add WebSocket event handling for `notification_created` and `notification_updated`
    - Parse `notification_created` events and dispatch to a new `handleNotificationCreated(payload)` method
    - Parse `notification_updated` events and dispatch to a new `handleNotificationUpdated(payload)` method
    - Map server notification `id` to Android notification ID for update/dismiss tracking
    - _Requirements: 4.1, 4.2, 6.3, 6.4, 6.6_

  - [x] 9.2 Implement `handleNotificationCreated` to show notifications by type
    - For `incoming_call`: forward to VoiceCallManager and show call notification (same logic as current `handleIncomingCallNotification`)
    - For `incoming_sms`: show SMS notification with sender info and preview from payload
    - For `missed_call`: show missed call notification with caller info and timestamp from payload
    - For `blocked_call`: show blocked call notification
    - For `new_device_login`: delegate to NewDeviceLoginNotifier
    - Use the server-provided notification `id` as the key for tracking (not in-memory dedup)
    - _Requirements: 6.3, 6.4_

  - [x] 9.3 Implement `handleNotificationUpdated` for state changes
    - If `status = 'read'`: dismiss the Android notification matching the server notification `id`
    - If `type` changed (e.g., `incoming_call` → `missed_call`): update the displayed notification content in-place using the same Android notification ID
    - If no displayed notification matches the `id`: ignore silently (no error)
    - _Requirements: 6.3, 6.4, 6.6_

  - [x] 9.4 Remove client-side deduplication and suppression logic
    - Remove `shownNotificationIds` ConcurrentHashMap and `isDuplicate()` method
    - Remove `isCallStale()` method
    - Remove all `wasCallDeclined*`, `wasAlreadyNotified*`, `wasRecentlyNotified*` checks and their backing data
    - Replace with server-`id`-based notification tracking (Map<String, Int> mapping server notification UUID to Android notification ID)
    - _Requirements: 6.5, 9.5_

  - [x] 9.5 Add `GET /api/notifications` call on WebSocket reconnect
    - When WebSocket reconnects, fetch pending notifications from the API
    - For each pending notification, call `handleNotificationCreated` to show it
    - _Requirements: 5.3, 5.5_

  - [ ]* 9.6 Write unit tests for ClientNotificationHandler refactoring
    - Test `handleNotificationCreated` shows correct notification for each type
    - Test `handleNotificationUpdated` with `status = 'read'` dismisses notification
    - Test `handleNotificationUpdated` with type change updates notification content
    - Test event for unknown notification ID is ignored
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

- [x] 10. Replace notification small icon (Android)
  - [x] 10.1 Replace `ic_notification.xml` with Svarla monochrome app icon
    - Create a 24dp × 24dp monochrome (single white fill with transparency) vector drawable of the Svarla app icon
    - Overwrite `ic_notification.xml` with the new vector, keeping the same resource name so all references resolve automatically
    - Verify the icon is used in all notification builders and PhoneAccount registration (no code changes needed since resource name is unchanged)
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 11. Final checkpoint - Full build and test verification
  - Ensure all server-side TypeScript compiles without errors
  - Ensure all server tests pass
  - Ensure Android project compiles without errors
  - Ensure no dangling references to removed code
  - Ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties defined in the design
- Unit tests validate specific examples and edge cases
- The server uses TypeScript/Fastify/Kysely on PostgreSQL; the Android client uses Kotlin with Jetpack Compose/Room/Hilt
- Migration numbering continues from existing `008_real_caller_number.ts`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2", "2.6", "2.7", "2.9", "2.11", "2.15", "2.16", "2.18"] },
    { "id": 3, "tasks": ["2.3", "2.4", "2.5", "2.8", "2.10", "2.12", "2.13", "2.14", "2.17", "2.19"] },
    { "id": 4, "tasks": ["4.1", "4.2", "4.3", "4.4", "4.5", "4.6"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["5.2", "6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["8.2", "8.3"] },
    { "id": 10, "tasks": ["8.4"] },
    { "id": 11, "tasks": ["9.1", "10.1"] },
    { "id": 12, "tasks": ["9.2", "9.3", "9.4"] },
    { "id": 13, "tasks": ["9.5", "9.6"] }
  ]
}
```
