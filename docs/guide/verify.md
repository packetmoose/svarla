# Verifying Releases

Every Svarla release is cryptographically signed. You can verify that the software you're running was approved by the maintainer and hasn't been tampered with.

## Public Keys

### GPG Key (Git Tags & Source)

Used to sign release tags. Proves the maintainer approved a specific source commit as an official release.

```
-----BEGIN PGP PUBLIC KEY BLOCK-----

[Replace with actual key after running: gpg --armor --export YOUR_KEY_ID]

-----END PGP PUBLIC KEY BLOCK-----
```

**Fingerprint:** `[Set after key generation]`

### Cosign Key (Container Images)

Used to sign container images on GHCR. Proves the container image is legitimate.

```
-----BEGIN PUBLIC KEY-----

[Replace with actual key after running: cosign generate-key-pair]

-----END PUBLIC KEY-----
```

## How to Verify

### Verify a Git Tag

Confirms the release source was approved by the maintainer:

```bash
# Import the GPG key (one-time)
curl -sSL https://packetmoose.github.io/svarla/guide/verify | gpg --import

# Or import from the repository
gpg --import .github/keys/maintainer.pub

# Verify a release tag
git verify-tag v1.2.0
```

### Verify a Container Image

Confirms the container image was signed by the maintainer after CI built it:

```bash
# Verify the server image
cosign verify \
  --key https://packetmoose.github.io/svarla/keys/cosign.pub \
  ghcr.io/packetmoose/svarla-server:v1.2.0

# Verify the mediabridge image
cosign verify \
  --key https://packetmoose.github.io/svarla/keys/cosign.pub \
  ghcr.io/packetmoose/svarla-mediabridge:v1.2.0
```

::: tip
Always verify by digest for the strongest guarantee:
```bash
cosign verify \
  --key https://packetmoose.github.io/svarla/keys/cosign.pub \
  ghcr.io/packetmoose/svarla-server@sha256:<digest>
```
The digest is listed on each [release page](https://github.com/packetmoose/svarla/releases).
:::

### Verify the Android APK

Confirms the APK was signed by the official Android signing key:

```bash
apksigner verify --print-certs svarla-v1.2.0.apk
```

The certificate fingerprint should match:

```
Signer #1 certificate SHA-256 digest: [Set after first release]
```

You can also verify using [AppVerifier](https://f-droid.org/packages/dev.nicholasgasior.appverifier/) on Android.

## Trust Chain

```
Maintainer GPG key
    │
    ├── Signs git tag → proves source approval
    │       │
    │       └── CI verifies tag → builds artifacts
    │               │
    │               ├── Unsigned APK
    │               ├── Container images (pushed to GHCR)
    │               └── Draft release
    │
    ├── Signs APK (Android keystore) → proves APK authenticity
    │
    └── Signs containers (Cosign) → proves image authenticity
            │
            └── Published release (signed APK + signed images)
```

## What Each Signature Proves

| Verification | What it proves |
|-------------|---------------|
| `git verify-tag` | The maintainer approved this exact source code as a release |
| `cosign verify` | The container image was signed by the maintainer after reviewing the CI build |
| `apksigner verify` | The APK came from the same developer who published all previous versions |

## Security Notes

- The GPG key fingerprint is pinned in a GitHub Actions secret — even if someone replaces the key file in the repo, CI will reject it.
- Container images are signed **by digest** (immutable), not by tag (which can be moved).
- The Android signing key cannot be rotated without users reinstalling the app — it's a permanent identity.
- All signing happens on the maintainer's local machine — keys never exist in CI.
