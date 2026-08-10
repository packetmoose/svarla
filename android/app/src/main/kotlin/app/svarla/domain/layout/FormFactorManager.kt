package app.svarla.domain.layout

import android.app.Activity
import android.content.Context
import android.content.pm.ActivityInfo
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Device form factor classification.
 *
 * - PHONE: smallest width < 600dp
 * - TABLET: smallest width >= 600dp
 * - FOLDABLE: device has a hinge (detected via WindowManager)
 */
enum class FormFactor {
    PHONE,
    TABLET,
    FOLDABLE
}

/**
 * Fold state for foldable devices.
 */
enum class FoldState {
    FOLDED,
    UNFOLDED
}

/**
 * Layout mode emitted by FormFactorManager to drive the UI scaffold.
 */
enum class LayoutMode {
    SINGLE_PANE,
    LIST_DETAIL
}

/**
 * Combined layout configuration describing the current device state.
 */
data class LayoutConfiguration(
    val formFactor: FormFactor,
    val foldState: FoldState?,
    val layoutMode: LayoutMode,
    val screenWidthDp: Int,
    val screenHeightDp: Int
)

/**
 * Classifies the device form factor (Phone, Tablet, Foldable), observes fold state changes
 * via Jetpack WindowManager, and emits the appropriate LayoutMode.
 *
 * Implements orientation policy:
 * - Phone / Folded → portrait lock
 * - Tablet / Unfolded → all orientations
 *
 * Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 12.8, 12.9
 */
@Singleton
class FormFactorManager @Inject constructor(
    @ApplicationContext private val context: Context
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _formFactor = MutableStateFlow(classifyFormFactor())
    val formFactor: StateFlow<FormFactor> = _formFactor.asStateFlow()

    private val _foldState = MutableStateFlow<FoldState?>(null)
    val foldState: StateFlow<FoldState?> = _foldState.asStateFlow()

    private val _layoutMode = MutableStateFlow(determineLayoutMode(_formFactor.value, _foldState.value))
    val layoutMode: StateFlow<LayoutMode> = _layoutMode.asStateFlow()

    private val _layoutConfiguration = MutableStateFlow(
        LayoutConfiguration(
            formFactor = _formFactor.value,
            foldState = _foldState.value,
            layoutMode = _layoutMode.value,
            screenWidthDp = getSmallestScreenWidthDp(),
            screenHeightDp = getScreenHeightDp()
        )
    )
    val layoutConfiguration: StateFlow<LayoutConfiguration> = _layoutConfiguration.asStateFlow()

    /**
     * Minimum screen dimensions supported by the app.
     */
    companion object {
        const val MIN_WIDTH_DP = 320
        const val MIN_HEIGHT_DP = 480
        const val TABLET_THRESHOLD_DP = 600
    }

    /**
     * Start observing fold state changes for the given activity.
     * Should be called from Activity.onCreate or when the activity resumes.
     */
    fun observeFoldState(activity: Activity) {
        val windowInfoTracker = WindowInfoTracker.getOrCreate(activity)

        scope.launch {
            windowInfoTracker.windowLayoutInfo(activity)
                .collect { windowLayoutInfo ->
                    processFoldingFeatures(windowLayoutInfo)
                    updateConfiguration()
                    applyOrientationPolicy(activity)
                }
        }

        // Initial orientation policy
        applyOrientationPolicy(activity)
    }

    /**
     * Check if the current screen meets the minimum size requirements.
     *
     * Requirement 12.8: minimum 320dp width and 480dp height.
     */
    fun isBelowMinimumScreen(): Boolean {
        val widthDp = getSmallestScreenWidthDp()
        val heightDp = getScreenHeightDp()
        return widthDp < MIN_WIDTH_DP || heightDp < MIN_HEIGHT_DP
    }

    /**
     * Classify the device form factor based on smallest screen width.
     *
     * Requirement 12.9: Phone < 600dp, Tablet >= 600dp.
     * FOLDABLE is detected via hinge presence (handled in processFoldingFeatures).
     */
    private fun classifyFormFactor(): FormFactor {
        val smallestWidthDp = getSmallestScreenWidthDp()
        return if (smallestWidthDp >= TABLET_THRESHOLD_DP) {
            FormFactor.TABLET
        } else {
            FormFactor.PHONE
        }
    }

    /**
     * Process folding features from WindowLayoutInfo to detect hinge and fold state.
     */
    private fun processFoldingFeatures(windowLayoutInfo: WindowLayoutInfo) {
        val foldingFeature = windowLayoutInfo.displayFeatures
            .filterIsInstance<FoldingFeature>()
            .firstOrNull()

        if (foldingFeature != null) {
            // Device has a hinge → it's a foldable
            _formFactor.value = FormFactor.FOLDABLE
            _foldState.value = when (foldingFeature.state) {
                FoldingFeature.State.FLAT -> FoldState.UNFOLDED
                FoldingFeature.State.HALF_OPENED -> FoldState.UNFOLDED
                else -> FoldState.FOLDED
            }
        } else {
            // No hinge detected; reclassify based on width
            if (_formFactor.value == FormFactor.FOLDABLE) {
                // If previously detected as foldable but no hinge info now,
                // treat as folded (compact mode)
                _foldState.value = FoldState.FOLDED
            } else {
                _formFactor.value = classifyFormFactor()
                _foldState.value = null
            }
        }
    }

    /**
     * Determine layout mode based on form factor and fold state.
     *
     * Requirements:
     * - 12.2: Tablet → List_Detail_Layout
     * - 12.4: Foldable Unfolded → Tablet layout (List_Detail)
     * - 12.5: Foldable Folded → Phone layout (Single_Pane)
     * - 12.6: Folded → single-pane
     */
    private fun determineLayoutMode(formFactor: FormFactor, foldState: FoldState?): LayoutMode {
        return when (formFactor) {
            FormFactor.TABLET -> LayoutMode.LIST_DETAIL
            FormFactor.FOLDABLE -> when (foldState) {
                FoldState.UNFOLDED -> LayoutMode.LIST_DETAIL
                FoldState.FOLDED, null -> LayoutMode.SINGLE_PANE
            }
            FormFactor.PHONE -> LayoutMode.SINGLE_PANE
        }
    }

    /**
     * Apply orientation policy based on current device state.
     *
     * Requirements:
     * - 12.1: Phone → portrait lock
     * - 12.3: Tablet → all orientations
     * - 12.6: Folded → portrait lock
     * - 12.4/12.5 imply: Unfolded → all orientations
     */
    fun applyOrientationPolicy(activity: Activity) {
        val requestedOrientation = when (_formFactor.value) {
            FormFactor.PHONE -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            FormFactor.TABLET -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            FormFactor.FOLDABLE -> when (_foldState.value) {
                FoldState.UNFOLDED -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
                FoldState.FOLDED, null -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            }
        }
        activity.requestedOrientation = requestedOrientation
    }

    /**
     * Calculate list pane proportion (30-40% of width).
     * Uses a linear interpolation based on screen width.
     *
     * Requirement 12.10: 30-40% for list pane.
     */
    fun calculateListPaneFraction(screenWidthDp: Int): Float {
        // At 600dp → 40% (more space for list on narrower tablets)
        // At 1200dp+ → 30% (less proportional space for list on wider screens)
        val minWidth = 600f
        val maxWidth = 1200f
        val minFraction = 0.30f
        val maxFraction = 0.40f

        return when {
            screenWidthDp <= minWidth.toInt() -> maxFraction
            screenWidthDp >= maxWidth.toInt() -> minFraction
            else -> {
                // Linear interpolation: wider screen → smaller fraction
                val ratio = (screenWidthDp - minWidth) / (maxWidth - minWidth)
                maxFraction - ratio * (maxFraction - minFraction)
            }
        }
    }

    private fun updateConfiguration() {
        val mode = determineLayoutMode(_formFactor.value, _foldState.value)
        _layoutMode.value = mode
        _layoutConfiguration.value = LayoutConfiguration(
            formFactor = _formFactor.value,
            foldState = _foldState.value,
            layoutMode = mode,
            screenWidthDp = getSmallestScreenWidthDp(),
            screenHeightDp = getScreenHeightDp()
        )
    }

    private fun getSmallestScreenWidthDp(): Int {
        return context.resources.configuration.smallestScreenWidthDp
    }

    private fun getScreenHeightDp(): Int {
        val config = context.resources.configuration
        return config.screenHeightDp
    }
}
