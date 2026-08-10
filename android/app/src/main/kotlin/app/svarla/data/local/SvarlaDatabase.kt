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
    version = 5,
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
    }
}
