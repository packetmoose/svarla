#!/bin/bash
set -e

# ─── Release Sign ─────────────────────────────────────────────────────────────
#
# Phase 2 of the release flow: download CI artifacts, sign them, and publish.
#
# This script:
#   1. Finds the draft release created by CI
#   2. Downloads the unsigned APK
#   3. Signs the APK with the local keystore
#   4. Signs the container images with Cosign
#   5. Uploads the signed APK to the release
#   6. Publishes (un-drafts) the release
#
# Prerequisites:
#   - gh CLI authenticated
#   - Android keystore available
#   - Cosign installed (keyless mode — no key pair needed)
#   - CI has completed and created a draft release
#
# Environment variables:
#   KEYSTORE_PATH       Path to the Android keystore. Default: ~/.android/release.p12
#   KEYSTORE_PASSWORD   Keystore password (prompted if not set)
#   KEY_ALIAS           Key alias. Default: release
#   KEY_PASSWORD        Key password. Defaults to KEYSTORE_PASSWORD.
#   COSIGN_KEY          (Optional) Path to Cosign private key for key-pair mode.
#                       If not set, uses keyless signing (Sigstore OIDC).
#
# Usage:
#   ./scripts/release-sign.sh
#   make release-sign

usage() {
    cat <<EOF
Usage: $0 [options]

Sign release artifacts and publish the release.

Run this after CI has completed building from a signed tag (make release-tag).

Options:
  -h, --help      Show this help message

Environment variables:
  KEYSTORE_PATH       Path to Android keystore. Default: ~/.android/release.p12
  KEYSTORE_PASSWORD   Keystore password. Prompted interactively if not set.
  KEY_ALIAS           Key alias. Default: release
  KEY_PASSWORD        Key password. Defaults to KEYSTORE_PASSWORD.
  COSIGN_KEY          (Optional) Path to Cosign private key for key-pair mode.
                      If not set, uses keyless signing (opens browser for auth).
EOF
    exit 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
fi

# ─── Configuration ───────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
OUTPUT_DIR="$REPO_ROOT/build-output"
KEYSTORE_PATH="${KEYSTORE_PATH:-$HOME/.android/release.p12}"
KEY_ALIAS="${KEY_ALIAS:-release}"
COSIGN_KEY="${COSIGN_KEY:-}"

GH_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")"
REGISTRY="ghcr.io"

# ─── Helpers ─────────────────────────────────────────────────────────────────

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

confirm() {
    local prompt="$1"
    read -r -p "$prompt [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY]) return 0 ;;
        *) return 1 ;;
    esac
}

# ─── Pre-checks ──────────────────────────────────────────────────────────────

info "Pre-checks"

command -v gh >/dev/null 2>&1 || die "gh CLI is required"
command -v cosign >/dev/null 2>&1 || die "cosign is required (https://docs.sigstore.dev/cosign/installation/)"
command -v docker >/dev/null 2>&1 || die "docker is required (for apksigner)"

gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"

if [ -z "$GH_REPO" ]; then
    die "Could not determine GitHub repository."
fi

if [ ! -f "$KEYSTORE_PATH" ]; then
    die "Android keystore not found at $KEYSTORE_PATH"
fi

# ─── Find the draft release ──────────────────────────────────────────────────

info "Finding draft release"

# Get the latest tag
VERSION="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
if [ -z "$VERSION" ]; then
    die "No tags found. Did you run 'make release-tag' first?"
fi

echo "Looking for draft release: $VERSION"

RELEASE_JSON="$(gh api "repos/${GH_REPO}/releases" \
    --jq ".[] | select(.tag_name == \"${VERSION}\" and .draft == true)" 2>/dev/null || echo "")"

if [ -z "$RELEASE_JSON" ]; then
    die "No draft release found for tag $VERSION. Has CI completed?"
fi

RELEASE_ID="$(echo "$RELEASE_JSON" | jq -r '.id')"
echo "Found draft release ID: $RELEASE_ID"

# ─── Download unsigned APK ────────────────────────────────────────────────────

info "Downloading unsigned APK"

mkdir -p "$OUTPUT_DIR"

APK_ASSET_NAME="svarla-${VERSION}-unsigned.apk"
APK_ASSET_URL="$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.name == \"${APK_ASSET_NAME}\") | .url")"

if [ -z "$APK_ASSET_URL" ] || [ "$APK_ASSET_URL" = "null" ]; then
    die "Unsigned APK asset '${APK_ASSET_NAME}' not found in draft release"
fi

UNSIGNED_APK="$OUTPUT_DIR/app-release-unsigned.apk"
gh api "$APK_ASSET_URL" -H "Accept: application/octet-stream" > "$UNSIGNED_APK"

if [ ! -s "$UNSIGNED_APK" ]; then
    die "Downloaded APK is empty"
fi

echo "Downloaded: $UNSIGNED_APK ($(wc -c < "$UNSIGNED_APK") bytes)"

# ─── Sign APK ────────────────────────────────────────────────────────────────

info "Signing APK"

if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
    read -r -s -p "Keystore password: " KEYSTORE_PASSWORD
    echo ""
fi

if [ -z "$KEYSTORE_PASSWORD" ]; then
    die "Keystore password is required"
fi

KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

SIGNED_APK="$OUTPUT_DIR/svarla-${VERSION}.apk"

# Use the Android build Docker image for apksigner
IMAGE_NAME="svarla-android-build"
ANDROID_DIR="$REPO_ROOT/android"

# Ensure the build image exists (it should from previous builds, but build if needed)
if ! docker image inspect "$IMAGE_NAME:release" >/dev/null 2>&1; then
    echo "Building Android toolchain image..."
    sudo docker build \
        --build-arg BUILD_TYPE=release \
        -t "$IMAGE_NAME:release" \
        -f "$ANDROID_DIR/Dockerfile.build" \
        "$ANDROID_DIR"
fi

sudo docker run --rm \
    -v "$KEYSTORE_PATH:/keystore/release.p12:ro" \
    -v "$OUTPUT_DIR:/work" \
    --entrypoint /bin/bash \
    "$IMAGE_NAME:release" \
    -c "
        apksigner sign \
            --ks /keystore/release.p12 \
            --ks-pass 'pass:${KEYSTORE_PASSWORD}' \
            --ks-key-alias '${KEY_ALIAS}' \
            --key-pass 'pass:${KEY_PASSWORD}' \
            --out '/work/$(basename "$SIGNED_APK")' \
            '/work/$(basename "$UNSIGNED_APK")' && \
        apksigner verify --print-certs '/work/$(basename "$SIGNED_APK")'
    "

if [ ! -f "$SIGNED_APK" ]; then
    die "Signed APK not found at $SIGNED_APK"
fi

APK_SHA256="$(sha256sum "$SIGNED_APK" | awk '{print $1}')"
echo "Signed APK: $SIGNED_APK"
echo "SHA-256:    $APK_SHA256"

# Write checksum file
echo "$APK_SHA256  $(basename "$SIGNED_APK")" > "$SIGNED_APK.sha256"

# ─── Sign container images with Cosign ────────────────────────────────────────

info "Signing container images"

# Get container image digests
SERVER_IMAGE="${REGISTRY}/${GH_REPO%/*}/svarla-server:${VERSION}"
MEDIABRIDGE_IMAGE="${REGISTRY}/${GH_REPO%/*}/svarla-mediabridge:${VERSION}"

# Get the digest for each image
echo "Resolving image digests..."

SERVER_DIGEST="$(docker manifest inspect "$SERVER_IMAGE" 2>/dev/null | jq -r '.digest // empty')"
if [ -z "$SERVER_DIGEST" ]; then
    SERVER_DIGEST="$(cosign triangulate "$SERVER_IMAGE" 2>/dev/null | grep -oP 'sha256:[a-f0-9]+' || echo "")"
fi

if [ -z "$SERVER_DIGEST" ]; then
    die "Could not resolve digest for $SERVER_IMAGE. Has CI pushed the image?"
fi

MEDIABRIDGE_DIGEST="$(docker manifest inspect "$MEDIABRIDGE_IMAGE" 2>/dev/null | jq -r '.digest // empty')"
if [ -z "$MEDIABRIDGE_DIGEST" ]; then
    MEDIABRIDGE_DIGEST="$(cosign triangulate "$MEDIABRIDGE_IMAGE" 2>/dev/null | grep -oP 'sha256:[a-f0-9]+' || echo "")"
fi

if [ -z "$MEDIABRIDGE_DIGEST" ]; then
    die "Could not resolve digest for $MEDIABRIDGE_IMAGE. Has CI pushed the image?"
fi

echo "Server:      $SERVER_IMAGE@$SERVER_DIGEST"
echo "MediaBridge: $MEDIABRIDGE_IMAGE@$MEDIABRIDGE_DIGEST"
echo ""

# Sign with Cosign — keyless (Sigstore OIDC) by default, key pair if COSIGN_KEY is set
COSIGN_SIGN_ARGS=""
if [ -n "$COSIGN_KEY" ] && [ -f "$COSIGN_KEY" ]; then
    echo "Using key pair: $COSIGN_KEY"
    COSIGN_SIGN_ARGS="--key $COSIGN_KEY"
    if [ -z "${COSIGN_PASSWORD:-}" ]; then
        read -r -s -p "Cosign key password: " COSIGN_PASSWORD
        echo ""
    fi
    export COSIGN_PASSWORD
else
    echo "Using keyless signing (Sigstore OIDC — will open browser for auth)"
    COSIGN_SIGN_ARGS="--yes"
fi

echo "Signing server image..."
cosign sign $COSIGN_SIGN_ARGS "${REGISTRY}/${GH_REPO%/*}/svarla-server@${SERVER_DIGEST}"

echo "Signing mediabridge image..."
cosign sign $COSIGN_SIGN_ARGS "${REGISTRY}/${GH_REPO%/*}/svarla-mediabridge@${MEDIABRIDGE_DIGEST}"

echo "Container images signed."

# ─── Upload signed APK to release ────────────────────────────────────────────

info "Uploading signed APK to release"

# Delete the unsigned APK asset from the release
UNSIGNED_ASSET_ID="$(echo "$RELEASE_JSON" | jq -r ".assets[] | select(.name == \"${APK_ASSET_NAME}\") | .id")"
if [ -n "$UNSIGNED_ASSET_ID" ] && [ "$UNSIGNED_ASSET_ID" != "null" ]; then
    gh api "repos/${GH_REPO}/releases/assets/${UNSIGNED_ASSET_ID}" -X DELETE
    echo "Removed unsigned APK from release"
fi

# Upload signed APK and checksum
gh release upload "$VERSION" \
    "$SIGNED_APK#svarla-${VERSION}.apk" \
    "$SIGNED_APK.sha256#checksums.sha256" \
    --clobber

echo "Signed APK uploaded"

# ─── Update release body with signing info ────────────────────────────────────

info "Updating release body"

# Get current release body
CURRENT_BODY="$(echo "$RELEASE_JSON" | jq -r '.body')"

SIGNING_INFO="

## Signatures

**APK SHA-256:** \`${APK_SHA256}\`

**Container images are signed with Cosign (Sigstore).** Verify with:
\`\`\`bash
cosign verify \\\\
  --certificate-identity-regexp=\"https://github.com/packetmoose\" \\\\
  --certificate-oidc-issuer=https://github.com/login/oauth \\\\
  ${REGISTRY}/${GH_REPO%/*}/svarla-server@${SERVER_DIGEST}
\`\`\`

**Git tag is GPG-signed.** Verify with:
\`\`\`bash
git verify-tag ${VERSION}
\`\`\`"

NEW_BODY="${CURRENT_BODY}${SIGNING_INFO}"

gh api "repos/${GH_REPO}/releases/${RELEASE_ID}" \
    -X PATCH \
    -f body="$NEW_BODY"

# ─── Publish release ──────────────────────────────────────────────────────────

info "Publishing release"

confirm "Everything looks good. Publish release $VERSION?" || { echo "Aborted. Release remains as draft."; exit 0; }

gh api "repos/${GH_REPO}/releases/${RELEASE_ID}" \
    -X PATCH \
    -f draft=false

# ─── Done ────────────────────────────────────────────────────────────────────

info "Release $VERSION published"
echo ""
echo "  Release:    https://github.com/${GH_REPO}/releases/tag/${VERSION}"
echo "  APK:        $SIGNED_APK"
echo "  SHA-256:    $APK_SHA256"
echo "  Server:     $SERVER_IMAGE@$SERVER_DIGEST (cosign signed)"
echo "  MediaBridge: $MEDIABRIDGE_IMAGE@$MEDIABRIDGE_DIGEST (cosign signed)"
echo ""
