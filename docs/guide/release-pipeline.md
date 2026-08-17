# Release Pipeline

Svarla uses a two-phase release pipeline where CI builds all artifacts transparently, and the maintainer signs them locally before publishing.

## Design Principles

- **CI builds everything** — fully transparent, public logs, reproducible.
- **Maintainer signs everything** — APK (Android keystore) and container images (Cosign).
- **Private signing keys never exist in CI** — not as secrets, not as artifacts.
- **Two commands** to perform a release — no waiting at the terminal required.
- **Platform-agnostic build scripts** — the same Makefile works locally and in CI.
- **Self-builders** can use their own signing keys with no GitHub dependency.

## Trust Model

| Component | Trust source |
|-----------|-------------|
| Source changes | Pull request review |
| Main branch | GitHub branch protection |
| Release identity | Signed git tag (GPG) |
| Build process | GitHub Actions (public logs) |
| APK authenticity | Android signing key (maintainer) |
| Container authenticity | Cosign signature (maintainer) |
| Release approval | Maintainer signs + publishes |

## High-Level Flow

```
Phase 1: make release-tag
    ├── Validate (clean main, GPG key configured)
    ├── Create signed git tag (git tag -s)
    └── Push tag → triggers CI

CI (automatic, ~5-10 minutes):
    ├── Verify tag GPG signature + fingerprint
    ├── Verify commit is on main
    ├── Build unsigned APK in Docker
    ├── Build server container → push to GHCR (unsigned)
    ├── Build mediabridge container → push to GHCR (unsigned)
    └── Create draft release with unsigned APK + checksums

Phase 2: make release-sign
    ├── Download unsigned APK from draft release
    ├── Sign APK with Android keystore
    ├── Sign container images with Cosign (by digest)
    ├── Upload signed APK to release
    ├── Update release body with verification commands
    └── Publish (un-draft) the release
```

## Prerequisites

### Tools

- `git` with GPG signing configured
- `docker` with buildx
- `make`
- `gh` (GitHub CLI, authenticated)
- `gpg` with a signing key
- `cosign` (for container image signing)

### Key Setup

You need three separate keys:

| Key | Purpose | Location |
|-----|---------|----------|
| GPG signing key | Sign git tags | `~/.gnupg/` |
| Android keystore | Sign APKs | `~/.android/release.keystore` |
| Cosign key pair | Sign container images | `~/.cosign/cosign.key` + `cosign.pub` |

#### GPG Key

```bash
gpg --full-generate-key
# Choose: RSA and RSA, 4096 bits, does not expire

gpg --list-secret-keys --keyid-format=long
# Note your key ID

git config --global user.signingkey YOUR_KEY_ID
```

Export the public key to the repository:

```bash
gpg --armor --export YOUR_KEY_ID > .github/keys/maintainer.pub
```

Add the fingerprint as a repository secret (`TRUSTED_GPG_FINGERPRINT`):

```bash
gpg --list-keys --with-colons | grep '^fpr' | head -1 | cut -d: -f10
# → Settings → Secrets → Actions → New: TRUSTED_GPP_FINGERPRINT
```

#### Android Keystore

```bash
keytool -genkey -v \
  -keystore ~/.android/release.keystore \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -alias release
```

#### Cosign Key Pair

```bash
cosign generate-key-pair
# Creates cosign.key (private) and cosign.pub (public)
mv cosign.key ~/.cosign/cosign.key
cp cosign.pub .github/keys/cosign.pub
```

Commit `cosign.pub` to the repository so users can verify container signatures.

::: warning
Back up all keys and passwords securely. The Android keystore cannot be rotated without users reinstalling the app.
:::

## Performing a Release

### 1. Prepare release notes

```bash
# Create docs/releases/v1.2.0.md with release notes
git add docs/releases/v1.2.0.md
git commit -m "docs: add v1.2.0 release notes"
git push
```

### 2. Phase 1 — Tag and trigger CI

```bash
make release-tag
```

This creates a signed git tag and pushes it. CI begins building.

### 3. Phase 2 — Sign and publish

Once CI completes (check GitHub Actions), run:

```bash
make release-sign
```

This downloads the unsigned APK, signs it, signs the container images with Cosign, and publishes the release.

### One-shot alternative

If you prefer to wait at the terminal:

```bash
make release
```

This runs both phases with an automatic CI wait loop in between.

## APK Distribution

The signed APK is distributed to users through the server itself:

- **Production containers**: On first start, the server fetches the signed APK from the matching GitHub release and caches it locally.
- **Download page**: Users visit their Svarla instance → see a download banner (Android) or navigate to the download page.
- **Version check**: The Android app checks `GET /api/version` on launch and shows an update banner if outdated.

### APK Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `APK_SOURCE` | `auto` | `local` = serve mounted file, `remote` = fetch from URL, `auto` = use local if exists else fetch |
| `APK_URL` | GitHub release URL | Override the URL to fetch the APK from |
| `APK_CERT_FINGERPRINT` | *(none)* | Expected APK signing certificate fingerprint (enables verification) |
| `APK_PATH` | `./public/downloads/svarla.apk` | Path where the APK is stored/served |

For development, the root `docker-compose.yml` mounts the locally built APK:

```yaml
volumes:
  - ./build-output/svarla-signed.apk:/app/public/downloads/svarla.apk:ro
environment:
  APK_SOURCE: local
```

## Building from Source (Self-Builders)

Users who want to build and sign everything with their own keys:

```bash
# Build everything — no GitHub, no CI, fully self-contained
make all
```

Or step by step:

```bash
make apk                              # Build unsigned APK
KEYSTORE_PATH=~/my.keystore make sign-apk  # Sign with your own key
make server                           # Build server container
make mediabridge                      # Build mediabridge container
```

Then run with the APK volume-mounted:

```yaml
services:
  server:
    image: svarla-server:dev
    environment:
      APK_SOURCE: local
    volumes:
      - ./build-output/svarla-signed.apk:/app/public/downloads/svarla.apk:ro
```

Or set `APK_URL` to point at your own release infrastructure.

## Makefile Reference

Run `make help` for a full list. Key targets:

| Target | Description |
|--------|-------------|
| `make apk` | Build unsigned APK in Docker |
| `make sign-apk` | Sign APK with local keystore |
| `make server` | Build server container |
| `make mediabridge` | Build mediabridge container |
| `make all` | Build everything (APK + sign + containers) |
| `make release-tag` | Phase 1: signed tag → triggers CI |
| `make release-sign` | Phase 2: sign artifacts → publish release |
| `make release` | Both phases with CI wait |
| `make clean` | Remove build artifacts |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BUILD_TYPE` | `release` | APK build type (`debug` or `release`) |
| `VERSION_NAME` | from git tag | APK version string |
| `VERSION_CODE` | git commit count | APK integer version code |
| `OUTPUT_DIR` | `./build-output` | Where build artifacts go |
| `KEYSTORE_PATH` | `~/.android/release.keystore` | Android signing keystore |
| `COSIGN_KEY` | `~/.cosign/cosign.key` | Cosign private key |
| `IMAGE_TAG` | `dev` | Docker image tag |
| `REGISTRY` | *(empty)* | Container registry prefix |
| `PUSH` | `false` | Push images to registry after build |
| `PLATFORM` | *(native)* | Docker platform(s) for cross-build |

## Key Management

### Backup Strategy

```
release-keys/
  ├── android-release.keystore.enc   # gpg --symmetric
  ├── cosign.key.enc                 # gpg --symmetric
  ├── git-signing.key.enc            # gpg --export-secret-keys | gpg --symmetric
  └── passwords.kdbx                 # KeePassXC (separate master password)
```

Keep encrypted backups on:
- Development laptop
- Self-hosted storage
- Offline USB drive

::: warning
Store key files and their passwords separately.
:::

### Key Rotation

- **GPG key**: Export new public key to `.github/keys/maintainer.pub`, update the `TRUSTED_GPG_FINGERPRINT` secret.
- **Cosign key**: Generate new pair, commit new `cosign.pub`, sign future images with new key.
- **Android keystore**: **Cannot** be rotated without users reinstalling the app.

## Security Considerations

- CI only builds if the tag is GPG-signed by the trusted key.
- CI verifies the tagged commit exists on `main` — tags pointing to unreviewed commits are rejected.
- The GPG fingerprint is pinned in a repository secret — swapping the key file alone doesn't bypass verification.
- `CODEOWNERS` requires maintainer review for changes to workflows, keys, and scripts.
- Container images are signed by digest (immutable) — tag-based attacks are not possible.
- The APK and containers are unsigned until the maintainer explicitly runs `make release-sign`.

### Branch Protection

```
Repository → Settings → Branches → Add rule for "main"
  ✓ Require a pull request before merging
  ✓ Require approvals (1+)
  ✓ Require review from code owners
  ✓ Require status checks to pass
  ✓ Do not allow bypassing the above settings
```

## Verifying a Release

### Verify the git tag

```bash
gpg --import .github/keys/maintainer.pub
git verify-tag v1.2.0
```

### Verify the APK

```bash
apksigner verify --print-certs svarla-v1.2.0.apk
# Check the certificate fingerprint matches the expected value
```

### Verify container images

```bash
cosign verify \
  --key https://raw.githubusercontent.com/packetmoose/svarla/main/.github/keys/cosign.pub \
  ghcr.io/packetmoose/svarla-server@sha256:<digest>
```

## Development Workflow

For day-to-day development, none of the release infrastructure is needed:

```bash
docker compose up    # builds from source, no APK needed
npm run dev          # or hot-reload dev server
```

To test the APK download flow locally:

```bash
make release-apk     # build + sign APK
docker compose up    # mounts the APK via volume
```
