package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import app.svarla.data.local.entity.Conversation
import kotlinx.coroutines.flow.Flow

@Dao
interface ConversationDao {

    @Query("SELECT * FROM conversations ORDER BY lastMessageTimestamp DESC")
    fun getAll(): Flow<List<Conversation>>

    @Query("SELECT * FROM conversations ORDER BY lastMessageTimestamp DESC")
    suspend fun getAllOnce(): List<Conversation>

    @Query("SELECT * FROM conversations ORDER BY lastMessageTimestamp DESC LIMIT :limit")
    fun getRecent(limit: Int): Flow<List<Conversation>>

    @Query("SELECT * FROM conversations WHERE phoneNumber = :number")
    suspend fun getByNumber(number: String): Conversation?

    @Query("SELECT * FROM conversations WHERE providerNumber = :providerNumber AND phoneNumber = :phoneNumber")
    suspend fun getByProviderAndPhone(providerNumber: String, phoneNumber: String): Conversation?

    @Query("SELECT * FROM conversations WHERE phoneNumber = :number OR phoneNumber = :normalizedNumber")
    suspend fun getByNumberOrNormalized(number: String, normalizedNumber: String): Conversation?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(conversation: Conversation)

    @Update
    suspend fun update(conversation: Conversation)

    @Query("UPDATE conversations SET lastReadAt = :timestamp WHERE providerNumber = :providerNumber AND phoneNumber = :number")
    suspend fun markAsRead(providerNumber: String, number: String, timestamp: Long)

    @Query("UPDATE conversations SET lastReadAt = :timestamp WHERE phoneNumber = :number")
    suspend fun markAsReadByPhone(number: String, timestamp: Long)

    @Query("DELETE FROM conversations WHERE providerNumber = :providerNumber AND phoneNumber = :phoneNumber")
    suspend fun deleteByProviderAndPhone(providerNumber: String, phoneNumber: String)
}
