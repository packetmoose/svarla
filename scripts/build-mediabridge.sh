#!/bin/bash
set -e

# ─── Build MediaBridge Container ─────────────────────────────────────────────
#
# Builds the Svarla MediaBridge Docker image.
#
# Environment variables:
#   IMAGE_NAME     Docker image name. Default: svarla-mediabridge
#   IMAGE_TAG      Docker image tag. Default: dev
#   REGISTRY       Container registry prefix. Default: (none, local only)
#   PUSH           Push to registry after build. Default: false
#   PLATFORM       Docker platform(s). Default: (native platform)
#
# Usage:
#   ./scripts/build-mediabridge.sh
#   IMAGE_TAG=v1.2.0 PUSH=true REGISTRY=ghcr.io/packetmoose ./scripts/build-mediabridge.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE_NAME="${IMAGE_NAME:-svarla-mediabridge}"
IMAGE_TAG="${IMAGE_TAG:-dev}"
REGISTRY="${REGISTRY:-}"
PUSH="${PUSH:-false}"
PLATFORM="${PLATFORM:-}"

# Build the full image reference
if [ -n "$REGISTRY" ]; then
    FULL_IMAGE="${REGISTRY}/${IMAGE_NAME}:${IMAGE_TAG}"
else
    FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"
fi

info "Building mediabridge container"
echo "  Image: $FULL_IMAGE"
echo "  Push:  $PUSH"
echo ""

cd "$REPO_ROOT/mediabridge"

# Build command
DOCKER_CMD="docker build"
DOCKER_ARGS="-t $FULL_IMAGE -f Dockerfile ."

if [ -n "$PLATFORM" ]; then
    DOCKER_ARGS="--platform $PLATFORM $DOCKER_ARGS"
fi

if [ "$PUSH" = "true" ]; then
    DOCKER_CMD="docker buildx build"
    DOCKER_ARGS="--push $DOCKER_ARGS"

    # Also tag as latest if this looks like a version tag
    if [[ "$IMAGE_TAG" =~ ^v[0-9] ]]; then
        if [ -n "$REGISTRY" ]; then
            DOCKER_ARGS="--tag ${REGISTRY}/${IMAGE_NAME}:latest $DOCKER_ARGS"
        else
            DOCKER_ARGS="--tag ${IMAGE_NAME}:latest $DOCKER_ARGS"
        fi
    fi
fi

$DOCKER_CMD $DOCKER_ARGS

info "MediaBridge container built"
echo "  $FULL_IMAGE"
echo ""
