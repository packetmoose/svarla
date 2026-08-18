# Signing Key Verification

Svarla uses a simplified signing model with minimal key management:

## How verification works

| What | Verified by | Protected by |
|------|-------------|--------------|
| Git tags | GitHub's tag verification API | Account GPG key |
| Container images | Cosign keyless (Sigstore) | GitHub identity |
| Android APK | Android keystore | Local file (maintainer's machine) |

## Setup required

### GPG key (for signed tags)

Add a GPG key to your GitHub account:

```bash
gpg --full-generate-key
gpg --armor --export YOUR_KEY_ID
# → GitHub → Settings → SSH and GPG keys → New GPG key

git config --global user.signingkey YOUR_KEY_ID
```

CI verifies tags via `gh api .../git/tags/<sha>` — checking GitHub's own
verification status. No key file in the repo needed.

### Cosign (for container images)

No key pair needed. Uses [Sigstore keyless signing](https://docs.sigstore.dev/cosign/signing/overview/):

```bash
cosign sign ghcr.io/packetmoose/svarla-server@sha256:<digest>
# Opens browser for GitHub OIDC authentication
```

Users verify with:

```bash
cosign verify \
  --certificate-identity-regexp="https://github.com/packetmoose" \
  --certificate-oidc-issuer=https://github.com/login/oauth \
  ghcr.io/packetmoose/svarla-server@sha256:<digest>
```

### Android keystore (for APK signing)

The only key you need to manage locally:

```bash
keytool -genkey -v \
  -keystore ~/.android/svarla-release.p12 \
  -storetype PKCS12 \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -alias release
```

## Migrating to key-pair Cosign later

If you want to move away from keyless signing:

```bash
cosign generate-key-pair
# Store cosign.key securely, commit cosign.pub here
# Update release-sign.sh to use: cosign sign --key cosign.key ...
# Update verify docs to use: cosign verify --key cosign.pub ...
```
