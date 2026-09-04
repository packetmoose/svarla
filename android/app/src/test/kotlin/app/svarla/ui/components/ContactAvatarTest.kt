package app.svarla.ui.components

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

class ContactAvatarTest : FunSpec({

    context("isPhoneNumberDisplay") {

        test("returns true for number starting with +") {
            isPhoneNumberDisplay("+46701234567") shouldBe true
        }

        test("returns true for number starting with digit") {
            isPhoneNumberDisplay("0701234567") shouldBe true
        }

        test("returns true for blank string") {
            isPhoneNumberDisplay("") shouldBe true
            isPhoneNumberDisplay("   ") shouldBe true
        }

        test("returns false for contact name") {
            isPhoneNumberDisplay("John Doe") shouldBe false
        }

        test("returns false for single word name") {
            isPhoneNumberDisplay("Alice") shouldBe false
        }

        test("returns true for number with spaces") {
            isPhoneNumberDisplay("+46 70 123 45 67") shouldBe true
        }

        test("handles name with leading whitespace") {
            isPhoneNumberDisplay("  Anna") shouldBe false
        }
    }

    context("extractInitials") {

        test("returns two initials for full name") {
            extractInitials("John Doe") shouldBe "JD"
        }

        test("returns first and last initial for multi-word name") {
            extractInitials("Anna Maria Svensson") shouldBe "AS"
        }

        test("returns single initial for one-word name") {
            extractInitials("Alice") shouldBe "A"
        }

        test("returns ? for blank input") {
            extractInitials("") shouldBe "?"
            extractInitials("   ") shouldBe "?"
        }

        test("handles lowercase names and uppercases initials") {
            extractInitials("john doe") shouldBe "JD"
        }

        test("handles name with extra whitespace") {
            extractInitials("  John   Doe  ") shouldBe "JD"
        }

        test("handles single character name") {
            extractInitials("A") shouldBe "A"
        }

        test("handles accented characters") {
            extractInitials("Erik Osterman") shouldBe "EO"
        }
    }
})
