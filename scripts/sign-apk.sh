#!/bin/bash
set -e

# ─── Sign APK ─────────────────────────────────────────────────────────────────
#
# Signs an unsigned APK using the Android release keystore.
# The signing happens inside the same Docker build image (for apksigner).
#
# Environment variables:
#   APK_INPUT          Path to unsigned APK. Default: ./build-output/app-release-unsigned.apk
#   APK_OUTPUT         Path for signed APK. Default: ./build-output/svarla-signed.apk
#   KEYSTORE_PATH      Path to the keystore file. Default: ~/.android/svarla-release.p12
#   KEYSTORE_PASSWORD  Keystore password. Prompted interactively if not set.
#   KEY_ALIAS          Key alias in the keystore. Default: release
#   KEY_PASSWORD       Key password. Defaults to KEYSTORE_PASSWORD.
#
# Output:
#   Signed APK at $APK_OUTPUT
#   SHA-256 checksum printed to stdout
#
# Usage:
#   ./scripts/sign-apk.sh
#   APK_INPUT=path/to/unsigned.apk APK_OUTPUT=path/to/signed.apk ./scripts/sign-apk.sh
#   KEYSTORE_PATH=~/keys/my.p12 ./scripts/sign-apk.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
APK_INPUT="${APK_INPUT:-$REPO_ROOT/build-output/app-release-unsigned.apk}"
APK_OUTPUT="${APK_OUTPUT:-$REPO_ROOT/build-output/svarla-signed.apk}"
KEYSTORE_PATH="${KEYSTORE_PATH:-$HOME/.android/svarla-release.p12}"
KEY_ALIAS="${KEY_ALIAS:-release}"
IMAGE_NAME="svarla-android-build"

# ─── Validation ───────────────────────────────────────────────────────────────

if [ ! -f "$APK_INPUT" ]; then
    die "Unsigned APK not found at $APK_INPUT (run 'make apk' first)"
fi

if [ ! -f "$KEYSTORE_PATH" ]; then
    die "Keystore not found at $KEYSTORE_PATH (override with KEYSTORE_PATH env var)"
fi

# ─── Keystore password ───────────────────────────────────────────────────────

if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
    read -r -s -p "Keystore password: " KEYSTORE_PASSWORD
    echo ""
fi

if [ -z "$KEYSTORE_PASSWORD" ]; then
    die "Keystore password is required"
fi

KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

# ─── Sign ─────────────────────────────────────────────────────────────────────

info "Signing APK"
echo "  Input:    $APK_INPUT"
echo "  Output:   $APK_OUTPUT"
echo "  Keystore: $KEYSTORE_PATH"
echo "  Alias:    $KEY_ALIAS"
echo ""

OUTPUT_DIR="$(dirname "$APK_OUTPUT")"
INPUT_DIR="$(dirname "$APK_INPUT")"
INPUT_FILENAME="$(basename "$APK_INPUT")"
OUTPUT_FILENAME="$(basename "$APK_OUTPUT")"

# Use the Docker build image which has apksigner available
sudo docker run --rm \
    -v "$KEYSTORE_PATH:/keystore/svarla-release.p12:ro" \
    -v "$INPUT_DIR:/input:ro" \
    -v "$OUTPUT_DIR:/output" \
    -e KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
    -e KEY_ALIAS="$KEY_ALIAS" \
    -e KEY_PASSWORD="$KEY_PASSWORD" \
    --entrypoint /bin/bash \
    "$IMAGE_NAME:release" \
    -c "
        apksigner sign \
            --ks /keystore/svarla-release.p12 \
            --ks-pass 'pass:${KEYSTORE_PASSWORD}' \
            --ks-key-alias '${KEY_ALIAS}' \
            --key-pass 'pass:${KEY_PASSWORD}' \
            --out '/output/${OUTPUT_FILENAME}' \
            '/input/${INPUT_FILENAME}' && \
        apksigner verify --print-certs '/output/${OUTPUT_FILENAME}'
    "

if [ ! -f "$APK_OUTPUT" ]; then
    die "Signed APK not found at $APK_OUTPUT"
fi

# ─── Checksum ─────────────────────────────────────────────────────────────────

SHA256="$(sha256sum "$APK_OUTPUT" | awk '{print $1}')"

info "APK signed successfully"
echo "  Output:  $APK_OUTPUT"
echo "  SHA-256: $SHA256"
echo ""

# Write checksum file alongside the APK
echo "$SHA256  $(basename "$APK_OUTPUT")" > "${APK_OUTPUT}.sha256"
