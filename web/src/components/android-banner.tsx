import { h, Component } from "preact";
import { navigate } from "../router";

interface AndroidBannerState {
  visible: boolean;
}

/**
 * Banner that appears on Android devices prompting users to download the app.
 * Can be dismissed and stays hidden for the session via localStorage.
 */
export class AndroidBanner extends Component<
  Record<string, never>,
  AndroidBannerState
> {
  state: AndroidBannerState = {
    visible: this.shouldShow(),
  };

  private shouldShow(): boolean {
    // Don't show if already dismissed
    if (localStorage.getItem("android_banner_dismissed")) {
      return false;
    }
    // Only show on Android devices
    return /Android/i.test(navigator.userAgent);
  }

  private handleDismiss = () => {
    localStorage.setItem("android_banner_dismissed", "1");
    this.setState({ visible: false });
  };

  private handleDownload = () => {
    this.handleDismiss();
    navigate("/download");
  };

  render() {
    if (!this.state.visible) return null;

    return (
      <div class="android-banner">
        <div class="android-banner-content">
          <span class="android-banner-icon">📱</span>
          <div class="android-banner-text">
            <strong>Svarla is better as an app</strong>
            <span>Get the native Android experience</span>
          </div>
        </div>
        <div class="android-banner-actions">
          <button
            class="android-banner-btn android-banner-btn-primary"
            onClick={this.handleDownload}
          >
            Get app
          </button>
          <button
            class="android-banner-btn android-banner-btn-dismiss"
            onClick={this.handleDismiss}
          >
            ✕
          </button>
        </div>
      </div>
    );
  }
}
