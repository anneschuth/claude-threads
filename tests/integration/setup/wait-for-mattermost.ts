#!/usr/bin/env bun
/**
 * Wait for Mattermost to be ready
 *
 * This script polls the Mattermost health endpoint until it responds,
 * or times out after a configurable duration.
 *
 * Usage:
 *   bun run tests/integration/setup/wait-for-mattermost.ts
 *   bun run tests/integration/setup/wait-for-mattermost.ts --timeout 120000
 */

import { DEFAULT_CONFIG } from './config.js';

const MATTERMOST_URL = process.env.MATTERMOST_URL || DEFAULT_CONFIG.mattermost.url;
const TIMEOUT_MS = parseInt(process.env.WAIT_TIMEOUT || '120000', 10);
const POLL_INTERVAL_MS = 2000;

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if Mattermost is healthy
 */
async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${MATTERMOST_URL}/api/v4/system/ping`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Wait for Mattermost to be ready
 */
async function waitForMattermost(): Promise<void> {
  console.log(`Waiting for Mattermost at ${MATTERMOST_URL}...`);

  const startTime = Date.now();
  let attempts = 0;

  while (Date.now() - startTime < TIMEOUT_MS) {
    attempts++;
    const healthy = await checkHealth();

    if (healthy) {
      console.log(`Mattermost is ready! (${attempts} attempts, ${Date.now() - startTime}ms)`);
      return;
    }

    if (attempts % 5 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Still waiting... (${elapsed}s elapsed, ${attempts} attempts)`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Mattermost did not become ready within ${TIMEOUT_MS}ms`);
}

// Run if executed directly
if (import.meta.main) {
  waitForMattermost()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}

export { waitForMattermost, checkHealth };
