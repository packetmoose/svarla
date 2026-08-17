# ─── Svarla Build System ──────────────────────────────────────────────────────
#
# Usage:
#   make apk                Build unsigned APK (Docker, no signing)
#   make sign-apk           Sign the APK with local keystore
#   make server             Build server container (includes APK if available)
#   make mediabridge        Build mediabridge container
#   make all                Build everything (apk + sign + server + mediabridge)
#   make release            Full release: build, sign, tag, publish draft
#
# Environment overrides (for CI or custom builds):
#   VERSION_NAME=1.2.0      APK version string
#   VERSION_CODE=42         APK version code integer
#   BUILD_TYPE=debug        APK build type (debug/release)
#   KEYSTORE_PATH=~/my.ks   Path to signing keystore
#   APK_PATH=./my.apk       Signed APK to bake into server image
#   IMAGE_TAG=v1.2.0        Container image tag
#   REGISTRY=ghcr.io/user   Container registry prefix
#   PUSH=true               Push images to registry after build
#   PLATFORM=linux/amd64    Docker platform(s) for cross-compilation
#
# ─────────────────────────────────────────────────────────────────────────────

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ─── Defaults ─────────────────────────────────────────────────────────────────

REPO_ROOT := $(shell git rev-parse --show-toplevel)
OUTPUT_DIR ?= $(REPO_ROOT)/build-output
BUILD_TYPE ?= release
IMAGE_TAG ?= dev
REGISTRY ?=
PUSH ?= false
PLATFORM ?=

# Derived
APK_UNSIGNED := $(OUTPUT_DIR)/app-release-unsigned.apk
APK_SIGNED := $(OUTPUT_DIR)/svarla-signed.apk
APK_PATH ?= $(APK_SIGNED)

# ─── Development Targets ──────────────────────────────────────────────────────

.PHONY: apk
apk: ## Build unsigned APK in Docker
	BUILD_TYPE=$(BUILD_TYPE) OUTPUT_DIR=$(OUTPUT_DIR) \
		./scripts/build-apk.sh

.PHONY: sign-apk
sign-apk: ## Sign the built APK with local keystore
	APK_INPUT=$(APK_UNSIGNED) APK_OUTPUT=$(APK_SIGNED) \
		./scripts/sign-apk.sh

.PHONY: server
server: ## Build server container image (includes APK if available)
	APK_PATH=$(APK_PATH) IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
		PUSH=$(PUSH) PLATFORM="$(PLATFORM)" \
		./scripts/build-server.sh

.PHONY: mediabridge
mediabridge: ## Build mediabridge container image
	IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
		PUSH=$(PUSH) PLATFORM="$(PLATFORM)" \
		./scripts/build-mediabridge.sh

.PHONY: all
all: apk sign-apk server mediabridge ## Build everything (APK + sign + containers)

# ─── Release Targets ──────────────────────────────────────────────────────────

.PHONY: release
release: ## Full release: build APK, sign, create signed tag, push draft
	./scripts/release.sh

.PHONY: release-apk
release-apk: apk sign-apk ## Build and sign APK (no tag, no publish)

# ─── CI Targets (used by GitHub Actions) ──────────────────────────────────────

.PHONY: ci-verify-tag
ci-verify-tag: ## Verify the signed git tag (CI only)
	./scripts/verify-tag.sh

.PHONY: ci-server
ci-server: ## Build and push server container (CI only)
	APK_PATH=$(APK_PATH) IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
		PUSH=true PLATFORM="$(PLATFORM)" \
		./scripts/build-server.sh

.PHONY: ci-mediabridge
ci-mediabridge: ## Build and push mediabridge container (CI only)
	IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
		PUSH=true PLATFORM="$(PLATFORM)" \
		./scripts/build-mediabridge.sh

# ─── Utility Targets ──────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(OUTPUT_DIR)
	rm -f $(REPO_ROOT)/apk-for-build.tmp

.PHONY: verify-tag
verify-tag: ## Verify a signed git tag locally
	./scripts/verify-tag.sh

.PHONY: help
help: ## Show this help
	@echo "Svarla Build System"
	@echo ""
	@echo "Usage: make <target> [VAR=value ...]"
	@echo ""
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "Examples:"
	@echo "  make all                          Build everything locally"
	@echo "  make apk BUILD_TYPE=debug         Build debug APK"
	@echo "  make server IMAGE_TAG=v1.2.0      Build server with version tag"
	@echo "  make release                      Full release flow"
	@echo "  make ci-server REGISTRY=ghcr.io/packetmoose IMAGE_TAG=v1.2.0"
	@echo ""
