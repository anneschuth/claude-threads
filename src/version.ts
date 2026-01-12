/**
 * Package version utility
 * Handles version resolution that works both in development and bundled builds
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PackageInfo {
  version: string;
  name: string;
}

/**
 * Find and load package.json by checking multiple possible locations
 * Works for both source and bundled builds
 */
function loadPackageJson(): PackageInfo {
  // Possible locations relative to this file (or the bundle)
  const candidates = [
    resolve(__dirname, '..', 'package.json'),        // dist/index.js -> package.json
    resolve(__dirname, '..', '..', 'package.json'),  // src/version.ts -> package.json (dev)
    resolve(process.cwd(), 'package.json'),          // fallback: cwd
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8'));
        if (pkg.name === 'claude-threads') {
          return { version: pkg.version, name: pkg.name };
        }
      } catch {
        // Try next candidate
      }
    }
  }

  // Fallback if package.json not found
  return { version: 'unknown', name: 'claude-threads' };
}

// Cache the result
const pkgInfo = loadPackageJson();

export const VERSION = pkgInfo.version;

// For update-notifier which needs { name, version } object
export const PKG = pkgInfo;
