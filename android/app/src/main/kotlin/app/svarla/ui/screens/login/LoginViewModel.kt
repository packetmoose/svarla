package app.svarla.ui.screens.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.svarla.data.remote.AuthManager
import app.svarla.data.remote.AuthResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class LoginUiState(
    val serverUrl: String = "",
    val password: String = "",
    val isLoading: Boolean = false,
    val error: String? = null,
    val isLockedOut: Boolean = false,
    val lockoutRemainingSeconds: Long = 0,
    val isLoginSuccess: Boolean = false
)

@HiltViewModel
class LoginViewModel @Inject constructor(
    private val authManager: AuthManager
) : ViewModel() {

    private val _uiState = MutableStateFlow(LoginUiState())
    val uiState: StateFlow<LoginUiState> = _uiState.asStateFlow()

    private var countdownJob: Job? = null

    fun onServerUrlChanged(url: String) {
        _uiState.update { it.copy(serverUrl = url, error = null) }
    }

    fun onPasswordChanged(password: String) {
        _uiState.update { it.copy(password = password, error = null) }
    }

    fun login() {
        val state = _uiState.value
        if (state.isLoading || state.isLockedOut) return

        if (state.serverUrl.isBlank()) {
            _uiState.update { it.copy(error = "Server URL is required") }
            return
        }

        if (state.password.isBlank()) {
            _uiState.update { it.copy(error = "Password is required") }
            return
        }

        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }

            when (val result = authManager.login(state.serverUrl, state.password)) {
                is AuthResult.Success -> {
                    _uiState.update { it.copy(isLoading = false, isLoginSuccess = true) }
                }

                is AuthResult.Locked -> {
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            isLockedOut = true,
                            error = "Account locked due to too many failed attempts"
                        )
                    }
                    startLockoutCountdown(result.lockedUntilEpochMs)
                }

                is AuthResult.Error -> {
                    _uiState.update { it.copy(isLoading = false, error = result.message) }
                }
            }
        }
    }

    private fun startLockoutCountdown(lockedUntilEpochMs: Long) {
        countdownJob?.cancel()
        countdownJob = viewModelScope.launch {
            while (true) {
                val remainingMs = lockedUntilEpochMs - System.currentTimeMillis()
                if (remainingMs <= 0) {
                    _uiState.update {
                        it.copy(isLockedOut = false, lockoutRemainingSeconds = 0, error = null)
                    }
                    break
                }
                _uiState.update {
                    it.copy(lockoutRemainingSeconds = remainingMs / 1000)
                }
                delay(1000L)
            }
        }
    }

    override fun onCleared() {
        super.onCleared()
        countdownJob?.cancel()
    }
}
