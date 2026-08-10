package app.svarla.di

import app.svarla.domain.call.WebRtcAudioClient
import app.svarla.domain.call.WebRtcAudioClientImpl
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Hilt DI module for voice/audio client bindings.
 *
 * Binds the provider-agnostic WebRtcAudioClient interface to its implementation.
 * No provider-specific bindings exist in this module —
 * all voice audio is handled through the generic WebRTC client connecting to
 * the MediaBridge.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class VoiceModule {

    @Binds
    @Singleton
    abstract fun bindWebRtcAudioClient(
        impl: WebRtcAudioClientImpl
    ): WebRtcAudioClient
}
