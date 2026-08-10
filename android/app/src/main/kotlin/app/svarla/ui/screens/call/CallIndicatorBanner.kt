package app.svarla.ui.screens.call

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import app.svarla.ui.theme.CallActiveGreen
import app.svarla.ui.theme.dimensions
import app.svarla.ui.theme.spacing

/**
 * Data class representing an active call on another device.
 */
data class RemoteCallInfo(
    /** Remote party number or contact name */
    val remoteParty: String,
    /** Label of the provider number in use (e.g., "Personal") */
    val providerNumberLabel: String,
    /** Name of the device handling the call */
    val deviceName: String,
    /** Elapsed call duration in seconds */
    val durationSeconds: Long
)

/**
 * A dismissible banner displayed on other screens when a call is active on another device.
 *
 * Shows the remote party, provider number label, device name, and elapsed duration.
 * Can be dismissed by the user.
 *
 * Requirements covered: 1.9, 1.10, 2.8
 *
 * @param remoteCallInfo Information about the active call on another device, null when no remote call
 * @param isVisible Whether the banner should be visible
 * @param onDismiss Callback when the banner is dismissed
 */
@Composable
fun CallIndicatorBanner(
    remoteCallInfo: RemoteCallInfo?,
    isVisible: Boolean,
    onDismiss: () -> Unit
) {
    AnimatedVisibility(
        visible = isVisible && remoteCallInfo != null,
        enter = slideInVertically(initialOffsetY = { -it }) + fadeIn(),
        exit = slideOutVertically(targetOffsetY = { -it }) + fadeOut()
    ) {
        remoteCallInfo?.let { info ->
            val formattedDuration = formatDuration(info.durationSeconds)

            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        horizontal = MaterialTheme.spacing.medium,
                        vertical = MaterialTheme.spacing.small
                    )
                    .semantics {
                        contentDescription = "Active call on ${info.deviceName} with ${info.remoteParty}"
                    },
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer
                )
            ) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(MaterialTheme.spacing.smallMedium),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    // Call icon
                    Icon(
                        imageVector = Icons.Default.Call,
                        contentDescription = null,
                        modifier = Modifier.size(MaterialTheme.dimensions.iconSizeMedium),
                        tint = CallActiveGreen
                    )

                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.smallMedium))

                    // Call details
                    Column(
                        modifier = Modifier.weight(1f)
                    ) {
                        // Remote party name/number
                        Text(
                            text = info.remoteParty,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )

                        // Provider number label + device name
                        Text(
                            text = "${info.providerNumberLabel} · ${info.deviceName}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.7f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }

                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.small))

                    // Duration
                    Text(
                        text = formattedDuration,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onPrimaryContainer
                    )

                    Spacer(modifier = Modifier.width(MaterialTheme.spacing.small))

                    // Dismiss button
                    IconButton(
                        onClick = onDismiss,
                        modifier = Modifier.size(MaterialTheme.dimensions.minTouchTarget)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Dismiss call indicator",
                            modifier = Modifier.size(MaterialTheme.dimensions.iconSizeSmall),
                            tint = MaterialTheme.colorScheme.onPrimaryContainer
                        )
                    }
                }
            }
        }
    }
}
