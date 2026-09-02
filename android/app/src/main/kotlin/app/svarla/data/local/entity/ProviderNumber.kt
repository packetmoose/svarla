package app.svarla.data.local.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "provider_numbers")
data class ProviderNumber(
    @PrimaryKey
    val number: String,
    val label: String? = null,
    val color: String? = null,
    val isActive: Boolean = true,
    val lastUsedAt: Long? = null,
    val blockInboundCalls: Boolean = false,
    val isDefault: Boolean = false
)
