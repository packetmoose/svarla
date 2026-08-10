#!/bin/bash
set -e

BUILD_TYPE="${BUILD_TYPE:-debug}"
OUTPUT_DIR="/output"

mkdir -p "$OUTPUT_DIR"

if [ "$BUILD_TYPE" = "release" ]; then
    APK_PATH="app/build/outputs/apk/release/app-release-unsigned.apk"
    SIGNED_APK_PATH="${OUTPUT_DIR}/app-release-signed.apk"

    if [ ! -f "$APK_PATH" ]; then
        echo "ERROR: Release APK not found at $APK_PATH"
        exit 1
    fi

    # Sign the APK if keystore is available
    if [ -f "/keystore/release.keystore" ]; then
        echo "Signing APK..."

        if [ -z "$KEYSTORE_PASSWORD" ]; then
            echo "ERROR: KEYSTORE_PASSWORD environment variable is required for signing"
            exit 1
        fi

        KEY_ALIAS="${KEY_ALIAS:-release}"
        KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

        apksigner sign \
            --ks /keystore/release.keystore \
            --ks-pass "pass:${KEYSTORE_PASSWORD}" \
            --ks-key-alias "$KEY_ALIAS" \
            --key-pass "pass:${KEY_PASSWORD}" \
            --out "$SIGNED_APK_PATH" \
            "$APK_PATH"

        # Verify the signature
        apksigner verify --print-certs "$SIGNED_APK_PATH"
        echo "Signed APK: $SIGNED_APK_PATH"
    else
        echo "No keystore found at /keystore/release.keystore, copying unsigned APK"
        cp "$APK_PATH" "${OUTPUT_DIR}/app-release-unsigned.apk"
    fi
else
    APK_PATH="app/build/outputs/apk/debug/app-debug.apk"

    if [ ! -f "$APK_PATH" ]; then
        echo "ERROR: Debug APK not found at $APK_PATH"
        exit 1
    fi

    cp "$APK_PATH" "${OUTPUT_DIR}/app-debug.apk"
    echo "Debug APK: ${OUTPUT_DIR}/app-debug.apk"
fi
