#!/bin/bash
set -e

# ─── Help ─────────────────────────────────────────────────────────────────────

usage() {
    cat <<EOF
Usage: $0 <version>

Build, sign, and release a new version of Svarla.

Arguments:
  <version>       Version to release (e.g., 1.3.0, 2.0.0-beta). The 'v' prefix
                  is added automatically to create the git tag.

Environment variables:
  KEYSTORE_PATH       Path to the release keystore file.
                      Default: ~/.android/release.keystore

  KEYSTORE_PASSWORD   Password for the keystore. If not set, you will be
                      prompted interactively.

  KEY_ALIAS           Alias of the signing key in the keystore.
                      Default: release

  KEY_PASSWORD        Password for the key. Defaults to KEYSTORE_PASSWORD
                      if not set.

Requirements:
  - git, docker, sudo, gh (GitHub CLI) must be installed
  - gh must be authenticated (run 'gh auth login')
  - Working directory must be clean (no uncommitted changes)
  - The version tag must not already exist

What it does:
  1. Validates repo state and tools
  2. Shows version info and asks for confirmation
  3. Creates and pushes the git tag (triggers CI for container build)
  4. Builds the release APK inside Docker
  5. Signs the APK inside Docker using your local keystore
  6. Computes SHA-256 of the signed APK
  7. Creates a GitHub release with the APK, SHA, and changelog

Examples:
  $0 1.3.0
  KEYSTORE_PATH=~/keys/my.keystore $0 2.0.0
  KEYSTORE_PASSWORD=secret KEY_ALIAS=mykey $0 1.4.0-beta
EOF
    exit 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] || [ $# -eq 0 ]; then
    usage
fi

# ─── Configuration ───────────────────────────────────────────────────────────

KEYSTORE_PATH="${KEYSTORE_PATH:-$HOME/.android/release.keystore}"
KEY_ALIAS="${KEY_ALIAS:-release}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
ANDROID_DIR="$REPO_ROOT/android"
OUTPUT_DIR="$REPO_ROOT/build-output"
IMAGE_NAME="svarla-android-build"

# GitHub container registry (matches CI workflow)
GH_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "")"
REGISTRY="ghcr.io"
CONTAINER_IMAGE="${REGISTRY}/${GH_REPO}"

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

# Version argument
VERSION="${1:-}"

# Strip 'v' prefix if user included it, then re-add for consistency
VERSION="${VERSION#v}"

# Validate semver format (MAJOR.MINOR.PATCH with optional pre-release suffix)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    die "Invalid version format: $VERSION (expected semver, e.g., 1.3.0, 2.0.0-beta, 1.0.0-rc.1)"
fi

# Tag always has v prefix
VERSION="v${VERSION}"

# Required tools
command -v git >/dev/null 2>&1 || die "git is required"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v gh >/dev/null 2>&1 || die "gh CLI is required (https://cli.github.com)"

# GitHub auth
gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"

# Repo state
if [ -n "$(git status --porcelain)" ]; then
    die "Working directory is not clean. Commit or stash your changes first."
fi

# Check tag doesn't already exist
if git rev-parse "$VERSION" >/dev/null 2>&1; then
    die "Tag $VERSION already exists"
fi

# Keystore
if [ ! -f "$KEYSTORE_PATH" ]; then
    die "Keystore not found at $KEYSTORE_PATH (override with KEYSTORE_PATH env var)"
fi

# Repo info
if [ -z "$GH_REPO" ]; then
    die "Could not determine GitHub repository. Make sure 'gh repo view' works."
fi

# ─── Version info ────────────────────────────────────────────────────────────

PREVIOUS_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
COMMIT_SHA="$(git rev-parse --short HEAD)"
VERSION_CODE="$(git rev-list --count HEAD)"

echo ""
echo "  Version:       $VERSION"
echo "  Previous tag:  ${PREVIOUS_TAG:-<none>}"
echo "  Commit:        $COMMIT_SHA"
echo "  Version code:  $VERSION_CODE"
echo "  Keystore:      $KEYSTORE_PATH"
echo "  Repository:    $GH_REPO"
echo ""

# ─── Confirmation ────────────────────────────────────────────────────────────

confirm "Build and release $VERSION?" || { echo "Aborted."; exit 0; }

# ─── Keystore password ───────────────────────────────────────────────────────

if [ -z "$KEYSTORE_PASSWORD" ]; then
    read -r -s -p "Keystore password: " KEYSTORE_PASSWORD
    echo ""
fi

if [ -z "$KEYSTORE_PASSWORD" ]; then
    die "Keystore password is required"
fi

KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

# ─── Create tag and push ─────────────────────────────────────────────────────

info "Creating tag $VERSION and pushing"

git tag -a "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

echo "Tag pushed. CI will build the server container."

# ─── Build release APK ───────────────────────────────────────────────────────

info "Building release APK in Docker"

mkdir -p "$OUTPUT_DIR"

# Update version in build.gradle.kts for the build
VERSION_NAME="${VERSION#v}"

sudo docker build \
    --build-arg BUILD_TYPE=release \
    --build-arg VERSION_NAME="$VERSION_NAME" \
    --build-arg VERSION_CODE="$VERSION_CODE" \
    -t "$IMAGE_NAME:$VERSION" \
    -f "$ANDROID_DIR/Dockerfile.build" \
    "$ANDROID_DIR"

# ─── Sign APK ────────────────────────────────────────────────────────────────

info "Signing APK"

sudo docker run --rm \
    -v "$KEYSTORE_PATH:/keystore/release.keystore:ro" \
    -v "$OUTPUT_DIR:/output" \
    -e BUILD_TYPE=release \
    -e KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD" \
    -e KEY_ALIAS="$KEY_ALIAS" \
    -e KEY_PASSWORD="$KEY_PASSWORD" \
    "$IMAGE_NAME:$VERSION"

SIGNED_APK="$OUTPUT_DIR/app-release-signed.apk"
if [ ! -f "$SIGNED_APK" ]; then
    die "Signed APK not found at $SIGNED_APK"
fi

# Rename to final name
FINAL_APK="$OUTPUT_DIR/svarla-${VERSION}.apk"
mv "$SIGNED_APK" "$FINAL_APK"

# ─── Compute SHA-256 ─────────────────────────────────────────────────────────

info "Computing SHA-256"

SHA256="$(sha256sum "$FINAL_APK" | awk '{print $1}')"
echo "SHA-256: $SHA256"

# ─── Generate changelog ──────────────────────────────────────────────────────

info "Generating changelog"

if [ -n "$PREVIOUS_TAG" ]; then
    CHANGELOG="$(git log --oneline "${PREVIOUS_TAG}..${VERSION}")"
else
    CHANGELOG="$(git log --oneline "$VERSION")"
fi

# ─── Create GitHub release ───────────────────────────────────────────────────

info "Creating GitHub release"

RELEASE_BODY="## Docker

Pull the container images:
\`\`\`
docker pull ${REGISTRY}/${GH_REPO%/*}/svarla-server:${VERSION}
docker pull ${REGISTRY}/${GH_REPO%/*}/svarla-mediabridge:${VERSION}
\`\`\`

## Android

Download the signed APK from the assets below.

**SHA-256:** \`${SHA256}\`

## Changes

${CHANGELOG}"

gh release create "$VERSION" \
    --title "Svarla $VERSION" \
    --notes "$RELEASE_BODY" \
    "$FINAL_APK#svarla-${VERSION}.apk"

# ─── Done ────────────────────────────────────────────────────────────────────

info "Release $VERSION complete"
echo ""
echo "  Release:   https://github.com/${GH_REPO}/releases/tag/${VERSION}"
echo "  APK:       $FINAL_APK"
echo "  SHA-256:   $SHA256"
echo ""
