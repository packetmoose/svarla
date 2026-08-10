package app.svarla.ui.screens.numbers

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.ui.components.NumberInUseStatus

/**
 * Number management screen listing all provider numbers with their labels.
 *
 * Features:
 * - List all numbers with labels (or "No label" if none)
 * - Inline label editing via TextField (1-30 characters)
 * - In-use status indicator when a number is active on another device
 * - Sync button to refresh numbers from provider API
 *
 * Requirements covered: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NumberManagementScreen(
    onNavigateBack: () -> Unit,
    viewModel: NumberManagementViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // Show sync error as snackbar
    LaunchedEffect(uiState.syncError) {
        uiState.syncError?.let { error ->
            snackbarHostState.showSnackbar(error)
            viewModel.dismissSyncError()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Manage Numbers") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Navigate back"
                        )
                    }
                },
                actions = {
                    IconButton(
                        onClick = { viewModel.syncNumbers() },
                        enabled = !uiState.isSyncing
                    ) {
                        if (uiState.isSyncing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(20.dp),
                                strokeWidth = 2.dp
                            )
                        } else {
                            Icon(
                                imageVector = Icons.Default.Refresh,
                                contentDescription = "Sync numbers"
                            )
                        }
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            // Syncing progress indicator
            AnimatedVisibility(
                visible = uiState.isSyncing,
                enter = fadeIn(),
                exit = fadeOut()
            ) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }

            when {
                uiState.isLoading -> {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }

                uiState.numbers.isEmpty() -> {
                    Box(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(32.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(
                                text = "No Numbers",
                                style = MaterialTheme.typography.titleMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = "No numbers found. Tap the sync button to refresh.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

                else -> {
                    LazyColumn(
                        modifier = Modifier
                            .fillMaxSize()
                            .padding(horizontal = 16.dp),
                        verticalArrangement = Arrangement.spacedBy(0.dp)
                    ) {
                        item {
                            Spacer(modifier = Modifier.height(8.dp))
                            Text(
                                text = "${uiState.numbers.size} number${if (uiState.numbers.size != 1) "s" else ""}",
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(bottom = 8.dp)
                            )
                        }

                        items(
                            items = uiState.numbers,
                            key = { it.number }
                        ) { providerNumber ->
                            val editState = uiState.editStates[providerNumber.number]
                            val inUseStatus = uiState.inUseStatuses[providerNumber.number]

                            NumberListItem(
                                providerNumber = providerNumber,
                                editState = editState,
                                inUseStatus = inUseStatus,
                                onStartEditing = { viewModel.startEditing(providerNumber.number) },
                                onCancelEditing = { viewModel.cancelEditing(providerNumber.number) },
                                onLabelChanged = { newLabel ->
                                    viewModel.onLabelChanged(providerNumber.number, newLabel)
                                },
                                onSaveLabel = { viewModel.saveLabel(providerNumber.number) },
                                onToggleBlockInbound = { viewModel.toggleBlockInbound(providerNumber.number) }
                            )

                            if (providerNumber != uiState.numbers.last()) {
                                HorizontalDivider(
                                    color = MaterialTheme.colorScheme.outlineVariant
                                )
                            }
                        }

                        item {
                            Spacer(modifier = Modifier.height(16.dp))
                        }
                    }
                }
            }
        }
    }
}

/**
 * A single number item in the management list.
 *
 * Shows:
 * - Phone number in E.164 format
 * - Label (or "No label" placeholder)
 * - Edit button to enter inline editing mode
 * - In-use indicator if active on another device
 * - Block incoming calls toggle
 *
 * In editing mode:
 * - TextField for label input
 * - Save (check) and Cancel (close) buttons
 * - Character count and validation errors
 */
@Composable
private fun NumberListItem(
    providerNumber: ProviderNumber,
    editState: NumberEditState?,
    inUseStatus: NumberInUseStatus?,
    onStartEditing: () -> Unit,
    onCancelEditing: () -> Unit,
    onLabelChanged: (String) -> Unit,
    onSaveLabel: () -> Unit,
    onToggleBlockInbound: () -> Unit
) {
    val isEditing = editState?.isEditing == true

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp, horizontal = 4.dp)
        ) {
            if (isEditing && editState != null) {
                // Editing mode
                EditingModeContent(
                    providerNumber = providerNumber,
                    editState = editState,
                    onLabelChanged = onLabelChanged,
                    onSave = onSaveLabel,
                    onCancel = onCancelEditing
                )
            } else {
                // Display mode
                DisplayModeContent(
                    providerNumber = providerNumber,
                    inUseStatus = inUseStatus,
                    onStartEditing = onStartEditing,
                    onToggleBlockInbound = onToggleBlockInbound
                )
            }
        }
    }
}

@Composable
private fun DisplayModeContent(
    providerNumber: ProviderNumber,
    inUseStatus: NumberInUseStatus?,
    onStartEditing: () -> Unit,
    onToggleBlockInbound: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            // Phone number
            Text(
                text = providerNumber.number,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(modifier = Modifier.height(2.dp))

            // Label or placeholder
            Text(
                text = providerNumber.label ?: "No label",
                style = MaterialTheme.typography.bodyMedium,
                color = if (providerNumber.label != null) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            // In-use status
            if (inUseStatus != null) {
                Spacer(modifier = Modifier.height(4.dp))
                InUseStatusIndicator(inUseStatus)
            }

            // Block incoming calls toggle
            Spacer(modifier = Modifier.height(8.dp))
            BlockInboundToggle(
                checked = providerNumber.blockInboundCalls,
                onToggle = onToggleBlockInbound
            )
        }

        // Edit button
        IconButton(onClick = onStartEditing) {
            Icon(
                imageVector = Icons.Default.Edit,
                contentDescription = "Edit label for ${providerNumber.number}",
                tint = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
private fun EditingModeContent(
    providerNumber: ProviderNumber,
    editState: NumberEditState,
    onLabelChanged: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit
) {
    // Number display
    Text(
        text = providerNumber.number,
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurface
    )

    Spacer(modifier = Modifier.height(8.dp))

    // Label edit field
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top
    ) {
        OutlinedTextField(
            value = editState.editingLabel,
            onValueChange = onLabelChanged,
            label = { Text("Label") },
            placeholder = { Text("e.g., Personal, Business") },
            isError = editState.error != null,
            supportingText = {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = editState.error ?: "",
                        color = if (editState.error != null) {
                            MaterialTheme.colorScheme.error
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        }
                    )
                    Text(
                        text = "${editState.editingLabel.length}/30",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { onSave() }),
            enabled = !editState.isSaving,
            modifier = Modifier.weight(1f)
        )

        Spacer(modifier = Modifier.width(4.dp))

        // Save button
        IconButton(
            onClick = onSave,
            enabled = !editState.isSaving
        ) {
            if (editState.isSaving) {
                CircularProgressIndicator(
                    modifier = Modifier.size(20.dp),
                    strokeWidth = 2.dp
                )
            } else {
                Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = "Save label",
                    tint = MaterialTheme.colorScheme.primary
                )
            }
        }

        // Cancel button
        IconButton(
            onClick = onCancel,
            enabled = !editState.isSaving
        ) {
            Icon(
                imageVector = Icons.Default.Close,
                contentDescription = "Cancel editing",
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

/**
 * Toggle switch for blocking incoming calls on a number.
 */
@Composable
private fun BlockInboundToggle(
    checked: Boolean,
    onToggle: () -> Unit
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            text = "Block incoming calls",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f)
        )
        androidx.compose.material3.Switch(
            checked = checked,
            onCheckedChange = { onToggle() }
        )
    }
}

/**
 * Displays an "In use on [device]" indicator with a colored dot.
 */
@Composable
private fun InUseStatusIndicator(status: NumberInUseStatus) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        androidx.compose.foundation.Canvas(
            modifier = Modifier.size(8.dp)
        ) {
            drawCircle(color = androidx.compose.ui.graphics.Color(0xFFFF6B00))
        }
        Spacer(modifier = Modifier.width(6.dp))
        Text(
            text = "In use on ${status.deviceName}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.tertiary
        )
    }
}
