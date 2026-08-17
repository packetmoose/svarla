#!/bin/bash
set -e

# ─── Verify Tag Signature ────────────────────────────────────────────────────
#
# Verifies that a git tag is signed by a trusted GPG key.
# Used by CI to ensure only maintainer-approved releases are built.
#
# Environment variables:
#   TAG                       The tag to verify. Default: determined from git.
#   TRUSTED_KEY               Path to the trusted public GPG key.
#                             Default: .github/keys/maintainer.pub
#   TRUSTED_GPG_FINGERPRINT   (Optional) Expected fingerprint of the trusted key.
#                             If set, the key file is verified against this fingerprint
#                             before verifying the tag — prevents key file tampering.
#
# Exit codes:
#   0  Tag signature is valid and signed by the trusted key
#   1  Tag is not signed, or signed by an untrusted key, or fingerprint mismatch
#
# Usage:
#   ./scripts/verify-tag.sh
#   TAG=v1.2.0 ./scripts/verify-tag.sh
#   TAG=v1.2.0 TRUSTED_GPG_FINGERPRINT=ABC123 ./scripts/verify-tag.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
TAG="${TAG:-$(git describe --tags --exact-match 2>/dev/null || echo "")}"
TRUSTED_KEY="${TRUSTED_KEY:-$REPO_ROOT/.github/keys/maintainer.pub}"

if [ -z "$TAG" ]; then
    die "No tag specified and HEAD is not tagged. Set TAG=vX.Y.Z"
fi

info "Verifying tag signature: $TAG"

# Check the trusted key exists
if [ ! -f "$TRUSTED_KEY" ]; then
    die "Trusted public key not found at $TRUSTED_KEY"
fi

# Import the trusted key into a temporary keyring
export GNUPGHOME="$(mktemp -d)"
trap 'rm -rf "$GNUPGHOME"' EXIT

gpg --batch --import "$TRUSTED_KEY" 2>/dev/null

# If a trusted fingerprint is provided, verify the key file hasn't been swapped
if [ -n "${TRUSTED_GPG_FINGERPRINT:-}" ]; then
    ACTUAL_FINGERPRINT=$(gpg --list-keys --with-colons 2>/dev/null | grep '^fpr' | head -1 | cut -d: -f10)
    if [ "$ACTUAL_FINGERPRINT" != "$TRUSTED_GPG_FINGERPRINT" ]; then
        die "Key fingerprint mismatch!
  Expected: $TRUSTED_GPG_FINGERPRINT
  Actual:   $ACTUAL_FINGERPRINT

  The key file $TRUSTED_KEY may have been tampered with."
    fi
    echo "  Key fingerprint verified against trusted value"
fi

# Verify the tag signature
if git verify-tag "$TAG" 2>/dev/null; then
    SIGNER="$(git tag -v "$TAG" 2>&1 | grep 'Good signature' || echo "unknown")"
    info "Tag signature verified"
    echo "  Tag:    $TAG"
    echo "  $SIGNER"
    echo ""
    exit 0
else
    die "Tag $TAG is NOT signed by the trusted key, or is not signed at all.
  Expected key: $TRUSTED_KEY
  This release will not be built."
fi
