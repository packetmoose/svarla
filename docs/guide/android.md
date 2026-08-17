# Android App

The Svarla Android app is a native Kotlin client built with Jetpack Compose and Material 3. It connects to the server for signaling and to the MediaBridge for WebRTC audio.

## Installing

### From your Svarla instance (recommended)

The APK is bundled inside the server container and served directly from your instance. This ensures the app version always matches your server.

1. Open your Svarla server URL in your phone's browser (e.g. `https://phone.example.com`)
2. You'll see a banner prompting you to download the app, or navigate to the download page manually
3. Tap **Download APK** and install it
4. If prompted, allow installation from this source in your device settings

::: tip
You can also access the APK directly at `https://your-server/public/downloads/svarla.apk`.
:::

### Manual APK download

You can also grab the APK from [GitHub Releases](https://github.com/packetmoose/svarla/releases). Make sure the version matches your server version.

### Building from source

If you want to build the app yourself:

```bash
cd android
./gradlew assembleDebug
# APK → app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 17 and Android SDK platform 35. Or build without any local SDK using Docker:

```bash
docker build -f android/Dockerfile.build -t svarla-android-builder android/
docker run --rm -v "$(pwd)/android/output:/output" svarla-android-builder
```

## Connecting to the server

On the login screen, enter:

- **Server URL** — Your server's address (e.g. `https://phone.example.com` or `http://192.168.1.50:3000`)
- **Password** — The password set via `INITIAL_PASSWORD`

The app registers the device, syncs history via WebSocket, and is ready to make calls.

## Updating the app

When you update your server container, a new APK is included automatically. The app checks your server's version on every launch:

- **App older than server** — An "Update available" banner appears with a button to open the download page in your browser.
- **App newer than server** — A warning banner appears indicating the versions are incompatible. Update your server to resolve this.

Simply tap the update banner, download the new APK, and install it over the existing app.

::: warning Do not use Obtainium or similar tools
Third-party update tools like Obtainium track GitHub releases independently of your server. This can result in installing an app version that is incompatible with your server. Always update the app from your own Svarla instance to guarantee version compatibility.
:::

## Requirements

- Android 8.0+ (API 26)
- Network access to the server (port 3000 or 443)
- Network access to the MediaBridge (port 10443)
