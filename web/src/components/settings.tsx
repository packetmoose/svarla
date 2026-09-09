import { h, Component, Fragment } from "preact";
import type { ComponentChildren } from "preact";
import { api } from "../api";
import { navigate } from "../router";
import { Providers } from "./providers";
import { Numbers } from "./numbers";
import { Devices } from "./devices";

/* ---------- Tab definitions ---------- */

type SettingsTab = "providers" | "numbers" | "devices" | "account";

interface TabDef {
  id: SettingsTab;
  label: string;
}

const tabs: TabDef[] = [
  { id: "providers", label: "Providers" },
  { id: "numbers", label: "Numbers" },
  { id: "devices", label: "Devices" },
  { id: "account", label: "Account" },
];

/* ---------- Tab icons ---------- */

/**
 * Material-style outline icons, rendered as inline SVG so they inherit the
 * current text color and stay pixel-consistent (unlike the previous mix of
 * unicode glyphs). All share a 24px viewBox and 1.75 stroke weight.
 */
function iconSvg(children: ComponentChildren) {
  return (
    <svg
      class="icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function chevronIcon() {
  return iconSvg(<path d="M6 9l6 6 6-6" />);
}

function tabIcon(id: SettingsTab) {
  switch (id) {
    case "providers":
      // Cloud/hub — represents connected telephony providers
      return iconSvg(
        <Fragment>
          <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6.5 19h11z" />
        </Fragment>
      );
    case "numbers":
      // Hash/dialpad — phone numbers
      return iconSvg(
        <Fragment>
          <path d="M9 4 7 20" />
          <path d="M17 4l-2 16" />
          <path d="M4 9h16" />
          <path d="M3 15h16" />
        </Fragment>
      );
    case "devices":
      // Smartphone — paired devices
      return iconSvg(
        <Fragment>
          <rect x="6" y="3" width="12" height="18" rx="2" />
          <path d="M11 18h2" />
        </Fragment>
      );
    case "account":
      // Person — account settings
      return iconSvg(
        <Fragment>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </Fragment>
      );
  }
}

interface VersionInfo {
  version: string;
  gitRef: string | null;
  buildRef: string | null;
  buildDate: string | null;
}

/* ---------- Password form state ---------- */

interface SettingsState {
  activeTab: SettingsTab;
  /** Whether the mobile tab dropdown is open. */
  tabMenuOpen: boolean;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  error: string;
  success: string;
  loading: boolean;
  versionInfo: VersionInfo | null;
}

interface ChangePasswordErrorData {
  error: string;
  details?: string[];
}

export class Settings extends Component<Record<string, never>, SettingsState> {
  state: SettingsState = {
    activeTab: "providers",
    tabMenuOpen: false,
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    error: "",
    success: "",
    loading: false,
    versionInfo: null,
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
    api.get<VersionInfo>("/api/version").then((res) => {
      if (res.ok) {
        this.setState({ versionInfo: res.data });
      }
    });

    document.addEventListener("click", this.handleDocumentClick);
    document.addEventListener("keydown", this.handleKeyDown);
  }

  componentWillUnmount() {
    document.removeEventListener("click", this.handleDocumentClick);
    document.removeEventListener("keydown", this.handleKeyDown);
  }

  private handleTabChange = (tab: SettingsTab) => {
    this.setState({ activeTab: tab, tabMenuOpen: false });
  };

  private toggleTabMenu = () => {
    this.setState((prev) => ({ tabMenuOpen: !prev.tabMenuOpen }));
  };

  private closeTabMenu = () => {
    if (this.state.tabMenuOpen) {
      this.setState({ tabMenuOpen: false });
    }
  };

  // Close the mobile tab menu when clicking anywhere outside it.
  private handleDocumentClick = (e: MouseEvent) => {
    if (!this.state.tabMenuOpen) return;
    const target = e.target as HTMLElement;
    if (!target.closest(".settings-tab-menu")) {
      this.setState({ tabMenuOpen: false });
    }
  };

  // Close the menu on Escape for keyboard users.
  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      this.closeTabMenu();
    }
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
    const { activeTab, versionInfo } = this.state;
    const activeTabLabel = tabs.find((t) => t.id === activeTab)?.label ?? "";

    // Build tooltip with build metadata
    let versionTooltip = "";
    if (versionInfo) {
      const parts: string[] = [];
      if (versionInfo.gitRef) parts.push(`Git: ${versionInfo.gitRef}`);
      if (versionInfo.buildRef) parts.push(`Build: ${versionInfo.buildRef}`);
      if (versionInfo.buildDate) parts.push(`Date: ${versionInfo.buildDate}`);
      versionTooltip = parts.join("\n");
    }

    return (
      <div class="settings-container">
        <h1 class="settings-page-title">Settings</h1>

        {/* Mobile: a compact dropdown instead of a horizontal scroll strip. */}
        <div class="settings-tab-menu">
          <button
            type="button"
            class="settings-tab-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={this.state.tabMenuOpen}
            onClick={this.toggleTabMenu}
          >
            <span class="settings-tab-menu-current">
              <span class="settings-tab-icon">{tabIcon(activeTab)}</span>
              {activeTabLabel}
            </span>
            <span class="settings-tab-menu-chevron" aria-hidden="true">
              {chevronIcon()}
            </span>
          </button>
          {this.state.tabMenuOpen && (
            <ul class="settings-tab-menu-list" role="menu" aria-label="Settings sections">
              {tabs.map((tab) => (
                <li key={tab.id} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeTab === tab.id}
                    class={`settings-tab-menu-item${
                      activeTab === tab.id ? " settings-tab-menu-item-active" : ""
                    }`}
                    onClick={() => this.handleTabChange(tab.id)}
                  >
                    <span class="settings-tab-icon">{tabIcon(tab.id)}</span>
                    {tab.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Desktop: the standard tab strip. */}
        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              class={`settings-tab${activeTab === tab.id ? " settings-tab-active" : ""}`}
              onClick={() => this.handleTabChange(tab.id)}
            >
              <span class="settings-tab-icon">{tabIcon(tab.id)}</span>
              {tab.label}
            </button>
          ))}
        </div>

        <div class="settings-tab-content" role="tabpanel">
          {this.renderTabContent()}
        </div>

        {versionInfo && (
          <div class="settings-footer">
            <p
              class="settings-version"
              title={versionTooltip || undefined}
            >
              Server version {versionInfo.version}
            </p>
            <a
              href="#/download"
              class="settings-download-link"
              onClick={(e: Event) => {
                e.preventDefault();
                navigate("/download");
              }}
            >
              📥 Download Android App
            </a>
          </div>
        )}
      </div>
    );
  }
}
