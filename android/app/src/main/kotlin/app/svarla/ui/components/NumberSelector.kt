package app.svarla.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.svarla.data.local.entity.ProviderNumber

/**
 * Data class representing the in-use status of a provider number on another device.
 */
data class NumberInUseStatus(
    val number: String,
    val deviceName: String
)

/**
 * Reusable provider number selector composable.
 *
 * Displays an ExposedDropdownMenuBox for choosing the outbound provider number.
 * If only one number exists, it auto-selects without showing the dropdown.
 * Shows label and number for each option, with optional in-use indicator.
 *
 * Requirements covered: 1.7, 3.7, 11.4, 11.8
 *
 * @param selectedNumber The currently selected provider number
 * @param availableNumbers All available provider numbers
 * @param onNumberSelected Callback when a number is selected
 * @param modifier Modifier for the composable
 * @param label The label text for the selector field (default: "From")
 * @param inUseStatuses Map of number → device name for numbers currently in use on other devices
 * @param enabled Whether the selector is interactive
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NumberSelector(
    selectedNumber: ProviderNumber?,
    availableNumbers: List<ProviderNumber>,
    onNumberSelected: (ProviderNumber) -> Unit,
    modifier: Modifier = Modifier,
    label: String = "From",
    inUseStatuses: Map<String, NumberInUseStatus> = emptyMap(),
    enabled: Boolean = true
) {
    // Auto-select when only one number is available
    if (availableNumbers.size == 1 && selectedNumber == null) {
        onNumberSelected(availableNumbers.first())
    }

    // If only one number, show a read-only field without dropdown
    if (availableNumbers.size <= 1) {
        val displayNumber = selectedNumber ?: availableNumbers.firstOrNull()
        OutlinedTextField(
            value = displayNumber?.let { formatNumberDisplay(it) } ?: "No numbers available",
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            supportingText = if (displayNumber != null && inUseStatuses.containsKey(displayNumber.number)) {
                {
                    InUseIndicatorText(inUseStatuses[displayNumber.number]!!)
                }
            } else null,
            modifier = modifier.fillMaxWidth()
        )
        return
    }

    // Multiple numbers — show dropdown
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { if (enabled) expanded = it },
        modifier = modifier
    ) {
        OutlinedTextField(
            value = selectedNumber?.let { formatNumberDisplay(it) } ?: "Select number",
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            supportingText = if (selectedNumber != null && inUseStatuses.containsKey(selectedNumber.number)) {
                {
                    InUseIndicatorText(inUseStatuses[selectedNumber.number]!!)
                }
            } else null,
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor()
        )

        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            availableNumbers.forEach { providerNumber ->
                val inUse = inUseStatuses[providerNumber.number]
                DropdownMenuItem(
                    text = {
                        NumberSelectorMenuItem(
                            providerNumber = providerNumber,
                            inUseStatus = inUse
                        )
                    },
                    onClick = {
                        onNumberSelected(providerNumber)
                        expanded = false
                    },
                    enabled = inUse == null
                )
            }
        }
    }
}

/**
 * Formats a ProviderNumber for display in the selector field.
 * Shows label if present, otherwise E.164 number.
 */
private fun formatNumberDisplay(number: ProviderNumber): String {
    return if (number.label != null) {
        "${number.label} (${number.number})"
    } else {
        number.number
    }
}

/**
 * Menu item content showing number label and phone number.
 */
@Composable
private fun NumberSelectorMenuItem(
    providerNumber: ProviderNumber,
    inUseStatus: NumberInUseStatus?
) {
    Column {
        Text(
            text = providerNumber.label ?: providerNumber.number,
            style = MaterialTheme.typography.bodyLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        if (providerNumber.label != null) {
            Text(
                text = providerNumber.number,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        if (inUseStatus != null) {
            InUseIndicatorText(inUseStatus)
        }
    }
}

/**
 * Small "In use on [device]" indicator text.
 */
@Composable
private fun InUseIndicatorText(status: NumberInUseStatus) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.padding(top = 2.dp)
    ) {
        // Small colored dot
        androidx.compose.foundation.Canvas(
            modifier = Modifier.size(6.dp)
        ) {
            drawCircle(color = androidx.compose.ui.graphics.Color(0xFFFF6B00))
        }
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = "In use on ${status.deviceName}",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.tertiary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}
