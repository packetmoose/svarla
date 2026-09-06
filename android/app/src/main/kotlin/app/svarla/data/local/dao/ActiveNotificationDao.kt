package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import app.svarla.data.local.entity.ActiveNotification

@Dao
interface ActiveNotificationDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(notification: ActiveNotification)

    @Query("SELECT * FROM active_notifications")
    suspend fun getAll(): List<ActiveNotification>

    @Query("SELECT * FROM active_notifications WHERE type = :type")
    suspend fun getByType(type: String): List<ActiveNotification>

    @Query("DELETE FROM active_notifications WHERE serverId = :serverId")
    suspend fun deleteByServerId(serverId: String)

    @Query("DELETE FROM active_notifications WHERE androidId = :androidId")
    suspend fun deleteByAndroidId(androidId: Int)

    @Query("DELETE FROM active_notifications WHERE createdAt < :cutoff")
    suspend fun deleteOlderThan(cutoff: Long)

    @Query("DELETE FROM active_notifications")
    suspend fun deleteAll()
}
