package app.svarla.ui.screens.call

import android.content.Context
import android.os.PowerManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bluetooth
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.Dialpad
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.PhoneInTalk
import androidx.compose.material.icons.filled.VolumeOff
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconToggleButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.svarla.domain.audio.AudioDevice
import app.svarla.domain.audio.AudioRouter
import app.svarla.domain.call.CallEndReason
import app.svarla.domain.call.CallStatus
import app.svarla.domain.call.VoiceCallManager
import app.svarla.ui.theme.CallEndRed
import app.svarla.ui.theme.dimensions
import app.svarla.ui.theme.spacing
import kotlinx.coroutines.delay

/**
 * Active call screen displaying elapsed duration, remote party info, and call controls.
 *
 * Features:
 * - Mute toggle button bound to isMuted state
 * - Speaker toggle button bound to isSpeakerOn state
 * - Current audio device indicator
 * - Call duration display from elapsedDurationSeconds
 * - Error message display for 3 seconds when call ends with errorMessage
 *
 * Requirements covered: 9.1, 9.2, 9.6, 11.5
 *
 * @param voiceCallManager The call manager providing call state and duration
 * @param audioRouter The audio router providing mute/speaker state
 * @param contactName Resolved contact name (null if no match)
 * @param onEndCall Callback when end call is tapped
 * @param onDialPadClick Callback to show in-call dial pad overlay
 */
@Composable
fun ActiveCallScreen(
    voiceCallManager: VoiceCallManager,
    audioRouter: AudioRouter,
    contactName: String? = null,
    onEndCall: () -> Unit,
    onDialPadClick: () -> Unit
) {
    val callState by voiceCallManager.callState.collectAsState()
    val elapsedSeconds by voiceCallManager.elapsedDurationSeconds.collectAsState()
    val isMuted by voiceCallManager.isMuted.collectAsState()
    val currentAudioDevice by voiceCallManager.currentAudioDevice.collectAsState()
    val availableDevices by voiceCallManager.availableDevices.collectAsState()
    val haptic = LocalHapticFeedback.current
    val context = LocalContext.current

    var showDialPad by remember { mutableStateOf(false) }

    // Proximity sensor wake lock — turns screen off when phone is held to ear
    DisposableEffect(Unit) {
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK,
            "svarla:call_proximity"
        )
        wakeLock.acquire()
        onDispose {
            if (wakeLock.isHeld) {
                wakeLock.release()
            }
        }
    }

    val remoteNumber = callState.activeCallInfo?.remoteNumber ?: ""
    val formattedDuration = formatDuration(elapsedSeconds)

    // Error message display state: show for 3 seconds when call ends with an error
    var showErrorMessage by remember { mutableStateOf(false) }
    var errorText by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(callState.status, callState.errorMessage) {
        if (callState.status == CallStatus.ENDED && callState.errorMessage != null) {
            errorText = callState.errorMessage
            showErrorMessage = true
            delay(3000L)
            showErrorMessage = false
        }
    }

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
            // Top section: call info
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = MaterialTheme.spacing.xxLarge),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Contact name or number as primary display
                Text(
                    text = contactName ?: remoteNumber,
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.semantics {
                        contentDescription = "Call with ${contactName ?: remoteNumber}"
                    }
                )

                // Show number below name if contact name is available
                if (contactName != null) {
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))
                    Text(
                        text = remoteNumber,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center
                    )
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.medium))

                // Elapsed duration (shown for connected calls and kept visible when ended)
                if (callState.status != CallStatus.DIALING) {
                    Text(
                        text = formattedDuration,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics {
                            contentDescription = "Call duration $formattedDuration"
                        }
                    )
                }

                // Call status text (shown when dialing or ended)
                if (callState.status == CallStatus.ENDED || callState.status == CallStatus.DIALING) {
                    Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))

                    val statusText = when (callState.status) {
                        CallStatus.ENDED -> callState.endReason?.let { reason ->
                            when (reason) {
                                CallEndReason.REMOTE_HANGUP -> "Call Ended"
                                CallEndReason.LOCAL_HANGUP -> "Call Ended"
                                CallEndReason.DECLINED -> "Call Declined"
                                CallEndReason.ANSWERED_ELSEWHERE -> "Answered Elsewhere"
                                CallEndReason.TIMEOUT -> "No Answer"
                                CallEndReason.UNANSWERED -> "No Answer"
                                CallEndReason.CONNECTIVITY_LOST -> "Connection Lost"
                                CallEndReason.FAILED -> "Call Failed"
                            }
                        } ?: "Call Ended"
                        else -> "Calling…"
                    }

                    Text(
                        text = statusText,
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                        textAlign = TextAlign.Center,
                        modifier = Modifier.semantics {
                            contentDescription = statusText
                        }
                    )
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))

                // Current audio device indicator
                AudioDeviceIndicator(audioDevice = currentAudioDevice)

                // Error message banner (shown for 3 seconds on call end with error)
                AnimatedVisibility(
                    visible = showErrorMessage,
                    enter = fadeIn(),
                    exit = fadeOut()
                ) {
                    Text(
                        text = errorText ?: "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onError,
                        textAlign = TextAlign.Center,
                        modifier = Modifier
                            .padding(top = MaterialTheme.spacing.medium)
                            .background(
                                color = MaterialTheme.colorScheme.error,
                                shape = RoundedCornerShape(8.dp)
                            )
                            .padding(
                                horizontal = MaterialTheme.spacing.medium,
                                vertical = MaterialTheme.spacing.small
                            )
                            .semantics {
                                contentDescription = "Error: ${errorText ?: ""}"
                            }
                    )
                }
            }

            // Middle section: control buttons
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Mute toggle
                    CallControlButton(
                        isActive = isMuted,
                        activeIcon = Icons.Default.MicOff,
                        inactiveIcon = Icons.Default.Mic,
                        activeDescription = "Unmute microphone",
                        inactiveDescription = "Mute microphone",
                        onClick = { voiceCallManager.toggleMute() }
                    )

                    // Audio device selector
                    AudioDeviceSelector(
                        currentDevice = currentAudioDevice,
                        availableDevices = availableDevices,
                        onDeviceSelected = { device -> voiceCallManager.selectAudioDevice(device) }
                    )

                    // Dial pad button
                    IconButton(
                        onClick = { showDialPad = true },
                        modifier = Modifier.size(MaterialTheme.dimensions.callControlButtonSize)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Dialpad,
                            contentDescription = "Open dial pad",
                            modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge),
                            tint = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
            }

            // Bottom section: end call button
            IconButton(
                onClick = {
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                    onEndCall()
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
                    contentDescription = "End call",
                    modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge)
                )
            }

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.extraLarge))
        }
    }

    // In-call dial pad overlay
    if (showDialPad) {
        app.svarla.ui.screens.dialpad.InCallDialPadOverlay(
            onDtmfTone = { digit -> voiceCallManager.sendDtmf(digit) },
            onDismiss = { showDialPad = false }
        )
    }
}

/**
 * Displays the current audio device with an icon and label.
 *
 * @param audioDevice The currently active audio output device
 */
@Composable
private fun AudioDeviceIndicator(audioDevice: AudioDevice) {
    val (icon, label) = audioDeviceDisplayInfo(audioDevice)

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Center,
        modifier = Modifier.semantics {
            contentDescription = "Audio output: $label"
        }
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            modifier = Modifier.size(16.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp)
        )
    }
}

/**
 * Audio device selector button that shows a dropdown menu with available audio devices.
 * Tapping cycles through devices or shows the picker when multiple devices are available.
 */
@Composable
private fun AudioDeviceSelector(
    currentDevice: AudioDevice,
    availableDevices: Set<AudioDevice>,
    onDeviceSelected: (AudioDevice) -> Unit
) {
    var showMenu by remember { mutableStateOf(false) }
    val (icon, _) = audioDeviceDisplayInfo(currentDevice)

    androidx.compose.foundation.layout.Box {
        IconButton(
            onClick = { showMenu = true },
            modifier = Modifier.size(56.dp)
        ) {
            Icon(
                imageVector = icon,
                contentDescription = "Select audio device",
                modifier = Modifier.size(24.dp),
                tint = MaterialTheme.colorScheme.onSurface
            )
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false }
        ) {
            availableDevices.sortedByDescending { it.priority }.forEach { device ->
                val (deviceIcon, deviceLabel) = audioDeviceDisplayInfo(device)
                DropdownMenuItem(
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            Icon(
                                imageVector = deviceIcon,
                                contentDescription = null,
                                modifier = Modifier.size(20.dp),
                                tint = if (device == currentDevice)
                                    MaterialTheme.colorScheme.primary
                                else
                                    MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                text = deviceLabel,
                                color = if (device == currentDevice)
                                    MaterialTheme.colorScheme.primary
                                else
                                    MaterialTheme.colorScheme.onSurface
                            )
                        }
                    },
                    onClick = {
                        onDeviceSelected(device)
                        showMenu = false
                    }
                )
            }
        }
    }
}

/**
 * Returns the icon and display label for a given audio device.
 */
private fun audioDeviceDisplayInfo(device: AudioDevice): Pair<ImageVector, String> {
    return when (device) {
        AudioDevice.EARPIECE -> Icons.Default.PhoneInTalk to "Earpiece"
        AudioDevice.SPEAKER -> Icons.Default.VolumeUp to "Speaker"
        AudioDevice.BLUETOOTH -> Icons.Default.Bluetooth to "Bluetooth"
        AudioDevice.WIRED_HEADPHONES -> Icons.Default.Headphones to "Headphones"
    }
}

/**
 * A toggle button for call controls (mute, speaker).
 */
@Composable
private fun CallControlButton(
    isActive: Boolean,
    activeIcon: ImageVector,
    inactiveIcon: ImageVector,
    activeDescription: String,
    inactiveDescription: String,
    onClick: () -> Unit
) {
    FilledIconToggleButton(
        checked = isActive,
        onCheckedChange = { onClick() },
        modifier = Modifier.size(56.dp)
    ) {
        Icon(
            imageVector = if (isActive) activeIcon else inactiveIcon,
            contentDescription = if (isActive) activeDescription else inactiveDescription,
            modifier = Modifier.size(24.dp)
        )
    }
}

/**
 * Formats elapsed seconds into HH:MM:SS format.
 *
 * @param totalSeconds The total elapsed seconds
 * @return Formatted duration string (e.g., "00:05:32")
 */
internal fun formatDuration(totalSeconds: Long): String {
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return "%02d:%02d:%02d".format(hours, minutes, seconds)
}
