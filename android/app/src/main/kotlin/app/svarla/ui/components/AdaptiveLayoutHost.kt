package app.svarla.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import app.svarla.domain.layout.FormFactorManager
import app.svarla.domain.layout.LayoutMode

/**
 * Transition duration for layout mode changes (fold/unfold).
 *
 * Requirement 12.4, 12.5: transition within 500 milliseconds.
 */
private const val TRANSITION_DURATION_MS = 500

/**
 * Adaptive layout host that switches between single-pane and list-detail layout
 * based on the current device form factor and fold state.
 *
 * - Single-pane mode: Displays either the list or the detail as a full-screen view.
 * - List-detail mode: Uses ListDetailPaneScaffold with 30-40% list pane proportion.
 *
 * Handles fold state transitions preserving navigation state and user input.
 *
 * Requirements: 12.2, 12.4, 12.5, 12.8, 12.10
 */
@Composable
fun AdaptiveLayoutHost(
    formFactorManager: FormFactorManager,
    listContent: @Composable (onItemSelected: (String) -> Unit) -> Unit,
    detailContent: @Composable (selectedId: String?) -> Unit,
    emptyDetailContent: @Composable () -> Unit = { DefaultEmptyDetailContent() }
) {
    val layoutConfiguration by formFactorManager.layoutConfiguration.collectAsState()

    // Check minimum screen requirements
    if (formFactorManager.isBelowMinimumScreen()) {
        MinimumScreenError()
        return
    }

    // Preserve selected item across layout mode transitions
    var selectedItemId by rememberSaveable { mutableStateOf<String?>(null) }

    AnimatedContent(
        targetState = layoutConfiguration.layoutMode,
        transitionSpec = {
            fadeIn(animationSpec = tween(TRANSITION_DURATION_MS)) togetherWith
                fadeOut(animationSpec = tween(TRANSITION_DURATION_MS))
        },
        label = "LayoutModeTransition"
    ) { currentLayoutMode ->
        when (currentLayoutMode) {
            LayoutMode.SINGLE_PANE -> {
                SinglePaneLayout(
                    selectedItemId = selectedItemId,
                    onItemSelected = { id -> selectedItemId = id },
                    onBack = { selectedItemId = null },
                    listContent = listContent,
                    detailContent = detailContent
                )
            }

            LayoutMode.LIST_DETAIL -> {
                ListDetailLayout(
                    formFactorManager = formFactorManager,
                    selectedItemId = selectedItemId,
                    onItemSelected = { id -> selectedItemId = id },
                    listContent = listContent,
                    detailContent = detailContent,
                    emptyDetailContent = emptyDetailContent
                )
            }
        }
    }
}

/**
 * Single-pane layout for phone form factor or folded state.
 * Shows either the list or the detail, not both simultaneously.
 *
 * Requirement 12.5: preserves the currently active detail view as the displayed screen.
 */
@Composable
private fun SinglePaneLayout(
    selectedItemId: String?,
    onItemSelected: (String) -> Unit,
    onBack: () -> Unit,
    listContent: @Composable (onItemSelected: (String) -> Unit) -> Unit,
    detailContent: @Composable (selectedId: String?) -> Unit
) {
    if (selectedItemId != null) {
        // Show detail view
        detailContent(selectedItemId)
    } else {
        // Show list view
        listContent(onItemSelected)
    }
}

/**
 * List-detail two-pane layout for tablet and unfolded foldable devices.
 * Uses Material3 Adaptive ListDetailPaneScaffold.
 *
 * Requirements:
 * - 12.2: list-detail layout for conversations and call history on tablet
 * - 12.10: 30-40% list pane width
 */
@Composable
private fun ListDetailLayout(
    formFactorManager: FormFactorManager,
    selectedItemId: String?,
    onItemSelected: (String) -> Unit,
    listContent: @Composable (onItemSelected: (String) -> Unit) -> Unit,
    detailContent: @Composable (selectedId: String?) -> Unit,
    emptyDetailContent: @Composable () -> Unit
) {
    val configuration = LocalConfiguration.current
    val screenWidthDp = configuration.screenWidthDp
    val listPaneFraction = formFactorManager.calculateListPaneFraction(screenWidthDp)

    Row(modifier = Modifier.fillMaxSize()) {
        // List pane
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .fillMaxWidth(fraction = listPaneFraction)
        ) {
            listContent(onItemSelected)
        }

        VerticalDivider()

        // Detail pane
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .weight(1f)
        ) {
            if (selectedItemId != null) {
                detailContent(selectedItemId)
            } else {
                emptyDetailContent()
            }
        }
    }
}

/**
 * Default empty state for the detail pane when no item is selected.
 */
@Composable
private fun DefaultEmptyDetailContent() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = "Select an item to view details",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/**
 * Error screen displayed when the device does not meet minimum screen size requirements.
 *
 * Requirement 12.8: graceful error below 320dp × 480dp.
 */
@Composable
private fun MinimumScreenError() {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Icon(
                imageVector = Icons.Default.ErrorOutline,
                contentDescription = "Screen size error",
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(bottom = 16.dp)
            )
            Text(
                text = "Screen Size Not Supported",
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.error
            )
            Spacer(modifier = Modifier.padding(top = 8.dp))
            Text(
                text = "This application requires a minimum screen size of " +
                    "${FormFactorManager.MIN_WIDTH_DP}dp × ${FormFactorManager.MIN_HEIGHT_DP}dp. " +
                    "Your device's screen does not meet this requirement.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp)
            )
        }
    }
}
