package app.svarla.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.unit.dp

/**
 * Transition duration used for animated content state changes (loading → content, content → error).
 *
 * Requirement 13.2: Smooth animations and transitions with duration between 200ms and 500ms.
 */
const val STATE_TRANSITION_DURATION_MS = 300

/**
 * Loading state variants that determine the visual presentation.
 */
enum class LoadingStyle {
    /** Skeleton shimmer placeholders mimicking list content layout */
    SKELETON,
    /** Centered circular progress indicator */
    CIRCULAR,
}

/**
 * A reusable loading state composable that displays either skeleton shimmer placeholders
 * or a centered circular progress indicator.
 *
 * Requirement 13.6: While content is loading, display a loading state using skeleton
 * placeholders or a progress indicator appropriate to the content type.
 *
 * @param modifier Modifier applied to the loading container.
 * @param style The loading visual style (SKELETON or CIRCULAR).
 * @param skeletonRowCount Number of skeleton placeholder rows to display (3-5 for lists).
 */
@Composable
fun LoadingState(
    modifier: Modifier = Modifier,
    style: LoadingStyle = LoadingStyle.SKELETON,
    skeletonRowCount: Int = 4,
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
    ) {
        when (style) {
            LoadingStyle.SKELETON -> {
                SkeletonPlaceholder(rowCount = skeletonRowCount)
            }
            LoadingStyle.CIRCULAR -> {
                CircularProgressIndicator(
                    color = MaterialTheme.colorScheme.primary,
                    strokeWidth = 3.dp,
                )
            }
        }
    }
}

/**
 * Skeleton shimmer placeholder that mimics a list layout with animated gradient.
 *
 * Shows [rowCount] placeholder rows, each with a circular avatar placeholder
 * and text line placeholders to represent loading list content.
 */
@Composable
private fun SkeletonPlaceholder(
    rowCount: Int = 4,
) {
    val shimmerColors = listOf(
        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
        MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
    )

    val transition = rememberInfiniteTransition(label = "shimmer")
    val translateAnim by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1000f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1200, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "shimmerTranslate",
    )

    val brush = Brush.linearGradient(
        colors = shimmerColors,
        start = Offset(translateAnim - 200f, 0f),
        end = Offset(translateAnim + 200f, 0f),
    )

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.Top,
    ) {
        repeat(rowCount) {
            SkeletonRow(brush = brush)
            if (it < rowCount - 1) {
                Spacer(modifier = Modifier.height(16.dp))
            }
        }
    }
}

/**
 * A single skeleton row with a circular placeholder (avatar) and two text-line placeholders.
 */
@Composable
private fun SkeletonRow(brush: Brush) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Avatar placeholder
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(brush),
        )

        Spacer(modifier = Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f)) {
            // Title line placeholder
            Box(
                modifier = Modifier
                    .fillMaxWidth(fraction = 0.7f)
                    .height(14.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(brush),
            )
            Spacer(modifier = Modifier.height(8.dp))
            // Subtitle line placeholder
            Box(
                modifier = Modifier
                    .fillMaxWidth(fraction = 0.5f)
                    .height(12.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(brush),
            )
        }
    }
}

/**
 * A container that manages transitions between loading, content, and error states
 * using animated crossfade transitions (300ms duration).
 *
 * Requirement 13.2: Smooth transitions between states with 200-500ms duration.
 *
 * @param contentState The current UI content state.
 * @param loadingContent Composable shown during loading.
 * @param errorContent Composable shown on error.
 * @param content Composable shown when content is available.
 */
@Composable
fun <T> AnimatedStateContent(
    contentState: ContentState<T>,
    modifier: Modifier = Modifier,
    loadingContent: @Composable () -> Unit = { LoadingState() },
    errorContent: @Composable (error: String, onRetry: () -> Unit) -> Unit = { error, onRetry ->
        ErrorState(message = error, onRetry = onRetry)
    },
    content: @Composable (data: T) -> Unit,
) {
    AnimatedContent(
        targetState = contentState,
        modifier = modifier,
        transitionSpec = {
            fadeIn(animationSpec = tween(STATE_TRANSITION_DURATION_MS)) togetherWith
                fadeOut(animationSpec = tween(STATE_TRANSITION_DURATION_MS))
        },
        label = "ContentStateTransition",
    ) { state ->
        when (state) {
            is ContentState.Loading -> loadingContent()
            is ContentState.Error -> errorContent(state.message, state.onRetry)
            is ContentState.Success -> content(state.data)
        }
    }
}

/**
 * Represents the state of content being loaded.
 */
sealed class ContentState<out T> {
    /** Content is loading. */
    data object Loading : ContentState<Nothing>()

    /** An error occurred. */
    data class Error(
        val message: String,
        val onRetry: () -> Unit,
    ) : ContentState<Nothing>()

    /** Content loaded successfully. */
    data class Success<T>(val data: T) : ContentState<T>()
}
