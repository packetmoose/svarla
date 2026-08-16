package app.svarla.domain.notifications

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Detects OEM-specific auto-start restrictions and provides intents to guide
 * the user to the correct settings page.
 *
 * Many manufacturers (Xiaomi, Huawei, Samsung, Oppo, Vivo, OnePlus, etc.)
 * restrict apps from receiving BOOT_COMPLETED and running in the background
 * unless the user explicitly whitelists them in a vendor-specific "auto-start"
 * or "startup manager" settings page.
 *
 * This helper:
 * 1. Detects if the device is from a restricted manufacturer
 * 2. Provides the correct intent to open the auto-start settings
 * 3. Tracks whether the user has been prompted (so we don't nag repeatedly)
 */
@Singleton
class AutoStartHelper @Inject constructor(
    @ApplicationContext private val context: Context,
    private val prefs: SharedPreferences
) {
    companion object {
        private const val KEY_AUTOSTART_PROMPTED = "autostart_prompt_shown"
        private const val KEY_AUTOSTART_DISMISSED = "autostart_prompt_dismissed"
    }

    /**
     * Known OEM auto-start manager intents, ordered by priority.
     * Each entry is a list of component names to try for that manufacturer.
     */
    private val oemAutoStartIntents: List<Intent> by lazy {
        val manufacturer = Build.MANUFACTURER.lowercase()
        val intents = mutableListOf<Intent>()

        when {
            manufacturer.contains("xiaomi") || manufacturer.contains("redmi") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.miui.securitycenter",
                        "com.miui.permcenter.autostart.AutoStartManagementActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.miui.securitycenter",
                        "com.miui.powercenter.PowerSettings"
                    )
                })
            }
            manufacturer.contains("huawei") || manufacturer.contains("honor") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.optimize.process.ProtectActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.huawei.systemmanager",
                        "com.huawei.systemmanager.appcontrol.activity.StartupAppControlActivity"
                    )
                })
            }
            manufacturer.contains("oppo") || manufacturer.contains("realme") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.coloros.safecenter",
                        "com.coloros.safecenter.startupapp.StartupAppListActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.coloros.safecenter",
                        "com.coloros.safecenter.permission.startup.StartupAppListActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.oppo.safe",
                        "com.oppo.safe.permission.startup.StartupAppListActivity"
                    )
                })
            }
            manufacturer.contains("vivo") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.vivo.permissionmanager",
                        "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.iqoo.secure",
                        "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager"
                    )
                })
            }
            manufacturer.contains("oneplus") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.oneplus.security",
                        "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity"
                    )
                })
            }
            manufacturer.contains("samsung") -> {
                // Samsung's "Sleeping apps" / "Never sleeping apps" in Device Care
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.samsung.android.lool",
                        "com.samsung.android.sm.battery.ui.BatteryActivity"
                    )
                })
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.samsung.android.sm",
                        "com.samsung.android.sm.battery.ui.BatteryActivity"
                    )
                })
            }
            manufacturer.contains("asus") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.asus.mobilemanager",
                        "com.asus.mobilemanager.autostart.AutoStartActivity"
                    )
                })
            }
            manufacturer.contains("letv") || manufacturer.contains("leeco") -> {
                intents.add(Intent().apply {
                    component = ComponentName(
                        "com.letv.android.letvsafe",
                        "com.letv.android.letvsafe.AutobootManageActivity"
                    )
                })
            }
        }

        intents
    }

    /**
     * Returns true if the device is from a manufacturer known to restrict
     * auto-start and background execution.
     */
    fun isRestrictedManufacturer(): Boolean {
        val manufacturer = Build.MANUFACTURER.lowercase()
        return manufacturer.contains("xiaomi") ||
            manufacturer.contains("redmi") ||
            manufacturer.contains("huawei") ||
            manufacturer.contains("honor") ||
            manufacturer.contains("oppo") ||
            manufacturer.contains("realme") ||
            manufacturer.contains("vivo") ||
            manufacturer.contains("oneplus") ||
            manufacturer.contains("samsung") ||
            manufacturer.contains("asus") ||
            manufacturer.contains("letv") ||
            manufacturer.contains("leeco")
    }

    /**
     * Returns true if the auto-start prompt should be shown to the user.
     * Conditions:
     * - Device is from a restricted manufacturer
     * - User hasn't permanently dismissed the prompt
     */
    fun shouldShowAutoStartPrompt(): Boolean {
        if (!isRestrictedManufacturer()) return false
        if (prefs.getBoolean(KEY_AUTOSTART_DISMISSED, false)) return false
        return true
    }

    /**
     * Mark that the prompt has been shown to the user.
     */
    fun markPromptShown() {
        prefs.edit().putBoolean(KEY_AUTOSTART_PROMPTED, true).apply()
    }

    /**
     * Mark that the user dismissed the prompt and doesn't want to see it again.
     */
    fun dismissPromptPermanently() {
        prefs.edit().putBoolean(KEY_AUTOSTART_DISMISSED, true).apply()
    }

    /**
     * Returns an intent to open the manufacturer's auto-start settings page.
     * Tries each known intent for the manufacturer and returns the first one
     * that resolves to an activity. Returns null if no valid intent is found
     * (e.g., manufacturer changed their settings app in a newer OS version).
     */
    fun getAutoStartSettingsIntent(): Intent? {
        val pm = context.packageManager
        for (intent in oemAutoStartIntents) {
            if (intent.resolveActivity(pm) != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                return intent
            }
        }
        return null
    }

    /**
     * Returns the manufacturer display name for use in UI text.
     */
    fun getManufacturerDisplayName(): String {
        return Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
    }
}
