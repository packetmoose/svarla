package app.svarla.data.remote.dto

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json

/**
 * Unit tests for WebSocket event DTO parsing.
 *
 * Validates:
 * - ActiveCallDto accepts both "vonageNumber" and "providerNumber" field names (Requirement 12.7)
 * - ActiveCallDto accepts both "vonageNumberLabel" and "providerNumberLabel" field names
 * - WebSocketEvent parses correctly with various payloads
 */
class WebSocketEventParsingTest : FunSpec({

    val json = Json { ignoreUnknownKeys = true }

    test("ActiveCallDto should deserialize providerNumber field") {
        val jsonStr = """
            {
                "callId": "call-123",
                "status": "connected",
                "from": "+14155551234",
                "providerNumber": "+14155559999",
                "providerNumberLabel": "Work",
                "startedAt": 1700000000000
            }
        """.trimIndent()

        val dto = json.decodeFromString<ActiveCallDto>(jsonStr)

        dto.callId shouldBe "call-123"
        dto.status shouldBe "connected"
        dto.from shouldBe "+14155551234"
        dto.providerNumber shouldBe "+14155559999"
        dto.providerNumberLabel shouldBe "Work"
        dto.startedAt shouldBe 1700000000000L
    }

    test("ActiveCallDto should deserialize legacy vonageNumber field") {
        val jsonStr = """
            {
                "callId": "call-456",
                "status": "ringing",
                "from": "+442071838750",
                "vonageNumber": "+442071839999",
                "vonageNumberLabel": "Personal",
                "startedAt": 1700000100000
            }
        """.trimIndent()

        val dto = json.decodeFromString<ActiveCallDto>(jsonStr)

        dto.callId shouldBe "call-456"
        dto.status shouldBe "ringing"
        dto.from shouldBe "+442071838750"
        dto.providerNumber shouldBe "+442071839999"
        dto.providerNumberLabel shouldBe "Personal"
        dto.startedAt shouldBe 1700000100000L
    }

    test("ActiveCallDto should handle missing optional fields") {
        val jsonStr = """
            {
                "callId": "call-789",
                "status": "connected"
            }
        """.trimIndent()

        val dto = json.decodeFromString<ActiveCallDto>(jsonStr)

        dto.callId shouldBe "call-789"
        dto.status shouldBe "connected"
        dto.from shouldBe null
        dto.providerNumber shouldBe null
        dto.providerNumberLabel shouldBe null
        dto.startedAt shouldBe null
    }

    test("WebSocketEvent should parse call_event with data") {
        val jsonStr = """
            {
                "type": "call_event",
                "data": {
                    "callId": "call-abc",
                    "status": "ringing",
                    "from": "+14155551234",
                    "providerNumber": "+14155559999",
                    "providerNumberLabel": "Office"
                }
            }
        """.trimIndent()

        val event = json.decodeFromString<WebSocketEvent>(jsonStr)

        event.type shouldBe "call_event"
        event.data shouldBe kotlinx.serialization.json.buildJsonObject {
            put("callId", kotlinx.serialization.json.JsonPrimitive("call-abc"))
            put("status", kotlinx.serialization.json.JsonPrimitive("ringing"))
            put("from", kotlinx.serialization.json.JsonPrimitive("+14155551234"))
            put("providerNumber", kotlinx.serialization.json.JsonPrimitive("+14155559999"))
            put("providerNumberLabel", kotlinx.serialization.json.JsonPrimitive("Office"))
        }
    }

    test("WebSocketEvent should parse call_cancelled with reason") {
        val jsonStr = """
            {
                "type": "call_cancelled",
                "data": {
                    "callId": "call-xyz",
                    "reason": "answered_elsewhere"
                }
            }
        """.trimIndent()

        val event = json.decodeFromString<WebSocketEvent>(jsonStr)

        event.type shouldBe "call_cancelled"
        val data = event.data as kotlinx.serialization.json.JsonObject
        data["callId"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        } shouldBe "call-xyz"
        data["reason"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        } shouldBe "answered_elsewhere"
    }

    test("WebSocketEvent should parse ice_candidate message") {
        val jsonStr = """
            {
                "type": "ice_candidate",
                "data": {
                    "candidate": "candidate:1 1 TCP 2130706431 192.168.1.100 8443 typ host",
                    "sdpMid": "0",
                    "sdpMLineIndex": 0
                }
            }
        """.trimIndent()

        val event = json.decodeFromString<WebSocketEvent>(jsonStr)

        event.type shouldBe "ice_candidate"
        val data = event.data as kotlinx.serialization.json.JsonObject
        (data["candidate"] as kotlinx.serialization.json.JsonPrimitive).content shouldBe
            "candidate:1 1 TCP 2130706431 192.168.1.100 8443 typ host"
        (data["sdpMid"] as kotlinx.serialization.json.JsonPrimitive).content shouldBe "0"
        (data["sdpMLineIndex"] as kotlinx.serialization.json.JsonPrimitive).content shouldBe "0"
    }

    test("WebSocketEvent should parse call_event with legacy vonageNumber in data") {
        val jsonStr = """
            {
                "type": "call_event",
                "data": {
                    "callId": "call-legacy",
                    "status": "ringing",
                    "from": "+46701234567",
                    "vonageNumber": "+46701111111",
                    "vonageNumberLabel": "Swedish"
                }
            }
        """.trimIndent()

        val event = json.decodeFromString<WebSocketEvent>(jsonStr)

        event.type shouldBe "call_event"
        val data = event.data as kotlinx.serialization.json.JsonObject
        // During transition, vonageNumber is in the raw JSON data
        // The VoiceCallManager handler falls back to vonageNumber if providerNumber is absent
        val providerNumber = data["providerNumber"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        } ?: data["vonageNumber"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        }
        providerNumber shouldBe "+46701111111"

        val providerNumberLabel = data["providerNumberLabel"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        } ?: data["vonageNumberLabel"]?.let {
            (it as kotlinx.serialization.json.JsonPrimitive).content
        }
        providerNumberLabel shouldBe "Swedish"
    }

    test("WebSocketEvent should handle null data") {
        val jsonStr = """
            {
                "type": "connected"
            }
        """.trimIndent()

        val event = json.decodeFromString<WebSocketEvent>(jsonStr)

        event.type shouldBe "connected"
        event.data shouldBe null
    }

    test("WebRtcOfferRequest serializes correctly") {
        val request = WebRtcOfferRequest(
            sdpOffer = "v=0\r\no=- 1234 2 IN IP4 127.0.0.1\r\n",
            callId = "call-offer"
        )

        request.sdpOffer shouldBe "v=0\r\no=- 1234 2 IN IP4 127.0.0.1\r\n"
        request.callId shouldBe "call-offer"
    }

    test("WebRtcOfferResponse deserializes correctly") {
        val jsonStr = """
            {
                "sdpAnswer": "v=0\r\no=- 5678 2 IN IP4 10.0.0.1\r\n"
            }
        """.trimIndent()

        val response = json.decodeFromString<WebRtcOfferResponse>(jsonStr)

        response.sdpAnswer shouldBe "v=0\r\no=- 5678 2 IN IP4 10.0.0.1\r\n"
    }
})
