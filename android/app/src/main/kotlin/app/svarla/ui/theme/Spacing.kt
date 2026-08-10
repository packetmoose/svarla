package app.svarla.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Spacing values following the 8dp grid system.
 * Provides consistent spacing throughout the app per Material Design 3 guidelines.
 */
data class Spacing(
    /** 4dp - Extra small spacing for tight layouts */
    val extraSmall: Dp = 4.dp,
    /** 8dp - Small spacing, base unit of the 8dp grid */
    val small: Dp = 8.dp,
    /** 12dp - Between small and medium */
    val smallMedium: Dp = 12.dp,
    /** 16dp - Medium spacing, commonly used for content padding */
    val medium: Dp = 16.dp,
    /** 24dp - Large spacing for section separations */
    val large: Dp = 24.dp,
    /** 32dp - Extra large spacing */
    val extraLarge: Dp = 32.dp,
    /** 48dp - Matches minimum touch target size */
    val xxLarge: Dp = 48.dp,
    /** 64dp - Maximum spacing for major section breaks */
    val xxxLarge: Dp = 64.dp,
)

val LocalSpacing = staticCompositionLocalOf { Spacing() }

/**
 * Accessor for [Spacing] from the current composition.
 *
 * Usage:
 * ```
 * val spacing = MaterialTheme.spacing
 * Modifier.padding(spacing.medium)
 * ```
 */
val androidx.compose.material3.MaterialTheme.spacing: Spacing
    @Composable
    @ReadOnlyComposable
    get() = LocalSpacing.current
