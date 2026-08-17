# Release Signing Public Keys

This directory contains the public keys used to verify releases.
CI validates these files against pinned hashes in repository secrets
to prevent tampering.

These same keys are also published on the docs site for easy user access:
https://packetmoose.github.io/svarla/guide/verify

## Files

| File | Purpose | Pinned secret |
|------|---------|---------------|
| `maintainer.pub` | GPG key for verifying signed git tags | `TRUSTED_GPG_FINGERPRINT` |
| `cosign.pub` | Cosign key for verifying container images | `TRUSTED_COSIGN_KEY_HASH` |

## Setup

### GPG Key

```bash
# Export your GPG public key
gpg --armor --export YOUR_KEY_ID > .github/keys/maintainer.pub

# Also copy to docs site
cp .github/keys/maintainer.pub docs/public/keys/maintainer.pub

# Get the fingerprint for the secret
gpg --list-keys --with-colons | grep '^fpr' | head -1 | cut -d: -f10
# → Settings → Secrets → Actions → TRUSTED_GPG_FINGERPRINT
```

### Cosign Key

```bash
# Generate a key pair (if you haven't already)
cosign generate-key-pair
mv cosign.key ~/.cosign/cosign.key

# Copy public key to repo and docs site
cp cosign.pub .github/keys/cosign.pub
cp cosign.pub docs/public/keys/cosign.pub

# Get the SHA-256 hash for the secret
sha256sum .github/keys/cosign.pub | awk '{print $1}'
# → Settings → Secrets → Actions → TRUSTED_COSIGN_KEY_HASH
```

## Why both a file and a secret?

The file is what CI and users use to perform verification. The secret pins the
file's identity — if someone replaces the file via a PR, CI will detect the
mismatch and fail. Changing secrets requires admin access with sudo mode
(passkey re-authentication).
