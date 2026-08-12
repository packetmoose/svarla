package app.svarla.domain

import android.util.Log
import app.svarla.data.local.dao.CallHistoryDao
import app.svarla.data.local.dao.ConversationDao
import app.svarla.data.local.dao.ProviderNumberDao
import app.svarla.data.local.entity.CallHistoryEntry
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.api.CallsApi
import app.svarla.data.remote.api.NumbersApi
import app.svarla.data.repository.ConversationRepository
import app.svarla.domain.contacts.ContactResolver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Pre-loads critical app data into Room on startup so that screens
 * display cached content immediately without waiting for per-screen
 * network requests.
 *
 * Also pre-warms the contact name cache so that display names are
 * available instantly when ViewModels enrich their data.
 *
 * Called once after authentication is confirmed. Runs all syncs in
 * parallel on IO threads. Failures are logged but do not block the
 * app — cached data from previous sessions remains available.
 */
@Singleton
class AppDataPreloader @Inject constructor(
    private val conversationRepository: ConversationRepository,
    private val callsApi: CallsApi,
    private val callHistoryDao: CallHistoryDao,
    private val conversationDao: ConversationDao,
    private val numbersApi: NumbersApi,
    private val providerNumberDao: ProviderNumberDao,
    private val contactResolver: ContactResolver
) {
    companion object {
        private const val TAG = "AppDataPreloader"
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * Kick off all data syncs in parallel. Safe to call multiple times
     * (e.g., on WebSocket reconnect) — each sync is idempotent via REPLACE.
     *
     * After data is synced, pre-resolves contact names for all unique phone
     * numbers so the contact cache is warm before ViewModels render.
     */
    fun preload() {
        scope.launch { syncConversations() }
        scope.launch { syncCallHistory() }
        scope.launch { syncNumbers() }
        scope.launch { preWarmContactCache() }
    }

    private suspend fun syncConversations() {
        try {
            conversationRepository.syncConversations()
            Log.d(TAG, "Conversations pre-loaded")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to pre-load conversations", e)
        }
    }

    private suspend fun syncCallHistory() {
        try {
            val response = callsApi.getCallHistory(page = 1, pageSize = 50)
            response.entries.forEach { dto ->
                val entity = CallHistoryEntry(
                    id = dto.id,
                    phoneNumber = dto.phoneNumber,
                    providerNumber = dto.providerNumber,
                    callType = parseCallType(dto.callType),
                    timestamp = parseTimestamp(dto.timestamp),
                    durationSeconds = dto.durationSeconds,
                    answeredByDevice = dto.answeredByDevice,
                    realCallerNumber = dto.realCallerNumber
                )
                callHistoryDao.insert(entity)
            }
            Log.d(TAG, "Call history pre-loaded (${response.entries.size} entries)")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to pre-load call history", e)
        }
    }

    private suspend fun syncNumbers() {
        try {
            val response = numbersApi.getNumbers()
            val entities = response.numbers.map { dto ->
                val isDefault = dto.number == response.defaultNumber
                ProviderNumber(
                    number = dto.number,
                    label = dto.label,
                    color = dto.color,
                    isActive = dto.isActive,
                    lastUsedAt = dto.lastUsedAt?.toLongOrNull(),
                    blockInboundCalls = dto.blockInboundCalls,
                    isDefault = isDefault
                )
            }
            providerNumberDao.insertAll(entities)
            Log.d(TAG, "Provider numbers pre-loaded (${response.numbers.size} numbers)")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to pre-load numbers", e)
        }
    }

    /**
     * Waits for the contact cache to be built, then resolves all unique phone
     * numbers from conversations and call history in a single batch. This ensures
     * that subsequent resolveContactName() calls from ViewModels are instant cache hits.
     */
    private suspend fun preWarmContactCache() {
        try {
            // Wait for ContactResolver's initial cache build to finish
            contactResolver.awaitCacheReady()

            // Collect all unique phone numbers from cached data
            val phoneNumbers = mutableSetOf<String>()

            conversationDao.getAllOnce().forEach { conversation ->
                phoneNumbers.add(conversation.phoneNumber)
            }
            callHistoryDao.getAllOnce().forEach { entry ->
                phoneNumbers.add(entry.phoneNumber)
            }

            if (phoneNumbers.isEmpty()) {
                Log.d(TAG, "No phone numbers to pre-resolve")
                return
            }

            // Batch resolve — one content provider lookup per unique number not in cache
            val resolved = contactResolver.resolveContactNames(phoneNumbers)
            Log.d(TAG, "Contact names pre-warmed: ${resolved.size}/${phoneNumbers.size} resolved")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to pre-warm contact cache", e)
        }
    }

    private fun parseCallType(type: String): app.svarla.data.local.entity.CallType {
        return when (type.uppercase()) {
            "INCOMING" -> app.svarla.data.local.entity.CallType.INCOMING
            "OUTGOING" -> app.svarla.data.local.entity.CallType.OUTGOING
            "MISSED" -> app.svarla.data.local.entity.CallType.MISSED
            "UNANSWERED" -> app.svarla.data.local.entity.CallType.UNANSWERED
            "DECLINED" -> app.svarla.data.local.entity.CallType.DECLINED
            "BLOCKED" -> app.svarla.data.local.entity.CallType.BLOCKED
            else -> app.svarla.data.local.entity.CallType.INCOMING
        }
    }

    private fun parseTimestamp(timestamp: String): Long {
        return try {
            java.time.Instant.parse(timestamp).toEpochMilli()
        } catch (e: Exception) {
            try {
                timestamp.toLong()
            } catch (e2: Exception) {
                System.currentTimeMillis()
            }
        }
    }
}
