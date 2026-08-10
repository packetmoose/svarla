package app.svarla.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import app.svarla.data.local.entity.ProviderNumber
import kotlinx.coroutines.flow.Flow

@Dao
interface ProviderNumberDao {

    @Query("SELECT * FROM provider_numbers")
    fun getAll(): Flow<List<ProviderNumber>>

    @Query("SELECT * FROM provider_numbers WHERE isActive = 1")
    fun getActive(): Flow<List<ProviderNumber>>

    @Query("SELECT * FROM provider_numbers WHERE number = :number")
    suspend fun getByNumber(number: String): ProviderNumber?

    @Query("SELECT * FROM provider_numbers WHERE isDefault = 1 LIMIT 1")
    suspend fun getDefault(): ProviderNumber?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(providerNumber: ProviderNumber)

    @Update
    suspend fun update(providerNumber: ProviderNumber)

    @Query("DELETE FROM provider_numbers WHERE number = :number")
    suspend fun deleteByNumber(number: String)

    @Query("UPDATE provider_numbers SET isActive = 0 WHERE number NOT IN (:activeNumbers)")
    suspend fun deactivateExcept(activeNumbers: List<String>)

    @Query("UPDATE provider_numbers SET isDefault = 0")
    suspend fun clearAllDefaults()
}
