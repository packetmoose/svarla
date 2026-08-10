# Requirements Document

## Introduction

The Svarla softphone app currently treats notifications as implicit side-effects of other operations. Deduplication is in-memory on the client (lost on restart), there is no cross-device coordination for dismissal, and the server auto-detects notification types by searching multiple unrelated tables. This feature replaces the existing `notification_queue` table and ad-hoc notification routes with a server-authoritative `notifications` table that owns the full notification lifecycle — creation, state mutation, delivery, and cross-device synchronization.

## Glossary

- **Notification_Service**: The server-side module responsible for creating, mutating, querying, and broadcasting notification entities.
- **Notifications_Table**: The PostgreSQL table storing notification entities with their own UUID, type, status, source reference, payload, and timestamps.
- **Notification_Entity**: A single row in the Notifications_Table representing one user-facing notification with a lifecycle managed by the server.
- **Wake_Signal**: A minimal JSON payload (`{ id, priority }`) sent via UnifiedPush to offline devices to prompt them to reconnect and fetch pending notifications.
- **WebSocket_Broadcaster**: The server component that delivers real-time events (including full notification payloads) to all connected devices over WebSocket.
- **Client_Notification_Handler**: The Android module that receives notification payloads from WebSocket or fetches them on reconnect, and displays Android system notifications.
- **Notification_Status**: The state of a notification entity: `pending` (unread/unresolved) or `read` (resolved/dismissed).
- **Notification_Type**: The category of a notification: `incoming_call`, `missed_call`, `incoming_sms`, `blocked_call`, or `new_device_login`.
- **Startup_Cleanup_Service**: The server-side module that runs on process start to reconcile stale call history entries and their associated notifications.

## Requirements

### Requirement 1: Notifications Table Schema

**User Story:** As a developer, I want a dedicated notifications table with its own identity and lifecycle fields, so that notifications are first-class entities independent of their source records.

#### Acceptance Criteria

1. THE Notifications_Table SHALL have the columns: `id` (UUID, primary key, generated), `type` (Notification_Type enum stored as text), `status` (Notification_Status enum stored as text, default `pending`), `source_entity_id` (text, references the originating record), `source_entity_type` (text, one of `call_history`, `messages`, or `device_registry`), `payload` (JSONB, contains display data), `created_at` (timestamptz, default now), `updated_at` (timestamptz, default now).
2. THE Notifications_Table SHALL enforce a NOT NULL constraint on `id`, `type`, `status`, `source_entity_id`, `source_entity_type`, and `created_at`.
3. THE Notifications_Table SHALL have a partial index on the `status` column filtering on `status = 'pending'` to support efficient queries for pending notifications.
4. THE Notifications_Table SHALL have an index on the `source_entity_id` column to support efficient lookups when mutating notifications by source event.
5. THE Notifications_Table SHALL be created via a Kysely database migration with an incremental version number following the existing migration convention.

### Requirement 2: Notification Creation on Events

**User Story:** As a user, I want the server to automatically create a notification when a relevant event occurs, so that I am informed without relying on client-side logic.

#### Acceptance Criteria

1. WHEN an inbound call is received, THE Notification_Service SHALL create a Notification_Entity with type `incoming_call`, status `pending`, `source_entity_id` set to the call's UUID, and `source_entity_type` set to `call_history`.
2. WHEN an inbound SMS is received, THE Notification_Service SHALL create a Notification_Entity with type `incoming_sms`, status `pending`, `source_entity_id` set to the message ID, and `source_entity_type` set to `messages`.
3. WHEN an inbound call is blocked by the server, THE Notification_Service SHALL create a Notification_Entity with type `blocked_call`, status `pending`, `source_entity_id` set to the call's UUID, and `source_entity_type` set to `call_history`.
4. WHEN a new device is registered, THE Notification_Service SHALL create a Notification_Entity with type `new_device_login`, status `pending`, `source_entity_id` set to the device ID, and `source_entity_type` set to `device_registry`.
5. WHEN a Notification_Entity of type `incoming_call`, `missed_call`, or `blocked_call` is created, THE Notification_Service SHALL populate the `payload` field with: caller number, provider number, provider label, contact name (or null if no contact match exists), and timestamp.
6. WHEN a Notification_Entity of type `incoming_sms` is created, THE Notification_Service SHALL populate the `payload` field with: sender number, provider number, provider label, contact name (or null if no contact match exists), message preview truncated to a maximum of 160 characters, and timestamp.
7. WHEN a Notification_Entity of type `new_device_login` is created, THE Notification_Service SHALL populate the `payload` field with: device ID, device label, and timestamp.
8. IF a Notification_Entity with the same `source_entity_id` and `type` already exists, THEN THE Notification_Service SHALL not create a duplicate Notification_Entity.

### Requirement 3: Notification Lifecycle Mutations

**User Story:** As a user, I want notification state to update automatically as I interact with the app on any device, so that I do not see stale or duplicate notifications.

#### Acceptance Criteria

1. WHEN an incoming call is answered on any device, THE Notification_Service SHALL update the Notification_Entity whose `source_entity_id` matches the call UUID to status `read` and set `updated_at` to the current timestamp.
2. WHEN an incoming call is declined on any device, THE Notification_Service SHALL update the Notification_Entity whose `source_entity_id` matches the call UUID to status `read` and set `updated_at` to the current timestamp.
3. WHEN an incoming call ends because the caller hangs up or the ring timeout expires without the call being answered or declined, THE Notification_Service SHALL update the corresponding Notification_Entity type from `incoming_call` to `missed_call`, keep status as `pending`, and set `updated_at` to the current timestamp.
4. WHEN a user opens a conversation containing an unread SMS on any device, THE Notification_Service SHALL update all `incoming_sms` Notification_Entities whose `source_entity_id` matches any message ID belonging to that conversation to status `read`.
5. WHEN a user opens the call history screen on any device, THE Notification_Service SHALL update all `missed_call` and `blocked_call` Notification_Entities with status `pending` to status `read`.
6. IF a lifecycle mutation targets a Notification_Entity that does not exist or has already been set to the target status, THEN THE Notification_Service SHALL complete the operation successfully without error and without broadcasting an update event.

### Requirement 4: Cross-Device State Broadcast

**User Story:** As a user with multiple devices, I want notification state changes to propagate to all my devices in real time, so that dismissing a notification on one device dismisses it everywhere.

#### Acceptance Criteria

1. WHEN a Notification_Entity is created, THE Notification_Service SHALL broadcast the full notification payload to all devices connected via WebSocket_Broadcaster, including the device that triggered the creation.
2. WHEN a Notification_Entity status or type is updated, THE Notification_Service SHALL broadcast the updated notification (including `id`, new `status`, new `type`, and `updated_at`) to all devices connected via WebSocket_Broadcaster, including the device that triggered the update.
3. THE WebSocket_Broadcaster SHALL deliver notification events using event type `notification_created` for new notifications and `notification_updated` for mutations.
4. THE WebSocket_Broadcaster SHALL deliver broadcast messages to each connected device within 2 seconds of the originating event.

### Requirement 5: Delivery to Offline Devices

**User Story:** As a user whose device is offline, I want to receive notifications when my device comes back online, so that I do not miss events that occurred while disconnected.

#### Acceptance Criteria

1. WHEN a Notification_Entity with type `incoming_call` is created and a device is not connected via WebSocket, THE Notification_Service SHALL send a Wake_Signal with priority `high` to that device via UnifiedPush.
2. WHEN a Notification_Entity with type other than `incoming_call` is created and a device is not connected via WebSocket, THE Notification_Service SHALL send a Wake_Signal with priority `normal` to that device via UnifiedPush.
3. WHEN a device reconnects via WebSocket, THE Notification_Service SHALL send all Notification_Entities with status `pending` to that device as part of the reconnection handshake.
4. THE Wake_Signal format SHALL remain unchanged: `{ id: <notification_uuid>, priority: "high" | "normal" }`.
5. WHEN a device receives a Wake_Signal and fetches the notification via `GET /api/notifications`, IF the notification status has already been updated to `read` before the fetch completes, THEN the notification SHALL NOT appear in the response.

### Requirement 6: Unified Notification Flow for Calls

**User Story:** As a developer, I want incoming calls to use the same notification mechanism as other event types, so that there is one notification path for all events and no special client-side suppression logic.

#### Acceptance Criteria

1. THE Notification_Service SHALL create exactly one Notification_Entity per call lifecycle, where the lifecycle begins when the call is received and ends when the call reaches a terminal state (answered, declined, or missed).
2. WHEN an incoming call transitions to missed, THE Notification_Service SHALL mutate the existing Notification_Entity type from `incoming_call` to `missed_call` rather than creating a separate notification.
3. WHEN a `notification_updated` event is received with a status of `read`, THE Client_Notification_Handler SHALL dismiss the corresponding displayed Android notification.
4. WHEN a `notification_updated` event is received with an updated type, THE Client_Notification_Handler SHALL use the notification `id` field to replace the displayed Android notification content to reflect the new type.
5. THE Client_Notification_Handler SHALL NOT contain or invoke client-side suppression logic (`wasCallDeclined`, `wasAlreadyNotified`, `wasRecentCallDeclinedFrom`, `wasRecentlyNotifiedForCaller`).
6. IF a `notification_updated` event is received for a notification `id` that has no corresponding displayed Android notification, THEN THE Client_Notification_Handler SHALL ignore the event without error.

### Requirement 7: Server Restart Cleanup

**User Story:** As a user, I want stale call notifications to be resolved after a server restart, so that I do not see phantom incoming call notifications for calls that ended while the server was down.

#### Acceptance Criteria

1. WHEN the server process starts, THE Startup_Cleanup_Service SHALL mark all call_history entries with `call_type = 'INCOMING'` and `answered_by_device IS NULL` as `MISSED`.
2. WHEN the server process starts, THE Startup_Cleanup_Service SHALL mark all call_history entries with `call_type = 'OUTGOING'` and `duration_seconds IS NULL` as `UNANSWERED`.
3. WHEN the server process starts, THE Startup_Cleanup_Service SHALL update all Notification_Entities with type `incoming_call` and status `pending` to type `missed_call` while retaining status as `pending`.
4. THE Startup_Cleanup_Service SHALL execute cleanup before the server begins accepting WebSocket connections or HTTP requests.
5. IF the Startup_Cleanup_Service fails to complete cleanup due to a database error, THEN THE Startup_Cleanup_Service SHALL abort server startup and log an error message indicating the failure reason.

### Requirement 8: Pending Notifications API

**User Story:** As a client developer, I want an API endpoint to fetch all pending notifications, so that reconnecting devices can synchronize their notification state.

#### Acceptance Criteria

1. THE Notification_Service SHALL expose a `GET /api/notifications` endpoint that returns all Notification_Entities with status `pending`, ordered by `created_at` ascending.
2. THE Notification_Service SHALL expose a `POST /api/notifications/:id/read` endpoint that marks a single Notification_Entity as `read` and broadcasts the update to all devices via WebSocket_Broadcaster.
3. THE Notification_Service SHALL expose a `POST /api/notifications/read-all` endpoint that accepts an optional `type` query parameter whose valid values are the Notification_Type enum (`incoming_call`, `missed_call`, `incoming_sms`, `blocked_call`, `new_device_login`), marks all pending Notification_Entities matching the given type as `read`, and broadcasts the updates to all devices via WebSocket_Broadcaster. IF no `type` parameter is provided, THEN all pending Notification_Entities SHALL be marked as `read`.
4. IF any request to `GET /api/notifications`, `POST /api/notifications/:id/read`, or `POST /api/notifications/read-all` is received with an invalid or missing session token, THEN THE Notification_Service SHALL return HTTP 401.
5. IF a `POST /api/notifications/:id/read` request references a notification ID that does not exist, THEN THE Notification_Service SHALL return HTTP 404.
6. IF a `POST /api/notifications/read-all` request includes a `type` parameter with a value not in the Notification_Type enum, THEN THE Notification_Service SHALL return HTTP 400 with an error message indicating the invalid type value.

### Requirement 9: Remove Legacy Notification Infrastructure

**User Story:** As a developer, I want the old notification queue and auto-detect routes removed, so that there is a single authoritative notification path and no dead code.

#### Acceptance Criteria

1. THE Notification_Service SHALL provide a database migration that migrates any undelivered, non-expired entries from `notification_queue` into the Notifications_Table (mapping `notification_type` to Notification_Type, setting status to `pending`, copying `payload` into the JSONB payload field) and then drops the `notification_queue` table.
2. IF the `notification_queue` table contains no undelivered non-expired entries at migration time, THEN THE Notification_Service SHALL drop the `notification_queue` table without inserting any rows into the Notifications_Table.
3. THE Notification_Service SHALL remove the `GET /api/notifications/:id` route (including the `autoDetectNotification` and `lookupByType` functions) and the entire `notification-routes.ts` file.
4. THE Notification_Service SHALL remove the `NotificationQueueService` class, its associated interface and type exports, and its test file, and SHALL remove all import statements and instantiation references to it in other modules.
5. THE Client_Notification_Handler SHALL remove the `shownNotificationIds` ConcurrentHashMap and all methods that read from or write to it (including `isDuplicate` checks), relying on the server-provided notification `id` for update-or-replace logic instead.
6. WHEN the removals are complete, THE Notification_Service and Client_Notification_Handler SHALL compile without errors and all remaining tests SHALL pass, confirming no dangling references to removed code.

### Requirement 10: Android Notification Small Icon

**User Story:** As a user, I want Svarla notifications to display the Svarla app icon rather than a generic phone handset, so that I can distinguish Svarla notifications from native dialer notifications in the Android status bar.

#### Acceptance Criteria

1. THE Client_Notification_Handler SHALL use a monochrome (single white fill color with transparency) vector drawable of the Svarla app icon, sized at 24dp × 24dp, as the small icon for all notification types (incoming calls, active calls, SMS, missed calls, blocked calls, new device login, and connection service).
2. THE Client_Notification_Handler SHALL replace the current `ic_notification.xml` phone handset vector with the Svarla app icon vector, retaining the same resource name (`ic_notification`) so that all existing references resolve to the new icon without code changes.
3. THE Client_Notification_Handler SHALL reference the same single icon drawable resource (`ic_notification`) in every notification builder and in the PhoneAccount registration, so that the Svarla icon appears consistently across the status bar, notification shade, and system telecom UI.
