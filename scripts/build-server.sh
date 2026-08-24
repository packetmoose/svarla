#!/bin/bash
set -e

# ─── Build Server Container ──────────────────────────────────────────────────
#
# Builds the Svarla server Docker image.
# The APK is NOT baked in — it's provisioned at runtime (fetched from GitHub
# release or volume-mounted for development).
#
# Environment variables:
#   IMAGE_NAME     Docker image name. Default: svarla-server
#   IMAGE_TAG      Docker image tag. Default: dev
#   REGISTRY       Container registry prefix. Default: (none, local only)
#   PUSH           Push to registry after build. Default: false
#   PLATFORM       Docker platform(s). Default: (native platform)
#
# Usage:
#   ./scripts/build-server.sh
#   IMAGE_TAG=v1.2.0 PUSH=true REGISTRY=ghcr.io/packetmoose ./scripts/build-server.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
IMAGE_NAME="${IMAGE_NAME:-svarla-server}"
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

info "Building server container"
echo "  Image: $FULL_IMAGE"
echo "  Push:  $PUSH"
echo ""

cd "$REPO_ROOT"

# Derive the version string from the image tag (strip leading 'v' if present)
BUILD_VERSION=""
if [[ "$IMAGE_TAG" =~ ^v[0-9] ]]; then
    BUILD_VERSION="${IMAGE_TAG#v}"
fi

# Build command
DOCKER_CMD="docker build"
DOCKER_ARGS="-t $FULL_IMAGE -f Dockerfile ."

if [ -n "$BUILD_VERSION" ]; then
    DOCKER_ARGS="--build-arg BUILD_VERSION=$BUILD_VERSION $DOCKER_ARGS"
fi

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

info "Server container built"
echo "  $FULL_IMAGE"
echo ""
