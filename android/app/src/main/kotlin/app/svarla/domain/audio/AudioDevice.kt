package app.svarla.domain.audio

/**
 * Represents the available audio output devices for call routing.
 * The enum ordinal reflects the priority order for automatic routing:
 * WIRED_HEADPHONES (highest) > BLUETOOTH > EARPIECE > SPEAKER (lowest, manual toggle only).
 */
enum class AudioDevice(val priority: Int) {
    WIRED_HEADPHONES(priority = 3),
    BLUETOOTH(priority = 2),
    EARPIECE(priority = 1),
    SPEAKER(priority = 0);

    companion object {
        /**
         * Given a set of available devices, returns the highest-priority device.
         * Speaker is excluded from automatic selection — it's only activated via manual toggle.
         */
        fun highestPriority(available: Set<AudioDevice>): AudioDevice {
            val autoRoutable = available - SPEAKER
            return autoRoutable.maxByOrNull { it.priority } ?: EARPIECE
        }
    }
}
