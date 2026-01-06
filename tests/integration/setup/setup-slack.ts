#!/usr/bin/env bun
/**
 * Setup script for Slack integration tests
 *
 * Starts the Slack mock server and waits for it to be ready.
 * This should be run before running Slack integration tests.
 *
 * Usage:
 *   bun run tests/integration/setup/setup-slack.ts [--stop]
 *
 * Options:
 *   --stop  Stop the mock server instead of starting it
 */

import { SlackMockServer } from '../fixtures/slack/mock-server.js';
import { DEFAULT_SLACK_CONFIG, loadConfig } from './config.js';

const PORT = parseInt(process.env.SLACK_MOCK_PORT || String(DEFAULT_SLACK_CONFIG.mockServerPort), 10);

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`http://localhost:${port}/api/api.test`, {
        method: 'POST',
      });
      if (response.ok) {
        const data = await response.json() as { ok: boolean };
        if (data.ok) {
          return true;
        }
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function isServerRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/api/api.test`, {
      method: 'POST',
    });
    const data = await response.json() as { ok: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  // Check if --stop flag is provided
  if (args.includes('--stop')) {
    console.log('Stopping Slack mock server...');
    // Try to stop by sending a request (mock server doesn't have a stop endpoint,
    // so we just check if it's running and inform the user)
    const running = await isServerRunning(PORT);
    if (running) {
      console.log(`Mock server is running on port ${PORT}. Use pkill or kill the process manually.`);
      console.log('Hint: pkill -f "mock-server" or find the process ID');
    } else {
      console.log('Mock server is not running.');
    }
    return;
  }

  // Check if server is already running
  const alreadyRunning = await isServerRunning(PORT);
  if (alreadyRunning) {
    console.log(`Slack mock server is already running on port ${PORT}`);
    return;
  }

  console.log(`Starting Slack mock server on port ${PORT}...`);

  // Load config to get any custom settings
  const config = loadConfig();
  const slackConfig = config.slack || DEFAULT_SLACK_CONFIG;

  // Start the mock server
  const server = new SlackMockServer({
    port: PORT,
    debug: process.env.DEBUG === '1',
  });

  await server.start();

  // Wait for server to be ready
  const ready = await waitForServer(PORT);
  if (ready) {
    console.log(`Slack mock server is ready on port ${PORT}`);
    console.log(`  API URL: http://localhost:${PORT}/api`);
    console.log(`  WebSocket URL: ws://localhost:${PORT}/socket-mode`);
    console.log(`  Bot Token: ${slackConfig.botToken}`);
    console.log(`  App Token: ${slackConfig.appToken}`);
    console.log(`  Channel ID: ${slackConfig.channelId}`);

    // Keep the server running
    console.log('\nServer is running. Press Ctrl+C to stop.');

    // Handle shutdown
    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await server.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await server.stop();
      process.exit(0);
    });

    // Keep process alive
    await new Promise(() => {});
  } else {
    console.error('Failed to start Slack mock server');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
