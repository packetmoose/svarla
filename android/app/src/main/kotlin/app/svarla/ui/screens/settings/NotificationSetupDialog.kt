package app.svarla.ui.screens.settings

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.svarla.domain.notifications.AutoStartHelper
import app.svarla.domain.notifications.NotificationDeliveryMode

/**
 * Dialog shown on first login when UnifiedPush is NOT available.
 * Asks the user to choose between persistent WebSocket or no notifications.
 *
 * If UnifiedPush IS available, the app auto-selects it and this dialog is not shown.
 */
@Composable
fun NotificationSetupDialog(
    autoStartHelper: AutoStartHelper? = null,
    onModeSelected: (NotificationDeliveryMode) -> Unit,
    onDismiss: () -> Unit
) {
    var selectedMode by remember { mutableStateOf(NotificationDeliveryMode.WEBSOCKET) }
    val context = LocalContext.current

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Notification delivery") },
        text = {
            Column {
                Text(
                    text = "No UnifiedPush distributor was found on this device. " +
                        "How would you like to receive incoming calls and messages?",
                    style = MaterialTheme.typography.bodyMedium
                )
                Spacer(modifier = Modifier.height(16.dp))

                // Persistent connection option
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = selectedMode == NotificationDeliveryMode.WEBSOCKET,
                            role = Role.RadioButton,
                            onClick = { selectedMode = NotificationDeliveryMode.WEBSOCKET }
                        )
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.Top
                ) {
                    RadioButton(
                        selected = selectedMode == NotificationDeliveryMode.WEBSOCKET,
                        onClick = null
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "Persistent connection",
                            style = MaterialTheme.typography.bodyLarge
                        )
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            text = "Keeps a background connection open to receive notifications instantly. Uses slightly more battery.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.height(4.dp))

                // No notifications option
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .selectable(
                            selected = selectedMode == NotificationDeliveryMode.NONE,
                            role = Role.RadioButton,
                            onClick = { selectedMode = NotificationDeliveryMode.NONE }
                        )
                        .padding(vertical = 8.dp),
                    verticalAlignment = Alignment.Top
                ) {
                    RadioButton(
                        selected = selectedMode == NotificationDeliveryMode.NONE,
                        onClick = null
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Column {
                        Text(
                            text = "No background notifications",
                            style = MaterialTheme.typography.bodyLarge
                        )
                        Spacer(modifier = Modifier.height(2.dp))
                        Text(
                            text = "You will only see calls and messages while the app is open. You can change this in Settings later.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    if (selectedMode == NotificationDeliveryMode.WEBSOCKET) {
                        // Request battery optimization exemption
                        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                        if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${context.packageName}")
                            }
                            context.startActivity(intent)
                        }
                        // Open OEM auto-start settings if needed
                        if (autoStartHelper != null && autoStartHelper.shouldShowAutoStartPrompt()) {
                            val autoStartIntent = autoStartHelper.getAutoStartSettingsIntent()
                            if (autoStartIntent != null) {
                                autoStartHelper.markPromptShown()
                                context.startActivity(autoStartIntent)
                            }
                        }
                    }
                    onModeSelected(selectedMode)
                }
            ) {
                Text("Continue")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Skip")
            }
        }
    )
}
