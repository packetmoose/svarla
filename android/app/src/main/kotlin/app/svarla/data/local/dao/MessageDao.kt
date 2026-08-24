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
     * Counts unread (received) messages per conversation where the message timestamp
     * is after the conversation's lastReadAt. Returns a list of [UnreadCount] objects.
     */
    @Query("""
        SELECT m.conversationNumber, COUNT(*) as count
        FROM messages m
        INNER JOIN conversations c ON m.conversationNumber = c.phoneNumber
        WHERE m.direction = 'RECEIVED'
        AND (c.lastReadAt IS NULL OR m.timestamp > c.lastReadAt)
        GROUP BY m.conversationNumber
    """)
    suspend fun getUnreadCountsPerConversation(): List<UnreadCount>
}

data class UnreadCount(
    val conversationNumber: String,
    val count: Int
)
