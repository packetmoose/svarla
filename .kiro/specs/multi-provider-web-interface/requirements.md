# Requirements Document

## Introduction

This feature transforms the softphone server from a single-provider system into a multi-provider platform with a web-based management interface. The server will support multiple telephony providers running simultaneously (including multiple instances of the same provider type), each identified by a unique ID used in webhook routing. A responsive web interface will allow full system administration and messaging. The database schema will be restructured from scratch to support the new architecture, and all Vonage-specific naming will be replaced with generic terminology.

## Glossary

- **Server**: The Node.js/TypeScript Fastify backend application
- **Provider**: A configured telephony backend instance (e.g., a Vonage account, a ModemManager modem) that can send/receive calls and SMS
- **Provider_Registry**: The database-backed store of all configured telephony provider instances
- **Provider_ID**: A unique identifier (UUID) assigned to each provider instance in the Provider_Registry
- **Web_Interface**: The browser-based management UI served by the Server
- **App**: The Android/Kotlin mobile client application
- **Number**: A phone number in E.164 format associated with a specific Provider
- **Device**: A registered client (App instance or browser session) that syncs with the Server
- **Conversation**: A thread of messages between the user and a specific external phone number
- **Webhook_Router**: The Server component that routes incoming webhooks to the correct Provider instance based on Provider_ID in the URL path
- **Config_File**: The server-config.yaml configuration file

## Requirements

### Requirement 1: Provider Registry Storage

**User Story:** As a system administrator, I want telephony providers to be stored in the database rather than in a config file, so that I can add and remove providers at runtime without restarting the server.

#### Acceptance Criteria

1. THE Provider_Registry SHALL store each provider instance with a Provider_ID, provider type, display name (maximum 100 characters), configuration parameters, and enabled status
2. WHEN a provider is added to the Provider_Registry, THE Server SHALL assign a unique Provider_ID (UUID) to that provider instance
3. WHEN the Server starts, THE Server SHALL load all enabled providers from the Provider_Registry and attempt to initialize each one independently
4. IF a provider fails to initialize on startup, THEN THE Server SHALL log the failure, mark that provider as unavailable, and continue initializing the remaining providers
5. WHEN a provider is removed from the Provider_Registry, THE Server SHALL reject the removal if the provider has active calls in progress, otherwise THE Server SHALL stop the provider instance and deregister its webhook routes
6. THE Provider_Registry SHALL support multiple provider instances of the same provider type simultaneously

### Requirement 2: Multi-Provider Webhook Routing

**User Story:** As a system administrator, I want each provider to have unique webhook URLs containing its Provider_ID, so that the server can route incoming webhooks to the correct provider instance.

#### Acceptance Criteria

1. THE Webhook_Router SHALL register webhook URL paths that include the Provider_ID as a path segment in the format `/webhooks/:providerId/<endpoint>`, where each provider type defines its own set of endpoint suffixes
2. WHEN a webhook request is received, THE Webhook_Router SHALL extract the Provider_ID from the URL path, look up the matching enabled provider instance in the Provider_Registry, and delegate the request body to that provider instance's webhook handler
3. IF a webhook request contains a Provider_ID that does not match any provider in the Provider_Registry, THEN THE Webhook_Router SHALL respond with HTTP 404 and log a warning that includes the unrecognized Provider_ID
4. IF a webhook request contains a Provider_ID that matches a disabled provider, THEN THE Webhook_Router SHALL respond with HTTP 503 and log a warning that includes the Provider_ID and its disabled status
5. WHEN a new provider is registered, THE Server SHALL return the complete list of webhook URLs for that provider instance, constructed by combining the configured base URL, the Provider_ID path segment, and each endpoint suffix supported by that provider type
6. THE Webhook_Router SHALL process webhook requests without requiring session authentication

### Requirement 3: Provider Management API

**User Story:** As a system administrator, I want API endpoints to add, update, and remove telephony providers, so that I can manage providers from both the App and the Web_Interface.

#### Acceptance Criteria

1. THE Server SHALL expose an authenticated API endpoint to list all registered providers with their Provider_ID, type, display name, and enabled status
2. WHEN a provider is successfully added via the API, THE Server SHALL assign a Provider_ID, persist the provider to the Provider_Registry, and return the Provider_ID along with the full set of webhook URLs for that provider instance
3. IF a remove or update request references a Provider_ID that does not exist in the Provider_Registry, THEN THE Server SHALL return an error indicating the provider was not found
4. THE Server SHALL expose an authenticated API endpoint to update a provider's display name, configuration parameters, and enabled status by Provider_ID
5. WHEN a provider is added via the API, THE Server SHALL validate the configuration parameters for the specified provider type before saving, including verifying all required fields for that type are present and non-empty
6. IF provider configuration validation fails, THEN THE Server SHALL return an error message that lists each invalid or missing field by name and the reason it failed validation
7. IF a remove request targets a provider that has associated Numbers, THEN THE Server SHALL reject the removal and return an error indicating the provider still has Numbers assigned to it
8. THE Server SHALL expose an authenticated API endpoint to remove a provider by Provider_ID

### Requirement 4: Number-to-Provider Association

**User Story:** As a user, I want each phone number to be associated with its provider instance, so that outbound messages and calls are routed through the correct provider.

#### Acceptance Criteria

1. THE Server SHALL store each Number with a reference to its owning Provider_ID, enforcing that each Number belongs to exactly one Provider instance
2. WHEN a message is sent from a Number, THE Server SHALL route it through the Provider instance that owns that Number by invoking that Provider's sendSms method
3. WHEN a call is initiated from a Number, THE Server SHALL route it through the Provider instance that owns that Number by invoking that Provider's makeCall method
4. THE Server SHALL expose the Provider_ID and provider display name alongside each Number in API responses that return Number data
5. IF a message or call is attempted from a Number whose owning Provider is disabled or unavailable, THEN THE Server SHALL reject the operation and return an error message indicating the provider is not available
6. WHEN a Provider is removed from the Provider_Registry, THE Server SHALL deactivate all Numbers associated with that Provider_ID

### Requirement 5: Web Interface Enable/Disable

**User Story:** As a system administrator, I want a config option to enable or disable the web interface, so that I can run the server without the web UI when not needed.

#### Acceptance Criteria

1. THE Config_File SHALL include a `web_interface.enabled` boolean option that defaults to false
2. WHILE `web_interface.enabled` is false, THE Server SHALL not register any web interface routes or serve static assets, and SHALL respond with HTTP 404 to any request targeting the Web_Interface paths
3. WHILE `web_interface.enabled` is true, THE Server SHALL serve the Web_Interface at the root URL path (`/`)
4. WHILE `web_interface.enabled` is false, THE Server SHALL continue to serve all API and webhook endpoints without interruption
5. THE Server SHALL read the `web_interface.enabled` setting at startup and configure route registration accordingly

### Requirement 6: Web Interface Authentication

**User Story:** As a user, I want to log into the web interface using the same credentials as the App, so that I do not need to manage separate passwords.

#### Acceptance Criteria

1. THE Web_Interface SHALL present a login form with a password field accepting between 1 and 128 characters
2. WHEN valid credentials are submitted, THE Web_Interface SHALL create an authenticated session with the same expiry duration as App sessions and redirect to the main view
3. IF invalid credentials are submitted, THEN THE Web_Interface SHALL display a generic error message that does not reveal whether the system has a password configured
4. IF the account is locked due to exceeding the maximum failed login attempts, THEN THE Web_Interface SHALL display an error message indicating the account is temporarily locked and the remaining lockout duration
5. THE Web_Interface SHALL use the same authentication backend, password hash, failed-attempt counter, and lockout policy as the App
6. WHEN the session expires or is invalidated, THE Web_Interface SHALL redirect to the login form and clear the local session state

### Requirement 7: Web Interface Provider Management

**User Story:** As a system administrator, I want to add and remove telephony providers through the web interface, so that I can configure the system without using CLI tools.

#### Acceptance Criteria

1. THE Web_Interface SHALL display a list of all registered providers with their type, display name, and enabled status
2. THE Web_Interface SHALL provide a form to add a new provider with type selection and type-specific configuration fields matching the required parameters for the selected provider type
3. THE Web_Interface SHALL provide controls to remove an existing provider with a confirmation step that requires the administrator to explicitly confirm the removal before it is executed
4. THE Web_Interface SHALL provide controls to enable or disable a provider
5. WHEN a provider is added or removed, THE Web_Interface SHALL update the displayed list without a full page reload
6. WHEN a provider detail view is opened, THE Web_Interface SHALL display all webhook URLs that need to be configured in the external provider's dashboard (e.g., answer URL, event URL, inbound SMS URL, SMS status URL)
7. WHEN a provider detail view is opened, THE Web_Interface SHALL display all configuration details for that provider instance, with sensitive secret values masked as asterisk characters showing only the last 4 characters
8. IF provider addition fails due to validation errors, THEN THE Web_Interface SHALL display the specific field-level validation errors returned by the Server without clearing the form inputs
9. WHEN a provider is successfully added, removed, enabled, or disabled, THE Web_Interface SHALL display a visible success notification within 1 second of receiving the server response
10. IF a provider removal or status change fails, THEN THE Web_Interface SHALL display an error notification indicating the reason for failure

### Requirement 8: Web Interface Password Management

**User Story:** As a user, I want to change my password through the web interface, so that I can maintain account security without database access.

#### Acceptance Criteria

1. THE Web_Interface SHALL provide a password change form requiring the current password, a new password, and a new password confirmation field
2. WHEN the current password is correct and the new password passes validation and the new password confirmation matches the new password, THE Server SHALL update the stored password hash and THE Web_Interface SHALL display a success confirmation message
3. IF the current password is incorrect, THEN THE Web_Interface SHALL display an error message indicating the current password is wrong without revealing details about the stored credential
4. IF the new password fails validation rules, THEN THE Web_Interface SHALL display the specific rule that failed (minimum 12 characters, at least one uppercase letter, at least one lowercase letter, at least one digit, at least one special character)
5. IF the new password confirmation does not match the new password, THEN THE Web_Interface SHALL display an error message indicating the passwords do not match

### Requirement 9: Web Interface Number Management

**User Story:** As a user, I want to manage phone numbers through the web interface, so that I can add labels, activate, or deactivate numbers.

#### Acceptance Criteria

1. THE Web_Interface SHALL display all Numbers grouped by their owning Provider, showing each Number's label, active status, and capabilities (SMS, Voice)
2. THE Web_Interface SHALL provide controls to edit the label of a Number, accepting between 1 and 30 characters
3. IF a label update fails validation, THEN THE Web_Interface SHALL display an error message indicating the validation failure reason
4. THE Web_Interface SHALL provide controls to activate or deactivate a Number with a confirmation step before deactivation
5. WHEN a Number's label or active status is changed, THE Web_Interface SHALL update the displayed list without a full page reload

### Requirement 10: Web Interface Device Management

**User Story:** As a user, I want to view and manage registered devices through the web interface, so that I can see which devices are connected and remove old ones.

#### Acceptance Criteria

1. THE Web_Interface SHALL display all active registered devices with their name, registration date, and last-seen timestamp, sorted by registration date with the most recently registered device first
2. THE Web_Interface SHALL provide a control to remove a registered device, requiring a confirmation step before executing the removal
3. WHEN a device is removed, THE Server SHALL invalidate that device's session token and THE Web_Interface SHALL remove the device from the displayed list without requiring a full page reload
4. IF the device removal request fails, THEN THE Web_Interface SHALL display an error message indicating the removal was unsuccessful and SHALL retain the device in the displayed list
5. THE Web_Interface SHALL prevent the user from removing the device associated with their current active session

### Requirement 11: Web Interface Conversations and Messaging

**User Story:** As a user, I want to view conversations and send messages through the web interface, so that I can manage SMS communication from a computer or tablet.

#### Acceptance Criteria

1. THE Web_Interface SHALL display a list of all conversations sorted by most recent message timestamp descending, showing for each entry the phone number, a message preview truncated to 50 characters, and the timestamp of the last message
2. WHEN a conversation is selected, THE Web_Interface SHALL display the most recent 100 messages for that conversation in chronological order with sent messages visually distinct from received messages
3. THE Web_Interface SHALL provide a message compose input that accepts between 1 and 1600 characters and SHALL display a live character count showing remaining characters
4. THE Web_Interface SHALL provide a way to start a new conversation by entering a phone number in E.164 format and selecting a source Number from the list of active Numbers
5. IF the user attempts to start a new conversation with a phone number that does not conform to E.164 format, THEN THE Web_Interface SHALL prevent message sending and display an inline validation error indicating the number is invalid
6. WHEN a new message is received while viewing a conversation, THE Web_Interface SHALL append it to the displayed thread within 3 seconds via WebSocket without requiring a page reload
7. THE Web_Interface SHALL display message delivery status (pending, sent, delivered, failed) for each outbound message
8. WHEN a message delivery status changes, THE Web_Interface SHALL update the displayed status indicator within 3 seconds via WebSocket without requiring a page reload

### Requirement 12: Responsive Design

**User Story:** As a user, I want the web interface to work well on phones, tablets, and computers, so that I can use it on any device.

#### Acceptance Criteria

1. THE Web_Interface SHALL adapt its layout to viewports from 320px to 2560px width
2. WHILE the viewport width is below 768px, THE Web_Interface SHALL display a single-column layout with a navigation menu accessible via a toggle button
3. WHILE the viewport width is 768px or above, THE Web_Interface SHALL display a multi-panel layout with persistent navigation
4. THE Web_Interface SHALL use touch-friendly interaction targets with a minimum size of 44x44px

### Requirement 13: Web Interface Call History

**User Story:** As a user, I want to view call history through the web interface, so that I can review past calls from any device.

#### Acceptance Criteria

1. THE Web_Interface SHALL display the call history as a paginated list ordered by timestamp descending (most recent first), showing for each entry: call type (incoming, outgoing, missed, declined, unanswered), phone number, timestamp, and duration in minutes and seconds
2. THE Web_Interface SHALL display which Number (source/destination) was used for each call entry alongside the provider display name
3. WHEN a `call_history_update` event is received via WebSocket, THE Web_Interface SHALL insert or update the affected entry in the displayed list without requiring a page reload
4. THE Web_Interface navigation SHALL include a dedicated section for call history
5. WHILE voice call functionality is not enabled, THE Web_Interface SHALL hide the dialer and all call-initiation controls
6. IF the call history contains no entries, THEN THE Web_Interface SHALL display an empty-state message indicating no calls have been recorded

### Requirement 14: Database Schema Restructuring

**User Story:** As a developer, I want a clean database schema that supports multi-provider architecture, so that the data model correctly represents the new system design.

#### Acceptance Criteria

1. THE Server SHALL include a single initial migration that creates the complete multi-provider schema including the `providers`, `numbers`, `provider_users`, `device_registry`, `call_history`, `conversations`, `messages`, `read_state`, `auth`, and `notification_queue` tables
2. THE Server SHALL remove all previous migration files from the migrations directory, retaining only the new single initial migration
3. THE Server database schema SHALL replace the `vonage_numbers` table with a `numbers` table that includes a `provider_id` foreign key referencing the `providers` table, retaining the number, label, is_active, added_at, and last_used_at columns
4. THE Server database schema SHALL replace the `vonage_users` table with a `provider_users` table that includes a `provider_id` foreign key referencing the `providers` table, retaining columns for device association, provider-specific user identifiers, display name, and timestamps
5. THE Server database schema SHALL include a `providers` table with a UUID primary key, provider type, display name, configuration stored as JSONB, and an enabled boolean status column
6. THE Server database schema SHALL replace `vonage_call_id` columns with a generic `provider_call_id` column in the `call_history` table
7. THE Server database schema SHALL replace `vonage_message_id` columns with a generic `provider_message_id` column in the `messages` table
8. THE Server database schema SHALL replace `vonage_number` columns with a generic `provider_number` column referencing the `numbers` table in all tables that previously referenced `vonage_numbers`
9. IF a provider is deleted from the `providers` table, THEN THE Server database schema SHALL prevent the deletion while associated records exist in the `numbers` or `provider_users` tables (RESTRICT behavior)
10. THE Server database schema SHALL enforce that every row in the `numbers` table and `provider_users` table references a valid `provider_id` via a NOT NULL foreign key constraint

### Requirement 15: Naming Refactor

**User Story:** As a developer, I want all Vonage-specific naming removed from the codebase, so that the project accurately reflects its multi-provider nature.

#### Acceptance Criteria

1. THE Server source code SHALL rename all Vonage-specific column and field names in shared database interfaces and service layers to generic equivalents (e.g., `vonage_call_id` to `provider_call_id`, `vonage_number` to `provider_number`, `vonage_message_id` to `provider_message_id`, `vonage_user_id` to `provider_user_id`, `vonage_user_name` to `provider_user_name`), excluding files that implement the Vonage-specific provider (e.g., `vonage-telephony-provider.ts`)
2. THE App source code SHALL rename all Vonage-specific class, variable, and parameter names to generic equivalents (e.g., `VonageNumber` to `ProviderNumber`, `VonageNumberDao` to `ProviderNumberDao`, `VonageNumberDto` to `ProviderNumberDto`, `vonageNumber` field to `providerNumber`, `vonageNumberLabel` to `providerNumberLabel`), excluding files that implement the Vonage-specific client integration (e.g., `VonageModule.kt`, `VonageClientManager.kt`)
3. THE Server source code SHALL rename `VonageUserManager` to `ProviderUserManager`, rename its associated interface `VonageUsersClient` to `ProviderUsersClient`, rename the database table reference from `vonage_users` to `provider_users`, and rename the exported types (`VonageUser` to `ProviderUser`, `VonageUserManagerConfig` to `ProviderUserManagerConfig`)
4. THE App database schema SHALL increment the database version number and include a destructive migration (using `fallbackToDestructiveMigration` or equivalent Room mechanism that drops and recreates all tables) to apply the renamed column and table names, requiring a fresh sync of data after upgrade
5. WHEN the naming refactor is complete, THE Server and App source code SHALL compile without errors, and all existing unit tests SHALL pass with updated references
