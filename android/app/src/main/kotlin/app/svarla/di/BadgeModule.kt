package app.svarla.di

import android.content.Context
import app.svarla.data.remote.api.ReadStateApi
import app.svarla.data.remote.sync.SyncManager
import app.svarla.domain.badge.BadgeManager
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object BadgeModule {

    @Provides
    @Singleton
    fun provideBadgeManager(
        context: Context,
        readStateApi: ReadStateApi,
        syncManager: SyncManager,
        json: Json
    ): BadgeManager {
        return BadgeManager(context, readStateApi, syncManager, json)
    }
}
