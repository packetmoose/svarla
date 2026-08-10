package app.svarla.ui.screens.dialpad

import android.media.AudioManager
import android.media.ToneGenerator
import android.util.Log
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.svarla.ui.theme.dimensions
import app.svarla.ui.theme.spacing

/**
 * In-call dial pad overlay for transmitting DTMF tones during an active call.
 *
 * Displays a smaller dial pad grid overlay on top of the active call screen.
 * Each tap transmits the corresponding DTMF tone via VoiceCallManager and plays
 * local audio feedback using ToneGenerator.
 *
 * Requirements covered: 14.10, 14.11, 14.12
 *
 * @param onDtmfTone Callback to transmit a DTMF tone character (0-9, *, #).
 *                   Implementation should call VoiceCallManager's DTMF sending method.
 *                   Must complete within 200ms.
 * @param onDismiss Callback to close the overlay
 */
@Composable
fun InCallDialPadOverlay(
    onDtmfTone: (Char) -> Unit,
    onDismiss: () -> Unit
) {
    // ToneGenerator for local audio feedback
    val toneGenerator = remember {
        try {
            ToneGenerator(AudioManager.STREAM_DTMF, 80)
        } catch (e: Exception) {
            Log.e("InCallDialPad", "Failed to create ToneGenerator", e)
            null
        }
    }

    // Track sent DTMF digits for display
    val sentDigits = remember { mutableStateOf("") }

    DisposableEffect(Unit) {
        onDispose {
            toneGenerator?.release()
        }
    }

    // Full-screen scrim + overlay
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.scrim.copy(alpha = 0.6f))
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.BottomCenter
    ) {
        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = false, onClick = {}), // Prevent dismiss when tapping pad
            shape = RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp),
            color = MaterialTheme.colorScheme.surface,
            tonalElevation = 6.dp
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(MaterialTheme.spacing.medium),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // Close button and title row
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = "DTMF Dial Pad",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurface
                    )
                    IconButton(onClick = onDismiss) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Close dial pad",
                            tint = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }

                // Display sent digits
                if (sentDigits.value.isNotEmpty()) {
                    Text(
                        text = sentDigits.value,
                        style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = MaterialTheme.spacing.small)
                    )
                }

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))

                // DTMF dial pad grid
                DtmfGrid(
                    onKeyPress = { digit ->
                        // Play local DTMF feedback tone
                        playDtmfTone(toneGenerator, digit)
                        // Transmit DTMF to remote party
                        onDtmfTone(digit)
                        // Update display
                        sentDigits.value += digit
                    }
                )

                Spacer(modifier = Modifier.height(MaterialTheme.spacing.large))
            }
        }
    }
}

// =============================================================================
// DTMF Grid
// =============================================================================

/**
 * DTMF dial pad grid — standard 3×4 telephone layout for in-call tone transmission.
 */
@Composable
private fun DtmfGrid(
    onKeyPress: (Char) -> Unit
) {
    val rows = listOf(
        listOf('1', '2', '3'),
        listOf('4', '5', '6'),
        listOf('7', '8', '9'),
        listOf('*', '0', '#')
    )

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.small)
    ) {
        rows.forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                row.forEach { digit ->
                    DtmfButton(
                        digit = digit,
                        onPress = { onKeyPress(digit) }
                    )
                }
            }
        }
    }
}

/**
 * A single DTMF button.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DtmfButton(
    digit: Char,
    onPress: () -> Unit
) {
    val buttonSize = 56.dp

    Surface(
        modifier = Modifier
            .size(buttonSize)
            .combinedClickable(
                onClick = onPress
            ),
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier.fillMaxSize()
        ) {
            Text(
                text = digit.toString(),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics {
                    contentDescription = when (digit) {
                        '*' -> "Star"
                        '#' -> "Hash"
                        else -> digit.toString()
                    }
                }
            )
        }
    }
}

// =============================================================================
// Tone generation helpers
// =============================================================================

/**
 * Maps a dial pad character to the corresponding ToneGenerator tone type
 * and plays it as local audio feedback.
 *
 * @param toneGenerator The ToneGenerator instance (may be null if creation failed)
 * @param digit The DTMF character (0-9, *, #)
 */
private fun playDtmfTone(toneGenerator: ToneGenerator?, digit: Char) {
    if (toneGenerator == null) return

    val toneType = when (digit) {
        '0' -> ToneGenerator.TONE_DTMF_0
        '1' -> ToneGenerator.TONE_DTMF_1
        '2' -> ToneGenerator.TONE_DTMF_2
        '3' -> ToneGenerator.TONE_DTMF_3
        '4' -> ToneGenerator.TONE_DTMF_4
        '5' -> ToneGenerator.TONE_DTMF_5
        '6' -> ToneGenerator.TONE_DTMF_6
        '7' -> ToneGenerator.TONE_DTMF_7
        '8' -> ToneGenerator.TONE_DTMF_8
        '9' -> ToneGenerator.TONE_DTMF_9
        '*' -> ToneGenerator.TONE_DTMF_S
        '#' -> ToneGenerator.TONE_DTMF_P
        else -> return
    }

    try {
        // Play tone for 150ms — short enough to not overlap but audible
        toneGenerator.startTone(toneType, 150)
    } catch (e: Exception) {
        Log.e("InCallDialPad", "Error playing DTMF tone for digit: $digit", e)
    }
}
