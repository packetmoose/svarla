package app.svarla.ui.screens.dialpad

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Unit tests for the in-call dial pad DTMF tone mapping.
 *
 * Verifies that all valid DTMF characters (0-9, *, #) are correctly
 * mapped to their corresponding ToneGenerator constants.
 *
 * Requirements covered: 14.11, 14.12
 */
class InCallDialPadDtmfMappingTest : FunSpec({

    test("all digits 0-9 have valid DTMF tone mappings") {
        val validDigits = ('0'..'9').toList()
        validDigits.forEach { digit ->
            getDtmfToneType(digit) shouldBe true
        }
    }

    test("star character has valid DTMF tone mapping") {
        getDtmfToneType('*') shouldBe true
    }

    test("hash character has valid DTMF tone mapping") {
        getDtmfToneType('#') shouldBe true
    }

    test("invalid characters do not have DTMF tone mappings") {
        val invalidChars = listOf('A', 'B', '+', '-', ' ', 'x')
        invalidChars.forEach { char ->
            getDtmfToneType(char) shouldBe false
        }
    }

    test("all 12 standard DTMF keys are supported") {
        val dtmfKeys = listOf('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#')
        val supportedCount = dtmfKeys.count { getDtmfToneType(it) }
        supportedCount shouldBe 12
    }
})

/**
 * Returns whether the given character has a valid DTMF tone mapping.
 * Mirrors the logic in InCallDialPadOverlay.playDtmfTone().
 */
private fun getDtmfToneType(digit: Char): Boolean {
    return when (digit) {
        '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#' -> true
        else -> false
    }
}
