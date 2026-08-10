package app.svarla.di

import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.api.ApiClient
import app.svarla.data.remote.api.CallsApi
import app.svarla.data.remote.api.CallsApiImpl
import app.svarla.data.remote.api.DevicesApi
import app.svarla.data.remote.api.DevicesApiImpl
import app.svarla.data.remote.api.NotificationsApi
import app.svarla.data.remote.api.NotificationsApiImpl
import app.svarla.data.remote.api.NumbersApi
import app.svarla.data.remote.api.NumbersApiImpl
import app.svarla.data.remote.api.ReadStateApi
import app.svarla.data.remote.api.ReadStateApiImpl
import app.svarla.data.remote.api.SmsApi
import app.svarla.data.remote.api.SmsApiImpl
import app.svarla.data.remote.api.SyncApi
import app.svarla.data.remote.api.SyncApiImpl
import app.svarla.data.remote.sync.SyncManager
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideJson(): Json {
        return Json {
            ignoreUnknownKeys = true
            isLenient = true
            encodeDefaults = true
        }
    }

    @Provides
    @Singleton
    fun provideOkHttpClient(): OkHttpClient {
        return OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    @Provides
    @Singleton
    fun provideKtorClient(json: Json): HttpClient {
        return HttpClient(OkHttp) {
            install(ContentNegotiation) {
                json(json)
            }
            install(Logging) {
                level = LogLevel.BODY
            }
        }
    }

    @Provides
    @Singleton
    fun provideApiClient(httpClient: HttpClient, authManager: AuthManager): ApiClient {
        return ApiClient(httpClient, authManager)
    }

    @Provides
    @Singleton
    fun provideDevicesApi(apiClient: ApiClient): DevicesApi {
        return DevicesApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideNumbersApi(apiClient: ApiClient): NumbersApi {
        return NumbersApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideSmsApi(apiClient: ApiClient): SmsApi {
        return SmsApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideCallsApi(apiClient: ApiClient): CallsApi {
        return CallsApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideSyncApi(apiClient: ApiClient): SyncApi {
        return SyncApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideReadStateApi(apiClient: ApiClient): ReadStateApi {
        return ReadStateApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideNotificationsApi(apiClient: ApiClient): NotificationsApi {
        return NotificationsApiImpl(apiClient)
    }

    @Provides
    @Singleton
    fun provideSyncManager(
        okHttpClient: OkHttpClient,
        authManager: AuthManager,
        syncApi: SyncApi,
        json: Json,
        networkMonitor: app.svarla.domain.call.NetworkMonitor
    ): SyncManager {
        return SyncManager(okHttpClient, authManager, syncApi, json, networkMonitor)
    }
}
