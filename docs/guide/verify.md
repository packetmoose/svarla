# Verifying Releases

Every Svarla release is cryptographically signed. You can verify that the software you're running was approved by the maintainer and hasn't been tampered with.

## Quick Verification

### Container Images

```bash
cosign verify \
  --certificate-identity-regexp="https://github.com/packetmoose" \
  --certificate-oidc-issuer=https://github.com/login/oauth \
  ghcr.io/packetmoose/svarla-server:v1.2.0
```

### Git Tags

```bash
git verify-tag v1.2.0
```

### Android APK

```bash
apksigner verify --print-certs svarla-v1.2.0.apk
```

## How It Works

Svarla uses a minimal signing model — no key files to distribute or manage:

| Artifact | Signing method | How to verify |
|----------|---------------|---------------|
| Git tags | GPG key on maintainer's GitHub account | `git verify-tag` or GitHub's "Verified" badge |
| Container images | Cosign keyless (Sigstore OIDC) | `cosign verify` with identity filter |
| Android APK | Android keystore (local) | `apksigner verify` |

### Why keyless?

- **No key files to distribute** — you don't need to download a public key from anywhere
- **No key rotation headaches** — identity-based, not key-based
- **Transparency log** — every signature is recorded in [Rekor](https://rekor.sigstore.dev), publicly auditable
- **Protected by passkey** — the GitHub identity used for signing requires passkey authentication

## Detailed Verification

### Container Images (Cosign keyless)

Container signatures are tied to the maintainer's GitHub identity. Sigstore's Fulcio CA issues a short-lived certificate at signing time, and the signature is logged in Rekor (public transparency log).

```bash
# Verify server image
cosign verify \
  --certificate-identity-regexp="https://github.com/packetmoose" \
  --certificate-oidc-issuer=https://github.com/login/oauth \
  ghcr.io/packetmoose/svarla-server:v1.2.0

# Verify mediabridge image
cosign verify \
  --certificate-identity-regexp="https://github.com/packetmoose" \
  --certificate-oidc-issuer=https://github.com/login/oauth \
  ghcr.io/packetmoose/svarla-mediabridge:v1.2.0
```

::: tip
For the strongest guarantee, verify by digest (listed on the [release page](https://github.com/packetmoose/svarla/releases)):
```bash
cosign verify \
  --certificate-identity-regexp="https://github.com/packetmoose" \
  --certificate-oidc-issuer=https://github.com/login/oauth \
  ghcr.io/packetmoose/svarla-server@sha256:<digest>
```
:::

### Git Tags (GPG)

Release tags are signed with the maintainer's GPG key, which is registered on their GitHub account. GitHub shows a "Verified" badge on signed tags.

```bash
# Verify locally
git verify-tag v1.2.0

# Or check via GitHub API
gh api repos/packetmoose/svarla/git/tags/$(git rev-parse v1.2.0) --jq '.verification.verified'
```

### Android APK

The APK is signed with an Android keystore. The signing certificate stays constant across all releases — Android uses it to verify updates come from the same developer.

```bash
apksigner verify --print-certs svarla-v1.2.0.apk
```

You can also use [AppVerifier](https://f-droid.org/packages/dev.nicholasgasior.appverifier/) on Android to check the certificate.

## Trust Chain

```
Maintainer's GitHub account (passkey-protected)
    │
    ├── GPG key registered on account
    │     └── Signs git tags → "Verified" badge on GitHub
    │
    ├── GitHub OIDC identity
    │     └── Cosign keyless → signs container images via Sigstore
    │
    └── Android keystore (local machine)
          └── Signs APK → consistent identity across updates
```

## What Each Signature Proves

| Verification | What it proves |
|-------------|---------------|
| `git verify-tag` | The maintainer approved this exact source code as a release |
| `cosign verify` | The container image was signed by the maintainer's GitHub identity |
| `apksigner verify` | The APK came from the same developer who published all previous versions |

## Migrating to Key-Pair Cosign

If you fork Svarla and want to use your own Cosign key pair instead of keyless:

```bash
# Generate a key pair
cosign generate-key-pair

# Sign with your key
cosign sign --key cosign.key ghcr.io/yourname/svarla-server@sha256:<digest>

# Users verify with your public key
cosign verify --key cosign.pub ghcr.io/yourname/svarla-server@sha256:<digest>
```

See the [Release Pipeline](/guide/release-pipeline) docs for full setup instructions.
