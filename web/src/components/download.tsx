import { h } from "preact";

/**
 * Download page — allows users to download the Svarla Android APK
 * directly from their own server instance.
 */
export function Download() {
  const apkUrl = "/public/downloads/svarla.apk";

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
            Distributed directly from your server — always compatible with your
            instance.
          </p>
          <a href={apkUrl} class="download-button" download="svarla.apk">
            Download APK
          </a>
        </div>
      </div>

      <div class="download-instructions">
        <h3>Installation</h3>
        <ol>
          <li>Download the APK file above</li>
          <li>
            Open the file from your notifications or file manager
          </li>
          <li>
            If prompted, allow installation from this source in your device
            settings
          </li>
          <li>Open Svarla and enter your server URL to connect</li>
        </ol>
      </div>

      <div class="download-note">
        <h3>Staying up to date</h3>
        <p>
          The app will notify you when a new version is available. Updates are
          always served from this server, ensuring your app and server versions
          remain compatible. Do not use third-party update tools (like
          Obtainium) as they may install versions incompatible with your server.
        </p>
      </div>
    </div>
  );
}
