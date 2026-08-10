package app.svarla.di

import android.content.Context
import android.content.SharedPreferences
import app.svarla.domain.call.CallServiceController
import app.svarla.domain.call.CallServiceControllerImpl
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    @Provides
    @Singleton
    fun provideApplicationContext(@ApplicationContext context: Context): Context {
        return context
    }

    @Provides
    @Singleton
    fun provideSharedPreferences(@ApplicationContext context: Context): SharedPreferences {
        return context.getSharedPreferences("svarla_prefs", Context.MODE_PRIVATE)
    }
}

/**
 * Binds interface types to their implementations for Hilt dependency injection.
 *
 * - [CallServiceController] → [CallServiceControllerImpl] (which injects [PhoneAccountRegistrar]
 *   via its @Inject constructor)
 * - [PhoneAccountRegistrar] is provided automatically by Hilt through constructor injection
 *   (@Singleton @Inject constructor)
 *
 * This ensures SvarlaConnectionService (@AndroidEntryPoint) can inject:
 * - VoiceCallManager (constructor-injectable @Singleton)
 * - CallServiceController (bound here to CallServiceControllerImpl)
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AppBindingsModule {

    @Binds
    @Singleton
    abstract fun bindCallServiceController(
        impl: CallServiceControllerImpl
    ): CallServiceController
}
