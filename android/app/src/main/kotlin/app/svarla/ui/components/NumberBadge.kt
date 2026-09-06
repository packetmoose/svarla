package app.svarla.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.svarla.data.local.entity.ProviderNumber

/**
 * A colored badge displaying a provider number's label (or number).
 * The badge is filled with the number's assigned color and the text uses a
 * fixed high-contrast color (white or black) chosen for the fill's luminance,
 * so labels stay clearly readable regardless of the assigned color.
 */
@Composable
fun NumberBadge(
    providerNumber: ProviderNumber,
    modifier: Modifier = Modifier
) {
    NumberBadge(
        label = providerNumber.label ?: providerNumber.number,
        color = providerNumber.color ?: "#6750A4",
        modifier = modifier
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
        color = contrastTextColor(badgeColor),
        modifier = modifier
            .background(
                color = badgeColor,
                shape = RoundedCornerShape(4.dp)
            )
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}

/**
 * A lightweight provider-number indicator: the label as plain text followed by
 * a small dot in the number's assigned color. Used where a full colored badge
 * would be too heavy, e.g. in the conversation list.
 */
@Composable
fun NumberLabelWithDot(
    label: String,
    color: String,
    modifier: Modifier = Modifier
) {
    val dotColor = parseNumberColor(color)

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Medium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.width(4.dp))
        Spacer(
            modifier = Modifier
                .size(8.dp)
                .background(color = dotColor, shape = CircleShape)
        )
    }
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

/**
 * Returns black or white, whichever contrasts better against [background],
 * using the WCAG relative-luminance formula.
 */
fun contrastTextColor(background: Color): Color {
    fun channel(c: Float): Double {
        val cc = c.toDouble()
        return if (cc <= 0.03928) cc / 12.92 else Math.pow((cc + 0.055) / 1.055, 2.4)
    }
    val luminance = 0.2126 * channel(background.red) +
        0.7152 * channel(background.green) +
        0.0722 * channel(background.blue)
    return if (luminance > 0.4) Color.Black else Color.White
}
