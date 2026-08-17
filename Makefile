# ─── Svarla Build System ──────────────────────────────────────────────────────
#
# Development:
#   make apk                Build unsigned APK (Docker, no signing)
#   make sign-apk           Sign the APK with local keystore
#   make server             Build server container
#   make mediabridge        Build mediabridge container
#   make all                Build everything (apk + sign + containers)
#
# Release (two-phase):
#   make release-tag        Phase 1: create signed git tag, push (triggers CI)
#   make release-sign       Phase 2: sign CI artifacts, publish release
#   make release            Both phases with CI wait (one-shot convenience)
#
# Environment overrides (for CI or custom builds):
#   BUILD_TYPE=debug        APK build type (debug/release)
#   VERSION_NAME=1.2.0      APK version string
#   VERSION_CODE=42         APK version code integer
#   KEYSTORE_PATH=~/my.ks   Path to signing keystore
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

# ─── Development Targets ──────────────────────────────────────────────────────

.PHONY: apk
apk: ## Build unsigned APK in Docker
	BUILD_TYPE=$(BUILD_TYPE) OUTPUT_DIR=$(OUTPUT_DIR) \
		./scripts/build-apk.sh

.PHONY: sign-apk
sign-apk: ## Sign the built APK with local keystore
	APK_INPUT=$(OUTPUT_DIR)/app-release-unsigned.apk \
		APK_OUTPUT=$(OUTPUT_DIR)/svarla-signed.apk \
		./scripts/sign-apk.sh

.PHONY: server
server: ## Build server container image
	IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
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

.PHONY: release-tag
release-tag: ## Phase 1: create signed tag, push (triggers CI)
	./scripts/release-tag.sh

.PHONY: release-sign
release-sign: ## Phase 2: sign CI artifacts (APK + containers), publish release
	./scripts/release-sign.sh

.PHONY: release
release: ## Full release: tag + wait for CI + sign + publish
	./scripts/release.sh

.PHONY: release-apk
release-apk: apk sign-apk ## Build and sign APK locally (no tag, no publish)

# ─── CI Targets (used by GitHub Actions) ──────────────────────────────────────

.PHONY: ci-server
ci-server: ## Build and push server container (CI only)
	IMAGE_TAG=$(IMAGE_TAG) REGISTRY=$(REGISTRY) \
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
	@echo "  make release-tag                  Create signed tag, trigger CI"
	@echo "  make release-sign                 Sign artifacts, publish release"
	@echo "  make release                      Full release (tag + wait + sign)"
	@echo ""
