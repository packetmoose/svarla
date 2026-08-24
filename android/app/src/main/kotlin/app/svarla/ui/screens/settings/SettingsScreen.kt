package app.svarla.ui.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import app.svarla.BuildConfig
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.data.remote.dto.DeviceDto
import app.svarla.domain.notifications.NotificationDeliveryMode

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel = hiltViewModel()
) {
    val numbers by viewModel.numbers.collectAsState()
    val defaultNumber by viewModel.defaultNumber.collectAsState()
    val hasLoadedNumbers by viewModel.hasLoadedNumbers.collectAsState()
    val isLoggingOut by viewModel.isLoggingOut.collectAsState()
    var editingNumber by remember { mutableStateOf<ProviderNumber?>(null) }
    var editLabel by remember { mutableStateOf("") }
    var editBlockInbound by remember { mutableStateOf(false) }
    var showLogoutConfirmation by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(title = { Text("Settings") })
        }
    ) { paddingValues ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            // Phone Numbers section
            item {
                SectionHeader(title = "Phone Numbers")
            }

            if (numbers.isEmpty()) {
                item {
                    if (hasLoadedNumbers) {
                        Text(
                            text = "No numbers configured",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
                        )
                    }
                }
            } else {
                items(numbers, key = { it.number }) { number ->
                    NumberItem(
                        providerNumber = number,
                        isDefault = defaultNumber == number.number,
                        onEdit = {
                            editingNumber = number
                            editLabel = number.label ?: ""
                            editBlockInbound = number.blockInboundCalls
                        },
                        onSetDefault = { viewModel.setDefaultNumber(number.number) },
                        onClearDefault = { viewModel.clearDefaultNumber() }
                    )
                    HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                }
            }

            item {
                Spacer(modifier = Modifier.height(24.dp))
                SectionHeader(title = "Devices")
            }

            item {
                // Embed the device list inline
                DeviceListContent(modifier = Modifier.fillMaxWidth())
            }

            // Notification Delivery section
            item {
                Spacer(modifier = Modifier.height(24.dp))
                SectionHeader(title = "Notification Delivery")
            }

            item {
                NotificationDeliverySection(viewModel = viewModel)
            }

            // Logout button
            item {
                Spacer(modifier = Modifier.height(32.dp))
                HorizontalDivider(modifier = Modifier.padding(horizontal = 16.dp))
                Spacer(modifier = Modifier.height(16.dp))
                Button(
                    onClick = { showLogoutConfirmation = true },
                    enabled = !isLoggingOut,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error
                    ),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp)
                ) {
                    if (isLoggingOut) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            color = MaterialTheme.colorScheme.onError,
                            strokeWidth = 2.dp
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    } else {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Logout,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp)
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                    }
                    Text(if (isLoggingOut) "Logging out…" else "Log out")
                }
                Spacer(modifier = Modifier.height(24.dp))
            }

            // App version
            item {
                Text(
                    text = "Version ${BuildConfig.VERSION_NAME}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                    textAlign = TextAlign.Center
                )
            }
        }
    }

    // Logout confirmation dialog
    if (showLogoutConfirmation) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirmation = false },
            title = { Text("Log out") },
            text = { Text("Are you sure you want to log out of this device?") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showLogoutConfirmation = false
                        viewModel.logout()
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.error
                    )
                ) {
                    Text("Log out")
                }
            },
            dismissButton = {
                TextButton(onClick = { showLogoutConfirmation = false }) {
                    Text("Cancel")
                }
            }
        )
    }

    // Edit number settings dialog
    editingNumber?.let { number ->
        EditNumberDialog(
            phoneNumber = number.number,
            currentLabel = editLabel,
            blockInboundCalls = editBlockInbound,
            onLabelChanged = { editLabel = it },
            onBlockInboundChanged = { editBlockInbound = it },
            onConfirm = {
                viewModel.updateLabel(number.number, editLabel.trim())
                if (editBlockInbound != number.blockInboundCalls) {
                    viewModel.toggleBlockInbound(number.number)
                }
                editingNumber = null
            },
            onDismiss = { editingNumber = null }
        )
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        text = title,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
    )
}

@Composable
private fun NumberItem(
    providerNumber: ProviderNumber,
    isDefault: Boolean,
    onEdit: () -> Unit,
    onSetDefault: () -> Unit,
    onClearDefault: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onEdit)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = Icons.Default.Phone,
            contentDescription = null,
            tint = if (isDefault) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.primary
        )

        Spacer(modifier = Modifier.width(16.dp))

        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = providerNumber.number,
                    style = MaterialTheme.typography.bodyLarge
                )
                if (isDefault) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Default",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        modifier = Modifier
                            .background(
                                color = MaterialTheme.colorScheme.primaryContainer,
                                shape = MaterialTheme.shapes.small
                            )
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
                if (providerNumber.blockInboundCalls) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Blocked",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        modifier = Modifier
                            .background(
                                color = MaterialTheme.colorScheme.errorContainer,
                                shape = MaterialTheme.shapes.small
                            )
                            .padding(horizontal = 6.dp, vertical = 2.dp)
                    )
                }
            }
            Spacer(modifier = Modifier.height(2.dp))
            if (providerNumber.label != null) {
                Text(
                    text = providerNumber.label,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            } else {
                Text(
                    text = "No label",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "SMS, Voice",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                )
                Spacer(modifier = Modifier.width(12.dp))
                if (isDefault) {
                    TextButton(
                        onClick = onClearDefault,
                        modifier = Modifier.height(28.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                    ) {
                        Text(
                            text = "Clear default",
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                } else {
                    TextButton(
                        onClick = onSetDefault,
                        modifier = Modifier.height(28.dp),
                        contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp)
                    ) {
                        Text(
                            text = "Set as default",
                            style = MaterialTheme.typography.labelSmall
                        )
                    }
                }
            }
        }

        IconButton(onClick = onEdit) {
            Icon(
                imageVector = Icons.Default.Edit,
                contentDescription = "Edit number settings",
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun EditNumberDialog(
    phoneNumber: String,
    currentLabel: String,
    blockInboundCalls: Boolean,
    onLabelChanged: (String) -> Unit,
    onBlockInboundChanged: (Boolean) -> Unit,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Settings for $phoneNumber") },
        text = {
            Column {
                OutlinedTextField(
                    value = currentLabel,
                    onValueChange = onLabelChanged,
                    label = { Text("Label") },
                    placeholder = { Text("e.g. Personal, Business") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = "Block incoming calls",
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = "Callers will hear a message to send a text instead",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Switch(
                        checked = blockInboundCalls,
                        onCheckedChange = onBlockInboundChanged
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = onConfirm,
                enabled = currentLabel.trim().isNotEmpty()
            ) {
                Text("Save")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

/**
 * Inline device list content (reuses DeviceListScreen's ViewModel).
 */
@Composable
private fun DeviceListContent(
    modifier: Modifier = Modifier,
    viewModel: DeviceListViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    Column(modifier = modifier.padding(horizontal = 16.dp)) {
        when {
            uiState.isLoading && uiState.devices.isEmpty() -> {
                Text(
                    text = "Loading devices…",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 12.dp)
                )
            }

            uiState.error != null && uiState.devices.isEmpty() -> {
                Text(
                    text = uiState.error ?: "Failed to load devices",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(vertical = 12.dp)
                )
            }

            uiState.devices.isEmpty() -> {
                Text(
                    text = "No registered devices",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 12.dp)
                )
            }

            else -> {
                uiState.devices.forEach { device ->
                    val isThis = device.deviceId == uiState.currentDeviceId
                    InlineDeviceItem(
                        device = device,
                        isCurrentDevice = isThis,
                        isDeregistering = uiState.isDeregistering,
                        onDeregister = { viewModel.showDeregisterConfirmation(device) }
                    )
                    HorizontalDivider()
                }
            }
        }
    }

    // Deregister confirmation dialog
    uiState.showDeregisterDialog?.let { device ->
        AlertDialog(
            onDismissRequest = { viewModel.dismissDeregisterDialog() },
            title = { Text("Remove ${device.deviceName}?") },
            text = { Text("This device will be signed out.") },
            confirmButton = {
                TextButton(
                    onClick = { viewModel.confirmDeregister() },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.error
                    )
                ) {
                    Text("Remove")
                }
            },
            dismissButton = {
                TextButton(onClick = { viewModel.dismissDeregisterDialog() }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun InlineDeviceItem(
    device: DeviceDto,
    isCurrentDevice: Boolean,
    isDeregistering: Boolean,
    onDeregister: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = Icons.Default.PhoneAndroid,
            contentDescription = null,
            tint = if (isCurrentDevice) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = device.deviceName,
                    style = MaterialTheme.typography.bodyLarge
                )
                if (isCurrentDevice) {
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "This device",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }
            Text(
                text = "Last seen: ${device.lastSeenAt.take(16).replace("T", " ")}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (!isCurrentDevice) {
            TextButton(
                onClick = onDeregister,
                enabled = !isDeregistering,
                colors = ButtonDefaults.textButtonColors(
                    contentColor = MaterialTheme.colorScheme.error
                )
            ) {
                Text("Deregister")
            }
        }
    }
}

// ========================================================================
// Notification Delivery Mode Section
// ========================================================================

@Composable
private fun NotificationDeliverySection(
    viewModel: SettingsViewModel
) {
    val deliveryMode by viewModel.deliveryMode.collectAsState()
    val isUnifiedPushAvailable by viewModel.isUnifiedPushAvailable.collectAsState()
    val context = LocalContext.current
    var showBatteryDialog by remember { mutableStateOf(false) }

    Column(modifier = Modifier.padding(horizontal = 16.dp)) {
        Text(
            text = "Choose how the app receives incoming calls and messages in the background.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 12.dp)
        )

        // UnifiedPush option
        DeliveryModeOption(
            title = "UnifiedPush",
            description = if (isUnifiedPushAvailable) {
                "Battery-friendly push via a distributor app (e.g., ntfy). Recommended."
            } else {
                "No UnifiedPush distributor found. Install one (e.g., ntfy) to enable."
            },
            selected = deliveryMode == NotificationDeliveryMode.UNIFIED_PUSH,
            enabled = isUnifiedPushAvailable,
            onClick = { viewModel.setDeliveryMode(NotificationDeliveryMode.UNIFIED_PUSH) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // WebSocket option
        DeliveryModeOption(
            title = "Persistent connection",
            description = "Keeps a background WebSocket connection alive. Uses more battery but works without a push distributor.",
            selected = deliveryMode == NotificationDeliveryMode.WEBSOCKET,
            enabled = true,
            onClick = {
                if (!viewModel.isIgnoringBatteryOptimizations()) {
                    showBatteryDialog = true
                } else {
                    viewModel.setDeliveryMode(NotificationDeliveryMode.WEBSOCKET)
                }
            }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // None option
        DeliveryModeOption(
            title = "None",
            description = "No background notifications. You will only receive calls and messages while the app is open.",
            selected = deliveryMode == NotificationDeliveryMode.NONE,
            enabled = true,
            onClick = { viewModel.setDeliveryMode(NotificationDeliveryMode.NONE) }
        )

        // Battery optimization warning for WebSocket mode
        if (deliveryMode == NotificationDeliveryMode.WEBSOCKET &&
            !viewModel.isIgnoringBatteryOptimizations()
        ) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = "⚠️ Battery optimization is still enabled. The persistent connection may be interrupted. Tap to fix.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable {
                        val intent = viewModel.batteryOptimizationHelper
                            .createRequestIgnoreBatteryOptimizationsIntent()
                        context.startActivity(intent)
                    }
                    .padding(vertical = 8.dp)
            )
        }

        // OEM auto-start restriction warning
        if (deliveryMode == NotificationDeliveryMode.WEBSOCKET &&
            viewModel.autoStartHelper.shouldShowAutoStartPrompt()
        ) {
            val autoStartIntent = viewModel.autoStartHelper.getAutoStartSettingsIntent()
            if (autoStartIntent != null) {
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    text = "⚠️ ${viewModel.autoStartHelper.getManufacturerDisplayName()} devices may block auto-start. " +
                        "Tap to allow Svarla to start automatically after reboot.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable {
                            viewModel.autoStartHelper.markPromptShown()
                            context.startActivity(autoStartIntent)
                        }
                        .padding(vertical = 8.dp)
                )
            }
        }
    }

    // Battery optimization dialog
    if (showBatteryDialog) {
        AlertDialog(
            onDismissRequest = { showBatteryDialog = false },
            title = { Text("Disable battery optimization") },
            text = {
                Text(
                    "The persistent connection requires the app to be exempt from battery " +
                    "optimization so Android doesn't kill the background service.\n\n" +
                    "You'll be asked to allow unrestricted battery usage for Svarla."
                )
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showBatteryDialog = false
                        val intent = viewModel.batteryOptimizationHelper
                            .createRequestIgnoreBatteryOptimizationsIntent()
                        context.startActivity(intent)
                        viewModel.setDeliveryMode(NotificationDeliveryMode.WEBSOCKET)
                    }
                ) {
                    Text("Continue")
                }
            },
            dismissButton = {
                TextButton(onClick = { showBatteryDialog = false }) {
                    Text("Cancel")
                }
            }
        )
    }
}

@Composable
private fun DeliveryModeOption(
    title: String,
    description: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = onClick
            )
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.Top
    ) {
        RadioButton(
            selected = selected,
            onClick = null, // handled by selectable
            enabled = enabled
        )
        Spacer(modifier = Modifier.width(12.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (enabled) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
            )
            Spacer(modifier = Modifier.height(2.dp))
            Text(
                text = description,
                style = MaterialTheme.typography.bodySmall,
                color = if (enabled) MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.38f)
            )
        }
    }
}
