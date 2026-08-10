package app.svarla.domain.contacts

import android.Manifest
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.telephony.PhoneNumberUtils
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Resolves phone numbers to contact names using the Android Contacts Provider.
 *
 * Responsibilities:
 * - Query Android ContentResolver for contacts matching phone numbers
 * - E.164 normalization for matching phone numbers to contacts
 * - Searchable contact list (by name and number), limited to 20 results
 * - Register ContentObserver for change detection (re-index within 30s)
 * - Handle READ_CONTACTS permission with graceful fallback
 * - Maintain in-memory cache of phoneNumber → contactName for fast lookups
 *
 * Integration points:
 * - Call screens: resolve remote party number to contact name
 * - Conversation threads: resolve thread phone number to contact name
 * - Call history: resolve phone number in each entry
 * - Notifications: resolve caller/sender to contact name
 *
 * Requirements covered: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */
@Singleton
class ContactResolver @Inject constructor(
    private val context: Context
) {
    companion object {
        private const val TAG = "ContactResolver"
        private const val SEARCH_RESULT_LIMIT = 20
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val contentResolver: ContentResolver = context.contentResolver

    /** Tracks whether READ_CONTACTS permission has been granted. */
    private val _hasPermission = MutableStateFlow(false)
    val hasPermission: StateFlow<Boolean> = _hasPermission.asStateFlow()

    /** In-memory cache: normalized phone number → contact display name */
    private val contactCache = ConcurrentHashMap<String, String>()

    /** Mutex for thread-safe cache rebuilding */
    private val cacheMutex = Mutex()

    private var contactObserver: ContentObserver? = null

    init {
        checkPermissionAndInitialize()
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Resolves a phone number to a contact display name.
     *
     * Normalizes the input to E.164 before lookup. Returns null if:
     * - READ_CONTACTS permission is denied
     * - No matching contact is found
     *
     * @param phoneNumber The phone number to resolve (any format)
     * @return The contact's display name, or null if not found
     */
    fun resolveContactName(phoneNumber: String): String? {
        if (!_hasPermission.value) {
            return null
        }

        if (phoneNumber.isBlank()) {
            return null
        }

        val normalized = normalizeNumber(phoneNumber)
        if (normalized.isEmpty()) {
            return null
        }

        // Try cache first
        contactCache[normalized]?.let { return it }

        // Fall back to direct query if not in cache
        return queryContactNameByNumber(phoneNumber)
    }

    /**
     * Searches contacts by name or phone number.
     *
     * Returns up to [SEARCH_RESULT_LIMIT] results matching the query.
     * If READ_CONTACTS permission is denied, returns an empty list.
     *
     * @param query The search query (name or phone number)
     * @return List of matching contacts, limited to 20 results
     */
    fun searchContacts(query: String): List<ContactInfo> {
        if (!_hasPermission.value) {
            return emptyList()
        }

        if (query.isBlank()) {
            return emptyList()
        }

        return searchContactsByQuery(query)
    }

    /**
     * Notifies the resolver that READ_CONTACTS permission has been granted.
     * Call this after the user grants permission at runtime.
     */
    fun onPermissionGranted() {
        _hasPermission.value = true
        registerContentObserver()
        scope.launch { rebuildCache() }
    }

    /**
     * Notifies the resolver that READ_CONTACTS permission has been denied.
     */
    fun onPermissionDenied() {
        _hasPermission.value = false
        unregisterContentObserver()
        contactCache.clear()
    }

    /**
     * Refreshes the contact cache. Can be called externally to force a refresh.
     */
    fun refresh() {
        if (_hasPermission.value) {
            scope.launch { rebuildCache() }
        }
    }

    // ========================================================================
    // Permission handling
    // ========================================================================

    private fun checkPermissionAndInitialize() {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.READ_CONTACTS
        ) == PackageManager.PERMISSION_GRANTED

        _hasPermission.value = granted

        if (granted) {
            registerContentObserver()
            scope.launch { rebuildCache() }
        }
    }

    // ========================================================================
    // ContentObserver for change detection
    // ========================================================================

    private fun registerContentObserver() {
        if (contactObserver != null) return

        contactObserver = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                onChange(selfChange, null)
            }

            override fun onChange(selfChange: Boolean, uri: Uri?) {
                Log.d(TAG, "Contact change detected, scheduling cache rebuild")
                // Re-index contacts within 30 seconds of changes
                // Using coroutine launch which starts immediately
                scope.launch { rebuildCache() }
            }
        }

        contentResolver.registerContentObserver(
            ContactsContract.Contacts.CONTENT_URI,
            true,
            contactObserver!!
        )

        Log.d(TAG, "ContentObserver registered for contact changes")
    }

    private fun unregisterContentObserver() {
        contactObserver?.let {
            contentResolver.unregisterContentObserver(it)
            contactObserver = null
            Log.d(TAG, "ContentObserver unregistered")
        }
    }

    // ========================================================================
    // Cache management
    // ========================================================================

    /**
     * Rebuilds the entire in-memory contact cache from the Contacts Provider.
     * Maps normalized phone numbers to display names.
     */
    private suspend fun rebuildCache() {
        cacheMutex.withLock {
            if (!_hasPermission.value) return

            val newCache = mutableMapOf<String, String>()

            try {
                val projection = arrayOf(
                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME
                )

                contentResolver.query(
                    ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                    projection,
                    null,
                    null,
                    null
                )?.use { cursor ->
                    val numberIndex = cursor.getColumnIndex(
                        ContactsContract.CommonDataKinds.Phone.NUMBER
                    )
                    val nameIndex = cursor.getColumnIndex(
                        ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME
                    )

                    while (cursor.moveToNext()) {
                        val number = cursor.getString(numberIndex) ?: continue
                        val name = cursor.getString(nameIndex) ?: continue

                        val normalized = normalizeNumber(number)
                        if (normalized.isNotEmpty()) {
                            newCache[normalized] = name
                        }
                    }
                }

                contactCache.clear()
                contactCache.putAll(newCache)
                Log.d(TAG, "Contact cache rebuilt: ${contactCache.size} entries")
            } catch (e: Exception) {
                Log.e(TAG, "Error rebuilding contact cache", e)
            }
        }
    }

    // ========================================================================
    // Direct queries
    // ========================================================================

    /**
     * Queries the Contacts Provider directly for a contact name matching the given number.
     * Uses the PhoneLookup URI which handles number normalization internally.
     */
    private fun queryContactNameByNumber(phoneNumber: String): String? {
        if (phoneNumber.isBlank()) return null

        try {
            val uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(phoneNumber)
            )

            val projection = arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME)

            contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIndex = cursor.getColumnIndex(
                        ContactsContract.PhoneLookup.DISPLAY_NAME
                    )
                    val name = cursor.getString(nameIndex)
                    if (name != null) {
                        // Cache the result for future fast lookups
                        val normalized = normalizeNumber(phoneNumber)
                        if (normalized.isNotEmpty()) {
                            contactCache[normalized] = name
                        }
                        return name
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error querying contact by number: $phoneNumber", e)
        }

        return null
    }

    /**
     * Searches contacts by name or number using the filter URI.
     * Returns up to [SEARCH_RESULT_LIMIT] results.
     */
    private fun searchContactsByQuery(query: String): List<ContactInfo> {
        val results = mutableListOf<ContactInfo>()

        try {
            // Search using the CONTENT_FILTER_URI which matches name and number
            val uri = Uri.withAppendedPath(
                ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI,
                Uri.encode(query)
            )

            val projection = arrayOf(
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                ContactsContract.CommonDataKinds.Phone.NUMBER,
                ContactsContract.CommonDataKinds.Phone.PHOTO_URI
            )

            contentResolver.query(
                uri,
                projection,
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            )?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME
                )
                val numberIndex = cursor.getColumnIndex(
                    ContactsContract.CommonDataKinds.Phone.NUMBER
                )
                val photoIndex = cursor.getColumnIndex(
                    ContactsContract.CommonDataKinds.Phone.PHOTO_URI
                )

                val seenNumbers = mutableSetOf<String>()

                while (cursor.moveToNext() && results.size < SEARCH_RESULT_LIMIT) {
                    val name = cursor.getString(nameIndex) ?: continue
                    val number = cursor.getString(numberIndex) ?: continue
                    val photoUri = cursor.getString(photoIndex)

                    // Deduplicate by normalized number
                    val normalized = normalizeNumber(number)
                    if (normalized in seenNumbers) continue
                    seenNumbers.add(normalized)

                    results.add(
                        ContactInfo(
                            name = name,
                            phoneNumber = normalized.ifEmpty { number },
                            photoUri = photoUri
                        )
                    )
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error searching contacts for query: $query", e)
        }

        return results
    }

    // ========================================================================
    // Phone number normalization
    // ========================================================================

    /**
     * Normalizes a phone number to E.164 format for consistent matching.
     *
     * Uses Android's PhoneNumberUtils for normalization. If normalization fails,
     * strips non-digit characters (keeping leading +) as a fallback.
     *
     * @param number The raw phone number string
     * @return The normalized number string, or stripped digits as fallback
     */
    internal fun normalizeNumber(number: String): String {
        if (number.isBlank()) return ""

        // Try Android's built-in normalization
        val normalized = PhoneNumberUtils.normalizeNumber(number)
        if (!normalized.isNullOrEmpty()) {
            return normalized
        }

        // Fallback: strip non-digit characters, preserve leading +
        val stripped = number.filter { it.isDigit() || it == '+' }
        return if (stripped.startsWith("+")) {
            stripped
        } else if (stripped.isNotEmpty()) {
            "+$stripped"
        } else {
            ""
        }
    }
}
