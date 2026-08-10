package app.svarla.ui.screens.call

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import app.svarla.ui.components.NumberBadge
import app.svarla.ui.theme.CallActiveGreen
import app.svarla.ui.theme.CallEndRed
import app.svarla.ui.theme.dimensions
import app.svarla.ui.theme.spacing

/**
 * Incoming call screen displayed when callState.status == RINGING.
 *
 * Shows caller number, contact name (if available), which provider number was called,
 * and large Answer (green) / Decline (red) buttons.
 *
 * Requirements covered: 2.1, 2.3, 2.7, 13.9
 *
 * @param callerNumber The remote caller's phone number (E.164)
 * @param contactName Resolved contact name (null if no match)
 * @param providerNumberLabel Label of the provider number that was called (e.g., "Personal")
 * @param providerNumberColor Hex color of the provider number
 * @param onAnswer Callback when the answer button is tapped
 * @param onDecline Callback when the decline button is tapped
 */
@Composable
fun IncomingCallScreen(
    callerNumber: String,
    contactName: String? = null,
    providerNumberLabel: String? = null,
    providerNumberColor: String? = null,
    onAnswer: () -> Unit,
    onDecline: () -> Unit
) {
    val haptic = LocalHapticFeedback.current

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(MaterialTheme.spacing.large),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.SpaceBetween
        ) {
            // Top section: caller info
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = MaterialTheme.spacing.xxxLarge),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Provider number label (which number was called) — show at the top for clarity
                if (providerNumberLabel != null) {
                    Text(
                        text = "Incoming call to",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))
                    NumberBadge(
                        label = providerNumberLabel,
                        color = providerNumberColor ?: "#6750A4"
                    )
                } else {
                    Text(
                        text = "Incoming Call",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.large))

                // Contact name or caller number as primary display
                Text(
                    text = contactName ?: callerNumber,
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics {
                        contentDescription = "Incoming call from ${contactName ?: callerNumber}"
                    }
                )

                // Show number below name if contact name is available
                if (contactName != null) {
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))
                    Text(
                        text = callerNumber,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                }
            }

            // Bottom section: answer/decline buttons
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(bottom = MaterialTheme.spacing.xxLarge),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Decline button (red)
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    IconButton(
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onDecline()
                        },
                        modifier = Modifier
                            .size(MaterialTheme.dimensions.callEndButtonSize)
                            .background(
                                color = CallEndRed,
                                shape = CircleShape
                            ),
                        colors = IconButtonDefaults.iconButtonColors(
                            containerColor = Color.Transparent,
                            contentColor = Color.White
                        )
                    ) {
                        Icon(
                            imageVector = Icons.Default.CallEnd,
                            contentDescription = "Decline call",
                            modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge)
                        )
                    }
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))
                    Text(
                        text = "Decline",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Answer button (green)
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    IconButton(
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onAnswer()
                        },
                        modifier = Modifier
                            .size(MaterialTheme.dimensions.callEndButtonSize)
                            .background(
                                color = CallActiveGreen,
                                shape = CircleShape
                            ),
                        colors = IconButtonDefaults.iconButtonColors(
                            containerColor = Color.Transparent,
                            contentColor = Color.White
                        )
                    ) {
                        Icon(
                            imageVector = Icons.Default.Call,
                            contentDescription = "Answer call",
                            modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge)
                        )
                    }
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))
                    Text(
                        text = "Answer",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}
