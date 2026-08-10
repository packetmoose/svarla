# Implementation Plan: Multi-Provider Web Interface

## Overview

This plan transforms the softphone server from a single-provider architecture into a multi-provider platform with a responsive web management interface. The implementation proceeds in layers: database schema first, then naming refactors, then core services (ProviderRegistry, WebhookRouter), then API endpoints, and finally the web interface SPA. The Android app updates are handled last as a parallel track.

## Tasks

- [x] 1. Database schema restructuring
  - [x] 1.1 Create the new single initial migration (`migrations/001_initial_schema.ts`)
    - Remove all existing migration files (001 through 004)
    - Write a single migration that creates the complete multi-provider schema: `providers`, `numbers`, `auth`, `device_registry`, `provider_users`, `conversations`, `messages`, `call_history`, `read_state`, `notification_queue` tables
    - Include all indexes, CHECK constraints, foreign keys with ON DELETE RESTRICT for providers, and the single-row auth constraint
    - Add `push_endpoint_url` column to `device_registry` (from removed migration 004)
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10_

  - [x] 1.2 Update Kysely type definitions in `src/database.ts`
    - Replace `VonageNumbersTable` with `NumbersTable` (add `provider_id` field)
    - Replace `VonageUsersTable` with `ProviderUsersTable` (add `provider_id`, rename `vonage_user_id` → `provider_user_id`, `vonage_user_name` → `provider_user_name`)
    - Add `ProvidersTable` interface
    - Rename `vonage_number` → `provider_number` in `CallHistoryTable` and `MessagesTable`
    - Rename `vonage_call_id` → `provider_call_id` in `CallHistoryTable`
    - Rename `vonage_message_id` → `provider_message_id` in `MessagesTable`
    - Update the `Database` interface to reference `providers`, `numbers`, `provider_users` tables
    - _Requirements: 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.10_

- [x] 2. Server naming refactor (Vonage → generic)
  - [x] 2.1 Rename `VonageUserManager` to `ProviderUserManager`
    - Rename file `src/services/vonage-user-manager.ts` → `src/services/provider-user-manager.ts`
    - Rename class `VonageUserManager` → `ProviderUserManager`
    - Rename interface `VonageUsersClient` → `ProviderUsersClient`
    - Rename interface `VonageUser` → `ProviderUser`
    - Rename interface `VonageUserManagerConfig` → `ProviderUserManagerConfig`
    - Rename internal fields: `vonageUserId` → `providerUserId`, `vonageUserName` → `providerUserName`
    - Update DB table reference from `vonage_users` to `provider_users`
    - Update all column references: `vonage_user_id` → `provider_user_id`, `vonage_user_name` → `provider_user_name`
    - _Requirements: 15.3_

  - [x] 2.2 Update all server imports and references to renamed types
    - Update `src/server.ts` imports and usage of `VonageUserManager` → `ProviderUserManager`
    - Update `src/routes/device-routes.ts` references
    - Update `src/routes/call-routes.ts` references
    - Update `src/routes/webhook-routes.ts` references (keep Vonage-specific provider logic)
    - Update `src/services/auth-service.ts` references
    - Update test files: `vonage-user-manager-security.test.ts` → `provider-user-manager-security.test.ts`
    - _Requirements: 15.1, 15.3, 15.5_

  - [x] 2.3 Rename Vonage-specific column references in shared services
    - Update `src/services/call-history-service.ts`: `vonage_number` → `provider_number`, `vonage_call_id` → `provider_call_id`
    - Update `src/services/conversation-service.ts`: `vonage_number` → `provider_number`, `vonage_message_id` → `provider_message_id`
    - Update `src/services/number-management-service.ts`: table reference `vonage_numbers` → `numbers`
    - Update `src/routes/number-routes.ts`, `src/routes/sms-routes.ts`, `src/routes/call-routes.ts` field references
    - Update `src/routes/sync-routes.ts` if it references old column names
    - _Requirements: 15.1, 15.5_

  - [x] 2.4 Update all existing test files to use renamed types and columns
    - Update `src/services/call-history-service.test.ts`
    - Update `src/services/conversation-service.test.ts`
    - Update `src/services/number-management-service.test.ts`
    - Update `src/routes/webhook-routes.test.ts` (Vonage-specific logic remains but shared fields are renamed)
    - Update `src/routes/number-routes.test.ts`, `src/routes/call-routes.test.ts`, `src/routes/sms-routes.test.ts`
    - Ensure all tests pass with `vitest run`
    - _Requirements: 15.5_

- [x] 3. Checkpoint - Verify refactor compiles and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Config file update and web interface gating
  - [x] 4.1 Add `web_interface.enabled` to config schema and AppConfig
    - Add `web_interface` section to `serverConfigFileSchema` in `src/config.ts` with `enabled: z.boolean().default(false)`
    - Add `webInterfaceEnabled: boolean` to `AppConfig` interface
    - Update `loadConfig()` to resolve the new field
    - Add the `web_interface` section to `server-config.yaml` (defaults to false)
    - _Requirements: 5.1, 5.5_

  - [x]* 4.2 Write unit tests for config loading with web_interface.enabled
    - Test that missing `web_interface` section defaults to `enabled: false`
    - Test that explicitly setting `enabled: true` is parsed correctly
    - _Requirements: 5.1, 5.2, 5.5_

- [x] 5. ProviderRegistry implementation
  - [x] 5.1 Create `src/services/provider-registry.ts` with ProviderRegistry class
    - Implement in-memory map of `ProviderRegistryEntry` keyed by Provider_ID
    - Implement `loadAll()`: query `providers` table for enabled providers, initialize each via provider factory
    - Implement `getProvider(providerId)`: lookup by ID
    - Implement `listProviders()`: return all entries
    - Implement `addProvider(type, displayName, config)`: validate config, persist to DB, initialize instance, return providerId + webhookUrls
    - Implement `updateProvider(providerId, updates)`: update DB, reinitialize if config/enabled changed
    - Implement `removeProvider(providerId)`: check for associated numbers and active calls, stop instance, delete from DB
    - Implement `getWebhookUrls(providerId)`: construct full URLs from base URL + providerId + provider type endpoints
    - Handle initialization failures gracefully (mark as unavailable, log, continue)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 5.2 Create provider configuration validators (`src/validators/provider-config-validator.ts`)
    - Define Zod schemas for each provider type: `vonageConfigSchema`, `modemmanagerConfigSchema`, `dummyConfigSchema`
    - Implement `validateProviderConfig(type, config)` that returns field-level validation errors
    - _Requirements: 3.5, 3.6_

  - [x]* 5.3 Write property tests for ProviderRegistry (`src/services/provider-registry.property.test.ts`)
    - **Property 1: Provider storage round-trip**
    - **Property 2: Multiple providers of same type coexist independently**
    - **Property 5: Non-existent provider operations return error**
    - **Property 7: Provider removal blocked by associated numbers**
    - **Property 8: Provider update persists changes**
    - **Validates: Requirements 1.1, 1.2, 1.5, 1.6, 3.2, 3.3, 3.4, 3.7, 14.9**

  - [x]* 5.4 Write property tests for provider config validation (`src/validators/provider-config-validator.property.test.ts`)
    - **Property 6: Provider config validation rejects invalid configs and reports fields**
    - **Validates: Requirements 3.5, 3.6**

- [x] 6. WebhookRouter implementation
  - [x] 6.1 Create `src/routes/webhook-router.ts` with dynamic provider-scoped routing
    - Implement route pattern `/webhooks/:providerId/<endpoint>`
    - Extract Provider_ID from URL path, look up provider in ProviderRegistry
    - Return 404 for unknown Provider_ID with warning log
    - Return 503 for disabled provider with warning log
    - Delegate webhook body to provider instance's handler
    - No session authentication required for webhook routes
    - Add `getWebhookEndpoints(): string[]` method to `TelephonyProvider` interface in `src/providers/telephony-provider.ts`
    - Implement `getWebhookEndpoints()` in VonageTelephonyProvider (returns `['answer', 'event', 'inbound-sms', 'sms-status']`)
    - Implement `getWebhookEndpoints()` in DummyTelephonyProvider (returns `['inbound-sms', 'event']`)
    - Implement `getWebhookEndpoints()` in ModemManagerTelephonyProvider (returns `[]`)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x]* 6.2 Write property tests for WebhookRouter (`src/routes/webhook-router.property.test.ts`)
    - **Property 3: Webhook routing delivers to correct provider**
    - **Property 4: Webhook routing rejects invalid and disabled providers**
    - **Validates: Requirements 2.2, 2.3, 2.4**

- [x] 7. Provider Management API
  - [x] 7.1 Create `src/routes/provider-routes.ts` with CRUD endpoints
    - `GET /api/providers` — list all providers (id, type, displayName, enabled status)
    - `POST /api/providers` — add provider (validate config, persist, return id + webhook URLs)
    - `GET /api/providers/:id` — get provider details (mask secrets in config)
    - `PUT /api/providers/:id` — update provider (display name, config, enabled)
    - `DELETE /api/providers/:id` — remove provider (reject if numbers assigned or active calls)
    - All endpoints require session authentication
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 7.2 Create secret masking utility (`src/formatters/secret-masker.ts`)
    - Implement function to mask sensitive config fields (show only last 4 chars, asterisks for rest)
    - Handle strings shorter than 4 characters (fully masked)
    - Define which fields are secrets per provider type (api_secret, private_key_path for Vonage)
    - _Requirements: 7.7_

  - [x]* 7.3 Write property tests for secret masking (`src/formatters/secret-masker.property.test.ts`)
    - **Property 12: Secret masking shows only last 4 characters**
    - **Validates: Requirements 7.7**

- [x] 8. Number-to-provider association updates
  - [x] 8.1 Update `NumberManagementService` for multi-provider awareness
    - Add `provider_id` to number records in all queries
    - Update `syncNumbers()` to sync per-provider (accept providerId parameter)
    - Update `getNumbers()` to return numbers with provider context (provider_id, display_name via JOIN)
    - Update outbound routing to use number's `provider_id` to select provider from ProviderRegistry
    - Reject operations when owning provider is disabled/unavailable
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [x]* 8.2 Write property tests for number-to-provider routing (`src/services/number-management-service.property.test.ts`)
    - **Property 9: Operations route through the owning provider**
    - **Property 10: Operations on numbers with disabled providers are rejected**
    - **Property 11: API responses include provider context for numbers and calls**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**

- [x] 9. Password change API and validation
  - [x] 9.1 Add password change endpoint (`POST /api/auth/change-password`)
    - Require current password, new password, new password confirmation
    - Validate current password against stored hash
    - Validate new password against rules (min 12 chars, uppercase, lowercase, digit, special char)
    - Validate new password confirmation matches
    - Update password hash on success
    - Return specific error messages for each failure case
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x]* 9.2 Write property tests for password validation (`src/validators/password-validator.property.test.ts`)
    - **Property 13: Password change round-trip**
    - **Property 14: Password validation returns specific rule failures**
    - **Validates: Requirements 8.2, 8.4**

- [x] 10. Checkpoint - Verify all backend services compile and tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Wire ProviderRegistry and WebhookRouter into server startup
  - [x] 11.1 Refactor `src/server.ts` to use ProviderRegistry
    - Replace single `createTelephonyProvider()` call with `ProviderRegistry.loadAll()`
    - Register WebhookRouter with dynamic routes instead of fixed `/webhooks/*` routes
    - Wire ProviderRegistry into NumberManagementService, ConversationService, CallHistoryService
    - Keep existing provider event handling logic but delegate through ProviderRegistry
    - Conditionally register web interface routes based on `webInterfaceEnabled` config
    - Register provider management API routes
    - Register password change route
    - _Requirements: 1.3, 1.4, 2.1, 5.2, 5.3, 5.4, 5.5_

  - [x]* 11.2 Write integration tests for server startup with multiple providers
    - Test that server starts with multiple providers in DB
    - Test that webhook routes are registered per-provider
    - Test that web interface routes are not registered when disabled
    - _Requirements: 1.3, 1.4, 5.2, 5.3_

- [x] 12. Checkpoint - Backend fully functional
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Web interface SPA setup and build tooling
  - [x] 13.1 Create web SPA project structure and esbuild build script
    - Create `web/` directory with `index.html`, `src/`, `src/components/`, `src/styles/`
    - Create `web/build.ts` esbuild bundler script (outputs to `dist/web/`)
    - Create `web/src/main.tsx` entry point with Preact
    - Create `web/src/api.ts` HTTP client (fetch wrapper with session cookie)
    - Create `web/src/ws.ts` WebSocket client for real-time updates
    - Create `web/src/router.ts` client-side hash router
    - Create `web/src/state.ts` simple reactive state store
    - Add Preact dependency to package.json
    - Add build script for web (`"build:web": "tsx web/build.ts"`)
    - _Requirements: 5.3, 12.1_

  - [x] 13.2 Configure Fastify to serve the web SPA
    - Register `@fastify/static` for `dist/web/` at root path `/` (only when `web_interface.enabled`)
    - Add SPA fallback route (serve `index.html` for all non-API, non-webhook paths)
    - Ensure API routes, webhook routes, and `/public/` static files continue working regardless of web_interface setting
    - _Requirements: 5.2, 5.3, 5.4_

- [x] 14. Web interface authentication (login page)
  - [x] 14.1 Create login component (`web/src/components/login.tsx`)
    - Password field accepting 1-128 characters
    - Submit handler calling `POST /api/auth/login`
    - On success: store session, redirect to main view
    - On failure: display generic error message
    - On lockout: display lockout message with remaining duration
    - On session expiry: redirect to login, clear local state
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

- [x] 15. Web interface provider management page
  - [x] 15.1 Create providers list and management component (`web/src/components/providers.tsx`)
    - Display all registered providers with type, display name, enabled status
    - Add provider form with type selection and type-specific config fields
    - Remove provider with confirmation dialog
    - Enable/disable toggle per provider
    - Update list without full page reload on add/remove
    - Display webhook URLs in provider detail view
    - Display masked config values (asterisks + last 4 chars for secrets)
    - Show field-level validation errors on add failure
    - Show success/error notifications within 1 second
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_

- [x] 16. Web interface number management page
  - [x] 16.1 Create numbers management component (`web/src/components/numbers.tsx`)
    - Display numbers grouped by owning provider (label, active status, capabilities)
    - Edit label (1-30 characters) with validation error display
    - Activate/deactivate with confirmation step
    - Update list without full page reload
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

- [x] 17. Web interface device management page
  - [x] 17.1 Create devices management component (`web/src/components/devices.tsx`)
    - Display active devices sorted by registration date (most recent first) with name, registered date, last-seen timestamp
    - Remove device with confirmation step
    - On removal: device disappears from list without page reload
    - Show error if removal fails, retain device in list
    - Prevent removing current session's device
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x]* 17.2 Write property tests for device self-removal prevention (`src/services/device-registry-manager.property.test.ts`)
    - **Property 15: Device removal invalidates session**
    - **Property 16: Self-removal prevention**
    - **Validates: Requirements 10.3, 10.5**

- [x] 18. Web interface conversations and messaging page
  - [x] 18.1 Create conversations and messaging component (`web/src/components/conversations.tsx`)
    - Conversation list sorted by most recent message (preview truncated to 50 chars, timestamp)
    - Message thread view: most recent 100 messages, chronological, sent vs received visually distinct
    - Compose input (1-1600 chars) with live character count
    - New conversation: E.164 phone number input with validation, source number selection
    - Real-time message append via WebSocket (within 3 seconds)
    - Message delivery status indicators (pending, sent, delivered, failed)
    - Real-time status updates via WebSocket
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8_

  - [x]* 18.2 Write property tests for message and phone number validation (`src/validators/message-validator.property.test.ts`)
    - **Property 19: Message body length validation**
    - **Property 20: E.164 phone number validation**
    - **Validates: Requirements 11.3, 11.5**

  - [x]* 18.3 Write property tests for conversation ordering (`src/services/conversation-service.property.test.ts`)
    - **Property 17: Conversations ordered by most recent message**
    - **Property 18: Messages limited to 100 and ordered chronologically**
    - **Validates: Requirements 11.1, 11.2**

- [x] 19. Web interface call history page
  - [x] 19.1 Create call history component (`web/src/components/call-history.tsx`)
    - Paginated list ordered by timestamp descending
    - Show call type (incoming, outgoing, missed, declined, unanswered), phone number, timestamp, duration
    - Show which Number/provider was used per entry
    - Real-time updates via WebSocket (`call_history_update` event)
    - Dedicated navigation section
    - Hide dialer/call controls when voice not enabled
    - Empty state message when no entries
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

  - [x]* 19.2 Write property tests for call history pagination (`src/services/call-history-service.property.test.ts`)
    - **Property 21: Call history pagination ordered by timestamp descending**
    - **Validates: Requirements 13.1**

- [x] 20. Web interface settings (password change) page
  - [x] 20.1 Create settings/password change component (`web/src/components/settings.tsx`)
    - Password change form: current password, new password, confirmation
    - Display success message on successful change
    - Display specific validation rule failures (min 12 chars, uppercase, lowercase, digit, special char)
    - Display error for incorrect current password
    - Display error for mismatched confirmation
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 21. Web interface navigation and responsive layout
  - [x] 21.1 Create navigation component and responsive CSS (`web/src/components/nav.tsx`, `web/src/styles/main.css`)
    - Navigation with sections: Providers, Numbers, Devices, Conversations, Call History, Settings
    - Single-column layout below 768px with toggle menu button
    - Multi-panel layout at 768px+ with persistent navigation
    - Adapt layout from 320px to 2560px width
    - Touch-friendly targets minimum 44x44px
    - Mobile-first responsive styles
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 13.4_

- [x] 22. Checkpoint - Web interface complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 23. Android app naming refactor
  - [x] 23.1 Rename Vonage-specific types in Android app
    - Rename `VonageNumber` entity → `ProviderNumber`
    - Rename `VonageNumberDao` → `ProviderNumberDao`
    - Rename DTO class `VonageNumberDto` → `ProviderNumberDto`
    - Rename fields: `vonageNumber` → `providerNumber`, `vonageNumberLabel` → `providerNumberLabel`
    - Update all references in ViewModels, Repositories, UI components
    - Exclude Vonage-specific client files (`VonageModule.kt`, `VonageClientManager.kt`)
    - _Requirements: 15.2_

  - [x] 23.2 Apply destructive database migration in Android app
    - Increment Room database version number
    - Add `fallbackToDestructiveMigration()` to database builder
    - Update `SoftphoneDatabase.kt` with renamed entities and DAOs
    - Verify app compiles without errors
    - _Requirements: 15.4, 15.5_

- [x] 24. Final checkpoint - All components integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The server uses TypeScript with Fastify, Kysely (PostgreSQL), Zod, and vitest
- The web SPA uses Preact + esbuild, served as static files from `dist/web/`
- The Android app uses Kotlin with Room database
- `fast-check` is already available in devDependencies for property-based testing
- The existing `vonage-telephony-provider.ts` file retains Vonage-specific naming (it IS the Vonage provider)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "2.3"] },
    { "id": 3, "tasks": ["2.2", "2.4"] },
    { "id": 4, "tasks": ["4.1", "5.2"] },
    { "id": 5, "tasks": ["4.2", "5.1"] },
    { "id": 6, "tasks": ["5.3", "5.4", "6.1"] },
    { "id": 7, "tasks": ["6.2", "7.1", "7.2"] },
    { "id": 8, "tasks": ["7.3", "8.1", "9.1"] },
    { "id": 9, "tasks": ["8.2", "9.2", "11.1"] },
    { "id": 10, "tasks": ["11.2", "13.1"] },
    { "id": 11, "tasks": ["13.2"] },
    { "id": 12, "tasks": ["14.1", "21.1"] },
    { "id": 13, "tasks": ["15.1", "16.1", "17.1", "20.1"] },
    { "id": 14, "tasks": ["17.2", "18.1", "19.1"] },
    { "id": 15, "tasks": ["18.2", "18.3", "19.2"] },
    { "id": 16, "tasks": ["23.1"] },
    { "id": 17, "tasks": ["23.2"] }
  ]
}
```
