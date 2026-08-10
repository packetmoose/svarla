package app.svarla.ui.screens.sms

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import app.svarla.data.local.entity.ProviderNumber
import app.svarla.domain.contacts.ContactInfo
import app.svarla.ui.components.NumberSelector
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * New conversation creation screen.
 *
 * Flow:
 * 1. Select a "from" number (if multiple provider numbers exist)
 * 2. Search for a contact by name or number, or enter a number directly
 * 3. On selection/entry, navigate to the conversation detail screen
 *
 * Requirements covered: 3.1, 3.4, 3.5, 3.7
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComposeMessageScreen(
    onNavigateBack: () -> Unit,
    onMessageSent: () -> Unit = {},
    onNavigateToConversation: ((providerNumber: String, phoneNumber: String) -> Unit)? = null,
    viewModel: ComposeMessageViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val scope = rememberCoroutineScope()
    var searchQuery by remember { mutableStateOf("") }
    var searchResults by remember { mutableStateOf<List<ContactInfo>>(emptyList()) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New Conversation") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Navigate back"
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
                .padding(horizontal = 16.dp)
        ) {
            Spacer(modifier = Modifier.height(8.dp))

            // Step 1: Provider number selector (from number)
            if (uiState.availableNumbers.size > 1) {
                NumberSelector(
                    selectedNumber = uiState.selectedProviderNumber,
                    availableNumbers = uiState.availableNumbers,
                    onNumberSelected = viewModel::onProviderNumberSelected,
                    label = "From"
                )
                Spacer(modifier = Modifier.height(16.dp))
            }

            // Step 2: Search field for contact or number
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { query ->
                    searchQuery = query
                    scope.launch {
                        searchResults = if (query.length >= 2) {
                            withContext(Dispatchers.IO) {
                                viewModel.searchContacts(query)
                            }
                        } else {
                            emptyList()
                        }
                    }
                },
                placeholder = { Text("Search name or enter number") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
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

            Spacer(modifier = Modifier.height(8.dp))

            // Show "Send to this number" option when a valid number is typed
            val isValidNumber = isValidPhoneInput(searchQuery)
            if (isValidNumber && searchQuery.length >= 3) {
                SendToNumberItem(
                    number = searchQuery,
                    onClick = {
                        val normalizedNumber = viewModel.normalizeNumber(searchQuery)
                        navigateToConversation(
                            providerNumber = uiState.selectedProviderNumber?.number ?: "",
                            number = normalizedNumber,
                            onNavigateToConversation = onNavigateToConversation,
                            onNavigateBack = onNavigateBack
                        )
                    }
                )
                HorizontalDivider(
                    modifier = Modifier.padding(horizontal = 8.dp),
                    color = MaterialTheme.colorScheme.outlineVariant
                )
            }

            // Contact search results
            if (searchResults.isNotEmpty()) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize()
                ) {
                    items(searchResults, key = { it.phoneNumber }) { contact ->
                        ContactResultItem(
                            contact = contact,
                            onClick = {
                                val normalizedNumber = viewModel.normalizeNumber(contact.phoneNumber)
                                navigateToConversation(
                                    providerNumber = uiState.selectedProviderNumber?.number ?: "",
                                    number = normalizedNumber,
                                    onNavigateToConversation = onNavigateToConversation,
                                    onNavigateBack = onNavigateBack
                                )
                            }
                        )
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = 8.dp),
                            color = MaterialTheme.colorScheme.outlineVariant
                        )
                    }
                }
            } else if (searchQuery.length >= 2 && !isValidNumber) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 32.dp),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        text = "No contacts found",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

private fun navigateToConversation(
    providerNumber: String,
    number: String,
    onNavigateToConversation: ((String, String) -> Unit)?,
    onNavigateBack: () -> Unit
) {
    if (onNavigateToConversation != null) {
        onNavigateToConversation(providerNumber, number)
    } else {
        onNavigateBack()
    }
}

@Composable
private fun SendToNumberItem(
    number: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "Send to $number",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.primary
            )
            Text(
                text = "New number",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = "Continue",
            tint = MaterialTheme.colorScheme.primary
        )
    }
}

@Composable
private fun ContactResultItem(
    contact: ContactInfo,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = contact.name,
                style = MaterialTheme.typography.bodyLarge,
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
        Icon(
            imageVector = Icons.AutoMirrored.Filled.ArrowForward,
            contentDescription = "Continue",
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/**
 * Check if input looks like a valid phone number (digits, optional + prefix).
 */
private fun isValidPhoneInput(input: String): Boolean {
    if (input.isBlank()) return false
    val trimmed = input.trim()
    return trimmed.matches(Regex("^\\+?[0-9]+$"))
}
