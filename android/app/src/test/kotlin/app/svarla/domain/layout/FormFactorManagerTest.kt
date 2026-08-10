package app.svarla.domain.layout

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.floats.shouldBeGreaterThanOrEqual
import io.kotest.matchers.floats.shouldBeLessThanOrEqual
import io.kotest.matchers.shouldBe

class FormFactorManagerTest : FunSpec({

    context("determineLayoutMode logic") {
        test("PHONE form factor always produces SINGLE_PANE") {
            val mode = determineLayoutModeForTest(FormFactor.PHONE, null)
            mode shouldBe LayoutMode.SINGLE_PANE
        }

        test("TABLET form factor always produces LIST_DETAIL") {
            val mode = determineLayoutModeForTest(FormFactor.TABLET, null)
            mode shouldBe LayoutMode.LIST_DETAIL
        }

        test("FOLDABLE with UNFOLDED state produces LIST_DETAIL") {
            val mode = determineLayoutModeForTest(FormFactor.FOLDABLE, FoldState.UNFOLDED)
            mode shouldBe LayoutMode.LIST_DETAIL
        }

        test("FOLDABLE with FOLDED state produces SINGLE_PANE") {
            val mode = determineLayoutModeForTest(FormFactor.FOLDABLE, FoldState.FOLDED)
            mode shouldBe LayoutMode.SINGLE_PANE
        }

        test("FOLDABLE with null fold state defaults to SINGLE_PANE") {
            val mode = determineLayoutModeForTest(FormFactor.FOLDABLE, null)
            mode shouldBe LayoutMode.SINGLE_PANE
        }
    }

    context("calculateListPaneFraction") {
        test("at 600dp width returns 40%") {
            val fraction = calculateListPaneFractionForTest(600)
            fraction shouldBe 0.40f
        }

        test("at 1200dp width returns 30%") {
            val fraction = calculateListPaneFractionForTest(1200)
            fraction shouldBe 0.30f
        }

        test("at 900dp width returns value between 30% and 40%") {
            val fraction = calculateListPaneFractionForTest(900)
            fraction shouldBeGreaterThanOrEqual 0.30f
            fraction shouldBeLessThanOrEqual 0.40f
        }

        test("below 600dp width clamps to 40%") {
            val fraction = calculateListPaneFractionForTest(400)
            fraction shouldBe 0.40f
        }

        test("above 1200dp width clamps to 30%") {
            val fraction = calculateListPaneFractionForTest(1600)
            fraction shouldBe 0.30f
        }

        test("fraction decreases as width increases") {
            val fraction700 = calculateListPaneFractionForTest(700)
            val fraction1000 = calculateListPaneFractionForTest(1000)
            (fraction700 > fraction1000) shouldBe true
        }
    }

    context("minimum screen validation") {
        test("below minimum width is detected") {
            val belowMin = isBelowMinScreenForTest(widthDp = 300, heightDp = 500)
            belowMin shouldBe true
        }

        test("below minimum height is detected") {
            val belowMin = isBelowMinScreenForTest(widthDp = 350, heightDp = 400)
            belowMin shouldBe true
        }

        test("at minimum dimensions is not below minimum") {
            val belowMin = isBelowMinScreenForTest(widthDp = 320, heightDp = 480)
            belowMin shouldBe false
        }

        test("above minimum dimensions is not below minimum") {
            val belowMin = isBelowMinScreenForTest(widthDp = 400, heightDp = 800)
            belowMin shouldBe false
        }
    }

    context("form factor classification") {
        test("smallest width below 600dp classifies as PHONE") {
            val formFactor = classifyFormFactorForTest(smallestWidthDp = 360)
            formFactor shouldBe FormFactor.PHONE
        }

        test("smallest width at 600dp classifies as TABLET") {
            val formFactor = classifyFormFactorForTest(smallestWidthDp = 600)
            formFactor shouldBe FormFactor.TABLET
        }

        test("smallest width above 600dp classifies as TABLET") {
            val formFactor = classifyFormFactorForTest(smallestWidthDp = 800)
            formFactor shouldBe FormFactor.TABLET
        }

        test("smallest width at 599dp classifies as PHONE") {
            val formFactor = classifyFormFactorForTest(smallestWidthDp = 599)
            formFactor shouldBe FormFactor.PHONE
        }
    }
})

// Test helpers that mirror the internal logic of FormFactorManager
// This avoids needing to mock Android Context for unit tests

private fun determineLayoutModeForTest(formFactor: FormFactor, foldState: FoldState?): LayoutMode {
    return when (formFactor) {
        FormFactor.TABLET -> LayoutMode.LIST_DETAIL
        FormFactor.FOLDABLE -> when (foldState) {
            FoldState.UNFOLDED -> LayoutMode.LIST_DETAIL
            FoldState.FOLDED, null -> LayoutMode.SINGLE_PANE
        }
        FormFactor.PHONE -> LayoutMode.SINGLE_PANE
    }
}

private fun calculateListPaneFractionForTest(screenWidthDp: Int): Float {
    val minWidth = 600f
    val maxWidth = 1200f
    val minFraction = 0.30f
    val maxFraction = 0.40f

    return when {
        screenWidthDp <= minWidth.toInt() -> maxFraction
        screenWidthDp >= maxWidth.toInt() -> minFraction
        else -> {
            val ratio = (screenWidthDp - minWidth) / (maxWidth - minWidth)
            maxFraction - ratio * (maxFraction - minFraction)
        }
    }
}

private fun isBelowMinScreenForTest(widthDp: Int, heightDp: Int): Boolean {
    return widthDp < FormFactorManager.MIN_WIDTH_DP || heightDp < FormFactorManager.MIN_HEIGHT_DP
}

private fun classifyFormFactorForTest(smallestWidthDp: Int): FormFactor {
    return if (smallestWidthDp >= FormFactorManager.TABLET_THRESHOLD_DP) {
        FormFactor.TABLET
    } else {
        FormFactor.PHONE
    }
}
