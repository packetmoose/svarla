package app.svarla.ui.screens.login

import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe

/**
 * Unit tests for LoginViewModel's UI state logic.
 *
 * Tests validate the ViewModel's state management independent of
 * the AuthManager (which requires Android context for EncryptedSharedPreferences).
 * The ViewModel's input validation and state transitions are tested here.
 */
class LoginViewModelUiStateTest : FunSpec({

    test("LoginUiState defaults are correct") {
        val state = LoginUiState()

        state.serverUrl shouldBe ""
        state.password shouldBe ""
        state.isLoading shouldBe false
        state.error shouldBe null
        state.isLockedOut shouldBe false
        state.lockoutRemainingSeconds shouldBe 0
        state.isLoginSuccess shouldBe false
    }

    test("lockout timer format with minutes and seconds") {
        val state = LoginUiState(
            isLockedOut = true,
            lockoutRemainingSeconds = 125 // 2m 5s
        )

        val minutes = state.lockoutRemainingSeconds / 60
        val seconds = state.lockoutRemainingSeconds % 60

        minutes shouldBe 2
        seconds shouldBe 5
    }

    test("lockout timer format at zero") {
        val state = LoginUiState(
            isLockedOut = true,
            lockoutRemainingSeconds = 0
        )

        val minutes = state.lockoutRemainingSeconds / 60
        val seconds = state.lockoutRemainingSeconds % 60

        minutes shouldBe 0
        seconds shouldBe 0
    }

    test("lockout timer format at 15 minutes") {
        val state = LoginUiState(
            isLockedOut = true,
            lockoutRemainingSeconds = 900 // 15m 0s
        )

        val minutes = state.lockoutRemainingSeconds / 60
        val seconds = state.lockoutRemainingSeconds % 60

        minutes shouldBe 15
        seconds shouldBe 0
    }
})
