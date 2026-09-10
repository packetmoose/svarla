#!/usr/bin/env bash
#
# Build container images locally and deploy them to a remote development server.
#
# Builds the PRODUCTION server and mediabridge images (the same images the
# production docker/docker-compose.yml runs) and transfers them directly via
# SSH (docker save | ssh docker load) — no registry needed.
#
# Why production images: the root docker-compose.yml is a local live-reload
# dev setup. Its `dev` Dockerfile stage never builds the web bundle (dist/web/)
# and it relies on the host source tree being bind-mounted, which does not
# exist on a remote host. Deploying that image makes the web UI 404 (the server
# skips static file registration when dist/web/ is absent). The production
# image bakes dist/web/ in, so it serves the page correctly.
#
# Images are tagged svarla-server:dev and svarla-mediabridge:dev and loaded on
# the remote as-is — no registry needed.
#
# Usage:
#   ./scripts/deploy-dev.sh user@devserver
#   ./scripts/deploy-dev.sh user@devserver --build-only    # build without uploading
#   ./scripts/deploy-dev.sh user@devserver --upload-only   # upload pre-built images
#
# Requires: docker (with buildx), ssh access to the remote host, and docker
# permissions on the remote host.

set -euo pipefail

IMAGES=("svarla-server:dev" "svarla-mediabridge:dev")

# Local docker invocation. The build scripts and `docker save` run on this
# host; on hosts where the docker daemon requires root, this must be sudo.
# Override with DOCKER="docker" if your user is in the docker group.
DOCKER="${DOCKER:-sudo docker}"

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

cd "$(dirname "$0")/.."

# ─── Build ────────────────────────────────────────────────────────────────────

build_images() {
  echo "▸ Building production images..."
  echo

  # build-server.sh runs the full production Dockerfile stage, which executes
  # `npm run build:web` and bakes dist/web/ into the image. The default
  # IMAGE_TAG=dev with no registry produces svarla-server:dev. DOCKER is passed
  # through so the build runs under sudo where the daemon requires root.
  DOCKER="$DOCKER" IMAGE_NAME="svarla-server" IMAGE_TAG="dev" \
    ./scripts/build-server.sh

  DOCKER="$DOCKER" IMAGE_NAME="svarla-mediabridge" IMAGE_TAG="dev" \
    ./scripts/build-mediabridge.sh

  echo "✓ Build complete"
  echo
  for img in "${IMAGES[@]}"; do
    echo "  • $img ($($DOCKER image inspect "$img" --format='{{.Size}}' | numfmt --to=iec 2>/dev/null || $DOCKER image inspect "$img" --format='{{.Size}}'))"
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
  $DOCKER save "${IMAGES[@]}" | pv 2>/dev/null | ssh "$SSH_HOST" "cat > $REMOTE_TMP" \
    || $DOCKER save "${IMAGES[@]}" | ssh "$SSH_HOST" "cat > $REMOTE_TMP"

  # Load with sudo (allocates TTY so sudo can prompt for password)
  echo "  Loading images on remote (sudo may prompt for password)..."
  ssh -t "$SSH_HOST" "sudo docker load -i $REMOTE_TMP && rm -f $REMOTE_TMP"

  echo
  echo "✓ Images loaded on $SSH_HOST"
}

# ─── Run ──────────────────────────────────────────────────────────────────────

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
    echo
    echo "The loaded images are tagged svarla-server:dev and svarla-mediabridge:dev."
    echo "Make sure the remote compose file references those tags (the production"
    echo "docker/docker-compose.yml points at ghcr.io/packetmoose/...:latest, so"
    echo "override the image names there or use a compose file that uses the :dev tags)."
    ;;
esac
