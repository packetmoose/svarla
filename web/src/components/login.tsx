import { h, Component } from "preact";
import { api } from "../api";
import { navigate } from "../router";
import { initWebSocket } from "../ws";

interface LoginProps {
  onLogin?: () => void;
}

interface LoginState {
  password: string;
  error: string;
  loading: boolean;
}

interface LoginResponse {
  sessionToken: string;
  deviceId: string;
}

interface LockoutErrorData {
  error: string;
  lockedUntil?: string;
}

export class Login extends Component<LoginProps, LoginState> {
  state: LoginState = {
    password: "",
    error: "",
    loading: false,
  };

  private handlePasswordChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ password: target.value, error: "" });
  };

  private handleSubmit = async (e: Event) => {
    e.preventDefault();

    const { password } = this.state;

    if (password.length < 1 || password.length > 128) {
      this.setState({ error: "Password must be between 1 and 128 characters." });
      return;
    }

    this.setState({ loading: true, error: "" });

    const result = await api.post<LoginResponse>("/api/auth/login", {
      password,
      deviceName: "Web Browser",
      pushTopicId: `web-${Date.now()}`,
    });

    this.setState({ loading: false });

    if (result.ok) {
      localStorage.setItem("session_token", result.data.sessionToken);
      localStorage.setItem("device_id", result.data.deviceId);
      if (this.props.onLogin) {
        this.props.onLogin();
      } else {
        initWebSocket();
        navigate("/");
      }
      return;
    }

    if (result.status === 423) {
      const data = result.data as unknown as LockoutErrorData;
      const remaining = this.formatLockoutDuration(data.lockedUntil);
      this.setState({
        error: `Account is temporarily locked. Try again in ${remaining}.`,
      });
      return;
    }

    // 401 or any other error
    this.setState({ error: "Invalid password" });
  };

  private formatLockoutDuration(lockedUntil?: string): string {
    if (!lockedUntil) {
      return "a few minutes";
    }

    const until = new Date(lockedUntil).getTime();
    const now = Date.now();
    const diffMs = until - now;

    if (diffMs <= 0) {
      return "a few seconds";
    }

    const diffSeconds = Math.ceil(diffMs / 1000);
    if (diffSeconds < 60) {
      return `${diffSeconds} second${diffSeconds !== 1 ? "s" : ""}`;
    }

    const diffMinutes = Math.ceil(diffSeconds / 60);
    return `${diffMinutes} minute${diffMinutes !== 1 ? "s" : ""}`;
  }

  render() {
    const { password, error, loading } = this.state;

    return (
      <div class="login-container" role="main">
        <form
          class="login-form"
          onSubmit={this.handleSubmit}
          aria-label="Login form"
          noValidate
        >
          <h1 class="login-title">Svarla</h1>

          <div class="form-group">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              value={password}
              onInput={this.handlePasswordChange}
              required
              minLength={1}
              maxLength={128}
              disabled={loading}
              aria-describedby={error ? "login-error" : undefined}
              aria-invalid={error ? "true" : undefined}
              autocomplete="current-password"
              placeholder="Enter your password"
            />
          </div>

          {error && (
            <div
              id="login-error"
              class="login-error"
              role="alert"
              aria-live="assertive"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            class="login-button"
            disabled={loading || password.length === 0}
            aria-busy={loading ? "true" : undefined}
          >
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    );
  }
}

/**
 * Utility to handle session expiry from any part of the app.
 * Call this when a 401 is received on an authenticated request.
 */
export function handleSessionExpiry(): void {
  localStorage.removeItem("session_token");
  localStorage.removeItem("device_id");
  window.dispatchEvent(new Event("session-expired"));
}
