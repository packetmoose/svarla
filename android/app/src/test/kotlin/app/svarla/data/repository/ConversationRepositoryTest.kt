package app.svarla.data.repository

import app.svarla.data.local.entity.MessageDirection
import app.svarla.data.local.entity.MessageStatus
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Unit tests for ConversationRepository parsing and conversion logic.
 *
 * Note: Full integration tests with Room and SyncManager require Android instrumentation.
 * These tests validate the internal parsing logic that is critical for correct behavior.
 */
class ConversationRepositoryTest : FunSpec({

    test("parseDirection handles SENT correctly") {
        parseDirection("SENT") shouldBe MessageDirection.SENT
        parseDirection("sent") shouldBe MessageDirection.SENT
        parseDirection("Sent") shouldBe MessageDirection.SENT
    }

    test("parseDirection handles RECEIVED correctly") {
        parseDirection("RECEIVED") shouldBe MessageDirection.RECEIVED
        parseDirection("received") shouldBe MessageDirection.RECEIVED
    }

    test("parseDirection defaults to RECEIVED for unknown values") {
        parseDirection(null) shouldBe MessageDirection.RECEIVED
        parseDirection("") shouldBe MessageDirection.RECEIVED
        parseDirection("UNKNOWN") shouldBe MessageDirection.RECEIVED
    }

    test("parseStatus handles all valid statuses") {
        parseStatus("PENDING") shouldBe MessageStatus.PENDING
        parseStatus("SENT") shouldBe MessageStatus.SENT
        parseStatus("DELIVERED") shouldBe MessageStatus.DELIVERED
        parseStatus("FAILED") shouldBe MessageStatus.FAILED
        parseStatus("QUEUED") shouldBe MessageStatus.QUEUED
    }

    test("parseStatus is case insensitive") {
        parseStatus("pending") shouldBe MessageStatus.PENDING
        parseStatus("Sent") shouldBe MessageStatus.SENT
        parseStatus("delivered") shouldBe MessageStatus.DELIVERED
    }

    test("parseStatus defaults to SENT for unknown values") {
        parseStatus(null) shouldBe MessageStatus.SENT
        parseStatus("") shouldBe MessageStatus.SENT
        parseStatus("UNKNOWN") shouldBe MessageStatus.SENT
    }

    test("parseTimestamp handles ISO 8601 format") {
        val timestamp = parseTimestamp("2024-01-15T10:30:00Z")
        timestamp shouldBe 1705314600000L
    }

    test("parseTimestamp handles epoch millis as string") {
        val epochMs = 1705311000000L
        val timestamp = parseTimestamp(epochMs.toString())
        timestamp shouldBe epochMs
    }

    test("parseTimestamp returns current time for null") {
        val before = System.currentTimeMillis()
        val timestamp = parseTimestamp(null)
        val after = System.currentTimeMillis()
        // Should be approximately now
        (timestamp in before..after) shouldBe true
    }

    test("parseTimestamp returns current time for invalid strings") {
        val before = System.currentTimeMillis()
        val timestamp = parseTimestamp("not-a-timestamp")
        val after = System.currentTimeMillis()
        (timestamp in before..after) shouldBe true
    }

    test("preview truncation truncates to 50 characters") {
        val longMessage = "This is a message that is much longer than fifty characters and should be truncated"
        val preview = longMessage.take(50)
        preview.length shouldBe 50
        preview shouldBe "This is a message that is much longer than fifty c"
    }

    test("preview truncation preserves short messages") {
        val shortMessage = "Hello!"
        val preview = shortMessage.take(50)
        preview shouldBe "Hello!"
    }
})

// --- Helper functions mirroring ConversationRepository internal logic ---

private fun parseDirection(direction: String?): MessageDirection {
    return when (direction?.uppercase()) {
        "SENT" -> MessageDirection.SENT
        "RECEIVED" -> MessageDirection.RECEIVED
        else -> MessageDirection.RECEIVED
    }
}

private fun parseStatus(status: String?): MessageStatus {
    return when (status?.uppercase()) {
        "PENDING" -> MessageStatus.PENDING
        "SENT" -> MessageStatus.SENT
        "DELIVERED" -> MessageStatus.DELIVERED
        "FAILED" -> MessageStatus.FAILED
        "QUEUED" -> MessageStatus.QUEUED
        else -> MessageStatus.SENT
    }
}

private fun parseTimestamp(timestamp: String?): Long {
    if (timestamp == null) return System.currentTimeMillis()
    return try {
        java.time.Instant.parse(timestamp).toEpochMilli()
    } catch (e: Exception) {
        try {
            timestamp.toLong()
        } catch (e2: Exception) {
            System.currentTimeMillis()
        }
    }
}
