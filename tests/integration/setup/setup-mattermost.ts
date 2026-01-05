#!/usr/bin/env bun
/**
 * Setup Mattermost for integration testing
 *
 * This script sets up a fresh Mattermost instance with:
 * 1. Admin user (first user on fresh Mattermost)
 * 2. Test team
 * 3. Test channel
 * 4. Bot account with access token
 * 5. Test users for multi-user scenarios
 *
 * Usage:
 *   bun run tests/integration/setup/setup-mattermost.ts
 */

import { DEFAULT_CONFIG, saveConfig, type IntegrationTestConfig } from './config.js';
import { MattermostTestApi } from '../fixtures/mattermost/api-helpers.js';

const config: IntegrationTestConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const api = new MattermostTestApi(config.mattermost.url);

/**
 * Create admin user (first user on fresh Mattermost)
 */
async function setupAdmin(): Promise<void> {
  console.log('Setting up admin user...');

  const { admin } = config.mattermost;

  try {
    // Try to login first (in case admin already exists)
    const { token, user } = await api.login(admin.username, admin.password);
    admin.token = token;
    admin.userId = user.id;
    console.log(`  Admin user already exists: ${user.username} (${user.id})`);
  } catch {
    // Create new admin user
    console.log('  Creating new admin user...');
    const user = await api.createUser({
      username: admin.username,
      password: admin.password,
      email: admin.email,
    });
    admin.userId = user.id;

    // Login to get token
    const { token } = await api.login(admin.username, admin.password);
    admin.token = token;
    console.log(`  Created admin user: ${user.username} (${user.id})`);
  }
}

/**
 * Create test team
 */
async function setupTeam(): Promise<void> {
  console.log('Setting up test team...');

  const { team } = config.mattermost;

  try {
    // Check if team exists
    const existingTeam = await api.getTeamByName(team.name);
    team.id = existingTeam.id;
    console.log(`  Team already exists: ${existingTeam.name} (${existingTeam.id})`);
  } catch {
    // Create new team
    console.log('  Creating new team...');
    const newTeam = await api.createTeam({
      name: team.name,
      display_name: team.displayName,
      type: 'O', // Open
    });
    team.id = newTeam.id;
    console.log(`  Created team: ${newTeam.name} (${newTeam.id})`);
  }
}

/**
 * Create test channel
 */
async function setupChannel(): Promise<void> {
  console.log('Setting up test channel...');

  const { team, channel } = config.mattermost;

  if (!team.id) {
    throw new Error('Team ID not set. Run setupTeam first.');
  }

  try {
    // Check if channel exists
    const existingChannel = await api.getChannelByName(team.id, channel.name);
    channel.id = existingChannel.id;
    console.log(`  Channel already exists: ${existingChannel.name} (${existingChannel.id})`);
  } catch {
    // Create new channel
    console.log('  Creating new channel...');
    const newChannel = await api.createChannel({
      team_id: team.id,
      name: channel.name,
      display_name: channel.displayName,
      type: 'O', // Public
    });
    channel.id = newChannel.id;
    console.log(`  Created channel: ${newChannel.name} (${newChannel.id})`);
  }
}

/**
 * Create bot account with access token
 */
async function setupBot(): Promise<void> {
  console.log('Setting up bot account...');

  const { bot, team, channel } = config.mattermost;

  try {
    // Check if bot already exists by trying to get the user
    const existingUser = await api.getUserByUsername(bot.username);
    bot.userId = existingUser.id;
    console.log(`  Bot user already exists: ${existingUser.username} (${existingUser.id})`);

    // Create a new token for the existing bot
    const tokenResponse = await api.createBotAccessToken(existingUser.id, 'Integration test token');
    bot.token = tokenResponse.token;
    console.log(`  Created new access token for bot`);
  } catch {
    // Create new bot
    console.log('  Creating new bot...');
    const newBot = await api.createBot({
      username: bot.username,
      display_name: bot.displayName,
      description: 'Integration test bot for claude-threads',
    });
    bot.userId = newBot.user_id;
    console.log(`  Created bot: ${newBot.username} (${newBot.user_id})`);

    // Create access token for bot
    const tokenResponse = await api.createBotAccessToken(newBot.user_id, 'Integration test token');
    bot.token = tokenResponse.token;
    console.log(`  Created access token for bot`);
  }

  // Add bot to team and channel
  if (team.id && bot.userId) {
    try {
      await api.addUserToTeam(team.id, bot.userId);
      console.log(`  Added bot to team`);
    } catch {
      console.log(`  Bot already in team`);
    }
  }

  if (channel.id && bot.userId) {
    try {
      await api.addUserToChannel(channel.id, bot.userId);
      console.log(`  Added bot to channel`);
    } catch {
      console.log(`  Bot already in channel`);
    }
  }
}

/**
 * Create test users
 */
async function setupTestUsers(): Promise<void> {
  console.log('Setting up test users...');

  const { testUsers, team, channel } = config.mattermost;

  for (const user of testUsers) {
    try {
      // Try to login first (in case user already exists)
      const { token, user: existingUser } = await api.login(user.username, user.password);
      user.token = token;
      user.userId = existingUser.id;
      console.log(`  User already exists: ${existingUser.username} (${existingUser.id})`);
    } catch {
      // Create new user
      console.log(`  Creating user: ${user.username}...`);
      const newUser = await api.createUser({
        username: user.username,
        password: user.password,
        email: user.email,
      });
      user.userId = newUser.id;

      // Login to get token
      const { token } = await api.login(user.username, user.password);
      user.token = token;
      console.log(`  Created user: ${newUser.username} (${newUser.id})`);
    }

    // Add user to team and channel (using admin token)
    api.setToken(config.mattermost.admin.token!);

    if (team.id && user.userId) {
      try {
        await api.addUserToTeam(team.id, user.userId);
        console.log(`  Added ${user.username} to team`);
      } catch {
        console.log(`  ${user.username} already in team`);
      }
    }

    if (channel.id && user.userId) {
      try {
        await api.addUserToChannel(channel.id, user.userId);
        console.log(`  Added ${user.username} to channel`);
      } catch {
        console.log(`  ${user.username} already in channel`);
      }
    }
  }
}

/**
 * Main setup function
 */
async function main(): Promise<void> {
  console.log('========================================');
  console.log('Mattermost Integration Test Setup');
  console.log('========================================');
  console.log(`URL: ${config.mattermost.url}`);
  console.log('');

  try {
    await setupAdmin();
    await setupTeam();
    await setupChannel();
    await setupBot();
    await setupTestUsers();

    // Save configuration
    saveConfig(config);
    console.log('');
    console.log('========================================');
    console.log('Setup complete!');
    console.log('========================================');
    console.log('');
    console.log('Configuration saved to .env.test');
    console.log('');
    console.log('Summary:');
    console.log(`  Admin user ID: ${config.mattermost.admin.userId}`);
    console.log(`  Bot user ID:   ${config.mattermost.bot.userId}`);
    console.log(`  Team ID:       ${config.mattermost.team.id}`);
    console.log(`  Channel ID:    ${config.mattermost.channel.id}`);
    console.log(`  Test users:    ${config.mattermost.testUsers.map((u) => u.username).join(', ')}`);
  } catch (error) {
    console.error('');
    console.error('Setup failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export { main as setupMattermost };
