#!/bin/bash
set -e

# Build a debug APK using the Docker build container.
# Usage: ./scripts/build-debug.sh

REPO_ROOT="$(git rev-parse --show-toplevel)"
ANDROID_DIR="$REPO_ROOT/android"
OUTPUT_DIR="$REPO_ROOT/build-output"
IMAGE_NAME="svarla-android-build"

echo "─── Building debug APK in Docker ───"

mkdir -p "$OUTPUT_DIR"

sudo docker build \
    --build-arg BUILD_TYPE=debug \
    -t "$IMAGE_NAME:debug" \
    -f "$ANDROID_DIR/Dockerfile.build" \
    "$ANDROID_DIR"

sudo docker run --rm \
    -v "$OUTPUT_DIR:/output" \
    -e BUILD_TYPE=debug \
    "$IMAGE_NAME:debug"

APK_PATH="$OUTPUT_DIR/app-debug.apk"

if [ -f "$APK_PATH" ]; then
    echo ""
    echo "─── Done ───"
    echo "  APK: $APK_PATH"
    echo ""
else
    echo "ERROR: Debug APK not found at $APK_PATH" >&2
    exit 1
fi
