package app.svarla.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import app.svarla.ui.theme.dimensions
import coil.compose.AsyncImage

/**
 * Contact avatar composable that displays a contact photo if available,
 * or falls back to a colored circle with the contact's initials.
 *
 * Behavior:
 * - If [photoUri] is non-null, loads and displays the contact photo in a circle.
 * - Otherwise, extracts initials from [displayName] and renders them on a
 *   deterministically colored background circle (color derived from the name).
 *
 * @param displayName The contact's display name (used for initials and color)
 * @param photoUri Optional URI to the contact's photo from the Contacts Provider
 * @param size The diameter of the avatar circle
 * @param textSize Font size for the initials text
 */
@Composable
fun ContactAvatar(
    displayName: String,
    photoUri: String?,
    modifier: Modifier = Modifier,
    size: Dp = MaterialTheme.dimensions.avatarMedium,
    textSize: TextUnit = 16.sp
) {
    if (photoUri != null) {
        AsyncImage(
            model = photoUri,
            contentDescription = "Profile photo of $displayName",
            modifier = modifier
                .size(size)
                .clip(CircleShape),
            contentScale = ContentScale.Crop
        )
    } else {
        val isPhoneNumber = isPhoneNumberDisplay(displayName)
        val backgroundColor = if (isPhoneNumber) {
            Color(0xFF9E9E9E) // Neutral grey for unknown contacts, like native Android
        } else {
            avatarColorForName(displayName)
        }

        Box(
            modifier = modifier
                .size(size)
                .background(color = backgroundColor, shape = CircleShape),
            contentAlignment = Alignment.Center
        ) {
            if (isPhoneNumber) {
                Icon(
                    imageVector = Icons.Default.Person,
                    contentDescription = "Unknown contact",
                    tint = Color.White,
                    modifier = Modifier.size(size * 0.6f)
                )
            } else {
                val initials = extractInitials(displayName)
                Text(
                    text = initials,
                    color = Color.White,
                    fontSize = textSize,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}

/**
 * Checks if a display name is actually a phone number (no contact was resolved).
 * Returns true if the string starts with a digit or '+'.
 */
internal fun isPhoneNumberDisplay(name: String): Boolean {
    if (name.isBlank()) return true
    val first = name.trim().first()
    return first.isDigit() || first == '+'
}

/**
 * Extracts up to two initials from a contact display name.
 * - For names with multiple words: first letter of first and last word.
 * - For single word names: first character.
 */
internal fun extractInitials(name: String): String {
    if (name.isBlank()) return "?"

    val parts = name.trim().split("\\s+".toRegex()).filter { it.isNotEmpty() }
    return when {
        parts.size >= 2 -> "${parts.first().first().uppercase()}${parts.last().first().uppercase()}"
        parts.size == 1 -> parts.first().take(1).uppercase()
        else -> "?"
    }
}

/**
 * Generates a deterministic background color for an avatar based on the name.
 * Uses a palette of muted, accessible colors.
 */
private fun avatarColorForName(name: String): Color {
    val palette = listOf(
        Color(0xFF5C6BC0), // Indigo
        Color(0xFF26A69A), // Teal
        Color(0xFFEF5350), // Red
        Color(0xFFAB47BC), // Purple
        Color(0xFF42A5F5), // Blue
        Color(0xFF66BB6A), // Green
        Color(0xFFFFA726), // Orange
        Color(0xFF78909C), // Blue Grey
        Color(0xFFEC407A), // Pink
        Color(0xFF8D6E63), // Brown
    )
    val index = (name.hashCode().toLong() and 0x7FFFFFFF) % palette.size
    return palette[index.toInt()]
}
