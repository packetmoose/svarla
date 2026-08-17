#!/bin/bash
set -e

# ─── Build Server Container ──────────────────────────────────────────────────
#
# Builds the Svarla server Docker image, optionally with the signed APK baked in.
#
# Environment variables:
#   APK_PATH       Path to the signed APK to include. Default: ./build-output/svarla-signed.apk
#                  If the file doesn't exist, the container is built without an APK
#                  (download page will show "not available in this build").
#   IMAGE_NAME     Docker image name. Default: svarla-server
#   IMAGE_TAG      Docker image tag. Default: dev
#   REGISTRY       Container registry prefix. Default: (none, local only)
#   PUSH           Push to registry after build. Default: false
#   PLATFORM       Docker platform(s). Default: (native platform)
#
# Usage:
#   ./scripts/build-server.sh
#   APK_PATH=./my-signed.apk IMAGE_TAG=v1.2.0 PUSH=true ./scripts/build-server.sh

die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "─── $* ───"; }

REPO_ROOT="$(git rev-parse --show-toplevel)"
APK_PATH="${APK_PATH:-$REPO_ROOT/build-output/svarla-signed.apk}"
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
echo "  Image:    $FULL_IMAGE"
echo "  APK:      ${APK_PATH:-none}"
echo "  Push:     $PUSH"
echo ""

cd "$REPO_ROOT"

# Determine APK build arg
BUILD_ARGS=""
if [ -f "$APK_PATH" ]; then
    # Copy APK into build context so Docker can COPY it
    cp "$APK_PATH" "$REPO_ROOT/apk-for-build.tmp"
    BUILD_ARGS="--build-arg APK_FILE=apk-for-build.tmp"
    echo "  Including APK in container image"
else
    echo "  No APK found at $APK_PATH — building without APK"
fi

# Build command
DOCKER_CMD="docker build"
DOCKER_ARGS="$BUILD_ARGS -t $FULL_IMAGE -f Dockerfile ."

if [ -n "$PLATFORM" ]; then
    DOCKER_ARGS="--platform $PLATFORM $DOCKER_ARGS"
fi

if [ "$PUSH" = "true" ]; then
    # Use buildx for push (supports multi-platform)
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

# Cleanup temp file
rm -f "$REPO_ROOT/apk-for-build.tmp"

info "Server container built"
echo "  $FULL_IMAGE"
echo ""
