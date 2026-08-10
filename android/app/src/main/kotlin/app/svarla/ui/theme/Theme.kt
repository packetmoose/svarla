package app.svarla.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * Theme mode for the Svarla app.
 * Supports system default (follows OS setting), always light, or always dark.
 * Maps to Requirement 13.12: in-app theme setting (system default, always light, always dark).
 */
enum class ThemeMode {
    /** Follow device system theme setting */
    SYSTEM,
    /** Always use light theme */
    LIGHT,
    /** Always use dark theme */
    DARK,
}

/**
 * Main theme composable for the Svarla app.
 *
 * Applies Material3 color scheme, typography, and shapes based on the selected [ThemeMode].
 * Supports dynamic color on Android 12+ (API 31+) when [useDynamicColor] is true.
 * Also provides custom [Spacing] and [Dimensions] via CompositionLocal.
 *
 * Requirements covered:
 * - 13.1: Material Design 3 guidelines for color, typography, shape
 * - 13.3: Consistent visual hierarchy using M3 type scale
 * - 13.5: 8dp grid spacing and 48dp touch targets
 * - 13.10: Dark mode theme support
 * - 13.11: Automatic theme switching on system theme change
 * - 13.12: In-app theme setting (system, light, dark)
 *
 * @param themeMode The desired theme mode (SYSTEM, LIGHT, DARK)
 * @param useDynamicColor Whether to use Android 12+ dynamic color (Material You)
 * @param content The composable content to theme
 */
@Composable
fun SvarlaTheme(
    themeMode: ThemeMode = ThemeMode.SYSTEM,
    useDynamicColor: Boolean = false,
    content: @Composable () -> Unit,
) {
    val isDarkTheme = when (themeMode) {
        ThemeMode.SYSTEM -> isSystemInDarkTheme()
        ThemeMode.LIGHT -> false
        ThemeMode.DARK -> true
    }

    val colorScheme = when {
        useDynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (isDarkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        isDarkTheme -> DarkColorScheme
        else -> LightColorScheme
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.surface.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !isDarkTheme
        }
    }

    CompositionLocalProvider(
        LocalSpacing provides Spacing(),
        LocalDimensions provides Dimensions(),
    ) {
        MaterialTheme(
            colorScheme = colorScheme,
            typography = SvarlaTypography,
            shapes = SvarlaShapes,
            content = content,
        )
    }
}
