package app.svarla.data.remote

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import kotlinx.serialization.json.Json

/**
 * Unit tests for authentication API models and result types.
 */
class AuthApiTest : FunSpec({

    val json = Json { ignoreUnknownKeys = true }

    test("LoginRequest serializes correctly") {
        val request = LoginRequest(
            password = "MySecurePass123!",
            deviceName = "Samsung Galaxy S24",
            pushTopicId = "svarla-123"
        )

        request.password shouldBe "MySecurePass123!"
        request.deviceName shouldBe "Samsung Galaxy S24"
        request.pushTopicId shouldBe "svarla-123"
    }

    test("LoginResponse deserializes session token") {
        val jsonString = """{"sessionToken":"abc123token"}"""
        val response = json.decodeFromString<LoginResponse>(jsonString)

        response.sessionToken shouldBe "abc123token"
    }

    test("LoginErrorResponse deserializes error message") {
        val jsonString = """{"error":"Invalid password"}"""
        val response = json.decodeFromString<LoginErrorResponse>(jsonString)

        response.error shouldBe "Invalid password"
        response.lockedUntil shouldBe null
    }

    test("LoginErrorResponse deserializes locked until") {
        val jsonString = """{"error":"Account locked","lockedUntil":1700000000000}"""
        val response = json.decodeFromString<LoginErrorResponse>(jsonString)

        response.error shouldBe "Account locked"
        response.lockedUntil shouldBe 1700000000000L
    }

    test("LoginErrorResponse defaults are null") {
        val jsonString = """{}"""
        val response = json.decodeFromString<LoginErrorResponse>(jsonString)

        response.error shouldBe null
        response.lockedUntil shouldBe null
    }

    test("AuthResult.Success carries token") {
        val result: AuthResult = AuthResult.Success("my-token")
        result.shouldBeInstanceOf<AuthResult.Success>()
        result.sessionToken shouldBe "my-token"
    }

    test("AuthResult.Locked carries epoch timestamp") {
        val lockedUntil = 1700000000000L
        val result: AuthResult = AuthResult.Locked(lockedUntil)
        result.shouldBeInstanceOf<AuthResult.Locked>()
        result.lockedUntilEpochMs shouldBe lockedUntil
    }

    test("AuthResult.Error carries message") {
        val result: AuthResult = AuthResult.Error("Connection failed")
        result.shouldBeInstanceOf<AuthResult.Error>()
        result.message shouldBe "Connection failed"
    }
})
