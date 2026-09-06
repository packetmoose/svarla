package app.svarla.ui.screens.conversations

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.core.content.ContextCompat
import app.svarla.data.local.entity.CallType
import app.svarla.data.local.entity.MessageDirection
import app.svarla.ui.components.NumberBadge
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Conversation detail screen showing messages in a single thread
 * with an inline message input bar at the bottom.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationDetailScreen(
    onNavigateBack: () -> Unit,
    viewModel: ConversationDetailViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()
    val keyboardController = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    var showRemoveConfirmation by remember { mutableStateOf(false) }
    val context = LocalContext.current

    // Dismiss keyboard when leaving this screen
    DisposableEffect(Unit) {
        onDispose {
            keyboardController?.hide()
        }
    }

    // Mic permission gating for the call button
    var pendingCall by remember { mutableStateOf(false) }
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted && pendingCall) {
            viewModel.makeCall()
        }
        pendingCall = false
    }

    // Auto-scroll to the bottom when new messages arrive
    LaunchedEffect(uiState.timelineItems.size) {
        if (uiState.timelineItems.isNotEmpty()) {
            // Account for date separator items in the list
            val dateCount = uiState.timelineItems
                .map { formatDateKey(it.timestamp) }
                .distinct()
                .size
            val totalItems = uiState.timelineItems.size + dateCount
            listState.animateScrollToItem(totalItems - 1)
        }
    }

    // Hide keyboard when user scrolls the message list
    val isDragged by listState.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(isDragged) {
        if (isDragged) {
            keyboardController?.hide()
            focusManager.clearFocus()
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = uiState.displayName,
                            style = MaterialTheme.typography.titleMedium
                        )
                        if (uiState.providerNumberLabel.isNotEmpty()) {
                            NumberBadge(
                                label = uiState.providerNumberLabel,
                                color = uiState.providerNumberColor
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = {
                        keyboardController?.hide()
                        onNavigateBack()
                    }) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back"
                        )
                    }
                },
                actions = {
                    IconButton(onClick = {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED
                        ) {
                            viewModel.makeCall()
                        } else {
                            pendingCall = true
                            micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
                        }
                    }) {
                        Icon(
                            imageVector = Icons.Filled.Phone,
                            contentDescription = "Call"
                        )
                    }
                    IconButton(onClick = { showRemoveConfirmation = true }) {
                        Icon(
                            imageVector = Icons.Default.Delete,
                            contentDescription = "Remove conversation"
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .imePadding()
        ) {
            // Messages area - takes all available space
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
            ) {
                when {
                    uiState.error != null && uiState.timelineItems.isEmpty() -> {
                        DetailErrorState(
                            message = uiState.error ?: "Unknown error",
                            onRetry = { viewModel.retry() }
                        )
                    }

                    uiState.isLoading && uiState.timelineItems.isEmpty() -> {
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    else -> {
                        TimelineList(
                            items = uiState.timelineItems,
                            listState = listState,
                            removedMessageIds = uiState.removedMessageIds,
                            onRemoveMessage = { messageId -> viewModel.removeMessage(messageId) },
                            onUndoRemove = { messageId -> viewModel.undoRemoveMessage(messageId) }
                        )
                    }
                }
            }

            // Input bar pinned at the bottom
            MessageInputBar(
                text = uiState.inputText,
                onTextChanged = viewModel::onInputChanged,
                onSend = viewModel::sendMessage,
                isSending = uiState.isSending,
                charCount = uiState.charCount,
                segmentCount = uiState.segmentCount,
                showSegmentIndicator = uiState.showSegmentIndicator,
                sendError = uiState.sendError,
                isRepliable = uiState.isRepliable
            )
        }
    }

    // Confirmation dialog for removing the conversation
    if (showRemoveConfirmation) {
        AlertDialog(
            onDismissRequest = { showRemoveConfirmation = false },
            title = { Text("Remove conversation") },
            text = { Text("Are you sure you want to remove this conversation? It will no longer appear in your message list.") },
            confirmButton = {
                TextButton(onClick = {
                    showRemoveConfirmation = false
                    viewModel.removeConversation()
                    onNavigateBack()
                }) {
                    Text("Remove")
                }
            },
            dismissButton = {
                TextButton(onClick = { showRemoveConfirmation = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun MessageInputBar(
    text: String,
    onTextChanged: (String) -> Unit,
    onSend: () -> Unit,
    isSending: Boolean,
    charCount: Int,
    segmentCount: Int,
    showSegmentIndicator: Boolean,
    sendError: String?,
    isRepliable: Boolean = true
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 8.dp)
    ) {
        HorizontalDivider(thickness = 0.5.dp, color = MaterialTheme.colorScheme.outlineVariant)

        if (sendError != null) {
            Text(
                text = sendError,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
            )
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 6.dp)
        ) {
            // Compact text input
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(20.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
                contentAlignment = Alignment.CenterStart
            ) {
                BasicTextField(
                    value = text,
                    onValueChange = onTextChanged,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = isRepliable,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(
                        color = MaterialTheme.colorScheme.onSurface
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    maxLines = 5,
                    decorationBox = { innerTextField ->
                        if (text.isEmpty()) {
                            Text(
                                text = if (isRepliable) "Message" else "Cannot reply to this sender",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        innerTextField()
                    }
                )
            }

            // Send button - same height as the single-line input
            Box(
                modifier = Modifier
                    .padding(start = 8.dp)
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(
                        if (text.isNotBlank() && !isSending && isRepliable)
                            MaterialTheme.colorScheme.primary
                        else
                            MaterialTheme.colorScheme.surfaceVariant
                    ),
                contentAlignment = Alignment.Center
            ) {
                if (isSending) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary
                    )
                } else {
                    IconButton(
                        onClick = onSend,
                        enabled = text.isNotBlank() && !isSending && isRepliable,
                        modifier = Modifier.size(40.dp)
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = "Send",
                            modifier = Modifier.size(18.dp),
                            tint = if (text.isNotBlank() && isRepliable)
                                MaterialTheme.colorScheme.onPrimary
                            else
                                MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }

        // Character count / segment indicator
        if (charCount > 0) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.End
            ) {
                val indicatorText = if (showSegmentIndicator) {
                    "$charCount · $segmentCount ${if (segmentCount == 1) "msg" else "msgs"}"
                } else {
                    "$charCount"
                }
                Text(
                    text = indicatorText,
                    style = MaterialTheme.typography.labelSmall,
                    color = if (showSegmentIndicator)
                        MaterialTheme.colorScheme.tertiary
                    else
                        MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                )
            }
        }
    }
}

@Composable
private fun TimelineList(
    items: List<TimelineItem>,
    listState: androidx.compose.foundation.lazy.LazyListState,
    removedMessageIds: Set<String> = emptySet(),
    onRemoveMessage: (String) -> Unit = {},
    onUndoRemove: (String) -> Unit = {}
) {
    LazyColumn(
        state = listState,
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        var lastDateKey: String? = null

        items.forEach { item ->
            val dateKey = formatDateKey(item.timestamp)
            if (dateKey != lastDateKey) {
                lastDateKey = dateKey
                item(key = "date_$dateKey") {
                    DateSeparator(timestamp = item.timestamp)
                }
            }
            item(key = item.id) {
                when (item) {
                    is TimelineItem.MessageItem -> {
                        val isRemoved = item.message.id in removedMessageIds
                        MessageBubble(
                            message = item.message,
                            isRemoved = isRemoved,
                            onRemove = { onRemoveMessage(item.message.id) },
                            onUndoRemove = { onUndoRemove(item.message.id) }
                        )
                    }
                    is TimelineItem.CallItem -> CallHistoryBubble(item = item)
                }
            }
        }
    }
}

@Composable
private fun DateSeparator(timestamp: Long) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.Center
    ) {
        Text(
            text = formatDateLabel(timestamp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
            modifier = Modifier
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                .padding(horizontal = 12.dp, vertical = 4.dp)
        )
    }
}

@Composable
private fun CallHistoryBubble(item: TimelineItem.CallItem) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.Center
    ) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f))
                .padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            val (icon, label) = when (item.callType) {
                CallType.INCOMING -> "↙" to "Incoming call"
                CallType.OUTGOING -> "↗" to "Outgoing call"
                CallType.MISSED -> "✕" to "Missed call"
                CallType.UNANSWERED -> "✕" to "Unanswered call"
                CallType.DECLINED -> "✕" to "Declined call"
                CallType.BLOCKED -> "⊘" to "Blocked call"
            }
            val textColor = if (item.callType == CallType.MISSED || item.callType == CallType.UNANSWERED) {
                MaterialTheme.colorScheme.error
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            }

            Text(
                text = icon,
                style = MaterialTheme.typography.bodySmall,
                color = textColor
            )
            Text(
                text = label,
                style = MaterialTheme.typography.bodySmall,
                color = textColor
            )
            if (item.durationSeconds != null && item.durationSeconds > 0) {
                Text(
                    text = "(${formatCallDuration(item.durationSeconds)})",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                )
            }
            Text(
                text = formatMessageTime(item.timestamp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageBubble(
    message: MessageUiItem,
    isRemoved: Boolean = false,
    onRemove: () -> Unit = {},
    onUndoRemove: () -> Unit = {}
) {
    val isSent = message.direction == MessageDirection.SENT
    val context = LocalContext.current
    val hapticFeedback = LocalHapticFeedback.current

    var showMenu by remember { mutableStateOf(false) }

    val alignment = if (isSent) Alignment.End else Alignment.Start

    // If removed, show grayed out state with undo button
    if (isRemoved) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = if (isSent) Arrangement.End else Arrangement.Start,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .clip(RoundedCornerShape(16.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Text(
                    text = "Message removed",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    modifier = Modifier.weight(1f, fill = false)
                )
                TextButton(
                    onClick = onUndoRemove,
                    modifier = Modifier.height(32.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                ) {
                    Text("Undo", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
        return
    }

    val backgroundColor = if (isSent) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }
    val textColor = if (isSent) {
        MaterialTheme.colorScheme.onPrimaryContainer
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isSent) Arrangement.End else Arrangement.Start
    ) {
        Box {
            Column(
                modifier = Modifier
                    .widthIn(max = 280.dp)
                    .clip(
                        RoundedCornerShape(
                            topStart = 16.dp,
                            topEnd = 16.dp,
                            bottomStart = if (isSent) 16.dp else 4.dp,
                            bottomEnd = if (isSent) 4.dp else 16.dp
                        )
                    )
                    .background(backgroundColor)
                    .combinedClickable(
                        onClick = {},
                        onLongClick = {
                            hapticFeedback.performHapticFeedback(HapticFeedbackType.LongPress)
                            showMenu = true
                        }
                    )
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalAlignment = alignment
            ) {
                Text(
                    text = message.body,
                    style = MaterialTheme.typography.bodyMedium,
                    color = textColor
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    Text(
                        text = formatMessageTime(message.timestamp),
                        style = MaterialTheme.typography.labelSmall,
                        color = textColor.copy(alpha = 0.7f)
                    )
                    if (isSent && message.status != "sent" && message.status != "delivered") {
                        Text(
                            text = "· ${message.status}",
                            style = MaterialTheme.typography.labelSmall,
                            color = textColor.copy(alpha = 0.7f)
                        )
                    }
                }
            }

            // Context menu on long-press
            androidx.compose.material3.DropdownMenu(
                expanded = showMenu,
                onDismissRequest = { showMenu = false }
            ) {
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Copy") },
                    onClick = {
                        showMenu = false
                        val clipboard = context.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        val clip = android.content.ClipData.newPlainText("Message", message.body)
                        clipboard.setPrimaryClip(clip)
                        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
                            android.widget.Toast.makeText(context, "Message copied", android.widget.Toast.LENGTH_SHORT).show()
                        }
                    }
                )
                androidx.compose.material3.DropdownMenuItem(
                    text = { Text("Remove") },
                    onClick = {
                        showMenu = false
                        onRemove()
                    }
                )
            }
        }
    }
}

@Composable
private fun DetailErrorState(
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
                text = "Failed to load messages",
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
            TextButton(onClick = onRetry) {
                Text("Retry")
            }
        }
    }
}

private fun formatMessageTime(timestamp: Long): String {
    return SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(timestamp))
}

private fun formatDateKey(timestamp: Long): String {
    return SimpleDateFormat("yyyyMMdd", Locale.getDefault()).format(Date(timestamp))
}

private fun formatDateLabel(timestamp: Long): String {
    val today = Calendar.getInstance()
    val date = Calendar.getInstance().apply { timeInMillis = timestamp }

    val todayStart = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }
    val yesterdayStart = Calendar.getInstance().apply {
        timeInMillis = todayStart.timeInMillis
        add(Calendar.DAY_OF_YEAR, -1)
    }

    return when {
        timestamp >= todayStart.timeInMillis -> "Today"
        timestamp >= yesterdayStart.timeInMillis -> "Yesterday"
        else -> SimpleDateFormat("EEEE, dd/MM/yyyy", Locale.getDefault()).format(Date(timestamp))
    }
}

private fun formatCallDuration(totalSeconds: Int): String {
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return if (hours > 0) {
        "%d:%02d:%02d".format(hours, minutes, seconds)
    } else {
        "%d:%02d".format(minutes, seconds)
    }
}
