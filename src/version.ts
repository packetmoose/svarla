import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface VersionInfo {
  version: string;
  gitRef: string | null;
  buildRef: string | null;
  buildDate: string | null;
}

const DEV_DEFAULT: VersionInfo = {
  version: '999.0.0-dev',
  gitRef: null,
  buildRef: null,
  buildDate: null,
};

let cached: VersionInfo | null = null;

/**
 * Resolve the application version info.
 *
 * Resolution order:
 * 1. DEV_VERSION_OVERRIDE env var (overrides version string only, other fields remain from file or null)
 * 2. version.json in the working directory (generated at Docker build time)
 * 3. Hardcoded dev defaults (999.0.0-dev)
 */
export function getVersionInfo(): VersionInfo {
  if (cached) return cached;

  let info: VersionInfo;

  const versionFilePath = join(process.cwd(), 'version.json');

  if (existsSync(versionFilePath)) {
    try {
      const raw = JSON.parse(readFileSync(versionFilePath, 'utf-8'));
      info = {
        version: raw.version || DEV_DEFAULT.version,
        gitRef: raw.gitRef || null,
        buildRef: raw.buildRef || null,
        buildDate: raw.buildDate || null,
      };
    } catch {
      info = { ...DEV_DEFAULT };
    }
  } else {
    info = { ...DEV_DEFAULT };
  }

  // DEV_VERSION_OVERRIDE takes highest priority for the version string
  if (process.env.DEV_VERSION_OVERRIDE) {
    info = { ...info, version: process.env.DEV_VERSION_OVERRIDE };
  }

  cached = info;
  return cached;
}

/**
 * Check whether a version string represents a development build.
 */
export function isDevVersion(version: string): boolean {
  return version.endsWith('-dev');
}
