package app.svarla.ui.screens.call

import android.content.Intent
import android.provider.ContactsContract
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.CallMade
import androidx.compose.material.icons.filled.CallMissed
import androidx.compose.material.icons.filled.CallReceived
import androidx.compose.material.icons.filled.PhoneMissed
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import app.svarla.data.local.entity.CallHistoryEntry
import app.svarla.data.local.entity.CallType
import app.svarla.ui.components.CallHistoryEmptyState
import app.svarla.ui.components.NumberBadge
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Call history screen that displays a list of recent calls.
 * Shows contact name when available, and provides options to call,
 * send message, or add to contacts when tapping an entry.
 */
@Composable
fun CallHistoryScreen(
    onMakeCall: () -> Unit,
    onCallNumber: (String) -> Unit = {},
    onSendMessage: (providerNumber: String, phoneNumber: String) -> Unit = { _, _ -> },
    modifier: Modifier = Modifier,
    viewModel: CallHistoryViewModel = hiltViewModel()
) {
    val callHistory by viewModel.callHistory.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val hasLoadedFromCache by viewModel.hasLoadedFromCache.collectAsState()
    val error by viewModel.error.collectAsState()
    val context = LocalContext.current

    var selectedEntry by remember { mutableStateOf<CallHistoryUiEntry?>(null) }

    // Sync from server and refresh badge state every time the screen is entered/recomposed
    LaunchedEffect(Unit) {
        viewModel.syncFromServer()
        viewModel.onScreenEntered()
    }

    // When the user leaves this screen, clear unseen indicators
    DisposableEffect(Unit) {
        onDispose {
            viewModel.onScreenExited()
        }
    }

    Box(modifier = modifier.fillMaxSize()) {
        when {
            callHistory.isNotEmpty() -> {
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(callHistory, key = { it.entry.id }) { uiEntry ->
                        val isDialable = isDialableNumber(uiEntry.entry.phoneNumber)
                        CallHistoryItem(
                            uiEntry = uiEntry,
                            onClick = if (isDialable) {
                                { selectedEntry = uiEntry }
                            } else null
                        )
                        HorizontalDivider()
                    }
                }
            }
            hasLoadedFromCache && !isLoading -> {
                CallHistoryEmptyState(onMakeCall = onMakeCall)
            }
        }

        if (isLoading && callHistory.isEmpty()) {
            CircularProgressIndicator(
                modifier = Modifier.align(Alignment.Center)
            )
        } else if (isLoading) {
            LinearProgressIndicator(
                modifier = Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopCenter)
            )
        }

        // Show error as a subtle message at the bottom if we have cached data
        if (error != null && callHistory.isNotEmpty()) {
            Text(
                text = error ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(16.dp)
            )
        }
    }

    // Action dialog with Call / Message / Add to contacts options
    selectedEntry?.let { uiEntry ->
        val number = uiEntry.entry.phoneNumber
        val displayName = uiEntry.displayName

        AlertDialog(
            onDismissRequest = { selectedEntry = null },
            title = { Text(displayName) },
            text = {
                if (displayName != number) {
                    Text(number)
                } else {
                    null
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    selectedEntry = null
                    onCallNumber(number)
                }) {
                    Text("Call")
                }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = {
                        selectedEntry = null
                        onSendMessage(uiEntry.entry.providerNumber ?: "", number)
                    }) {
                        Text("Message")
                    }
                    if (!uiEntry.hasContact) {
                        TextButton(onClick = {
                            selectedEntry = null
                            // Open system Add Contact UI with the number pre-filled
                            val intent = Intent(ContactsContract.Intents.Insert.ACTION).apply {
                                type = ContactsContract.RawContacts.CONTENT_TYPE
                                putExtra(ContactsContract.Intents.Insert.PHONE, number)
                            }
                            context.startActivity(intent)
                        }) {
                            Text("Add contact")
                        }
                    }
                }
            }
        )
    }
}

/**
 * Checks if a phone number is dialable (not anonymous, has digits).
 */
private fun isDialableNumber(number: String): Boolean {
    if (number.isBlank()) return false
    if (number.equals("anonymous", ignoreCase = true)) return false
    if (number.equals("unknown", ignoreCase = true)) return false
    if (number.equals("withheld", ignoreCase = true)) return false
    // Must contain at least some digits
    return number.any { it.isDigit() }
}

@Composable
private fun CallHistoryItem(uiEntry: CallHistoryUiEntry, onClick: (() -> Unit)?) {
    val entry = uiEntry.entry
    val (icon, iconColor, typeLabel) = callTypeVisuals(entry.callType)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) Modifier.clickable(onClick = onClick)
                else Modifier
            )
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics {
                contentDescription = "$typeLabel call ${if (entry.callType == CallType.OUTGOING) "to" else "from"} ${uiEntry.displayName}"
            },
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Unseen dot indicator
        if (uiEntry.isUnseen) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .background(
                        color = MaterialTheme.colorScheme.primary,
                        shape = CircleShape
                    )
            )
            Spacer(modifier = Modifier.width(8.dp))
        } else {
            Spacer(modifier = Modifier.width(16.dp))
        }

        Icon(
            imageVector = icon,
            contentDescription = typeLabel,
            tint = iconColor,
            modifier = Modifier.size(24.dp)
        )

        Spacer(modifier = Modifier.width(12.dp))

        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                text = uiEntry.displayName,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = if (uiEntry.isUnseen) FontWeight.Bold else FontWeight.Normal,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                color = if (entry.callType == CallType.MISSED) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                }
            )

            Spacer(modifier = Modifier.height(2.dp))

            Row(
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Show which provider number this call belonged to, before the type label
                if (uiEntry.providerNumberLabel != null) {
                    NumberBadge(
                        label = uiEntry.providerNumberLabel,
                        color = uiEntry.providerNumberColor
                    )
                    Spacer(modifier = Modifier.width(6.dp))
                }
                Text(
                    text = typeLabel,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (entry.durationSeconds != null && entry.durationSeconds > 0) {
                    Text(
                        text = " · ${formatDuration(entry.durationSeconds)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        Text(
            text = formatTimestamp(entry.timestamp),
            style = MaterialTheme.typography.bodySmall,
            color = if (uiEntry.isUnseen) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

private data class CallTypeVisual(
    val icon: ImageVector,
    val color: Color,
    val label: String
)

@Composable
private fun callTypeVisuals(callType: CallType): CallTypeVisual {
    return when (callType) {
        CallType.INCOMING -> CallTypeVisual(
            icon = Icons.Default.CallReceived,
            color = MaterialTheme.colorScheme.primary,
            label = "Incoming"
        )
        CallType.OUTGOING -> CallTypeVisual(
            icon = Icons.Default.CallMade,
            color = MaterialTheme.colorScheme.primary,
            label = "Outgoing"
        )
        CallType.MISSED -> CallTypeVisual(
            icon = Icons.Default.CallMissed,
            color = MaterialTheme.colorScheme.error,
            label = "Missed"
        )
        CallType.UNANSWERED -> CallTypeVisual(
            icon = Icons.Default.PhoneMissed,
            color = MaterialTheme.colorScheme.error,
            label = "Unanswered"
        )
        CallType.DECLINED -> CallTypeVisual(
            icon = Icons.Default.CallMissed,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            label = "Declined"
        )
        CallType.BLOCKED -> CallTypeVisual(
            icon = Icons.Default.Block,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            label = "Blocked"
        )
    }
}

private fun formatTimestamp(timestamp: Long): String {
    val now = System.currentTimeMillis()
    val diff = now - timestamp

    return when {
        diff < 60_000 -> "Just now"
        diff < 3_600_000 -> "${diff / 60_000}m ago"
        diff < 86_400_000 -> {
            val sdf = SimpleDateFormat("HH:mm", Locale.getDefault())
            sdf.format(Date(timestamp))
        }
        diff < 604_800_000 -> {
            val sdf = SimpleDateFormat("EEE", Locale.getDefault())
            sdf.format(Date(timestamp))
        }
        else -> {
            val sdf = SimpleDateFormat("dd/MM/yyyy", Locale.getDefault())
            sdf.format(Date(timestamp))
        }
    }
}

private fun formatDuration(seconds: Int): String {
    val mins = seconds / 60
    val secs = seconds % 60
    return if (mins > 0) "${mins}m ${secs}s" else "${secs}s"
}
