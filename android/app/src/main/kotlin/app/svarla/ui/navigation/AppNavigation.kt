package app.svarla.ui.navigation

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import app.svarla.data.remote.AuthManager
import app.svarla.domain.audio.AudioRouter
import app.svarla.domain.call.CallStatus
import app.svarla.domain.call.VoiceCallManager
import app.svarla.domain.contacts.ContactResolver
import app.svarla.domain.notifications.NotificationDeliveryMode
import app.svarla.domain.notifications.NotificationDeliveryPreferences
import app.svarla.domain.notifications.PushEndpointManager
import app.svarla.ui.screens.call.ActiveCallScreen
import app.svarla.ui.screens.call.CallHistoryScreen
import app.svarla.ui.screens.call.IncomingCallScreen
import app.svarla.ui.screens.conversations.ConversationDetailScreen
import app.svarla.ui.screens.conversations.ConversationListScreen
import app.svarla.ui.screens.dialpad.DialPadScreen
import app.svarla.ui.screens.dialpad.DialPadViewModel
import app.svarla.ui.screens.login.LoginScreen
import app.svarla.ui.screens.settings.DeviceListScreen
import app.svarla.ui.screens.settings.NotificationSetupDialog
import app.svarla.ui.screens.settings.SettingsScreen

/**
 * Top-level navigation destinations for the Svarla app.
 */
sealed class Screen(val route: String) {
    data object Login : Screen("login")
    data object Home : Screen("home")
    data object Calls : Screen("calls")
    data object Conversations : Screen("conversations")
    data object ConversationDetail : Screen("conversation_detail/{providerNumber}/{phoneNumber}") {
        fun createRoute(providerNumber: String, phoneNumber: String): String =
            "conversation_detail/${java.net.URLEncoder.encode(providerNumber, "UTF-8")}/${java.net.URLEncoder.encode(phoneNumber, "UTF-8")}"
    }
    data object DialPad : Screen("dial_pad")
    data object Settings : Screen("settings")
}

/**
 * Top-level navigation host with authentication gate.
 */
@Composable
fun AppNavigation(
    authManager: AuthManager,
    contactResolver: ContactResolver,
    voiceCallManager: VoiceCallManager,
    audioRouter: AudioRouter,
    deliveryPreferences: NotificationDeliveryPreferences,
    pushEndpointManager: PushEndpointManager,
    initialRoute: String? = null,
    navController: NavHostController = rememberNavController()
) {
    val isAuthenticated by authManager.isAuthenticated.collectAsState()
    val callState by voiceCallManager.callState.collectAsState()
    var showNotificationSetup by remember { mutableStateOf(false) }

    // Check if we need to show the notification setup dialog on first auth
    LaunchedEffect(isAuthenticated) {
        if (isAuthenticated && !deliveryPreferences.isSetupCompleted) {
            if (pushEndpointManager.isUnifiedPushAvailable()) {
                // Auto-select UnifiedPush — no dialog needed
                deliveryPreferences.setMode(NotificationDeliveryMode.UNIFIED_PUSH)
                deliveryPreferences.markSetupCompleted()
            } else {
                // Show dialog to ask user
                showNotificationSetup = true
            }
        }
    }

    // Show the notification setup dialog
    if (showNotificationSetup) {
        NotificationSetupDialog(
            onModeSelected = { mode ->
                deliveryPreferences.setMode(mode)
                deliveryPreferences.markSetupCompleted()
                showNotificationSetup = false
            },
            onDismiss = {
                // User skipped — default to NONE
                deliveryPreferences.setMode(NotificationDeliveryMode.NONE)
                deliveryPreferences.markSetupCompleted()
                showNotificationSetup = false
            }
        )
    }

    val startDestination = if (isAuthenticated) {
        Screen.Home.route
    } else {
        Screen.Login.route
    }

    // Auto-reset to IDLE after call ends (show ended state for 3 seconds)
    LaunchedEffect(callState.status) {
        if (callState.status == CallStatus.ENDED) {
            kotlinx.coroutines.delay(3000L)
            voiceCallManager.resetToIdle()
        }
    }

    // Show full-screen call UI overlay when a call is active (covers all screens)
    when (callState.status) {
        CallStatus.RINGING -> {
            val callInfo = callState.activeCallInfo
            if (callInfo != null && callInfo.isInbound) {
                IncomingCallScreen(
                    callerNumber = callInfo.remoteNumber,
                    contactName = null,
                    providerNumberLabel = callInfo.providerNumberLabel,
                    providerNumberColor = callInfo.providerNumberColor,
                    onAnswer = { voiceCallManager.answerCall(callInfo.callId) },
                    onDecline = { voiceCallManager.declineCall(callInfo.callId) }
                )
                return
            }
        }
        CallStatus.DIALING, CallStatus.CONNECTED -> {
            ActiveCallScreen(
                voiceCallManager = voiceCallManager,
                audioRouter = audioRouter,
                contactName = null,
                onEndCall = { voiceCallManager.endCall() },
                onDialPadClick = { /* TODO: in-call dial pad */ }
            )
            return
        }
        CallStatus.ENDED -> {
            ActiveCallScreen(
                voiceCallManager = voiceCallManager,
                audioRouter = audioRouter,
                contactName = null,
                onEndCall = { voiceCallManager.resetToIdle() },
                onDialPadClick = { }
            )
            return
        }
        CallStatus.IDLE -> { /* Show normal UI below */ }
    }

    // Navigate to the initial route from a notification tap (once)
    LaunchedEffect(initialRoute) {
        if (initialRoute != null && isAuthenticated) {
            navController.navigate(initialRoute) {
                launchSingleTop = true
            }
        }
    }

    // Navigate to login when user logs out
    LaunchedEffect(isAuthenticated) {
        if (!isAuthenticated) {
            navController.navigate(Screen.Login.route) {
                popUpTo(0) { inclusive = true }
            }
        }
    }

    NavHost(
        navController = navController,
        startDestination = startDestination
    ) {
        composable(Screen.Login.route) {
            LoginScreen(
                onLoginSuccess = {
                    navController.navigate(Screen.Home.route) {
                        popUpTo(Screen.Login.route) { inclusive = true }
                    }
                }
            )
        }
        composable(Screen.Home.route) {
            HomeScreen(
                currentRoute = Screen.Home.route,
                initialTab = when {
                    initialRoute == "home?tab=calls" -> BottomNavDestination.CALLS
                    initialRoute == "home?tab=settings" -> BottomNavDestination.SETTINGS
                    else -> null
                },
                onNavigate = { dest ->
                    // Navigation between tabs — for now just stay on home
                },
                onConversationClick = { providerNumber, phoneNumber ->
                    navController.navigate(Screen.ConversationDetail.createRoute(providerNumber, phoneNumber))
                },
                contactResolver = contactResolver,
                voiceCallManager = voiceCallManager,
                audioRouter = audioRouter
            )
        }
        composable(
            route = Screen.ConversationDetail.route,
            arguments = listOf(
                navArgument("providerNumber") { type = NavType.StringType },
                navArgument("phoneNumber") { type = NavType.StringType }
            )
        ) {
            ConversationDetailScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HomeScreen(
    currentRoute: String,
    initialTab: BottomNavDestination? = null,
    onNavigate: (BottomNavDestination) -> Unit,
    onConversationClick: (providerNumber: String, phoneNumber: String) -> Unit,
    contactResolver: ContactResolver,
    voiceCallManager: VoiceCallManager,
    audioRouter: AudioRouter
) {
    val initialIndex = initialTab?.let { BottomNavDestination.entries.indexOf(it) } ?: 0
    var selectedTabIndex by rememberSaveable { mutableStateOf(initialIndex) }
    val selectedTab = BottomNavDestination.entries[selectedTabIndex]
    var showComposeMessage by remember { mutableStateOf(false) }

    // Request contacts permission on first display
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) {
            contactResolver.onPermissionGranted()
        } else {
            contactResolver.onPermissionDenied()
        }
    }

    // Request microphone permission for voice calls
    val micPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* granted or not — WebRTC handles gracefully */ }

    val hasContactsPermission by contactResolver.hasPermission.collectAsState()
    LaunchedEffect(Unit) {
        if (!hasContactsPermission) {
            permissionLauncher.launch(Manifest.permission.READ_CONTACTS)
        }
        // Always request mic permission upfront for call readiness
        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
    }

    if (showComposeMessage) {
        androidx.activity.compose.BackHandler { showComposeMessage = false }
        app.svarla.ui.screens.sms.ComposeMessageScreen(
            onNavigateBack = { showComposeMessage = false },
            onMessageSent = { showComposeMessage = false },
            onNavigateToConversation = { providerNumber, phoneNumber ->
                showComposeMessage = false
                onConversationClick(providerNumber, phoneNumber)
            }
        )
        return
    }

    Scaffold(
        bottomBar = {
            SvarlaBottomNavigation(
                currentRoute = selectedTab.route,
                badgeState = NavigationBadgeState(),
                onNavigate = { dest ->
                    selectedTabIndex = BottomNavDestination.entries.indexOf(dest)
                }
            )
        }
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentAlignment = Alignment.Center
        ) {
            when (selectedTab) {
                BottomNavDestination.DIAL_PAD -> {
                    val dialPadViewModel: DialPadViewModel = hiltViewModel()
                    DialPadScreen(
                        viewModel = dialPadViewModel,
                        onCallPressed = { number -> dialPadViewModel.makeCall(number) },
                        onSmsPressed = { /* TODO: navigate to compose with number pre-filled */ }
                    )
                }
                BottomNavDestination.CALLS -> {
                    val dialPadViewModel: DialPadViewModel = hiltViewModel()
                    CallHistoryScreen(
                        onMakeCall = { selectedTabIndex = BottomNavDestination.entries.indexOf(BottomNavDestination.DIAL_PAD) },
                        onCallNumber = { number -> dialPadViewModel.makeCall(number) },
                        onSendMessage = { providerNumber, phoneNumber ->
                            showComposeMessage = false
                            onConversationClick(providerNumber, phoneNumber)
                        }
                    )
                }
                BottomNavDestination.MESSAGES -> {
                    ConversationListScreen(
                        onConversationClick = onConversationClick,
                        onComposeMessage = { showComposeMessage = true }
                    )
                }
                BottomNavDestination.SETTINGS -> {
                    SettingsScreen()
                }
            }
        }
    }
}
