package app.svarla.ui.navigation

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Dialpad
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Message
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Navigation destinations for the bottom navigation bar.
 */
enum class BottomNavDestination(
    val route: String,
    val label: String,
    val icon: ImageVector
) {
    DIAL_PAD("dial_pad", "Dial Pad", Icons.Filled.Dialpad),
    CALLS("calls", "Calls", Icons.Filled.History),
    MESSAGES("conversations", "Messages", Icons.Filled.Message),
    SETTINGS("settings", "Settings", Icons.Filled.Settings)
}

/**
 * Badge state for navigation items.
 */
data class NavigationBadgeState(
    val unseenMissedCalls: Int = 0,
    val unreadMessages: Int = 0
)

/**
 * Bottom navigation bar with badge indicators on Call History and Messages tabs.
 *
 * Displays a dot badge when there are unseen missed calls (on Calls tab)
 * or unread messages (on Messages tab).
 *
 * Requirements covered: 15.8, 15.9, 15.10, 15.11
 *
 * @param currentRoute The currently active route
 * @param badgeState Current badge counts for navigation items
 * @param onNavigate Callback when a navigation item is tapped
 */
@Composable
fun SvarlaBottomNavigation(
    currentRoute: String,
    badgeState: NavigationBadgeState,
    onNavigate: (BottomNavDestination) -> Unit
) {
    NavigationBar {
        BottomNavDestination.entries.forEach { destination ->
            val selected = currentRoute == destination.route

            NavigationBarItem(
                selected = selected,
                onClick = { onNavigate(destination) },
                icon = {
                    val showBadge = when (destination) {
                        BottomNavDestination.CALLS -> badgeState.unseenMissedCalls > 0
                        BottomNavDestination.MESSAGES -> badgeState.unreadMessages > 0
                        else -> false
                    }

                    if (showBadge) {
                        BadgedBox(
                            badge = {
                                Badge()
                            }
                        ) {
                            Icon(
                                imageVector = destination.icon,
                                contentDescription = destination.label
                            )
                        }
                    } else {
                        Icon(
                            imageVector = destination.icon,
                            contentDescription = destination.label
                        )
                    }
                },
                label = { Text(destination.label) }
            )
        }
    }
}
