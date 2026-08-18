#!/bin/bash
set -e

# ─── Release Tag ──────────────────────────────────────────────────────────────
#
# Phase 1 of the release flow: create a signed git tag and push it.
# This triggers CI to build all unsigned artifacts.
#
# After CI completes, run `make release-sign` (or scripts/release-sign.sh)
# to sign the artifacts and publish the release.
#
# Prerequisites:
#   - git, gpg must be installed
#   - GPG signing key configured (git config user.signingkey)
#   - Working directory must be clean and on main branch
#   - A release file must exist in docs/releases/ without a matching git tag
#
# Usage:
#   ./scripts/release-tag.sh
#   make release-tag

usage() {
    cat <<EOF
Usage: $0 [options]

Create a signed release tag and push it to trigger CI builds.

The version is determined automatically from the next unreleased file in
docs/releases/ (a file named vX.Y.Z.md that doesn't have a matching git tag).

Options:
  -h, --help      Show this help message
EOF
    exit 0
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
fi

# ─── Configuration ───────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel)"
RELEASES_DIR="$REPO_ROOT/docs/releases"

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

for file in "$RELEASES_DIR"/v*.md; do
    [ -f "$file" ] || continue
    filename="$(basename "$file" .md)"
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

if ! [[ "$VERSION_NUMBER" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
    die "Invalid version format in filename: $VERSION (expected vX.Y.Z)"
fi

command -v git >/dev/null 2>&1 || die "git is required"
command -v gpg >/dev/null 2>&1 || die "gpg is required (for signed tags)"

SIGNING_KEY="$(git config user.signingkey 2>/dev/null || echo "")"
if [ -z "$SIGNING_KEY" ]; then
    die "No GPG signing key configured. Run: git config --global user.signingkey <KEY_ID>"
fi

if [ -n "$(git status --porcelain)" ]; then
    die "Working directory is not clean. Commit or stash your changes first."
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
    die "Releases must be created from 'main' branch (currently on '$CURRENT_BRANCH')"
fi

# ─── Version info ────────────────────────────────────────────────────────────

PREVIOUS_TAG="$(git describe --tags --abbrev=0 2>/dev/null || echo "")"
COMMIT_SHA="$(git rev-parse --short HEAD)"

echo ""
echo "  Version:       $VERSION"
echo "  Release file:  $(basename "$RELEASE_FILE")"
echo "  Previous tag:  ${PREVIOUS_TAG:-<none>}"
echo "  Commit:        $COMMIT_SHA"
echo "  Signing key:   $SIGNING_KEY"
echo ""

# ─── Confirmation ────────────────────────────────────────────────────────────

confirm "Create signed tag $VERSION and push?" || { echo "Aborted."; exit 0; }

# ─── Create signed tag and push ──────────────────────────────────────────────

info "Creating signed tag $VERSION"

git tag -s "$VERSION" -m "Release $VERSION"
git push origin "$VERSION"

# ─── Done ────────────────────────────────────────────────────────────────────

info "Tag $VERSION pushed"
echo ""
echo "  CI will now:"
echo "    1. Verify the tag signature"
echo "    2. Build unsigned APK"
echo "    3. Build server and mediabridge containers"
echo "    4. Push images to GHCR"
echo "    5. Create a draft release with all artifacts"
echo ""
echo "  Once CI completes, run:"
echo "    make release-sign"
echo ""
echo "  This will sign the APK, sign containers with Cosign, and publish the release."
echo ""
