package app.svarla.domain.call

import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import android.graphics.drawable.Icon
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import app.svarla.R
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Registration status of the PhoneAccount with TelecomManager.
 */
enum class RegistrationStatus {
    /** Initial state before registration attempt */
    UNKNOWN,
    /** PhoneAccount successfully registered and verified */
    REGISTERED,
    /** Registration failed (OEM block, missing permission, etc.) */
    FAILED
}

/**
 * Singleton responsible for registering and verifying the app's PhoneAccount
 * with Android's TelecomManager using self-managed mode.
 *
 * Called from [SvarlaApplication.onCreate] at app startup. Persists registration
 * status to SharedPreferences so the app can quickly determine its path on subsequent
 * launches before re-verification completes.
 */
@Singleton
class PhoneAccountRegistrar @Inject constructor(
    @ApplicationContext private val context: Context,
    private val sharedPreferences: SharedPreferences
) {
    companion object {
        private const val TAG = "PhoneAccountRegistrar"
        private const val PREF_KEY_REGISTRATION_STATUS = "phone_account_registered"
        private const val PHONE_ACCOUNT_ID = "svarla_self_managed"
    }

    private val telecomManager: TelecomManager =
        context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager

    private val _registrationStatus = MutableStateFlow(RegistrationStatus.UNKNOWN)
    val registrationStatus: StateFlow<RegistrationStatus> = _registrationStatus.asStateFlow()

    val phoneAccountHandle: PhoneAccountHandle by lazy {
        PhoneAccountHandle(
            ComponentName(context.packageName, "app.svarla.domain.call.SvarlaConnectionService"),
            PHONE_ACCOUNT_ID
        )
    }

    /**
     * Registers the app's PhoneAccount with TelecomManager using CAPABILITY_SELF_MANAGED.
     * On success, persists status as REGISTERED. On failure (including SecurityException
     * from OEM-blocked devices), persists status as FAILED.
     */
    fun register() {
        try {
            val account = PhoneAccount.builder(phoneAccountHandle, context.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .setIcon(Icon.createWithResource(context, R.drawable.ic_notification))
                .build()

            telecomManager.registerPhoneAccount(account)

            // Verify registration succeeded.
            // On Android 14+, getPhoneAccount() may require READ_PHONE_NUMBERS permission.
            // If verification throws, assume registration succeeded (registerPhoneAccount
            // didn't throw) and optimistically set status to REGISTERED.
            val registered = try {
                telecomManager.getPhoneAccount(phoneAccountHandle) != null
            } catch (e: SecurityException) {
                Log.w(TAG, "Cannot verify registration (missing READ_PHONE_NUMBERS), assuming success", e)
                true // registerPhoneAccount succeeded, so assume it's registered
            }

            if (registered) {
                _registrationStatus.value = RegistrationStatus.REGISTERED
                sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, true).apply()
            } else {
                _registrationStatus.value = RegistrationStatus.FAILED
                sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, false).apply()
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "Registration failed due to SecurityException", e)
            _registrationStatus.value = RegistrationStatus.FAILED
            sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, false).apply()
        } catch (e: Exception) {
            Log.e(TAG, "Registration failed", e)
            _registrationStatus.value = RegistrationStatus.FAILED
            sharedPreferences.edit().putBoolean(PREF_KEY_REGISTRATION_STATUS, false).apply()
        }
    }

    /**
     * Verifies that the existing PhoneAccount registration is still valid.
     * If it's no longer valid, re-attempts registration.
     * On Android 14+, getPhoneAccount() may require READ_PHONE_NUMBERS — if that
     * permission isn't granted, re-register optimistically.
     */
    fun verifyRegistration() {
        try {
            val existing = telecomManager.getPhoneAccount(phoneAccountHandle)
            if (existing != null) {
                _registrationStatus.value = RegistrationStatus.REGISTERED
            } else {
                _registrationStatus.value = RegistrationStatus.FAILED
                register() // Re-attempt registration
            }
        } catch (e: SecurityException) {
            // getPhoneAccount requires READ_PHONE_NUMBERS on some Android versions.
            // Re-register optimistically since we can't verify.
            Log.w(TAG, "Verification failed (missing permission), re-registering", e)
            register()
        }
    }
}
