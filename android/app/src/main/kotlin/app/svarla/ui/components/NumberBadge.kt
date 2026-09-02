package app.svarla.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.svarla.data.local.entity.ProviderNumber

/**
 * A colored badge displaying a provider number's label (or number).
 * The badge background uses the number's assigned color with reduced opacity,
 * and the text uses the full-strength color for contrast.
 */
@Composable
fun NumberBadge(
    providerNumber: ProviderNumber,
    modifier: Modifier = Modifier
) {
    val badgeColor = parseNumberColor(providerNumber.color)
    val display = providerNumber.label ?: providerNumber.number

    Text(
        text = display,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = badgeColor,
        modifier = modifier
            .background(
                color = badgeColor.copy(alpha = 0.12f),
                shape = RoundedCornerShape(4.dp)
            )
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

/**
 * A colored badge displaying a label and color directly (for cases where
 * we don't have the full ProviderNumber entity, e.g. in conversation lists).
 */
@Composable
fun NumberBadge(
    label: String,
    color: String,
    modifier: Modifier = Modifier
) {
    val badgeColor = parseNumberColor(color)

    Text(
        text = label,
        style = MaterialTheme.typography.labelSmall,
        fontWeight = FontWeight.Medium,
        color = badgeColor,
        modifier = modifier
            .background(
                color = badgeColor.copy(alpha = 0.12f),
                shape = RoundedCornerShape(4.dp)
            )
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

/**
 * Parses a hex color string (e.g. "#6750A4") to a Compose Color.
 * Falls back to primary purple if the color is null or parsing fails.
 */
fun parseNumberColor(hex: String?): Color {
    if (hex == null) return Color(0xFF6750A4)
    return try {
        Color(android.graphics.Color.parseColor(hex))
    } catch (_: Exception) {
        Color(0xFF6750A4)
    }
}
