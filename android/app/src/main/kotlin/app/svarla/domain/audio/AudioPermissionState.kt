package app.svarla.domain.audio

/**
 * Represents the state of audio-related permissions needed for calls.
 */
sealed class AudioPermissionState {
    /** All required audio permissions are granted. */
    data object Granted : AudioPermissionState()

    /** One or more required permissions were denied. */
    data class Denied(val missingPermissions: List<String>) : AudioPermissionState()
}
