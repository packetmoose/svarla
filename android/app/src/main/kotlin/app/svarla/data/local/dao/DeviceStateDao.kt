package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import app.svarla.data.local.entity.DeviceState
import kotlinx.coroutines.flow.Flow

@Dao
interface DeviceStateDao {

    @Query("SELECT * FROM device_state WHERE id = 1")
    fun get(): Flow<DeviceState?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(deviceState: DeviceState)

    @Update
    suspend fun update(deviceState: DeviceState)
}
