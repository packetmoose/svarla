package app.svarla.domain.version

import android.util.Log
import app.svarla.BuildConfig
import app.svarla.data.remote.AuthManager
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.HttpStatusCode
import kotlinx.serialization.Serializable
import javax.inject.Inject
import javax.inject.Singleton

@Serializable
data class VersionResponse(val version: String)

/**
 * Result of comparing the app version against the server version.
 */
sealed class VersionCheckResult {
    /** App and server are on the same version. */
    data object UpToDate : VersionCheckResult()

    /** Server has a newer version — user should update the app. */
    data class UpdateAvailable(val serverVersion: String) : VersionCheckResult()

    /** App is newer than the server — likely incompatible. */
    data class AppNewerThanServer(val serverVersion: String) : VersionCheckResult()

    /** Version check failed (network error, server unreachable, etc.). */
    data class Error(val message: String) : VersionCheckResult()
}

/**
 * Service that checks the server's version against the locally installed app version.
 *
 * This does NOT require authentication — the /api/version endpoint is public.
 */
@Singleton
class VersionCheckService @Inject constructor(
    private val httpClient: HttpClient,
    private val authManager: AuthManager
) {

    companion object {
        private const val TAG = "VersionCheck"
    }

    /**
     * Checks the server version and compares it with the installed app version.
     *
     * Returns a [VersionCheckResult] indicating whether the app is up to date,
     * needs an update, or is newer than the server.
     */
    suspend fun check(): VersionCheckResult {
        val serverUrl = authManager.getServerUrl()
        if (serverUrl == null) {
            Log.w(TAG, "Version check skipped: no server URL configured")
            return VersionCheckResult.Error("No server configured")
        }

        val url = "${serverUrl}/api/version"
        Log.d(TAG, "Checking server version at: $url")
        Log.d(TAG, "App version (local): ${BuildConfig.VERSION_NAME}")

        return try {
            val response = httpClient.get(url)
            Log.d(TAG, "Server responded with status: ${response.status.value}")

            if (response.status != HttpStatusCode.OK) {
                Log.w(TAG, "Version check failed: server returned ${response.status.value}")
                return VersionCheckResult.Error("Server returned ${response.status.value}")
            }

            val versionResponse: VersionResponse = response.body()
            val serverVersion = versionResponse.version
            val appVersion = BuildConfig.VERSION_NAME

            Log.d(TAG, "Server version: $serverVersion, App version: $appVersion")

            val result = when {
                appVersion == serverVersion -> VersionCheckResult.UpToDate
                isNewer(serverVersion, appVersion) -> VersionCheckResult.UpdateAvailable(serverVersion)
                else -> VersionCheckResult.AppNewerThanServer(serverVersion)
            }

            Log.i(TAG, "Version check result: ${result::class.simpleName}" +
                    if (result is VersionCheckResult.UpdateAvailable) " (server: ${result.serverVersion})"
                    else if (result is VersionCheckResult.AppNewerThanServer) " (server: ${result.serverVersion})"
                    else "")

            result
        } catch (e: Exception) {
            Log.e(TAG, "Version check failed with exception: ${e::class.simpleName} - ${e.message}", e)
            VersionCheckResult.Error(e.message ?: "Version check failed")
        }
    }

    /**
     * Compares two semantic version strings (e.g. "1.2.3").
     * Returns true if [a] is newer than [b].
     */
    private fun isNewer(a: String, b: String): Boolean {
        val partsA = a.split(".").mapNotNull { it.toIntOrNull() }
        val partsB = b.split(".").mapNotNull { it.toIntOrNull() }

        for (i in 0 until maxOf(partsA.size, partsB.size)) {
            val partA = partsA.getOrElse(i) { 0 }
            val partB = partsB.getOrElse(i) { 0 }
            if (partA > partB) return true
            if (partA < partB) return false
        }
        return false
    }
}
