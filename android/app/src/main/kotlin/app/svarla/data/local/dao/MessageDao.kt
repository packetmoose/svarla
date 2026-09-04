package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import app.svarla.data.local.entity.Message
import app.svarla.data.local.entity.MessageStatus
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {

    @Query("SELECT * FROM messages WHERE conversationNumber = :number ORDER BY timestamp DESC LIMIT :limit")
    fun getByConversation(number: String, limit: Int = 100): Flow<List<Message>>

    @Query("SELECT * FROM messages WHERE conversationNumber = :number AND providerNumber = :providerNumber ORDER BY timestamp DESC LIMIT :limit")
    fun getByConversationAndProvider(number: String, providerNumber: String, limit: Int = 100): Flow<List<Message>>

    @Query("SELECT providerNumber FROM messages WHERE conversationNumber = :number AND providerNumber IS NOT NULL ORDER BY timestamp DESC LIMIT 1")
    suspend fun getLastProviderNumberForConversation(number: String): String?

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun getById(id: String): Message?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(message: Message)

    @Query("UPDATE messages SET status = :status WHERE id = :id")
    suspend fun updateStatus(id: String, status: MessageStatus)

    @Query("SELECT * FROM messages WHERE providerMessageId = :providerMessageId")
    suspend fun getByProviderMessageId(providerMessageId: String): Message?

    @Query("SELECT * FROM messages WHERE status = :status ORDER BY timestamp ASC")
    suspend fun getByStatus(status: MessageStatus): List<Message>

    @Query("DELETE FROM messages WHERE id = :id")
    suspend fun deleteById(id: String)

    /**
     * Returns the id + timestamp of locally-stored messages belonging to a specific
     * thread (matched by recipient number and provider/own number) whose timestamp
     * falls within the given inclusive window. Used to reconcile the local cache
     * against the authoritative server response for that thread so that messages
     * which no longer belong to the thread (e.g. previously mis-attributed to the
     * wrong same-recipient conversation) can be removed — WITHOUT deleting older
     * history that simply fell outside the server's paged response window.
     *
     * A NULL/empty stored providerNumber is treated as matching an empty provider.
     */
    @Query("""
        SELECT id FROM messages
        WHERE conversationNumber = :number
        AND COALESCE(providerNumber, '') = :providerNumber
        AND timestamp >= :minTimestamp
        AND timestamp <= :maxTimestamp
    """)
    suspend fun getIdsForThreadInRange(
        number: String,
        providerNumber: String,
        minTimestamp: Long,
        maxTimestamp: Long
    ): List<String>

    /**
     * Counts unread (received) messages per conversation thread where the message
     * timestamp is after the conversation's lastReadAt. Returns a list of
     * [UnreadCount] objects keyed by the full (providerNumber, conversationNumber) pair.
     *
     * The join matches on BOTH the remote number (conversationNumber = phoneNumber) and
     * the provider/own number so that two conversations with the same recipient but
     * different provider numbers are counted independently. A message whose
     * providerNumber is NULL or empty is attributed to the conversation whose
     * providerNumber is likewise empty.
     */
    @Query("""
        SELECT c.providerNumber AS providerNumber, m.conversationNumber AS conversationNumber, COUNT(*) as count
        FROM messages m
        INNER JOIN conversations c
            ON m.conversationNumber = c.phoneNumber
            AND COALESCE(m.providerNumber, '') = c.providerNumber
        WHERE m.direction = 'RECEIVED'
        AND (c.lastReadAt IS NULL OR m.timestamp > c.lastReadAt)
        GROUP BY c.providerNumber, m.conversationNumber
    """)
    suspend fun getUnreadCountsPerConversation(): List<UnreadCount>
}

data class UnreadCount(
    val providerNumber: String,
    val conversationNumber: String,
    val count: Int
)
