package app.svarla.ui.screens.dialpad

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Unit tests for DialPadViewModel.sanitizeDialInput() — the core logic
 * behind paste-from-clipboard in the dial pad.
 */
class PasteNumberTest : FunSpec({

    context("sanitizeDialInput") {

        test("preserves plain digits") {
            DialPadViewModel.sanitizeDialInput("5551234567") shouldBe "5551234567"
        }

        test("preserves international prefix +") {
            DialPadViewModel.sanitizeDialInput("+46701234567") shouldBe "+46701234567"
        }

        test("preserves * and # characters") {
            DialPadViewModel.sanitizeDialInput("*123#") shouldBe "*123#"
        }

        test("strips spaces") {
            DialPadViewModel.sanitizeDialInput("+46 70 123 45 67") shouldBe "+46701234567"
        }

        test("strips dashes") {
            DialPadViewModel.sanitizeDialInput("555-123-4567") shouldBe "5551234567"
        }

        test("strips parentheses") {
            DialPadViewModel.sanitizeDialInput("(555) 123-4567") shouldBe "5551234567"
        }

        test("strips dots") {
            DialPadViewModel.sanitizeDialInput("555.123.4567") shouldBe "5551234567"
        }

        test("strips letters") {
            DialPadViewModel.sanitizeDialInput("Call: +1-555-ABC-1234") shouldBe "+15551234"
        }

        test("returns empty for text with no dial characters") {
            DialPadViewModel.sanitizeDialInput("hello world") shouldBe ""
        }

        test("returns empty for empty string") {
            DialPadViewModel.sanitizeDialInput("") shouldBe ""
        }

        test("handles mixed valid and invalid characters") {
            DialPadViewModel.sanitizeDialInput("tel:+1(555)123-4567;ext=89") shouldBe "+1555123456789"
        }

        test("preserves plus only at any position") {
            DialPadViewModel.sanitizeDialInput("00+46701234567") shouldBe "00+46701234567"
        }
    }
})
