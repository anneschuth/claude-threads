import { config } from 'dotenv';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

let envLoaded = false;

function loadEnv(): void {
  if (envLoaded) return;
  envLoaded = true;

  // Load .env file from multiple locations (in order of priority)
  const envPaths = [
    resolve(process.cwd(), '.env'),                          // Current directory
    resolve(homedir(), '.config', 'mm-claude', '.env'),      // ~/.config/mm-claude/.env
    resolve(homedir(), '.mm-claude.env'),                    // ~/.mm-claude.env
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      if (process.env.DEBUG === '1' || process.argv.includes('--debug')) {
        console.log(`  [config] Loading from: ${envPath}`);
      }
      config({ path: envPath });
      break;
    }
  }
}

export interface Config {
  mattermost: {
    url: string;
    token: string;
    channelId: string;
    botName: string;
  };
  allowedUsers: string[];
  skipPermissions: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  loadEnv();
  return {
    mattermost: {
      url: requireEnv('MATTERMOST_URL').replace(/\/$/, ''), // Remove trailing slash
      token: requireEnv('MATTERMOST_TOKEN'),
      channelId: requireEnv('MATTERMOST_CHANNEL_ID'),
      botName: process.env.MATTERMOST_BOT_NAME || 'claude-code',
    },
    allowedUsers: (process.env.ALLOWED_USERS || '')
      .split(',')
      .map(u => u.trim())
      .filter(u => u.length > 0),
    // SKIP_PERMISSIONS=true or --dangerously-skip-permissions flag
    skipPermissions: process.env.SKIP_PERMISSIONS === 'true' ||
      process.argv.includes('--dangerously-skip-permissions'),
  };
}
