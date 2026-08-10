package app.svarla.di

import android.content.Context
import app.svarla.domain.layout.FormFactorManager
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object LayoutModule {

    @Provides
    @Singleton
    fun provideFormFactorManager(
        @ApplicationContext context: Context
    ): FormFactorManager {
        return FormFactorManager(context)
    }
}
