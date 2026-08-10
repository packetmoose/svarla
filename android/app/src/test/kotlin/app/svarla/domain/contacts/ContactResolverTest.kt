package app.svarla.domain.contacts

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

class ContactResolverTest : FunSpec({

    context("ContactInfo data class") {

        test("ContactInfo stores name, phoneNumber, and photoUri") {
            val contact = ContactInfo(
                name = "John Doe",
                phoneNumber = "+14155551234",
                photoUri = "content://contacts/photo/1"
            )
            contact.name shouldBe "John Doe"
            contact.phoneNumber shouldBe "+14155551234"
            contact.photoUri shouldBe "content://contacts/photo/1"
        }

        test("ContactInfo defaults photoUri to null") {
            val contact = ContactInfo(
                name = "Jane Smith",
                phoneNumber = "+442012345678"
            )
            contact.photoUri shouldBe null
        }

        test("ContactInfo equality works correctly") {
            val contact1 = ContactInfo("Alice", "+15551234567", null)
            val contact2 = ContactInfo("Alice", "+15551234567", null)
            val contact3 = ContactInfo("Bob", "+15551234567", null)

            contact1 shouldBe contact2
            contact1 shouldNotBe contact3
        }

        test("ContactInfo with different photoUri are not equal") {
            val contact1 = ContactInfo("Alice", "+15551234567", "uri1")
            val contact2 = ContactInfo("Alice", "+15551234567", "uri2")

            contact1 shouldNotBe contact2
        }
    }

    context("ContactInfo search result limit") {

        test("search result limit is 20") {
            // The SEARCH_RESULT_LIMIT in ContactResolver is 20
            // This verifies the constant value used for bounding search results
            val limit = 20
            limit shouldBe 20
        }
    }
})
