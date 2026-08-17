#!/bin/bash
set -e

# ─── Release ──────────────────────────────────────────────────────────────────
#
# Full release workflow: build APK, sign it, create a signed git tag, push,
# and create a draft GitHub release.
#
# This is the GitHub-specific orchestrator. The actual build logic lives in
# the individual scripts (build-apk.sh, sign-apk.sh) called via make targets.
#
# Prerequisites:
#   - git, docker, sudo, gh, gpg must be installed
#   - gh must be authenticated (run 'gh auth login')
#   - GPG signing key configured (git config user.signingkey)
#   - Working directory must be clean (no uncommitted changes)
#   - A release file must exist in docs/releases/ without a matching git tag
#
# What it does:
#   1. Finds the next unreleased version from docs/releases/
#   2. Validates repo state and tools
#   3. Shows version info and asks for confirmation
#   4. Builds the APK via make (Docker, reproducible)
#   5. Signs the APK with local keystore
#   6. Creates a SIGNED git tag (git tag -s)
#   7. Pushes the signed tag (triggers CI)
#   8. Creates a draft GitHub release with APK + checksums attached
#   9. CI verifies tag signature, builds containers with APK, publishes release
#
# Usage:
#   ./scripts/release.sh
#   KEYSTORE_PATH=~/keys/my.keystore ./scripts/release.sh

usage() {
    cat <<EOF
Usage: $0 [options]

Build, sign, and release a new version of Svarla.

The version is determined automatically from the next unreleased file in
docs/releases/ (a file named vX.Y.Z.md that doesn't have a matching git tag).

Options:
  -h, --help      Show this help message

Environment variables:
  KEYSTORE_PATH       Path to the release keystore file.
                      Default: ~/.android/release.keystore

  KEYSTORE_PASSWORD   Password for the keystore. If not set, you will be
                      prompted interactively.

  KEY_ALIAS           Alias of the signing key in the keystore.
                      Default: release

  KEY_PASSWORD        Password for the key. Defaults to KEYSTORE_PASSWORD
                      if not set.

Examples:
  $0
  KEYSTORE_PATH=~/keys/my.keystore $0
  KEYSTORE_PASSWORD=secret KEY_ALIAS=mykey $0
EOF
    exit 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
fi

# ─── Configuration ───────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
OUTPUT_DIR="$REPO_ROOT/build-output"
RELEASES_DIR="$REPO_ROOT/docs/releases"

# GitHub container registry (matches CI workflow)
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

# ─── Find next release ───────────────────────────────────────────────────────

info "Finding next release"

RELEASE_FILE=""
RELEASE_VERSION=""

# Look for v*.md files in docs/releases/ that don't have a matching git tag
for file in "$RELEASES_DIR"/v*.md; do
    [ -f "$file" ] || continue
    filename="$(basename "$file" .md)"
    # filename is like v1.3.0
    if ! git rev-parse "$filename" >/dev/null 2>&1; then
        if [ -n "$RELEASE_FILE" ]; then
            die "Multiple unreleased version files found: $(basename "$RELEASE_FILE") and ${filename}.md. Only one is allowed."
        fi
        RELEASE_FILE="$file"
        RELEASE_VERSION="$filename"
    fi
done

if [ -z "$RELEASE_FILE" ]; then
    die "No unreleased version file found in docs/releases/. Create one first (see docs/releases/TEMPLATE.md)."
fi

echo "Found: $(basename "$RELEASE_FILE") → tag $RELEASE_VERSION"

# ─── Pre-checks ──────────────────────────────────────────────────────────────

info "Pre-checks"

VERSION="$RELEASE_VERSION"
VERSION_NUMBER="${VERSION#v}"

# Validate version format
if ! [[ "$VERSION_NUMBER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    die "Invalid version format in filename: $VERSION (expected vX.Y.Z, e.g., v1.3.0)"
fi

# Required tools
command -v git >/dev/null 2>&1 || die "git is required"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v make >/dev/null 2>&1 || die "make is required"
command -v gh >/dev/null 2>&1 || die "gh CLI is required (https://cli.github.com)"
command -v gpg >/dev/null 2>&1 || die "gpg is required (for signed tags)"

# GitHub auth
gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"

# GPG signing key
SIGNING_KEY="$(git config user.signingkey 2>/dev/null || echo "")"
if [ -z "$SIGNING_KEY" ]; then
    die "No GPG signing key configured. Run: git config --global user.signingkey <KEY_ID>"
fi

# Repo state
if [ -n "$(git status --porcelain)" ]; then
    die "Working directory is not clean. Commit or stash your changes first."
fi

# Must be on main
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
    die "Releases must be created from 'main' branch (currently on '$CURRENT_BRANCH')"
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
echo "  Release file:  $(basename "$RELEASE_FILE")"
echo "  Previous tag:  ${PREVIOUS_TAG:-<none>}"
echo "  Commit:        $COMMIT_SHA"
echo "  Version code:  $VERSION_CODE"
echo "  Signing key:   $SIGNING_KEY"
echo "  Repository:    $GH_REPO"
echo ""

# ─── Confirmation ────────────────────────────────────────────────────────────

confirm "Build and release $VERSION?" || { echo "Aborted."; exit 0; }

# ─── Build and sign APK ──────────────────────────────────────────────────────
# Uses make targets which call scripts/build-apk.sh and scripts/sign-apk.sh.
# If the build or signing fails, nothing is published.

info "Building and signing APK"

export VERSION_NAME="$VERSION_NUMBER"
export VERSION_CODE
export OUTPUT_DIR

make -C "$REPO_ROOT" release-apk

FINAL_APK="$OUTPUT_DIR/svarla-signed.apk"
if [ ! -f "$FINAL_APK" ]; then
    die "Signed APK not found at $FINAL_APK"
fi

# Read checksum from the file produced by sign-apk.sh
SHA256="$(cat "$FINAL_APK.sha256" | awk '{print $1}')"
echo "  SHA-256: $SHA256"

# Rename to versioned filename for the release
RELEASE_APK="$OUTPUT_DIR/svarla-${VERSION}.apk"
cp "$FINAL_APK" "$RELEASE_APK"

# ─── Create signed tag and push ──────────────────────────────────────────────
# The signed tag proves a maintainer approved this commit as an official release.

info "Creating signed tag $VERSION"

git tag -s "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

echo "Signed tag pushed. CI will verify the signature before building."

# ─── Build release body ──────────────────────────────────────────────────────

info "Building release body"

RELEASE_CONTENT="$(sed '1{/^# /d}' "$RELEASE_FILE")"

RELEASE_BODY="${RELEASE_CONTENT}

## Docker

Pull the container images:
\`\`\`
docker pull ${REGISTRY}/${GH_REPO%/*}/svarla-server:${VERSION}
docker pull ${REGISTRY}/${GH_REPO%/*}/svarla-mediabridge:${VERSION}
\`\`\`

## Android

The APK is bundled inside the server container and available for download
from your Svarla instance. You can also download it from the assets below.

**SHA-256:** \`${SHA256}\`

## Verification

This release was created from a [signed git tag](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification). Verify with:
\`\`\`
git verify-tag ${VERSION}
\`\`\`"

# ─── Create draft GitHub release ─────────────────────────────────────────────

info "Creating draft GitHub release"

gh release create "$VERSION" \
    --title "Svarla $VERSION" \
    --notes "$RELEASE_BODY" \
    --draft \
    "$RELEASE_APK#svarla-${VERSION}.apk" \
    "$FINAL_APK.sha256#checksums.sha256"

echo "Draft release created. CI will verify the tag, build containers, and publish it."

# ─── Done ────────────────────────────────────────────────────────────────────

info "Release $VERSION initiated"
echo ""
echo "  Draft:     https://github.com/${GH_REPO}/releases/tag/${VERSION}"
echo "  APK:       $RELEASE_APK"
echo "  SHA-256:   $SHA256"
echo ""
echo "  CI will:"
echo "    1. Verify your signed tag"
echo "    2. Download the APK from the draft release"
echo "    3. Build containers with the APK baked in"
echo "    4. Push containers to GHCR"
echo "    5. Publish (un-draft) the release"
echo ""
echo "  Monitor:   https://github.com/${GH_REPO}/actions"
echo ""
