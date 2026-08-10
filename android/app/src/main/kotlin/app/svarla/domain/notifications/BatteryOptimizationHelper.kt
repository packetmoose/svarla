package app.svarla.domain.notifications

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Helps check and request battery optimization exemption.
 *
 * When the app uses a persistent WebSocket for notification delivery (no UnifiedPush),
 * battery optimization must be disabled for the app so the system doesn't kill the
 * foreground service or restrict network access in doze mode.
 */
@Singleton
class BatteryOptimizationHelper @Inject constructor(
    @ApplicationContext private val context: Context
) {
    /**
     * Returns true if the app is already exempt from battery optimization.
     */
    fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Creates an intent that directly requests the user to disable battery optimization
     * for this app. The system shows a confirmation dialog.
     */
    fun createRequestIgnoreBatteryOptimizationsIntent(): Intent {
        return Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
            data = Uri.parse("package:${context.packageName}")
        }
    }

    /**
     * Creates an intent to open the battery optimization settings page for all apps.
     * Fallback if the direct request is not available.
     */
    fun createBatterySettingsIntent(): Intent {
        return Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
    }
}
