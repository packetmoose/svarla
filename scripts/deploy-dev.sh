#!/usr/bin/env bash
#
# Build container images locally and deploy them to a remote development server.
#
# Images are transferred directly via SSH (docker save | ssh docker load) —
# no registry needed.
#
# Usage:
#   ./scripts/deploy-dev.sh user@devserver
#   ./scripts/deploy-dev.sh user@devserver --build-only   # build without uploading
#   ./scripts/deploy-dev.sh user@devserver --upload-only   # upload pre-built images
#
# Requires: docker (with buildx), ssh access to the remote host, and docker
# permissions on the remote host.

set -euo pipefail

IMAGES=("svarla-server:dev" "svarla-mediabridge:dev")

usage() {
  echo "Usage: $0 <ssh-host> [--build-only|--upload-only]"
  echo
  echo "Examples:"
  echo "  $0 user@10.0.0.5"
  echo "  $0 user@devbox --build-only"
  echo "  $0 user@devbox --upload-only"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

SSH_HOST="$1"
MODE="${2:-full}"

case "$MODE" in
  --build-only)  MODE="build" ;;
  --upload-only) MODE="upload" ;;
  -*)            usage ;;
  *)             MODE="full" ;;
esac

# ─── Build ────────────────────────────────────────────────────────────────────

build_images() {
  echo "▸ Building images..."
  sudo docker compose build
  echo "✓ Build complete"
  echo
  for img in "${IMAGES[@]}"; do
    echo "  • $img ($(sudo docker image inspect "$img" --format='{{.Size}}' | numfmt --to=iec 2>/dev/null || sudo docker image inspect "$img" --format='{{.Size}}'))"
  done
  echo
}

# ─── Upload ───────────────────────────────────────────────────────────────────

upload_images() {
  echo "▸ Uploading images to $SSH_HOST..."
  echo "  Saving and transferring via SSH (this may take a minute)..."
  echo

  REMOTE_TMP="/tmp/svarla-images-$$.tar"

  # Transfer the image tarball to a temp file on the remote host
  sudo docker save "${IMAGES[@]}" | pv 2>/dev/null | ssh "$SSH_HOST" "cat > $REMOTE_TMP" \
    || sudo docker save "${IMAGES[@]}" | ssh "$SSH_HOST" "cat > $REMOTE_TMP"

  # Load with sudo (allocates TTY so sudo can prompt for password)
  echo "  Loading images on remote (sudo may prompt for password)..."
  ssh -t "$SSH_HOST" "sudo docker load -i $REMOTE_TMP && rm -f $REMOTE_TMP"

  echo
  echo "✓ Images loaded on $SSH_HOST"
}

# ─── Run ──────────────────────────────────────────────────────────────────────

cd "$(dirname "$0")/.."

case "$MODE" in
  build)
    build_images
    ;;
  upload)
    upload_images
    ;;
  full)
    build_images
    upload_images
    echo
    echo "Done. On the remote host, start services with:"
    echo "  docker compose up -d"
    ;;
esac
