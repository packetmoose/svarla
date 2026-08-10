package app.svarla.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Common dimension constants used throughout the app.
 * Ensures consistent sizing and adherence to touch target accessibility guidelines.
 */
data class Dimensions(
    /** Minimum interactive touch target size per Material Design 3 (48dp × 48dp) */
    val minTouchTarget: Dp = 48.dp,

    /** Small icon size (16dp) */
    val iconSizeSmall: Dp = 16.dp,
    /** Default icon size (24dp) */
    val iconSizeMedium: Dp = 24.dp,
    /** Large icon size (32dp) */
    val iconSizeLarge: Dp = 32.dp,
    /** Extra large icon size (48dp) */
    val iconSizeExtraLarge: Dp = 48.dp,

    /** Avatar/profile image size - small (32dp) */
    val avatarSmall: Dp = 32.dp,
    /** Avatar/profile image size - medium (40dp) */
    val avatarMedium: Dp = 40.dp,
    /** Avatar/profile image size - large (56dp) */
    val avatarLarge: Dp = 56.dp,

    /** Dial pad button size (64dp for comfortable touch targets) */
    val dialPadButtonSize: Dp = 64.dp,

    /** Bottom navigation bar height (80dp per Material 3) */
    val bottomNavHeight: Dp = 80.dp,

    /** Top app bar height (64dp) */
    val topAppBarHeight: Dp = 64.dp,

    /** FAB size - standard (56dp) */
    val fabSize: Dp = 56.dp,
    /** FAB size - small (40dp) */
    val fabSizeSmall: Dp = 40.dp,
    /** FAB size - large (96dp) */
    val fabSizeLarge: Dp = 96.dp,

    /** Divider thickness (1dp) */
    val dividerThickness: Dp = 1.dp,

    /** List item minimum height (56dp) */
    val listItemMinHeight: Dp = 56.dp,

    /** In-call control button size (56dp) */
    val callControlButtonSize: Dp = 56.dp,
    /** In-call end button size (72dp for emphasis) */
    val callEndButtonSize: Dp = 72.dp,
)

val LocalDimensions = staticCompositionLocalOf { Dimensions() }

/**
 * Accessor for [Dimensions] from the current composition.
 *
 * Usage:
 * ```
 * val dimens = MaterialTheme.dimensions
 * Modifier.size(dimens.minTouchTarget)
 * ```
 */
val androidx.compose.material3.MaterialTheme.dimensions: Dimensions
    @Composable
    @ReadOnlyComposable
    get() = LocalDimensions.current
