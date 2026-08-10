package app.svarla.domain.notifications

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import kotlinx.serialization.json.Json

/**
 * Unit tests for NotificationHandler logic.
 * Tests payload parsing, deduplication, and notification type classification.
 * Android-dependent logic (actual notification display, PendingIntents) is not tested here.
 */
class NotificationHandlerTest : FunSpec({

    val json = Json { ignoreUnknownKeys = true }

    test("PushNotificationPayload should parse incoming call notification") {
        val payload = """
            {
                "type": "incoming_call",
                "id": "notif-123",
                "callId": "call-abc",
                "from": "+14155559999",
                "to": "+14155551234",
                "providerNumber": "+14155551234",
                "providerNumberLabel": "Personal",
                "contactName": "John Doe",
                "timestamp": 1700000000000
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.type shouldBe "incoming_call"
        parsed.id shouldBe "notif-123"
        parsed.callId shouldBe "call-abc"
        parsed.from shouldBe "+14155559999"
        parsed.to shouldBe "+14155551234"
        parsed.providerNumber shouldBe "+14155551234"
        parsed.providerNumberLabel shouldBe "Personal"
        parsed.contactName shouldBe "John Doe"
        parsed.timestamp shouldBe 1700000000000L
    }

    test("PushNotificationPayload should parse SMS notification") {
        val payload = """
            {
                "type": "incoming_sms",
                "id": "notif-456",
                "from": "+14155558888",
                "providerNumber": "+14155551234",
                "providerNumberLabel": "Business",
                "messagePreview": "Hey, are you free for lunch tomorrow?",
                "timestamp": 1700000100000
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.type shouldBe "incoming_sms"
        parsed.id shouldBe "notif-456"
        parsed.from shouldBe "+14155558888"
        parsed.providerNumberLabel shouldBe "Business"
        parsed.messagePreview shouldBe "Hey, are you free for lunch tomorrow?"
        parsed.callId shouldBe null
    }

    test("PushNotificationPayload should parse missed call notification") {
        val payload = """
            {
                "type": "missed_call",
                "id": "notif-789",
                "callId": "call-xyz",
                "from": "+14155557777",
                "providerNumber": "+14155551234",
                "providerNumberLabel": "Personal",
                "timestamp": 1700000200000
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.type shouldBe "missed_call"
        parsed.id shouldBe "notif-789"
        parsed.callId shouldBe "call-xyz"
        parsed.from shouldBe "+14155557777"
        parsed.providerNumberLabel shouldBe "Personal"
        parsed.timestamp shouldBe 1700000200000L
        parsed.messagePreview shouldBe null
    }

    test("PushNotificationPayload should handle missing optional fields") {
        val payload = """
            {
                "type": "incoming_call",
                "id": "notif-minimal",
                "from": "+14155559999"
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.type shouldBe "incoming_call"
        parsed.id shouldBe "notif-minimal"
        parsed.from shouldBe "+14155559999"
        parsed.callId shouldBe null
        parsed.to shouldBe null
        parsed.providerNumber shouldBe null
        parsed.providerNumberLabel shouldBe null
        parsed.contactName shouldBe null
        parsed.messagePreview shouldBe null
        parsed.timestamp shouldBe null
    }

    test("PushNotificationPayload should handle unknown extra fields gracefully") {
        val payload = """
            {
                "type": "incoming_sms",
                "id": "notif-extra",
                "from": "+14155558888",
                "unknownField": "some value",
                "anotherField": 42
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.type shouldBe "incoming_sms"
        parsed.id shouldBe "notif-extra"
        parsed.from shouldBe "+14155558888"
    }

    test("NotificationChannels constants should have correct values") {
        NotificationChannels.CHANNEL_ID_CALLS shouldBe "svarla_calls"
        NotificationChannels.CHANNEL_ID_MESSAGES shouldBe "svarla_messages"
        NotificationChannels.CHANNEL_ID_MISSED_CALLS shouldBe "svarla_missed_calls"
    }

    test("NotificationHandler constants should be defined correctly") {
        NotificationHandler.TYPE_INCOMING_CALL shouldBe "incoming_call"
        NotificationHandler.TYPE_INCOMING_SMS shouldBe "incoming_sms"
        NotificationHandler.TYPE_MISSED_CALL shouldBe "missed_call"
        NotificationHandler.ACTION_ANSWER_CALL shouldBe "app.svarla.ACTION_ANSWER_CALL"
        NotificationHandler.ACTION_DECLINE_CALL shouldBe "app.svarla.ACTION_DECLINE_CALL"
    }

    test("NotificationHandler intent extras should be defined") {
        NotificationHandler.EXTRA_NOTIFICATION_TYPE shouldBe "notification_type"
        NotificationHandler.EXTRA_CALL_ID shouldBe "call_id"
        NotificationHandler.EXTRA_PHONE_NUMBER shouldBe "phone_number"
        NotificationHandler.EXTRA_NOTIFICATION_ID shouldBe "notification_id"
    }

    test("PushNotificationPayload with long message preview should preserve full content") {
        val longPreview = "A".repeat(100)
        val payload = """
            {
                "type": "incoming_sms",
                "id": "notif-long",
                "from": "+14155558888",
                "messagePreview": "$longPreview"
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.messagePreview shouldBe longPreview
        parsed.messagePreview?.length shouldBe 100
    }

    test("PushNotificationPayload with E.164 numbers should parse correctly") {
        val payload = """
            {
                "type": "incoming_call",
                "id": "notif-e164",
                "from": "+442071838750",
                "to": "+14155551234",
                "providerNumber": "+14155551234"
            }
        """.trimIndent()

        val parsed = json.decodeFromString<PushNotificationPayload>(payload)

        parsed.from shouldBe "+442071838750"
        parsed.to shouldBe "+14155551234"
        parsed.providerNumber shouldBe "+14155551234"
    }
})
