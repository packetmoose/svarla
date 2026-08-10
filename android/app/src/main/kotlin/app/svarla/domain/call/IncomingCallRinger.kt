package app.svarla.domain.call

import android.content.Context
import android.media.AudioAttributes
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Manages continuous ringtone playback and vibration for incoming calls.
 *
 * Uses Android's [Ringtone] API (rather than raw MediaPlayer) for reliable playback
 * even when the app process is cold-started from a terminated state. The Ringtone API
 * handles content provider resolution internally and works from services/receivers.
 *
 * Acquires a partial wake lock to keep the CPU active while ringing, ensuring
 * sound and vibration continue even when the screen is off (device sleeping).
 *
 * Plays the device's default ringtone in a loop and vibrates with a repeating
 * pattern until explicitly stopped (when the call is answered, declined, or times out).
 */
@Singleton
class IncomingCallRinger @Inject constructor(
    @ApplicationContext private val context: Context
) {
    companion object {
        private const val TAG = "IncomingCallRinger"

        // Vibration pattern: wait 0ms, vibrate 1000ms, pause 1000ms (repeating)
        private val VIBRATION_PATTERN = longArrayOf(0, 1000, 1000)

        // Max wake lock duration (safety timeout) — 60 seconds
        private const val WAKE_LOCK_TIMEOUT_MS = 60_000L
    }

    private var ringtone: Ringtone? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var isRinging = false
    private val handler = Handler(Looper.getMainLooper())
    private var loopRunnable: Runnable? = null

    /**
     * Start ringing and vibrating. Safe to call multiple times — subsequent
     * calls are no-ops if already ringing.
     *
     * Acquires a wake lock to keep the CPU alive and turns on the screen
     * so the user is alerted even when the device is sleeping.
     */
    fun start() {
        if (isRinging) return
        isRinging = true

        acquireWakeLock()
        startRingtone()
        startVibration()
        Log.d(TAG, "Incoming call ringer started")
    }

    /**
     * Stop ringing and vibrating. Safe to call even if not currently ringing.
     * Releases the wake lock.
     */
    fun stop() {
        if (!isRinging) return
        isRinging = false

        stopRingtone()
        stopVibration()
        releaseWakeLock()
        Log.d(TAG, "Incoming call ringer stopped")
    }

    private fun startRingtone() {
        try {
            val ringtoneUri = RingtoneManager.getActualDefaultRingtoneUri(
                context, RingtoneManager.TYPE_RINGTONE
            ) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

            val r = RingtoneManager.getRingtone(context, ringtoneUri)
            if (r == null) {
                Log.e(TAG, "Failed to get ringtone instance")
                return
            }

            val audioAttributes = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()

            r.audioAttributes = audioAttributes

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                r.isLooping = true
            }

            r.play()

            // Always use the loop fallback as a safety net. Some devices/OEMs
            // don't honor Ringtone.isLooping reliably, causing the tone to play
            // only once. The fallback polls and restarts playback if it stops.
            startLoopFallback(r)

            ringtone = r
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start ringtone", e)
            ringtone = null
        }
    }

    /**
     * For devices below API 28 where Ringtone.setLooping isn't available,
     * poll and restart playback when it stops.
     */
    private fun startLoopFallback(r: Ringtone) {
        val runnable = object : Runnable {
            override fun run() {
                if (!isRinging) return
                if (!r.isPlaying) {
                    r.play()
                }
                handler.postDelayed(this, 1000)
            }
        }
        loopRunnable = runnable
        handler.postDelayed(runnable, 1000)
    }

    private fun stopRingtone() {
        loopRunnable?.let { handler.removeCallbacks(it) }
        loopRunnable = null

        try {
            ringtone?.let {
                if (it.isPlaying) {
                    it.stop()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping ringtone", e)
        }
        ringtone = null
    }

    private fun startVibration() {
        try {
            vibrator = getVibrator()
            vibrator?.let { v ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    val effect = VibrationEffect.createWaveform(
                        VIBRATION_PATTERN,
                        0 // repeat from index 0
                    )
                    v.vibrate(effect)
                } else {
                    @Suppress("DEPRECATION")
                    v.vibrate(VIBRATION_PATTERN, 0)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start vibration", e)
        }
    }

    private fun stopVibration() {
        try {
            vibrator?.cancel()
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping vibration", e)
        }
        vibrator = null
    }

    private fun getVibrator(): Vibrator {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }

    /**
     * Acquires wake locks to:
     * 1. Keep the CPU running so ringtone and vibration continue while screen is off
     * 2. Turn on the screen so the user can see the incoming call notification/UI
     *
     * The wake locks have a safety timeout to auto-release if stop() is never called.
     */
    private fun acquireWakeLock() {
        try {
            val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager

            // CPU wake lock — keeps the processor running for ringtone + vibration
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "svarla:incoming_call_ringer"
            ).apply {
                acquire(WAKE_LOCK_TIMEOUT_MS)
            }

            // Screen wake lock — turns on the screen so the user sees the call
            // FULL_WAKE_LOCK is deprecated but ACQUIRE_CAUSES_WAKEUP only works
            // with screen-level wake locks. The fullScreenIntent on the notification
            // also helps, but this ensures the screen wakes even on OEMs that
            // don't honor fullScreenIntent reliably.
            @Suppress("DEPRECATION")
            val screenLock = powerManager.newWakeLock(
                PowerManager.FULL_WAKE_LOCK
                    or PowerManager.ACQUIRE_CAUSES_WAKEUP
                    or PowerManager.ON_AFTER_RELEASE,
                "svarla:incoming_call_screen"
            )
            screenLock.acquire(WAKE_LOCK_TIMEOUT_MS)
            // Release immediately — its only purpose is to turn on the screen
            screenLock.release()

            Log.d(TAG, "Wake locks acquired for incoming call")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire wake lock", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let {
                if (it.isHeld) {
                    it.release()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error releasing wake lock", e)
        }
        wakeLock = null
    }
}
