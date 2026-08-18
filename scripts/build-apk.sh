#!/bin/bash
set -e

# ─── Build APK ────────────────────────────────────────────────────────────────
#
# Builds the Svarla Android APK inside Docker for reproducibility.
# Does NOT sign the APK — use scripts/sign-apk.sh for that.
#
# Environment variables:
#   BUILD_TYPE       debug or release (default: release)
#   VERSION_NAME     Version string (e.g. 1.2.0). Default: read from release file or "dev"
#   VERSION_CODE     Integer version code. Default: git rev-list --count HEAD
#   OUTPUT_DIR       Where to place the built APK. Default: ./build-output
#
# Output:
#   $OUTPUT_DIR/app-release-unsigned.apk  (for release builds)
#   $OUTPUT_DIR/app-debug.apk             (for debug builds)
#
# Usage:
#   ./scripts/build-apk.sh
#   BUILD_TYPE=debug ./scripts/build-apk.sh
#   VERSION_NAME=1.3.0 ./scripts/build-apk.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
ANDROID_DIR="$REPO_ROOT/android"
BUILD_TYPE="${BUILD_TYPE:-release}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/build-output}"
VERSION_CODE="${VERSION_CODE:-$(git rev-list --count HEAD)}"
IMAGE_NAME="svarla-android-build"

# Determine version name
if [ -z "$VERSION_NAME" ]; then
    # Try to read from the latest git tag or fallback to "dev"
    VERSION_NAME="$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "dev")"
fi

info "Building APK ($BUILD_TYPE)"
echo "  Version:      $VERSION_NAME"
echo "  Version code: $VERSION_CODE"
echo "  Output:       $OUTPUT_DIR"
echo ""

mkdir -p "$OUTPUT_DIR"

# Build in Docker
sudo docker build \
    --build-arg BUILD_TYPE="$BUILD_TYPE" \
    --build-arg VERSION_NAME="$VERSION_NAME" \
    --build-arg VERSION_CODE="$VERSION_CODE" \
    -t "$IMAGE_NAME:$BUILD_TYPE" \
    -f "$ANDROID_DIR/Dockerfile.build" \
    "$ANDROID_DIR"

# Extract APK from container
sudo docker run --rm \
    -v "$OUTPUT_DIR:/output" \
    -e BUILD_TYPE="$BUILD_TYPE" \
    "$IMAGE_NAME:$BUILD_TYPE"

# Verify output
if [ "$BUILD_TYPE" = "release" ]; then
    APK_PATH="$OUTPUT_DIR/app-release-unsigned.apk"
    # The docker-entrypoint copies unsigned APK when no keystore is mounted
    if [ ! -f "$APK_PATH" ]; then
        die "Release APK not found at $APK_PATH"
    fi
else
    APK_PATH="$OUTPUT_DIR/app-debug.apk"
    if [ ! -f "$APK_PATH" ]; then
        die "Debug APK not found at $APK_PATH"
    fi
fi

info "APK built successfully"
echo "  $APK_PATH"
echo ""
