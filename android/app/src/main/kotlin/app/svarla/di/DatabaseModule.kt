package app.svarla.di

import android.content.Context
import androidx.room.Room
import app.svarla.data.local.SvarlaDatabase
import app.svarla.data.local.dao.ActiveNotificationDao
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.DeviceStateDao
import app.svarla.data.local.dao.MessageDao
import app.svarla.data.local.dao.ProviderNumberDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): SvarlaDatabase {
        return Room.databaseBuilder(
            context,
            SvarlaDatabase::class.java,
            SvarlaDatabase.DATABASE_NAME
        )
            .addMigrations(SvarlaDatabase.MIGRATION_1_2, SvarlaDatabase.MIGRATION_2_3, SvarlaDatabase.MIGRATION_3_4, SvarlaDatabase.MIGRATION_4_5, SvarlaDatabase.MIGRATION_5_6, SvarlaDatabase.MIGRATION_6_7, SvarlaDatabase.MIGRATION_7_8)
            .build()
    }

    @Provides
    fun provideProviderNumberDao(database: SvarlaDatabase): ProviderNumberDao {
        return database.providerNumberDao()
    }

    @Provides
    fun provideCallHistoryDao(database: SvarlaDatabase): CallHistoryDao {
        return database.callHistoryDao()
    }

    @Provides
    fun provideConversationDao(database: SvarlaDatabase): ConversationDao {
        return database.conversationDao()
    }

    @Provides
    fun provideMessageDao(database: SvarlaDatabase): MessageDao {
        return database.messageDao()
    }

    @Provides
    fun provideDeviceStateDao(database: SvarlaDatabase): DeviceStateDao {
        return database.deviceStateDao()
    }

    @Provides
    fun provideActiveNotificationDao(database: SvarlaDatabase): ActiveNotificationDao {
        return database.activeNotificationDao()
    }
}
