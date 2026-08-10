package app.svarla.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "device_state")
data class DeviceState(
    @PrimaryKey
    val id: Int = 1,
    val isLoggedIn: Boolean = false,
    val sessionToken: String? = null,
    val serverUrl: String? = null
)
