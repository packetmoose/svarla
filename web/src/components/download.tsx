import { h, Component } from "preact";
import { api } from "../api";

interface DownloadState {
  loading: boolean;
  available: boolean;
  apkUrl: string;
  version: string | null;
}

interface DownloadStatusResponse {
  available: boolean;
  url: string;
}

interface VersionResponse {
  version: string;
}

/**
 * Download page — allows users to download the Svarla Android APK
 * directly from their own server instance.
 *
 * Checks the server's /api/download/status endpoint on mount to determine
 * whether the APK is currently provisioned and available for download.
 */
export class Download extends Component<Record<string, never>, DownloadState> {
  state: DownloadState = {
    loading: true,
    available: false,
    apkUrl: "/public/downloads/svarla.apk",
    version: null,
  };

  componentDidMount() {
    this.checkAvailability();
    this.fetchVersion();
  }

  private async fetchVersion() {
    const result = await api.get<VersionResponse>("/api/version");
    if (result.ok) {
      this.setState({ version: result.data.version });
    }
  }

  private async checkAvailability() {
    const result = await api.get<DownloadStatusResponse>(
      "/api/download/status"
    );
    if (result.ok) {
      this.setState({
        loading: false,
        available: result.data.available,
        apkUrl: result.data.url,
      });
    } else {
      this.setState({ loading: false, available: false });
    }
  }

  render() {
    const { loading, available, apkUrl, version } = this.state;

    return (
      <div class="download-page">
        <div class="download-hero">
          <div class="download-icon">📱</div>
          <h1>Get Svarla for Android</h1>
          <p class="download-description">
            Download the Svarla app for your Android device. The app connects to
            this server instance and stays in sync with your current server
            version.
          </p>
        </div>

        <div class="download-card">
          <div class="download-card-content">
            <h2>Svarla for Android</h2>
            <p class="download-card-meta">
              Distributed directly from your server — always compatible with
              your instance.
            </p>
            {version && (
              <p class="download-card-version">Version {version}</p>
            )}
            {loading ? (
              <span class="download-button download-button-disabled">
                Checking availability…
              </span>
            ) : available ? (
              <a href={apkUrl} class="download-button" download="svarla.apk">
                Download APK
              </a>
            ) : (
              <div class="download-unavailable">
                <span class="download-button download-button-disabled">
                  APK not available
                </span>
                <p class="download-unavailable-hint">
                  The APK has not been provisioned on this server yet. Check
                  that <code>APK_SOURCE</code> and <code>APK_URL</code> are
                  configured correctly, or place a signed APK at the server's
                  configured <code>APK_PATH</code>.
                </p>
              </div>
            )}
          </div>
        </div>

        {available && (
          <div class="download-instructions">
            <h3>Installation</h3>
            <ol>
              <li>Download the APK file above</li>
              <li>Open the file from your notifications or file manager</li>
              <li>
                If prompted, allow installation from this source in your device
                settings
              </li>
              <li>Open Svarla and enter your server URL to connect</li>
            </ol>
          </div>
        )}

        <div class="download-note">
          <h3>Staying up to date</h3>
          <p>
            The app will notify you when a new version is available. Updates are
            always served from this server, ensuring your app and server versions
            remain compatible. Do not use third-party update tools (like
            Obtainium) as they may install versions incompatible with your
            server.
          </p>
        </div>
      </div>
    );
  }
}
