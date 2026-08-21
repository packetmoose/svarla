#!/bin/bash
set -e

# ─── Release (combined) ──────────────────────────────────────────────────────
#
# Convenience wrapper that runs both release phases sequentially.
# In practice, you'll usually run them separately:
#
#   make release-tag     ← creates signed tag, pushes (triggers CI)
#   # wait for CI to complete...
#   make release-sign    ← signs artifacts, publishes release
#
# This script runs release-tag, then waits for CI, then runs release-sign.
# Useful if you want to stay at the terminal and do everything in one go.
#
# Usage:
#   ./scripts/release.sh
#   make release

REPO_ROOT="$(git rev-parse --show-toplevel)"
KEYSTORE_PATH="${KEYSTORE_PATH:-$HOME/.android/svarla-release.p12}"

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

# ─── Pre-flight checks ───────────────────────────────────────────────────────
# Validate everything and collect all credentials upfront so the rest can run
# unattended (including the 10+ minute CI wait).

info "Pre-flight checks"

command -v git >/dev/null 2>&1 || die "git is required"
command -v gpg >/dev/null 2>&1 || die "gpg is required (for signed tags)"
command -v gh >/dev/null 2>&1 || die "gh CLI is required"
command -v cosign >/dev/null 2>&1 || die "cosign is required (https://docs.sigstore.dev/cosign/installation/)"
command -v docker >/dev/null 2>&1 || die "docker is required (for apksigner)"

gh auth status >/dev/null 2>&1 || die "gh CLI is not authenticated. Run: gh auth login"

# Verify gh token has write:packages scope (required for pushing cosign signatures to GHCR)
GH_SCOPES="$(gh auth status 2>&1)"
if ! echo "$GH_SCOPES" | grep -q "write:packages"; then
    echo "WARNING: gh token is missing 'write:packages' scope (required for cosign)."
    echo ""
    read -r -p "Refresh token to add write:packages scope? [y/N] " response
    case "$response" in
        [yY][eE][sS]|[yY]) gh auth refresh -s write:packages || die "Failed to refresh gh auth scope" ;;
        *) die "Cannot continue without write:packages scope. Run manually: gh auth refresh -s write:packages" ;;
    esac
    echo ""
fi

# Elevate sudo and verify Docker daemon
sudo true || die "sudo is required for Docker operations"
sudo docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start it with: sudo systemctl start docker"

if [ ! -f "$KEYSTORE_PATH" ]; then
    die "Android keystore not found at $KEYSTORE_PATH"
fi

# Collect passwords upfront
if [ -z "${KEYSTORE_PASSWORD:-}" ]; then
    read -r -s -p "Keystore password: " KEYSTORE_PASSWORD
    echo ""
fi
if [ -z "$KEYSTORE_PASSWORD" ]; then
    die "Keystore password is required"
fi
export KEYSTORE_PASSWORD
export KEY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

echo "All checks passed."
echo ""

# ─── Phase 1: Create signed tag and push ─────────────────────────────────────

"$REPO_ROOT/scripts/release-tag.sh"

# ─── Wait for CI ─────────────────────────────────────────────────────────────

info "Waiting for CI to complete"
echo ""
echo "  CI is building artifacts. This typically takes 5-10 minutes."
echo "  You can monitor progress at:"
echo "    https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"
echo ""

VERSION="$(git describe --tags --abbrev=0)"
GH_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# Keep sudo alive during the wait
(while true; do sudo -v; sleep 60; done) &
SUDO_KEEPALIVE_PID=$!
trap "kill $SUDO_KEEPALIVE_PID 2>/dev/null" EXIT

# Poll for draft release to appear (CI creates it when done)
echo "  Waiting for draft release..."
for i in $(seq 1 80); do
    DRAFT="$(gh api "repos/${GH_REPO}/releases" \
        --jq ".[] | select(.tag_name == \"${VERSION}\" and .draft == true)" 2>/dev/null || echo "")"
    if [ -n "$DRAFT" ]; then
        echo "  Draft release found!"
        break
    fi
    if [ "$i" -eq 80 ]; then
        die "Timed out waiting for CI to create draft release (20 minutes). Check CI status and run 'make release-sign' manually."
    fi
    sleep 15
done

echo ""

# ─── Phase 2: Sign and publish ───────────────────────────────────────────────

"$REPO_ROOT/scripts/release-sign.sh"
