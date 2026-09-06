package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import app.svarla.data.local.entity.CallHistoryEntry
import kotlinx.coroutines.flow.Flow

@Dao
interface CallHistoryDao {

    @Query("SELECT * FROM call_history ORDER BY timestamp DESC")
    fun getAll(): Flow<List<CallHistoryEntry>>

    @Query("SELECT * FROM call_history ORDER BY timestamp DESC")
    suspend fun getAllOnce(): List<CallHistoryEntry>

    @Query("SELECT * FROM call_history ORDER BY timestamp DESC LIMIT :limit")
    fun getRecent(limit: Int): Flow<List<CallHistoryEntry>>

    @Query("SELECT * FROM call_history WHERE phoneNumber = :phoneNumber ORDER BY timestamp DESC")
    fun getByPhoneNumber(phoneNumber: String): Flow<List<CallHistoryEntry>>

    @Query("SELECT * FROM call_history WHERE phoneNumber = :phoneNumber AND providerNumber = :providerNumber ORDER BY timestamp DESC")
    fun getByPhoneAndProvider(phoneNumber: String, providerNumber: String): Flow<List<CallHistoryEntry>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(entry: CallHistoryEntry)

    @Query("DELETE FROM call_history WHERE id IN (SELECT id FROM call_history ORDER BY timestamp ASC LIMIT 1)")
    suspend fun deleteOldest()

    @Query("SELECT COUNT(*) FROM call_history")
    suspend fun getCount(): Int
}
