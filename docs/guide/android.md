# Android App

The Svarla Android app is a native Kotlin client built with Jetpack Compose and Material 3. It connects to the server for signaling and to the MediaBridge for WebRTC audio.

## Installing

### Obtainium (recommended)

The easiest way to install and keep Svarla updated is with [Obtainium](https://github.com/ImranR98/Obtainium), which tracks GitHub releases and notifies you of updates.

1. Install Obtainium from [F-Droid](https://f-droid.org/packages/dev.imranr.obtainium.fdroid/) or their GitHub releases.
2. Add a new app with the URL: `https://github.com/packetmoose/svarla`
3. Obtainium will find the APK from releases and install it.

### Manual APK download

Grab the latest APK directly from [GitHub Releases](https://github.com/packetmoose/svarla/releases).

### Building from source

If you want to build the app yourself:

```bash
cd android
./gradlew assembleDebug
# APK → app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 17 and Android SDK platform 34. Or build without any local SDK using Docker:

```bash
docker build -f android/Dockerfile.build -t svarla-android-builder android/
docker run --rm -v "$(pwd)/android/output:/output" svarla-android-builder
```

## Connecting to the server

On the login screen, enter:

- **Server URL** — Your server's address (e.g. `https://phone.example.com` or `http://192.168.1.50:3000`)
- **Password** — The password set via `INITIAL_PASSWORD`

The app registers the device, syncs history via WebSocket, and is ready to make calls.

## Requirements

- Android 8.0+ (API 26)
- Network access to the server (port 3000 or 443)
- Network access to the MediaBridge (port 10443)
