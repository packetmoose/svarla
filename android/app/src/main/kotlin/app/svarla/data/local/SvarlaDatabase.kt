package app.svarla.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import app.svarla.data.local.dao.ActiveNotificationDao
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.DeviceStateDao
import app.svarla.data.local.dao.MessageDao
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.ActiveNotification
import app.svarla.data.local.entity.CallHistoryEntry
import app.svarla.data.local.entity.Conversation
import app.svarla.data.local.entity.DeviceState
import app.svarla.data.local.entity.Message
import app.svarla.data.local.entity.ProviderNumber

@Database(
    entities = [
        ProviderNumber::class,
        CallHistoryEntry::class,
        Conversation::class,
        Message::class,
        DeviceState::class,
        ActiveNotification::class
    ],
    version = 8,
    exportSchema = false
)
abstract class SvarlaDatabase : RoomDatabase() {

    abstract fun providerNumberDao(): ProviderNumberDao

    abstract fun callHistoryDao(): CallHistoryDao

    abstract fun conversationDao(): ConversationDao

    abstract fun messageDao(): MessageDao

    abstract fun deviceStateDao(): DeviceStateDao

    abstract fun activeNotificationDao(): ActiveNotificationDao

    companion object {
        const val DATABASE_NAME = "svarla_db"

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE provider_numbers ADD COLUMN blockInboundCalls INTEGER NOT NULL DEFAULT 0")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE provider_numbers ADD COLUMN isDefault INTEGER NOT NULL DEFAULT 0")
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE provider_numbers ADD COLUMN color TEXT NOT NULL DEFAULT '#6750A4'")
            }
        }

        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE call_history ADD COLUMN realCallerNumber TEXT DEFAULT NULL")
            }
        }

        // Make provider_numbers.color nullable. SQLite cannot drop NOT NULL in
        // place, so recreate the table. The color is refreshed from the server
        // on the next sync, so no data is lost by relaxing the constraint.
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE provider_numbers_new (
                        number TEXT NOT NULL PRIMARY KEY,
                        label TEXT,
                        color TEXT,
                        isActive INTEGER NOT NULL DEFAULT 1,
                        lastUsedAt INTEGER,
                        blockInboundCalls INTEGER NOT NULL DEFAULT 0,
                        isDefault INTEGER NOT NULL DEFAULT 0
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    """
                    INSERT INTO provider_numbers_new (number, label, color, isActive, lastUsedAt, blockInboundCalls, isDefault)
                    SELECT number, label, color, isActive, lastUsedAt, blockInboundCalls, isDefault FROM provider_numbers
                    """.trimIndent()
                )
                db.execSQL("DROP TABLE provider_numbers")
                db.execSQL("ALTER TABLE provider_numbers_new RENAME TO provider_numbers")
            }
        }

        // Add active_notifications: persists displayed-notification tracking so
        // dismissal and de-duplication survive app process death.
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS active_notifications (
                        serverId TEXT NOT NULL PRIMARY KEY,
                        androidId INTEGER NOT NULL,
                        type TEXT NOT NULL,
                        normalizedNumber TEXT,
                        createdAt INTEGER NOT NULL
                    )
                    """.trimIndent()
                )
            }
        }

        // Make a conversation's identity the (providerNumber, phoneNumber) pair.
        // Previously the conversations table was keyed by phoneNumber alone, so
        // two threads with the same recipient but different provider (own)
        // numbers collapsed into one row and one thread went missing. Rebuild the
        // table with the composite primary key and backfill providerNumber from
        // the newest message per recipient (SQLite cannot change a PK in place).
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // Column definitions must match what Room generates for the
                // Conversation entity exactly (no SQL DEFAULT, since the entity
                // declares none) or Room's open-time schema validation fails.
                // The backfill below always supplies providerNumber, so no
                // default is needed.
                db.execSQL(
                    """
                    CREATE TABLE conversations_new (
                        providerNumber TEXT NOT NULL,
                        phoneNumber TEXT NOT NULL,
                        lastMessagePreview TEXT,
                        lastMessageTimestamp INTEGER,
                        lastReceivedAt INTEGER,
                        lastReadAt INTEGER,
                        createdAt INTEGER NOT NULL,
                        PRIMARY KEY (providerNumber, phoneNumber)
                    )
                    """.trimIndent()
                )

                // Copy existing rows, backfilling providerNumber from the newest
                // message for that recipient (empty string when none exists).
                db.execSQL(
                    """
                    INSERT OR IGNORE INTO conversations_new
                        (providerNumber, phoneNumber, lastMessagePreview, lastMessageTimestamp, lastReceivedAt, lastReadAt, createdAt)
                    SELECT
                        COALESCE((
                            SELECT m.providerNumber FROM messages m
                            WHERE m.conversationNumber = c.phoneNumber
                              AND m.providerNumber IS NOT NULL
                            ORDER BY m.timestamp DESC
                            LIMIT 1
                        ), '') AS providerNumber,
                        c.phoneNumber,
                        c.lastMessagePreview,
                        c.lastMessageTimestamp,
                        c.lastReceivedAt,
                        c.lastReadAt,
                        c.createdAt
                    FROM conversations c
                    """.trimIndent()
                )

                // Create the additional rows for recipients that have messages
                // under other provider numbers, so no thread is lost.
                db.execSQL(
                    """
                    INSERT OR IGNORE INTO conversations_new
                        (providerNumber, phoneNumber, lastMessagePreview, lastMessageTimestamp, lastReceivedAt, lastReadAt, createdAt)
                    SELECT
                        m.providerNumber,
                        m.conversationNumber AS phoneNumber,
                        (SELECT body FROM messages mm
                         WHERE mm.conversationNumber = m.conversationNumber
                           AND mm.providerNumber = m.providerNumber
                         ORDER BY mm.timestamp DESC LIMIT 1) AS lastMessagePreview,
                        (SELECT timestamp FROM messages mm
                         WHERE mm.conversationNumber = m.conversationNumber
                           AND mm.providerNumber = m.providerNumber
                         ORDER BY mm.timestamp DESC LIMIT 1) AS lastMessageTimestamp,
                        NULL AS lastReceivedAt,
                        NULL AS lastReadAt,
                        (SELECT createdAt FROM conversations c WHERE c.phoneNumber = m.conversationNumber) AS createdAt
                    FROM messages m
                    WHERE m.providerNumber IS NOT NULL
                      AND EXISTS (SELECT 1 FROM conversations c WHERE c.phoneNumber = m.conversationNumber)
                    GROUP BY m.conversationNumber, m.providerNumber
                    """.trimIndent()
                )

                db.execSQL("DROP TABLE conversations")
                db.execSQL("ALTER TABLE conversations_new RENAME TO conversations")
            }
        }
    }
}
