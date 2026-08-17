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

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

# Phase 1: Create signed tag and push
"$REPO_ROOT/scripts/release-tag.sh"

# Wait for CI
info "Waiting for CI to complete"
echo ""
echo "  CI is building artifacts. This typically takes 5-10 minutes."
echo "  You can monitor progress at:"
echo "    https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/actions"
echo ""

VERSION="$(git describe --tags --abbrev=0)"
GH_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

# Poll for draft release to appear (CI creates it when done)
echo "  Waiting for draft release..."
for i in $(seq 1 60); do
    DRAFT="$(gh api "repos/${GH_REPO}/releases" \
        --jq ".[] | select(.tag_name == \"${VERSION}\" and .draft == true)" 2>/dev/null || echo "")"
    if [ -n "$DRAFT" ]; then
        echo "  Draft release found!"
        break
    fi
    if [ "$i" -eq 60 ]; then
        die "Timed out waiting for CI to create draft release (5 minutes). Check CI status and run 'make release-sign' manually."
    fi
    sleep 5
done

echo ""

# Phase 2: Sign and publish
"$REPO_ROOT/scripts/release-sign.sh"
