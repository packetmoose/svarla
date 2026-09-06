import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/**
 * Migration 014: Conversation identity by (provider_number, phone_number)
 *
 * Previously a conversation was identified by the recipient `phone_number` alone.
 * Two threads with the same recipient but different provider (own) numbers
 * collapsed into a single row, so one thread went missing from the list. This
 * migration makes a conversation's identity the pair (provider_number,
 * phone_number).
 *
 * Steps (up):
 *  1. Add conversations.provider_number (nullable, temporarily).
 *  2. Backfill: for each existing conversation, set provider_number from the
 *     newest message for that recipient (or '' when none).
 *  3. Split: for recipients whose messages span MULTIPLE provider numbers,
 *     insert the additional (provider_number, phone_number) conversation rows so
 *     no thread is lost. Metadata is derived from that thread's own messages.
 *  4. Set provider_number NOT NULL DEFAULT ''.
 *  5. Replace the primary key with the composite (provider_number, phone_number).
 *  6. Drop the messages.conversation_number FK. Integrity is now enforced in the
 *     service layer (the conversation is upserted before a message is inserted),
 *     and messages cannot guarantee a non-null provider number for a composite FK.
 *  7. Migrate read_state message thread keys from `<phone>` to the composite
 *     `<provider_number>|<phone>` form so existing read markers survive.
 *
 * The empty string '' is the sentinel for "unknown/legacy provider", matching
 * the Android client convention (avoids NULL in a primary key).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Add the column, nullable for now.
  await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS provider_number varchar(20)`.execute(db);

  // 2. Backfill provider_number on each existing conversation from the newest
  //    message for that recipient that carries a provider number.
  await sql`
    UPDATE conversations c
    SET provider_number = sub.provider_number
    FROM (
      SELECT DISTINCT ON (m.conversation_number)
        m.conversation_number,
        m.provider_number
      FROM messages m
      WHERE m.provider_number IS NOT NULL
      ORDER BY m.conversation_number, m.timestamp DESC
    ) sub
    WHERE c.phone_number = sub.conversation_number
      AND c.provider_number IS NULL
  `.execute(db);

  // Any conversation with no provider-bearing message gets the '' sentinel.
  await sql`UPDATE conversations SET provider_number = '' WHERE provider_number IS NULL`.execute(db);

  // 3. Enforce NOT NULL with '' default (required before the column can be part
  //    of the primary key).
  await sql`ALTER TABLE conversations ALTER COLUMN provider_number SET DEFAULT ''`.execute(db);
  await sql`ALTER TABLE conversations ALTER COLUMN provider_number SET NOT NULL`.execute(db);

  // 4. Drop the messages -> conversations FK before changing the PK it targets.
  await sql`ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_conversation_number_fkey`.execute(db);

  // 5. Replace the primary key with the composite (provider_number, phone_number)
  //    BEFORE the split insert below. The split adds extra rows sharing a
  //    phone_number, which would violate the old phone_number-only PK; the
  //    composite PK must be in place first.
  await sql`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey`.execute(db);
  await sql`ALTER TABLE conversations ADD PRIMARY KEY (provider_number, phone_number)`.execute(db);

  // 6. Split: create the missing conversation rows for recipients that have
  //    messages under a provider number OTHER than the one now stored on the
  //    existing row. One row per distinct (provider_number, phone_number) pair.
  //    Metadata (preview/timestamp) is taken from that thread's newest message;
  //    `removed` inherits from the original recipient row so a hidden thread
  //    stays hidden.
  await sql`
    INSERT INTO conversations (phone_number, provider_number, last_message_preview, last_message_timestamp, removed, created_at)
    SELECT
      t.conversation_number AS phone_number,
      t.provider_number,
      t.last_message_preview,
      t.last_message_timestamp,
      COALESCE(orig.removed, false) AS removed,
      COALESCE(orig.created_at, now()) AS created_at
    FROM (
      SELECT DISTINCT ON (m.conversation_number, m.provider_number)
        m.conversation_number,
        m.provider_number,
        substring(m.body from 1 for 50) AS last_message_preview,
        m.timestamp AS last_message_timestamp
      FROM messages m
      WHERE m.provider_number IS NOT NULL
      ORDER BY m.conversation_number, m.provider_number, m.timestamp DESC
    ) t
    JOIN conversations orig ON orig.phone_number = t.conversation_number
    WHERE NOT EXISTS (
      SELECT 1 FROM conversations existing
      WHERE existing.phone_number = t.conversation_number
        AND existing.provider_number = t.provider_number
    )
  `.execute(db);

  // 7. Migrate read_state message thread keys to the composite form.
  //    Old key: '<phone>'. New key: '<provider_number>|<phone>' using the same
  //    newest-message provider lookup. Threads with no provider message use ''.
  await sql`
    UPDATE read_state rs
    SET item_key = COALESCE(sub.provider_number, '') || '|' || rs.item_key
    FROM (
      SELECT DISTINCT ON (m.conversation_number)
        m.conversation_number,
        m.provider_number
      FROM messages m
      WHERE m.provider_number IS NOT NULL
      ORDER BY m.conversation_number, m.timestamp DESC
    ) sub
    WHERE rs.item_type = 'messages'
      AND rs.item_key = sub.conversation_number
      AND rs.item_key NOT LIKE '%|%'
  `.execute(db);

  // Any remaining message read_state keys had no provider message: prefix '|'.
  await sql`
    UPDATE read_state
    SET item_key = '|' || item_key
    WHERE item_type = 'messages'
      AND item_key NOT LIKE '%|%'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Revert read_state composite keys back to the recipient-only form.
  await sql`
    UPDATE read_state
    SET item_key = split_part(item_key, '|', 2)
    WHERE item_type = 'messages'
      AND item_key LIKE '%|%'
  `.execute(db);
  // De-duplicate any read_state rows that now collide on (item_type, item_key)
  // by keeping the most recent read_at.
  await sql`
    DELETE FROM read_state a
    USING read_state b
    WHERE a.item_type = 'messages'
      AND a.item_type = b.item_type
      AND a.item_key = b.item_key
      AND a.read_at < b.read_at
  `.execute(db);

  // Collapse conversations back to one row per recipient (keep newest activity).
  await sql`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey`.execute(db);
  await sql`
    DELETE FROM conversations a
    USING conversations b
    WHERE a.phone_number = b.phone_number
      AND a.provider_number <> b.provider_number
      AND (
        COALESCE(a.last_message_timestamp, to_timestamp(0)) < COALESCE(b.last_message_timestamp, to_timestamp(0))
        OR (
          COALESCE(a.last_message_timestamp, to_timestamp(0)) = COALESCE(b.last_message_timestamp, to_timestamp(0))
          AND a.provider_number < b.provider_number
        )
      )
  `.execute(db);

  await sql`ALTER TABLE conversations ADD PRIMARY KEY (phone_number)`.execute(db);
  await sql`ALTER TABLE conversations DROP COLUMN IF EXISTS provider_number`.execute(db);

  // Restore the messages -> conversations FK.
  await sql`
    ALTER TABLE messages
    ADD CONSTRAINT messages_conversation_number_fkey
    FOREIGN KEY (conversation_number) REFERENCES conversations(phone_number)
  `.execute(db);
}
