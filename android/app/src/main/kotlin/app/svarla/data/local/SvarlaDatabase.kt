package app.svarla.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.DeviceStateDao
import app.svarla.data.local.dao.MessageDao
import app.svarla.data.local.dao.ProviderNumberDao
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
        DeviceState::class
    ],
    version = 6,
    exportSchema = false
)
abstract class SvarlaDatabase : RoomDatabase() {

    abstract fun providerNumberDao(): ProviderNumberDao

    abstract fun callHistoryDao(): CallHistoryDao

    abstract fun conversationDao(): ConversationDao

    abstract fun messageDao(): MessageDao

    abstract fun deviceStateDao(): DeviceStateDao

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
    }
}
