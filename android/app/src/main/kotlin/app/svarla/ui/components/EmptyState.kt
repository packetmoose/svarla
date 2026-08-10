package app.svarla.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Phone
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

/**
 * A reusable empty state composable that displays an illustration/icon, a descriptive
 * message, and optionally a call-to-action button.
 *
 * Requirement 13.8: When no content exists for a view (empty Call_History, no
 * Conversation_Threads, no search results), display a purposeful empty state with
 * an illustration or icon, a descriptive message, and where applicable a call-to-action
 * guiding the user to populate the view.
 *
 * Requirement 6.6: When no call history entries exist, display an empty state message.
 *
 * @param icon The illustration/icon displayed above the message.
 * @param title The primary descriptive message explaining the empty state.
 * @param modifier Modifier applied to the empty state container.
 * @param subtitle An optional secondary message providing additional context.
 * @param actionLabel Text for the optional call-to-action button.
 * @param onAction Callback invoked when the CTA button is tapped. If null, the button is hidden.
 */
@Composable
fun EmptyState(
    icon: ImageVector,
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            modifier = Modifier.size(72.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
        )

        if (subtitle != null) {
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }

        if (actionLabel != null && onAction != null) {
            Spacer(modifier = Modifier.height(24.dp))
            Button(onClick = onAction) {
                Text(text = actionLabel)
            }
        }
    }
}

/**
 * Empty state variant for Call History when no entries exist.
 *
 * Requirement 6.6: When the user opens the Call_History view and no entries exist,
 * display an empty state message indicating that no call history is available.
 *
 * @param onMakeCall Callback invoked when the user taps "Make your first call".
 * @param modifier Modifier applied to the empty state container.
 */
@Composable
fun CallHistoryEmptyState(
    onMakeCall: () -> Unit,
    modifier: Modifier = Modifier,
) {
    EmptyState(
        icon = Icons.Outlined.Phone,
        title = "No call history yet",
        actionLabel = "Make your first call",
        onAction = onMakeCall,
        modifier = modifier,
    )
}

/**
 * Empty state variant for Conversations when no threads exist.
 *
 * @param onSendMessage Callback invoked when the user taps "Send a message".
 * @param modifier Modifier applied to the empty state container.
 */
@Composable
fun ConversationsEmptyState(
    onSendMessage: () -> Unit,
    modifier: Modifier = Modifier,
) {
    EmptyState(
        icon = Icons.Outlined.ChatBubbleOutline,
        title = "No conversations yet",
        actionLabel = "Send a message",
        onAction = onSendMessage,
        modifier = modifier,
    )
}

/**
 * Empty state variant for search results when no matches are found.
 *
 * @param modifier Modifier applied to the empty state container.
 */
@Composable
fun SearchEmptyState(
    modifier: Modifier = Modifier,
) {
    EmptyState(
        icon = Icons.Outlined.Search,
        title = "No results found",
        subtitle = "Try a different search",
        modifier = modifier,
    )
}
