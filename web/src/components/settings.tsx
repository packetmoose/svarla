import { h, Component } from "preact";
import { api } from "../api";
import { Providers } from "./providers";
import { Numbers } from "./numbers";
import { Devices } from "./devices";

/* ---------- Tab definitions ---------- */

type SettingsTab = "providers" | "numbers" | "devices" | "account";

interface TabDef {
  id: SettingsTab;
  label: string;
  icon: string;
}

const tabs: TabDef[] = [
  { id: "providers", label: "Providers", icon: "◈" },
  { id: "numbers", label: "Numbers", icon: "#" },
  { id: "devices", label: "Devices", icon: "▣" },
  { id: "account", label: "Account", icon: "⚙" },
];

/* ---------- Password form state ---------- */

interface SettingsState {
  activeTab: SettingsTab;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  error: string;
  success: string;
  loading: boolean;
  serverVersion: string | null;
}

interface ChangePasswordErrorData {
  error: string;
  details?: string[];
}

export class Settings extends Component<Record<string, never>, SettingsState> {
  state: SettingsState = {
    activeTab: "providers",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    error: "",
    success: "",
    loading: false,
    serverVersion: null,
  };

  componentDidMount() {
    // Check if a specific tab was requested via hash query (e.g., /settings?tab=devices)
    const hash = window.location.hash;
    const queryIndex = hash.indexOf("?");
    if (queryIndex !== -1) {
      const params = new URLSearchParams(hash.slice(queryIndex + 1));
      const tab = params.get("tab");
      if (tab && tabs.some((t) => t.id === tab)) {
        this.setState({ activeTab: tab as SettingsTab });
      }
    }

    // Fetch server version
    api.get<{ version: string }>("/api/version").then((res) => {
      if (res.ok) {
        this.setState({ serverVersion: res.data.version });
      }
    });
  }

  private handleTabChange = (tab: SettingsTab) => {
    this.setState({ activeTab: tab });
  };

  private handleCurrentPasswordChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ currentPassword: target.value, error: "", success: "" });
  };

  private handleNewPasswordChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ newPassword: target.value, error: "", success: "" });
  };

  private handleConfirmPasswordChange = (e: Event) => {
    const target = e.target as HTMLInputElement;
    this.setState({ confirmPassword: target.value, error: "", success: "" });
  };

  private handleSubmit = async (e: Event) => {
    e.preventDefault();

    const { currentPassword, newPassword, confirmPassword } = this.state;

    if (newPassword !== confirmPassword) {
      this.setState({ error: "Passwords do not match", success: "" });
      return;
    }

    this.setState({ loading: true, error: "", success: "" });

    const result = await api.post<{ message: string }>("/api/auth/change-password", {
      currentPassword,
      newPassword,
      confirmPassword,
    });

    this.setState({ loading: false });

    if (result.ok) {
      this.setState({
        success: "Password changed successfully",
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
      return;
    }

    if (result.status === 401) {
      this.setState({ error: "Current password is incorrect" });
      return;
    }

    if (result.status === 400) {
      const data = result.data as unknown as ChangePasswordErrorData;
      this.setState({ error: data.error || "Validation failed" });
      return;
    }

    this.setState({ error: "An unexpected error occurred" });
  };

  private renderAccountTab() {
    const { currentPassword, newPassword, confirmPassword, error, success, loading } = this.state;

    return (
      <div class="settings-account">
        <h2 class="settings-section-title">Change Password</h2>

        <form
          class="settings-form"
          onSubmit={this.handleSubmit}
          aria-label="Change password form"
          noValidate
        >
          <div class="form-group">
            <label htmlFor="settings-current-password">Current Password</label>
            <input
              id="settings-current-password"
              type="password"
              value={currentPassword}
              onInput={this.handleCurrentPasswordChange}
              required
              disabled={loading}
              aria-describedby={error ? "settings-error" : undefined}
              aria-invalid={error ? "true" : undefined}
              autocomplete="current-password"
            />
          </div>

          <div class="form-group">
            <label htmlFor="settings-new-password">New Password</label>
            <input
              id="settings-new-password"
              type="password"
              value={newPassword}
              onInput={this.handleNewPasswordChange}
              required
              disabled={loading}
              aria-describedby={error ? "settings-error" : undefined}
              aria-invalid={error ? "true" : undefined}
              autocomplete="new-password"
            />
          </div>

          <div class="form-group">
            <label htmlFor="settings-confirm-password">Confirm New Password</label>
            <input
              id="settings-confirm-password"
              type="password"
              value={confirmPassword}
              onInput={this.handleConfirmPasswordChange}
              required
              disabled={loading}
              aria-describedby={error ? "settings-error" : undefined}
              aria-invalid={error ? "true" : undefined}
              autocomplete="new-password"
            />
          </div>

          {error && (
            <div
              id="settings-error"
              class="settings-error"
              role="alert"
              aria-live="assertive"
            >
              {error}
            </div>
          )}

          {success && (
            <div
              id="settings-success"
              class="settings-success"
              role="status"
              aria-live="polite"
            >
              {success}
            </div>
          )}

          <button
            type="submit"
            class="settings-button"
            disabled={loading || !currentPassword || !newPassword || !confirmPassword}
            aria-busy={loading ? "true" : undefined}
          >
            {loading ? "Changing Password..." : "Change Password"}
          </button>
        </form>
      </div>
    );
  }

  private renderTabContent() {
    switch (this.state.activeTab) {
      case "providers":
        return <Providers />;
      case "numbers":
        return <Numbers />;
      case "devices":
        return <Devices />;
      case "account":
        return this.renderAccountTab();
    }
  }

  render() {
    const { activeTab, serverVersion } = this.state;

    return (
      <div class="settings-container">
        <h1 class="settings-page-title">Settings</h1>

        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              class={`settings-tab${activeTab === tab.id ? " settings-tab-active" : ""}`}
              onClick={() => this.handleTabChange(tab.id)}
            >
              <span class="settings-tab-icon">{tab.icon}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <div class="settings-tab-content" role="tabpanel">
          {this.renderTabContent()}
        </div>

        {serverVersion && (
          <p class="settings-version">Server version {serverVersion}</p>
        )}
      </div>
    );
  }
}
