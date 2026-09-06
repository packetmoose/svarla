# Design: Conversation identity by (provider number, recipient)

## Problem

A conversation thread's identity is inconsistent across the stack. The Android
client already models a thread as the pair **(providerNumber, phoneNumber)** —
own number + other party — but the **server** still identifies a conversation by
the recipient `phone_number` alone.

Concrete symptom: after a fresh reinstall + login, one of two conversations with
the same recipient but different provider numbers was missing from the list. It
only reappeared after sending an SMS. Root cause: the server's `conversations`
table has `phone_number` as its sole primary key, so two threads with the same
recipient collapse into a single row. The list is read straight from that table,
so only one thread ever shows; the displayed provider number is back-filled from
the most recent message, which is why sending an SMS made the "missing" thread
surface (it was really the same row showing the other provider number).

## Current state (verified)

### Server — recipient-only (the lagging side)
- `migrations/001_initial_schema.ts`: `conversations` PK is `phone_number`; no
  `provider_number` column. `messages` carries a nullable `provider_number` FK
  to `numbers.number`, and `messages.conversation_number` is an FK to
  `conversations.phone_number`.
- `src/services/conversation-service.ts`:
  - `upsertConversation(phoneNumber)`, `updateConversationMetadata(phoneNumber, ...)`,
    `removeConversation(phoneNumber)` all key by recipient only.
  - `getConversations()` selects from the `conversations` table (one row per
    recipient) and back-fills `provider_number` via
    `getConversationProviderNumbers()` (most recent message's provider number).
  - `getMessages(phoneNumber, limit, providerNumber?)` **already** scopes messages
    by provider number when supplied — the read path is half-migrated.
- `src/routes/sms-routes.ts`:
  - `GET /api/conversations` returns one entry per recipient.
  - `GET /api/conversations/:number?from=<providerNumber>` already accepts the
    provider filter for messages.
  - `DELETE /api/conversations/:number` is recipient-only (no provider).
- `src/server.ts` `new_message` broadcast currently emits only
  `{ conversationNumber, messageId, direction }` — **no `providerNumber`**.
- `src/services/read-state-service.ts`: read state is keyed by
  `read_state.item_key = phoneNumber` (recipient only), and
  `getUnreadMessagesCount()` iterates conversations by `phone_number`.
- `POST /api/read-state/messages/:number` is recipient-only.

### Android — already ~80% on the pair model
- `Conversation` Room entity already has composite PK
  `["providerNumber", "phoneNumber"]` (`data/local/entity/Conversation.kt`),
  with `providerNumber = ""` as the sentinel for unknown/legacy.
- `ConversationDao` has provider-aware queries (`getByProviderAndPhone`,
  `markAsRead(provider, number)`, `deleteByProviderAndPhone`) plus residual
  phone-only ones (`getByNumber`, `markAsReadByPhone`).
- `MessageDao.getUnreadCountsPerConversation()` joins on both recipient and
  `COALESCE(providerNumber,'')` — correctly keyed by the pair.
- Nav route already carries both args:
  `conversation_detail/{providerNumber}/{phoneNumber}`. List `LazyColumn` keys on
  `"${providerNumber}:${phoneNumber}"`. Detail VM sends from the thread's
  `providerNumber`.
- **Gap / risk**: `SvarlaDatabase` is at version 7 with migrations only up to
  `MIGRATION_6_7`. There is **no migration** that moves the on-disk
  `conversations` table to the composite PK, and no `fallbackToDestructiveMigration`.
  An existing install will crash on open. This must be fixed regardless.
- Remaining phone-only paths: `handleNewMessageEvent` falls back to
  `getLastProviderNumberForConversation` when an event omits `providerNumber`
  (can mis-route to the wrong same-recipient thread); notification dismissal is
  keyed by phone only; `removeConversation` server call sends no provider.

## Goal

Make a conversation's identity the pair **(provider_number, phone_number)**
end to end, so two threads with the same recipient but different provider numbers
are always distinct — in the list, in reads, in real time, and on removal.

`provider_number` uses empty string `""` as the sentinel for "unknown/legacy"
to match the client's existing convention (avoids NULL-in-PK issues).

## Server changes

### 1. Migration `014_conversation_provider_identity.ts`
This is the highest-risk step (schema + FK + backfill). Plan:

1. Add `provider_number varchar(20)` to `conversations`, nullable initially.
2. Backfill each conversation's `provider_number` from its messages: for each
   existing `conversations` row, pick the provider number of the most recent
   message for that recipient (mirrors today's display logic). Where no message
   has a provider number, set `''`.
   - Where a recipient legitimately has messages under **multiple** provider
     numbers, insert the additional `conversations` rows (one per distinct
     provider number) so no thread is lost. Derive their
     `last_message_preview`/`last_message_timestamp`/`removed` from that thread's
     messages.
3. Set `provider_number` NOT NULL DEFAULT `''` after backfill.
4. Replace the primary key: drop PK on `phone_number`, add composite PK
   `(provider_number, phone_number)`.
5. Fix the `messages.conversation_number` FK. Options:
   - **Preferred**: drop the single-column FK to `conversations.phone_number`.
     Enforce integrity in the service layer instead (the app already upserts the
     conversation before inserting a message). A composite FK would require
     `messages` to carry a non-null provider number, which it does not guarantee.
   - Document the dropped FK in the migration.
6. `down()` reverses: restore single-column PK (collapsing duplicates is lossy;
   `down` will keep the most recent row per recipient and is documented as such).

Migrations run via `npm run migrate` (`src/migrate.ts`). This migration must be
tested against a copy of real data because of the backfill + FK change.

### 2. `ConversationService` (`src/services/conversation-service.ts`)
- `upsertConversation(providerNumber, phoneNumber)` — look up and insert by the
  pair; un-remove by the pair.
- `updateConversationMetadata(providerNumber, phoneNumber, ...)` — filter by pair.
- `sendMessage`: already knows `from` (provider number) — pass it through to the
  upsert/metadata calls.
- `receiveMessage`: already knows `to` (provider number) — pass it through.
- `getConversations()`: select the pair; return `provider_number` directly from
  the row instead of back-filling from messages. `getConversationProviderNumbers`
  is used only inside the migration backfill and can be removed from the request
  path (no runtime fallback needed — see coordinated release below).
- `removeConversation(providerNumber, phoneNumber)` — filter by pair.

### 3. Read state (`src/services/read-state-service.ts`)
- Key thread read state by the pair. Store `item_key` as a composite string
  (e.g. `"<providerNumber>|<phoneNumber>"`) so two threads track reads
  independently. Backfill existing `item_key` values in migration `014` (map the
  old recipient-only key to the pair using the same newest-message provider
  lookup as the conversations backfill) so existing read markers survive.
- `markThreadAsRead(providerNumber, phoneNumber, ...)`.
- `getUnreadMessagesCount()` iterate by pair and match messages on
  `provider_number` too.

### 4. Routes
Because the app ships in the same release, these params are **required** (no
optional-with-fallback). Missing `from` is a 400.
- `DELETE /api/conversations/:number?from=<providerNumber>` → pass to
  `removeConversation(providerNumber, phoneNumber)`.
- `POST /api/read-state/messages/:number?from=<providerNumber>` → pass to
  `markThreadAsRead(providerNumber, phoneNumber)`.
- `GET /api/conversations/:number?from=<providerNumber>` (messages) → `from`
  required.
- `GET /api/conversations` responses include `providerNumber` sourced directly
  from the row (not the back-fill).

### 5. `new_message` broadcast (`src/server.ts`)
Always include `providerNumber` in the event payload:
`{ conversationNumber, providerNumber, messageId, direction }`. The service event
already has the message with `provider_number`; thread it through the broadcast.
Since the app in this release relies on the field, the client's phone-only
provider guess is removed entirely (not kept as a fallback).

## Android changes

Most of the model is in place. Remaining work:

### 1. Room migration `MIGRATION_7_8` (blocking, ship-before-anything)
`conversations` on disk still has the old single-column PK. Add a migration that
rebuilds the table with composite PK `(providerNumber, phoneNumber)`, following
the `MIGRATION_5_6` pattern (create new / copy / drop / rename), backfilling
`providerNumber` from the newest message per recipient (or `''`). Bump DB version
to 8 and register it in `DatabaseModule`.

### 2. Remove phone-only fallbacks
- `ConversationRepository.handleNewMessageEvent`: read `providerNumber` from the
  now-always-present event field; drop the `getLastProviderNumberForConversation`
  guess. Keep it only as a last resort for legacy events.
- `ConversationDetailViewModel.observeReconnections`: match `new_message` on both
  `conversationNumber` and `providerNumber`.
- Retire/limit the phone-only DAO methods (`getByNumber`, `markAsReadByPhone`,
  single-arg `observeMessages`) once callers pass the pair.

### 3. Provider-aware removal + read state calls
- `SmsApi.removeConversation(providerNumber, phoneNumber)` → send `?from=`.
- `markThreadAsRead` API call → send `?from=`.

### 4. Notification dismissal
- Make `dismissConversationNotifications` and `ActiveNotification` matching
  provider-aware so opening one thread doesn't dismiss the other same-recipient
  thread's notification. (Lower priority; can follow.)

## Rollout / ordering

Server and app ship together in one coordinated release, so there is no
cross-version compatibility to maintain and no optional-with-fallback params.
The `from` query param is required and `new_message` always carries
`providerNumber`.

Ordering within the release:

1. Server DB migration `014` runs on deploy (`npm run migrate`), converting
   `conversations` to the composite key and backfilling / splitting rows.
2. Server code (service, read-state, routes, `new_message` payload) deploys with
   the migrated schema.
3. App ships with Room `MIGRATION_7_8` (composite-PK rebuild + backfill) and the
   provider-aware calls, relying on the server's required params and the
   `providerNumber` field.

The only hard sequencing constraint is that the DB migration must complete
before the new server code serves traffic (standard migrate-then-deploy). No
staged/independent rollout is needed.

## Risks

- **Backfill correctness**: recipients with genuinely multiple provider numbers
  must be split into multiple rows, not merged. Test against real data. This is
  the highest-risk item since it runs once, in-place, during the release.
- **Migrate-before-deploy**: the new server code assumes the composite schema and
  required params, so the DB migration must finish before the new code serves
  traffic. A failed/partial migration would break conversation reads — take a DB
  backup before running `014`.
- **Dropped `messages.conversation_number` FK**: integrity moves to the service
  layer. Acceptable because the upsert already precedes message insert, but note
  it explicitly.
- **Android upgrade crash**: the missing conversations migration is a
  pre-existing latent bug; shipping `MIGRATION_7_8` is mandatory this release.
- **Read-state `item_key` format change**: needs a backfill so existing read
  markers aren't lost (otherwise old threads show unread once after upgrade).

## Out of scope

- Contact-name resolution stays keyed by recipient (same person regardless of
  provider number) — intentional.
- Merging/splitting existing mis-attributed local message history beyond the
  reconciliation the client already performs in `syncMessages`.

## Verification

- Server: unit tests for `ConversationService` upsert/list/remove by pair;
  `ReadStateService` per-pair counts; a migration test that backfills a fixture
  with a same-recipient/two-provider case and asserts two rows result. Run
  `npm run test` and `npm run build`.
- Android: Room migration test (v7 → v8) with the same-recipient/two-provider
  fixture; verify both threads appear and reads are independent.
- Manual: reproduce the original bug — two threads, same recipient, different
  provider numbers; confirm both show on a fresh install/login without needing
  to send a message.
