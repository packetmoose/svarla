package app.svarla.ui.screens.conversations

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import app.svarla.ui.components.ContactAvatar
import app.svarla.ui.components.NumberBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Conversation list screen showing all SMS threads sorted by most recent message.
 *
 * Each thread shows:
 * - Contact name (or phone number if no contact match)
 * - Message preview truncated to 50 characters
 * - Timestamp of the most recent message
 * - Provider number label
 *
 * Requirements: 7.2, 7.4, 7.5
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationListScreen(
    onConversationClick: (providerNumber: String, phoneNumber: String) -> Unit,
    onComposeMessage: () -> Unit = {},
    viewModel: ConversationListViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Messages") }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = onComposeMessage) {
                Icon(imageVector = Icons.Default.Edit, contentDescription = "New message")
            }
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            when {
                uiState.error != null && uiState.conversations.isEmpty() && uiState.hasLoadedFromCache -> {
                    ErrorState(
                        message = uiState.error ?: "Unknown error",
                        onRetry = { viewModel.syncFromServer() }
                    )
                }

                uiState.conversations.isEmpty() && uiState.hasLoadedFromCache && !uiState.isLoading -> {
                    EmptyState()
                }

                uiState.conversations.isNotEmpty() -> {
                    ConversationList(
                        conversations = uiState.conversations,
                        onConversationClick = onConversationClick
                    )
                }
            }

            if (uiState.isLoading && uiState.conversations.isEmpty()) {
                CircularProgressIndicator(
                    modifier = Modifier.align(Alignment.Center)
                )
            } else if (uiState.isLoading) {
                LinearProgressIndicator(
                    modifier = Modifier
                        .fillMaxWidth()
                        .align(Alignment.TopCenter)
                )
            }

            // Show error as a subtle message at the bottom if we have cached data
            if (uiState.error != null && uiState.conversations.isNotEmpty()) {
                Text(
                    text = uiState.error ?: "",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(16.dp)
                )
            }
        }
    }
}

@Composable
private fun ConversationList(
    conversations: List<ConversationListItem>,
    onConversationClick: (providerNumber: String, phoneNumber: String) -> Unit
) {
    LazyColumn(
        modifier = Modifier.fillMaxSize()
    ) {
        items(
            items = conversations,
            key = { "${it.providerNumber}:${it.phoneNumber}" }
        ) { conversation ->
            ConversationListItemRow(
                item = conversation,
                onClick = { onConversationClick(conversation.providerNumber, conversation.phoneNumber) }
            )
            HorizontalDivider()
        }
    }
}

@Composable
private fun ConversationListItemRow(
    item: ConversationListItem,
    onClick: () -> Unit
) {
    val isUnread = item.unreadCount > 0

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Profile picture / initials avatar
        ContactAvatar(
            displayName = item.displayName,
            photoUri = item.photoUri
        )

        Spacer(modifier = Modifier.width(12.dp))

        // Text content: 3 rows
        Column(
            modifier = Modifier.weight(1f)
        ) {
            // Row 1: Contact name + provider number badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = item.displayName,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = if (isUnread) FontWeight.Bold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )
                if (item.providerNumberLabel.isNotEmpty()) {
                    Spacer(modifier = Modifier.width(8.dp))
                    NumberBadge(
                        label = item.providerNumberLabel,
                        color = item.providerNumberColor
                    )
                }
            }

            Spacer(modifier = Modifier.height(2.dp))

            // Row 2: Last message preview
            Text(
                text = item.preview,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (isUnread) FontWeight.Medium else FontWeight.Normal,
                color = if (isUnread) MaterialTheme.colorScheme.onSurface
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(modifier = Modifier.height(2.dp))

            // Row 3: Timestamp + unread count badge
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                item.timestamp?.let { timestamp ->
                    Text(
                        text = formatTimestamp(timestamp),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (isUnread) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (isUnread) {
                    val badgeText = if (item.unreadCount > 99) "99+" else item.unreadCount.toString()
                    Box(
                        modifier = Modifier
                            .background(
                                color = MaterialTheme.colorScheme.primary,
                                shape = RoundedCornerShape(10.dp)
                            )
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            text = badgeText,
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onPrimary,
                            fontWeight = FontWeight.Bold
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "No conversations yet",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Send a message to start a conversation",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun ErrorState(
    message: String,
    onRetry: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(
                text = "Failed to load conversations",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.error
            )
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(16.dp))
            androidx.compose.material3.TextButton(onClick = onRetry) {
                Text("Retry")
            }
        }
    }
}

/**
 * Format a timestamp for display in the conversation list.
 * Shows time for today, day of week for this week, or date otherwise.
 */
private fun formatTimestamp(timestamp: Long): String {
    val now = System.currentTimeMillis()
    val diff = now - timestamp

    val date = Date(timestamp)

    return when {
        diff < 24 * 60 * 60 * 1000L -> {
            // Today: show time (24h)
            SimpleDateFormat("HH:mm", Locale.getDefault()).format(date)
        }
        diff < 7 * 24 * 60 * 60 * 1000L -> {
            // This week: show day
            SimpleDateFormat("EEE", Locale.getDefault()).format(date)
        }
        else -> {
            // Older: show date (European format)
            SimpleDateFormat("dd/MM/yyyy", Locale.getDefault()).format(date)
        }
    }
}
