# Release Pipeline

Svarla uses a secure release pipeline where CI builds artifacts but signing keys never leave the maintainer's machine. This page documents the full flow, key management, and how to perform a release.

## Design Principles

- **All code is reviewed** through pull requests before reaching `main`.
- **Release tags are cryptographically signed** by the maintainer.
- **CI verifies the tag signature** before building anything.
- **Private signing keys never exist in CI** — not as secrets, not as artifacts.
- **One command** performs the entire release from a development laptop.
- **Platform-agnostic build scripts** — the same Makefile works locally and in CI.
- **Users building from source** can use their own signing keys with no GitHub dependency.

## Trust Model

| Component | Trust source |
|-----------|-------------|
| Source changes | Pull request review |
| Main branch | GitHub branch protection |
| Release identity | Signed git tag (GPG) |
| Build process | GitHub Actions (verified tag) |
| APK authenticity | Android signing key (local) |
| Container contents | APK baked in at build time |
| Release approval | Maintainer local signing |

## High-Level Flow

```
    main branch (reviewed code)
            │
            ▼
   make release (local)
     ├── Build APK in Docker (reproducible)
     ├── Sign APK with local keystore
     ├── Create signed git tag (GPG)
     ├── Push tag to GitHub
     └── Create draft release with APK attached
            │
            ▼
   GitHub Actions (triggered by tag)
     ├── Verify tag GPG signature ← fails if not signed
     ├── Download APK from draft release
     ├── Verify APK checksum
     ├── Build server container (APK baked in)
     ├── Build mediabridge container
     ├── Push images to GHCR
     └── Publish (un-draft) the release
```

## Prerequisites

### Tools

- `git` with GPG signing configured
- `docker` with buildx
- `make`
- `gh` (GitHub CLI, authenticated)
- `gpg` with a signing key

### Key Setup

You need three separate keys:

| Key | Purpose | Location |
|-----|---------|----------|
| GPG signing key | Sign git tags | `~/.gnupg/` |
| Android keystore | Sign APKs | `~/.android/release.keystore` |
| SSH key (optional) | Push to GitHub | `~/.ssh/` |

#### GPG Key

Generate if you don't have one:

```bash
gpg --full-generate-key
# Choose: RSA and RSA, 4096 bits, does not expire
```

Configure git to use it:

```bash
gpg --list-secret-keys --keyid-format=long
# Note your key ID (e.g., 3AA5C34371567BD2)

git config --global user.signingkey 3AA5C34371567BD2
```

Export the public key and commit it to the repository:

```bash
gpg --armor --export 3AA5C34371567BD2 > .github/keys/maintainer.pub
git add .github/keys/maintainer.pub
git commit -m "chore: add maintainer GPG public key"
git push
```

CI uses this public key to verify release tags.

#### Android Keystore

Generate if you don't have one:

```bash
keytool -genkey -v \
  -keystore ~/.android/release.keystore \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -alias release
```

::: warning
Back up your keystore and password securely. If lost, you cannot publish APK updates that Android recognizes as the same app.
:::

## Performing a Release

### 1. Prepare

Ensure you're on `main` with a clean working directory and a release notes file:

```bash
git checkout main
git pull
# Create docs/releases/v1.2.0.md with release notes
git add docs/releases/v1.2.0.md
git commit -m "docs: add v1.2.0 release notes"
git push
```

### 2. Release

```bash
make release
```

This single command:
1. Finds the unreleased version from `docs/releases/`
2. Builds the APK in Docker (reproducible)
3. Prompts for your keystore password and signs the APK
4. Creates a signed git tag (`git tag -s`)
5. Pushes the tag (triggers CI)
6. Creates a draft GitHub release with the APK attached

### 3. Monitor

Watch CI at `https://github.com/packetmoose/svarla/actions`. CI will:
1. Verify your GPG tag signature
2. Download and verify the APK checksum
3. Build containers with the APK baked in
4. Push to GHCR
5. Publish the release

## Building from Source

Users who want to build everything locally with their own signing key:

```bash
# Build everything — no GitHub, no CI, fully self-contained
make all
```

Or step by step:

```bash
# Build unsigned APK
make apk

# Sign with your own keystore
KEYSTORE_PATH=~/my-keystore.jks make sign-apk

# Build server container with the APK included
make server

# Build mediabridge container
make mediabridge
```

Then use the locally built images in your `docker-compose.yml`:

```yaml
services:
  server:
    image: svarla-server:dev
    # ...
  mediabridge:
    image: svarla-mediabridge:dev
    # ...
```

## Makefile Reference

Run `make help` for a full list. Key targets:

| Target | Description |
|--------|-------------|
| `make apk` | Build unsigned APK in Docker |
| `make sign-apk` | Sign the APK with local keystore |
| `make server` | Build server container (includes APK if available) |
| `make mediabridge` | Build mediabridge container |
| `make all` | Build everything |
| `make release` | Full release flow |
| `make release-apk` | Build + sign APK only (no tag/publish) |
| `make clean` | Remove build artifacts |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILD_TYPE` | `release` | APK build type (`debug` or `release`) |
| `VERSION_NAME` | from git tag | APK version string |
| `VERSION_CODE` | git commit count | APK integer version code |
| `OUTPUT_DIR` | `./build-output` | Where build artifacts go |
| `KEYSTORE_PATH` | `~/.android/release.keystore` | Path to Android signing keystore |
| `APK_PATH` | `./build-output/svarla-signed.apk` | Signed APK for container builds |
| `IMAGE_TAG` | `dev` | Docker image tag |
| `REGISTRY` | *(empty)* | Container registry prefix |
| `PUSH` | `false` | Push images to registry after build |
| `PLATFORM` | *(native)* | Docker platform(s) for cross-build |

## Key Management

### Backup Strategy

Store encrypted copies of your keys:

```
release-keys/
  ├── android-release.keystore.enc   # gpg --symmetric
  ├── git-signing.key.enc            # gpg --export-secret-keys | gpg --symmetric
  └── passwords.kdbx                 # KeePassXC database (separate master password)
```

Keep encrypted backups on:
- Development laptop
- Self-hosted storage (e.g., your server)
- Offline USB drive

::: warning
Store key files and their passwords separately. The encrypted keystore on a USB drive is useless without the password in KeePassXC (and vice versa).
:::

### Key Rotation

If you need to rotate a signing key:

- **GPG key**: Export new public key to `.github/keys/maintainer.pub`, commit and push. Old releases remain verifiable.
- **Android keystore**: You **cannot** rotate this without users reinstalling the app. Plan carefully.

### Device Loss

If your development device is lost or compromised:

1. Revoke the GPG key: `gpg --gen-revoke KEY_ID`
2. Generate a new GPG key and update `.github/keys/maintainer.pub`
3. The Android keystore can be restored from your encrypted backup
4. All existing releases remain valid (signatures are permanent)

## Verifying a Release

Users can verify that a release was signed by the maintainer:

```bash
# Import the maintainer's public key
gpg --import .github/keys/maintainer.pub

# Verify a release tag
git verify-tag v1.2.0
```

The APK signature can be verified with:

```bash
apksigner verify --print-certs svarla-v1.2.0.apk
```

## Security Considerations

- The GPG key proves **who** approved a release.
- The Android keystore proves **which app** is legitimate.
- The signed tag connects **source code** to **release artifacts**.
- CI only builds if the tag signature is valid — a compromised GitHub account alone cannot produce a release.
- CI verifies the tagged commit exists on `main` — tags pointing to unreviewed commits on feature branches are rejected.
- Signing keys exist only on the maintainer's machine and encrypted backups.

### Protecting the verification itself

The tag verification only works if the verification infrastructure (workflow file, public key, scripts) cannot be tampered with. This is enforced by:

- **Branch protection on `main`** — require pull requests, require approvals, no direct pushes
- **Commit ancestry check** — CI verifies the tagged commit is on `main`, preventing tags that point to feature branch commits with modified workflows
- **Code review** — any changes to `.github/workflows/`, `.github/keys/`, or `scripts/verify-tag.sh` are visible in PRs

Configure branch protection:

```
Repository → Settings → Branches → Add rule for "main"
  ✓ Require a pull request before merging
  ✓ Require approvals (1+)
  ✓ Require status checks to pass
  ✓ Do not allow bypassing the above settings (optional, strict mode)
```

## Development Workflow

For day-to-day development, none of the release infrastructure is needed:

```bash
# Just run the containers for development
docker compose up

# Or use the dev server with hot reload
npm run dev
```

The Makefile and release scripts are only used when producing production builds or cutting a release.
