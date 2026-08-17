# Maintainer GPG Public Key

This directory contains the public GPG key used to verify signed release tags.

## Setup

Export your public key and place it here:

```bash
gpg --armor --export YOUR_KEY_ID > .github/keys/maintainer.pub
```

Then commit and push it. CI will use this key to verify that release tags
were signed by the maintainer before building any artifacts.

**Important:** Also add your key fingerprint as a repository secret to prevent
key file tampering:

```bash
# Get your fingerprint
gpg --list-keys --with-colons | grep '^fpr' | head -1 | cut -d: -f10

# Add as a secret:
# Settings → Secrets and variables → Actions → New repository secret
# Name: TRUSTED_GPG_FINGERPRINT
# Value: <your full fingerprint>
```

CI verifies that the key in this file matches the fingerprint in the secret.
If someone replaces this file via a PR, the fingerprint won't match and CI
will refuse to build.

## Verifying a release locally

```bash
gpg --import .github/keys/maintainer.pub
git verify-tag v1.0.0
```

## Key rotation

If you need to rotate your signing key:

1. Generate a new key: `gpg --full-generate-key`
2. Export it: `gpg --armor --export NEW_KEY_ID > .github/keys/maintainer.pub`
3. Update git config: `git config --global user.signingkey NEW_KEY_ID`
4. Commit the new public key to the repository
5. All future releases will use the new key; old releases remain verifiable
   if you keep the old key in a separate file (e.g., `maintainer-old.pub`)
