# Release File Template

<!-- 
This file is a template and instructions for creating release files.
It is excluded from the GitHub Pages site.

## How to create a new release

1. Determine the next version number (semver: MAJOR.MINOR.PATCH, e.g., 1.3.0)
2. Copy the template section below into a new file named `vX.Y.Z.md` in this 
   directory (e.g., `v1.3.0.md`)
3. Fill in the summary and list the changes since the last release
4. Commit and push the file to main
5. Run `scripts/release.sh` to perform the release

## Finding changes since last release

To see commits since the last tag:
```
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

## Rules

- The filename MUST match the pattern `vX.Y.Z.md` (e.g., v1.3.0.md, v2.0.0-beta.md)
- The file MUST start with a level-1 heading: `# vX.Y.Z`
- Only ONE unreleased version file should exist at a time
- The content is used as the description in the GitHub release (Docker/APK/SHA 
  info is appended automatically by the release script)
- Do NOT include Docker pull commands or APK SHA in the release file — those are 
  added by the release script
- Keep it concise and human-readable

## Template

Copy everything below the line into your new release file:
-->

---

# vX.Y.Z

Brief summary of this release.

## Changes

- Change 1
- Change 2
- Change 3

## Fixes

- Fix 1
- Fix 2
