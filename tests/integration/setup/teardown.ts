#!/usr/bin/env bun
/**
 * Teardown script for integration tests
 *
 * Cleans up test data between test runs:
 * - Deletes all posts in the test channel
 * - Optionally creates a fresh channel for isolation
 *
 * Usage:
 *   bun run tests/integration/setup/teardown.ts
 *   bun run tests/integration/setup/teardown.ts --create-channel unique-name
 */

import { loadConfig } from './config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';

/**
 * Clean up posts in a channel
 */
export async function cleanupChannel(channelId: string, adminToken: string, baseUrl: string): Promise<number> {
  const api = new MattermostTestApi(baseUrl, adminToken);
  const count = await api.deleteAllPostsInChannel(channelId);
  return count;
}

/**
 * Create a new channel for test isolation
 */
export async function createTestChannel(
  teamId: string,
  channelName: string,
  adminToken: string,
  baseUrl: string,
): Promise<string> {
  const api = new MattermostTestApi(baseUrl, adminToken);

  const channel = await api.createChannel({
    team_id: teamId,
    name: channelName,
    display_name: `Test ${channelName}`,
    type: 'O',
  });

  return channel.id;
}

/**
 * Main teardown function
 */
async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.mattermost.admin.token) {
    console.error('Admin token not found. Run setup-mattermost.ts first.');
    process.exit(1);
  }

  if (!config.mattermost.channel.id) {
    console.error('Channel ID not found. Run setup-mattermost.ts first.');
    process.exit(1);
  }

  // Parse arguments
  const args = process.argv.slice(2);
  const createChannelIndex = args.indexOf('--create-channel');

  if (createChannelIndex !== -1 && args[createChannelIndex + 1]) {
    // Create a new channel
    const channelName = args[createChannelIndex + 1];
    console.log(`Creating new test channel: ${channelName}...`);

    const channelId = await createTestChannel(
      config.mattermost.team.id!,
      channelName,
      config.mattermost.admin.token,
      config.mattermost.url,
    );

    console.log(`Created channel ${channelName} (${channelId})`);
    // Output just the ID for scripts to capture
    console.log(`CHANNEL_ID=${channelId}`);
  } else {
    // Clean up the default channel
    console.log('Cleaning up test channel...');
    const count = await cleanupChannel(
      config.mattermost.channel.id,
      config.mattermost.admin.token,
      config.mattermost.url,
    );
    console.log(`Deleted ${count} posts`);
  }
}

// Run if executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error('Teardown failed:', error);
    process.exit(1);
  });
}

export { main as teardown };
