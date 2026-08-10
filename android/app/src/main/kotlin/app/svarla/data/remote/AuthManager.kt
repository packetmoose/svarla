package app.svarla.data.remote

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import app.svarla.data.local.dao.DeviceStateDao
import app.svarla.data.local.entity.DeviceState
import dagger.hilt.android.qualifiers.ApplicationContext
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Authentication result sealed class representing the possible outcomes of a login attempt.
 */
sealed class AuthResult {
    data class Success(val sessionToken: String) : AuthResult()
    data class Locked(val lockedUntilEpochMs: Long) : AuthResult()
    data class Error(val message: String) : AuthResult()
}

/**
 * Manages authentication state, login/logout operations, session token storage,
 * and device registration.
 *
 * Requirements covered:
 * - 9.1: Require authentication before granting access
 * - 9.2: Password requirements (enforced server-side)
 * - 9.3: Session duration (30 days default)
 * - 9.4: Lockout after 5 failed attempts (15 min)
 * - 9.5: Reset failed attempts on success
 * - 9.6: Encrypt stored credentials/tokens at rest
 * - 9.7: Logout invalidates session, removes from registry
 */
@Singleton
class AuthManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val httpClient: HttpClient,
    private val deviceStateDao: DeviceStateDao
) {
    companion object {
        private const val PREFS_FILE = "svarla_secure_prefs"
        private const val KEY_SESSION_TOKEN = "session_token"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PUSH_TOPIC_ID = "push_topic_id"
    }

    private val encryptedPrefs: SharedPreferences by lazy {
        val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
        EncryptedSharedPreferences.create(
            PREFS_FILE,
            masterKeyAlias,
            context,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    private val _isAuthenticated = MutableStateFlow(hasValidSession())
    val isAuthenticated: StateFlow<Boolean> = _isAuthenticated.asStateFlow()

    private val _lockoutEndTime = MutableStateFlow<Long?>(null)
    val lockoutEndTime: StateFlow<Long?> = _lockoutEndTime.asStateFlow()

    /**
     * Returns whether a valid session token exists in encrypted storage.
     */
    fun hasValidSession(): Boolean {
        return getSessionToken() != null
    }

    /**
     * Returns the stored session token, or null if not authenticated.
     */
    fun getSessionToken(): String? {
        return encryptedPrefs.getString(KEY_SESSION_TOKEN, null)
    }

    /**
     * Returns the stored server URL.
     */
    fun getServerUrl(): String? {
        return encryptedPrefs.getString(KEY_SERVER_URL, null)
    }

    /**
     * Returns the stored device ID (assigned by the server during login).
     */
    fun getDeviceId(): String? {
        return encryptedPrefs.getString(KEY_DEVICE_ID, null)
    }

    /**
     * Returns the push topic ID assigned by the server (used as instance ID for UnifiedPush).
     */
    fun getPushTopicId(): String? {
        return encryptedPrefs.getString(KEY_PUSH_TOPIC_ID, null)
    }

    /**
     * Performs login against the backend API.
     *
     * On success: stores session token, updates DeviceState in Room DB.
     * On 423 (locked): returns lockout information with countdown.
     * On other errors: returns error message.
     */
    suspend fun login(serverUrl: String, password: String): AuthResult {
        val deviceName = "${Build.MANUFACTURER} ${Build.MODEL}"
        val pushTopicId = "svarla-${context.packageName}"

        val loginRequest = LoginRequest(
            password = password,
            deviceName = deviceName,
            pushTopicId = pushTopicId
        )

        return try {
            val url = "${serverUrl.trimEnd('/')}/api/auth/login"
            val response: HttpResponse = httpClient.post(url) {
                contentType(ContentType.Application.Json)
                setBody(loginRequest)
            }

            when (response.status) {
                HttpStatusCode.OK -> {
                    val loginResponse: LoginResponse = response.body()
                    // Store session token and device ID encrypted
                    encryptedPrefs.edit()
                        .putString(KEY_SESSION_TOKEN, loginResponse.sessionToken)
                        .putString(KEY_SERVER_URL, serverUrl.trimEnd('/'))
                        .apply {
                            loginResponse.deviceId?.let { putString(KEY_DEVICE_ID, it) }
                            loginResponse.pushTopicId?.let { putString(KEY_PUSH_TOPIC_ID, it) }
                        }
                        .apply()

                    // Update device state in Room DB
                    deviceStateDao.insert(
                        DeviceState(
                            id = 1,
                            isLoggedIn = true,
                            sessionToken = loginResponse.sessionToken,
                            serverUrl = serverUrl.trimEnd('/')
                        )
                    )

                    _isAuthenticated.value = true
                    _lockoutEndTime.value = null
                    AuthResult.Success(loginResponse.sessionToken)
                }

                HttpStatusCode(423, "Locked") -> {
                    val errorResponse: LoginErrorResponse = response.body()
                    val lockedUntil = errorResponse.lockedUntil ?: (System.currentTimeMillis() + 15 * 60 * 1000)
                    _lockoutEndTime.value = lockedUntil
                    AuthResult.Locked(lockedUntil)
                }

                HttpStatusCode.Unauthorized -> {
                    val errorResponse: LoginErrorResponse = response.body()
                    AuthResult.Error(errorResponse.error ?: "Invalid password")
                }

                else -> {
                    AuthResult.Error("Login failed (${response.status.value})")
                }
            }
        } catch (e: Exception) {
            AuthResult.Error(e.message ?: "Connection failed")
        }
    }

    /**
     * Performs logout: calls API to invalidate session, clears local state.
     */
    suspend fun logout(): Boolean {
        val token = getSessionToken()
        val serverUrl = getServerUrl()

        // Attempt to notify server
        if (token != null && serverUrl != null) {
            try {
                httpClient.post("$serverUrl/api/auth/logout") {
                    header("Authorization", "Bearer $token")
                }
            } catch (_: Exception) {
                // Best-effort logout to server; clear local state regardless
            }
        }

        // Clear encrypted preferences
        encryptedPrefs.edit()
            .remove(KEY_SESSION_TOKEN)
            .remove(KEY_SERVER_URL)
            .remove(KEY_PUSH_TOPIC_ID)
            .apply()

        // Clear device state in Room DB
        deviceStateDao.insert(
            DeviceState(
                id = 1,
                isLoggedIn = false,
                sessionToken = null,
                serverUrl = null
            )
        )

        _isAuthenticated.value = false
        _lockoutEndTime.value = null
        return true
    }

    /**
     * Handles session expiry (401 from any API call).
     * Clears session and forces re-authentication.
     */
    suspend fun handleSessionExpiry() {
        encryptedPrefs.edit()
            .remove(KEY_SESSION_TOKEN)
            .apply()

        deviceStateDao.insert(
            DeviceState(
                id = 1,
                isLoggedIn = false,
                sessionToken = null,
                serverUrl = getServerUrl()
            )
        )

        _isAuthenticated.value = false
    }
}
