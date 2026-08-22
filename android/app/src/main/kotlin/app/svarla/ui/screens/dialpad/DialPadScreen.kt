package app.svarla.ui.screens.dialpad

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.widget.Toast
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Backspace
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.PersonSearch
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.domain.contacts.ContactInfo
import app.svarla.ui.components.NumberBadge
import app.svarla.ui.theme.CallActiveGreen
import app.svarla.ui.theme.dimensions
import app.svarla.ui.theme.spacing
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Main dial pad screen composable.
 *
 * Provides a standard telephone grid layout with digits 0-9, *, #, backspace,
 * a number entry field with formatting, contact name display for matching numbers,
 * a search button for looking up contacts, and a call button.
 *
 * Requirements covered: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 14.8, 14.9
 *
 * @param viewModel The DialPadViewModel managing state
 * @param onCallPressed Callback when call button is pressed with a valid number
 * @param onSmsPressed Callback when SMS button is pressed with the current number
 */
@Composable
fun DialPadScreen(
    viewModel: DialPadViewModel,
    onCallPressed: (String) -> Unit,
    onSmsPressed: (String) -> Unit
) {
    val formattedNumber by viewModel.formattedNumber.collectAsState()
    val rawInput by viewModel.rawInput.collectAsState()
    val contactSuggestions by viewModel.contactSuggestions.collectAsState()
    val matchedContactName by viewModel.matchedContactName.collectAsState()
    val availableNumbers by viewModel.availableNumbers.collectAsState()
    val selectedProviderNumber by viewModel.selectedProviderNumber.collectAsState()

    var showContactSearch by remember { mutableStateOf(false) }

    if (showContactSearch) {
        ContactSearchOverlay(
            viewModel = viewModel,
            onContactSelected = { contact ->
                viewModel.selectContact(contact)
                showContactSearch = false
            },
            onDismiss = { showContactSearch = false }
        )
        return
    }

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = MaterialTheme.spacing.medium),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Spacer(modifier = Modifier.height(MaterialTheme.spacing.small))

            // Provider number indicator at the top — discrete, tappable to change
            ProviderNumberIndicator(
                selectedNumber = selectedProviderNumber,
                availableNumbers = availableNumbers,
                onNumberSelected = { viewModel.selectProviderNumber(it) }
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.medium))

            // Number display field with contact name
            NumberDisplayField(
                formattedNumber = formattedNumber,
                rawInput = rawInput,
                matchedContactName = matchedContactName,
                onCopy = { rawInput },
                onPaste = { text -> viewModel.pasteNumber(text) }
            )

            // Search contact button
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = MaterialTheme.spacing.medium),
                horizontalArrangement = Arrangement.Center
            ) {
                IconButton(
                    onClick = { showContactSearch = true },
                    modifier = Modifier.size(MaterialTheme.dimensions.minTouchTarget)
                ) {
                    Icon(
                        imageVector = Icons.Default.PersonSearch,
                        contentDescription = "Search contacts",
                        modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge),
                        tint = MaterialTheme.colorScheme.primary
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            // Dial pad grid
            DialPadGrid(
                onDigitPressed = { digit -> viewModel.appendDigit(digit) },
                onBackspacePressed = { viewModel.deleteLastDigit() },
                onBackspaceLongPressed = { viewModel.clearInput() }
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.large))

            // Call button
            ActionButtonsRow(
                hasInput = rawInput.isNotEmpty(),
                onCallPressed = {
                    if (rawInput.isNotEmpty()) {
                        onCallPressed(rawInput)
                    } else {
                        // Empty field + call → show most recent outbound number
                        viewModel.populateLastDialedNumber { found ->
                            // If found, number is populated; user can tap call again
                            // If not found, do nothing (no call history)
                        }
                    }
                },
                onSmsPressed = {
                    if (rawInput.isNotEmpty()) {
                        onSmsPressed(rawInput)
                    }
                }
            )

            Spacer(modifier = Modifier.height(MaterialTheme.spacing.extraLarge))
        }
    }
}

// =============================================================================
// Provider Number Indicator
// =============================================================================

/**
 * Provider number indicator shown at the top of the dial pad.
 * Shows the selected number prominently. Tappable to switch when multiple numbers exist.
 */
@Composable
private fun ProviderNumberIndicator(
    selectedNumber: ProviderNumber?,
    availableNumbers: List<ProviderNumber>,
    onNumberSelected: (ProviderNumber) -> Unit
) {

    var showDropdown by remember { mutableStateOf(false) }
    val canSwitch = availableNumbers.size > 1

    // Fixed height box reserves space even before numbers load, preventing layout jumps
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(44.dp),
        contentAlignment = Alignment.Center
    ) {
        if (selectedNumber != null || availableNumbers.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .then(
                        if (canSwitch) Modifier.clickable { showDropdown = true }
                        else Modifier
                    )
                    .background(
                        color = if (selectedNumber != null) {
                            app.svarla.ui.components.parseNumberColor(selectedNumber.color).copy(alpha = 0.25f)
                        } else {
                            MaterialTheme.colorScheme.surfaceVariant
                        },
                        shape = RoundedCornerShape(8.dp)
                    )
                    .padding(vertical = 10.dp, horizontal = 20.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center
            ) {
                if (selectedNumber != null) {
                    val display = selectedNumber.label ?: selectedNumber.number
                    val badgeColor = app.svarla.ui.components.parseNumberColor(selectedNumber.color)
                    Text(
                        text = display,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,
                        color = badgeColor
                    )
                }
                if (canSwitch) {
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = "▾",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        androidx.compose.material3.DropdownMenu(
            expanded = showDropdown,
            onDismissRequest = { showDropdown = false }
        ) {
            availableNumbers.forEach { number ->
                val display = number.label ?: number.number
                val badgeColor = app.svarla.ui.components.parseNumberColor(number.color)
                val isSelected = number.number == selectedNumber?.number

                androidx.compose.material3.DropdownMenuItem(
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(vertical = 4.dp)
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .background(
                                        color = badgeColor,
                                        shape = CircleShape
                                    )
                            )
                            Spacer(modifier = Modifier.width(12.dp))
                            Column {
                                Text(
                                    text = display,
                                    style = MaterialTheme.typography.bodyLarge,
                                    fontWeight = if (isSelected) androidx.compose.ui.text.font.FontWeight.Bold
                                        else androidx.compose.ui.text.font.FontWeight.Normal,
                                    color = MaterialTheme.colorScheme.onSurface
                                )
                                if (number.label != null) {
                                    Text(
                                        text = number.number,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    },
                    onClick = {
                        onNumberSelected(number)
                        showDropdown = false
                    }
                )
            }
        }
    }
}

// =============================================================================
// Number Display Field
// =============================================================================

/**
 * Displays the formatted phone number the user is entering,
 * with the matched contact name shown below when a complete number matches.
 * Long-press shows a context menu with Copy (when input exists) and Paste options.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NumberDisplayField(
    formattedNumber: String,
    rawInput: String,
    matchedContactName: String?,
    onCopy: () -> String,
    onPaste: (String) -> Boolean
) {
    val context = LocalContext.current
    var showMenu by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(if (matchedContactName != null) 92.dp else 72.dp)
            .padding(horizontal = MaterialTheme.spacing.medium)
            .combinedClickable(
                onClick = {},
                onLongClick = { showMenu = true }
            ),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            if (rawInput.isEmpty()) {
                Text(
                    text = "Enter number",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                    textAlign = TextAlign.Center
                )
            } else {
                Text(
                    text = formattedNumber.ifEmpty { rawInput },
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics {
                        contentDescription = "Entered number: $rawInput"
                    }
                )
                if (matchedContactName != null) {
                    Text(
                        text = matchedContactName,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary,
                        textAlign = TextAlign.Center,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }

        DropdownMenu(
            expanded = showMenu,
            onDismissRequest = { showMenu = false }
        ) {
            // Show "Paste" if clipboard has text content
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            if (clipboard.hasPrimaryClip()) {
                DropdownMenuItem(
                    text = { Text("Paste") },
                    onClick = {
                        showMenu = false
                        val clipText = clipboard.primaryClip?.getItemAt(0)?.text?.toString()
                        if (clipText != null) {
                            onPaste(clipText)
                        }
                    }
                )
            }
            // Show "Copy" only when there's a number entered
            if (rawInput.isNotEmpty()) {
                DropdownMenuItem(
                    text = { Text("Copy") },
                    onClick = {
                        showMenu = false
                        val number = onCopy()
                        val clip = ClipData.newPlainText("Phone number", number)
                        clipboard.setPrimaryClip(clip)
                        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
                            Toast.makeText(context, "Number copied", Toast.LENGTH_SHORT).show()
                        }
                    }
                )
            }
        }
    }
}

// =============================================================================
// Contact Search Overlay
// =============================================================================

/**
 * Full-screen contact search overlay.
 * Users can search by name or phone number. Results are displayed in a scrollable list.
 * Selecting a contact fills the dial pad with their number.
 */
@Composable
fun ContactSearchOverlay(
    viewModel: DialPadViewModel,
    onContactSelected: (ContactInfo) -> Unit,
    onDismiss: () -> Unit
) {
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<ContactInfo>>(emptyList()) }
    val scope = rememberCoroutineScope()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.surface
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            // Top bar with back button and search field
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        horizontal = MaterialTheme.spacing.small,
                        vertical = MaterialTheme.spacing.medium
                    ),
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onDismiss) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back"
                    )
                }

                OutlinedTextField(
                    value = searchQuery,
                    onValueChange = { query ->
                        searchQuery = query
                        scope.launch {
                            searchResults = if (query.length >= 2) {
                                withContext(kotlinx.coroutines.Dispatchers.IO) {
                                    viewModel.searchContactsForOverlay(query)
                                }
                            } else {
                                emptyList()
                            }
                        }
                    },
                    placeholder = { Text("Search name or number") },
                    singleLine = true,
                    modifier = Modifier
                        .weight(1f)
                        .padding(end = MaterialTheme.spacing.small),
                    shape = RoundedCornerShape(24.dp),
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Default.Search,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    },
                    trailingIcon = if (searchQuery.isNotEmpty()) {
                        {
                            IconButton(onClick = {
                                searchQuery = ""
                                searchResults = emptyList()
                            }) {
                                Icon(
                                    imageVector = Icons.Default.Clear,
                                    contentDescription = "Clear search"
                                )
                            }
                        }
                    } else null
                )
            }

            HorizontalDivider()

            if (searchResults.isEmpty() && searchQuery.length >= 2) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(MaterialTheme.spacing.large),
                    contentAlignment = Alignment.TopCenter
                ) {
                    Text(
                        text = "No contacts found",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(searchResults, key = { it.phoneNumber }) { contact ->
                        ContactSearchResultItem(
                            contact = contact,
                            onClick = { onContactSelected(contact) }
                        )
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = MaterialTheme.spacing.medium),
                            color = MaterialTheme.colorScheme.outlineVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ContactSearchResultItem(
    contact: ContactInfo,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(
                horizontal = MaterialTheme.spacing.medium,
                vertical = MaterialTheme.spacing.smallMedium
            ),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = contact.name,
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                text = contact.phoneNumber,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}

// =============================================================================
// Dial Pad Grid
// =============================================================================

/**
 * Standard telephone grid layout: 3 columns × 4 rows (1-9, *, 0, #) plus backspace.
 *
 * Requirements covered: 14.1, 14.2, 14.3, 14.7
 */
@Composable
private fun DialPadGrid(
    onDigitPressed: (Char) -> Unit,
    onBackspacePressed: () -> Unit,
    onBackspaceLongPressed: () -> Unit
) {
    val dialPadRows = listOf(
        listOf(
            DialPadKey('1', "", null),
            DialPadKey('2', "ABC", null),
            DialPadKey('3', "DEF", null)
        ),
        listOf(
            DialPadKey('4', "GHI", null),
            DialPadKey('5', "JKL", null),
            DialPadKey('6', "MNO", null)
        ),
        listOf(
            DialPadKey('7', "PQRS", null),
            DialPadKey('8', "TUV", null),
            DialPadKey('9', "WXYZ", null)
        ),
        listOf(
            DialPadKey('*', "", null),
            DialPadKey('0', "+", '+'),  // Long-press produces '+'
            DialPadKey('#', "", null)
        )
    )

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(MaterialTheme.spacing.small)
    ) {
        dialPadRows.forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.CenterVertically
            ) {
                row.forEach { key ->
                    DialPadButton(
                        key = key,
                        onPress = { onDigitPressed(key.digit) },
                        onLongPress = if (key.longPressChar != null) {
                            { onDigitPressed(key.longPressChar) }
                        } else null
                    )
                }
            }
        }

        // Backspace row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Spacer(modifier = Modifier.weight(1f))
            BackspaceButton(
                onPress = onBackspacePressed,
                onLongPress = onBackspaceLongPressed
            )
            Spacer(modifier = Modifier.width(MaterialTheme.spacing.xxLarge))
        }
    }
}

/**
 * Data class representing a key on the dial pad.
 */
private data class DialPadKey(
    val digit: Char,
    val letters: String,
    val longPressChar: Char?
)

/**
 * A single dial pad button with digit display, optional letters, and long-press support.
 *
 * The 0 key supports long-press (500ms) to produce '+' for international dialing.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DialPadButton(
    key: DialPadKey,
    onPress: () -> Unit,
    onLongPress: (() -> Unit)?
) {
    val buttonSize = MaterialTheme.dimensions.dialPadButtonSize

    Box(
        modifier = Modifier
            .size(buttonSize)
            .background(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
                shape = CircleShape
            )
            .combinedClickable(
                onClick = onPress,
                onLongClick = onLongPress
            ),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Text(
                text = key.digit.toString(),
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics {
                    contentDescription = when (key.digit) {
                        '*' -> "Star"
                        '#' -> "Hash"
                        else -> key.digit.toString()
                    }
                }
            )
            if (key.letters.isNotEmpty()) {
                Text(
                    text = key.letters,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/**
 * Backspace button with long-press to clear all.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun BackspaceButton(
    onPress: () -> Unit,
    onLongPress: () -> Unit
) {
    Box(
        modifier = Modifier
            .size(MaterialTheme.dimensions.dialPadButtonSize)
            .combinedClickable(
                onClick = onPress,
                onLongClick = onLongPress
            ),
        contentAlignment = Alignment.Center
    ) {
        Icon(
            imageVector = Icons.AutoMirrored.Filled.Backspace,
            contentDescription = "Backspace",
            modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge),
            tint = MaterialTheme.colorScheme.onSurface
        )
    }
}

// =============================================================================
// Action Buttons (Call + SMS)
// =============================================================================

/**
 * Call button (green circle) below the dial pad grid.
 *
 * Requirements covered: 14.8, 14.9
 */
@Composable
private fun ActionButtonsRow(
    hasInput: Boolean,
    onCallPressed: () -> Unit,
    onSmsPressed: () -> Unit
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Call button (center, green circle)
        Box(
            modifier = Modifier
                .size(MaterialTheme.dimensions.callEndButtonSize)
                .background(
                    color = CallActiveGreen,
                    shape = CircleShape
                )
                .clickable(onClick = onCallPressed),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Call,
                contentDescription = "Make call",
                modifier = Modifier.size(MaterialTheme.dimensions.iconSizeLarge),
                tint = Color.White
            )
        }
    }
}
