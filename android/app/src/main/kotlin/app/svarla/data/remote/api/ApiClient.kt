package app.svarla.data.remote.api

import app.svarla.data.remote.AuthManager
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.parameter
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import javax.inject.Inject
import javax.inject.Singleton

/**
 * HTTP API client wrapping Ktor HttpClient with automatic session token
 * injection and base URL resolution from AuthManager.
 *
 * Handles 401 responses by calling authManager.handleSessionExpiry().
 */
@Singleton
class ApiClient @Inject constructor(
    @PublishedApi internal val httpClient: HttpClient,
    @PublishedApi internal val authManager: AuthManager
) {
    @PublishedApi
    internal fun baseUrl(): String {
        return authManager.getServerUrl() ?: throw IllegalStateException("No server URL configured")
    }

    @PublishedApi
    internal fun authHeader(): String {
        val token = authManager.getSessionToken()
            ?: throw IllegalStateException("No session token available")
        return "Bearer $token"
    }

    suspend inline fun <reified T> get(
        path: String,
        params: Map<String, Any?> = emptyMap()
    ): T {
        val response: HttpResponse = httpClient.get("${baseUrl()}$path") {
            header("Authorization", authHeader())
            params.forEach { (key, value) ->
                if (value != null) {
                    parameter(key, value.toString())
                }
            }
        }
        return handleResponse(response)
    }

    suspend inline fun <reified T> post(
        path: String,
        body: Any? = null
    ): T {
        val response: HttpResponse = httpClient.post("${baseUrl()}$path") {
            header("Authorization", authHeader())
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }
        return handleResponse(response)
    }

    suspend inline fun <reified T> put(
        path: String,
        body: Any? = null
    ): T {
        val response: HttpResponse = httpClient.put("${baseUrl()}$path") {
            header("Authorization", authHeader())
            if (body != null) {
                contentType(ContentType.Application.Json)
                setBody(body)
            }
        }
        return handleResponse(response)
    }

    suspend fun delete(path: String): Boolean {
        val response: HttpResponse = httpClient.delete("${baseUrl()}$path") {
            header("Authorization", authHeader())
        }
        if (response.status == HttpStatusCode.Unauthorized) {
            authManager.handleSessionExpiry()
            return false
        }
        return response.status.value in 200..299
    }

    @PublishedApi
    internal suspend inline fun <reified T> handleResponse(response: HttpResponse): T {
        if (response.status == HttpStatusCode.Unauthorized) {
            authManager.handleSessionExpiry()
            throw SessionExpiredException("Session expired (401)")
        }
        if (response.status.value !in 200..299) {
            throw ApiException(
                statusCode = response.status.value,
                message = "API request failed with status ${response.status.value}"
            )
        }
        return response.body()
    }
}

/**
 * Thrown when the server returns a 401 indicating the session has expired.
 */
class SessionExpiredException(message: String) : Exception(message)

/**
 * Thrown for non-2xx API responses (excluding 401 which throws SessionExpiredException).
 */
class ApiException(val statusCode: Int, message: String) : Exception(message)
