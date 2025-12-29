import prompts from 'prompts';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, dirname } from 'path';
import { parse } from 'dotenv';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// Paths to search for .env files (in order of priority)
const ENV_PATHS = [
  resolve(process.cwd(), '.env'),
  resolve(homedir(), '.config', 'claude-threads', '.env'),
  resolve(homedir(), '.claude-threads.env'),
];

function loadExistingConfig(): { path: string | null; values: Record<string, string> } {
  for (const envPath of ENV_PATHS) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        return { path: envPath, values: parse(content) };
      } catch {
        return { path: null, values: {} };
      }
    }
  }
  return { path: null, values: {} };
}

export async function runOnboarding(reconfigure = false): Promise<void> {
  const { path: existingPath, values: existing } = reconfigure ? loadExistingConfig() : { path: null, values: {} };
  const hasExisting = Object.keys(existing).length > 0;

  console.log('');
  if (reconfigure && hasExisting) {
    console.log(bold('  Reconfiguring claude-threads'));
    console.log(dim('  ─────────────────────────────────'));
    console.log('');
    console.log(dim('  Press Enter to keep existing values.'));
  } else {
    console.log(bold('  Welcome to claude-threads!'));
    console.log(dim('  ─────────────────────────────────'));
    console.log('');
    console.log('  No configuration found. Let\'s set things up.');
  }
  console.log('');
  console.log(dim('  You\'ll need:'));
  console.log(dim('  • A Mattermost bot account with a token'));
  console.log(dim('  • A channel ID where the bot will listen'));
  console.log('');

  // Handle Ctrl+C gracefully
  prompts.override({});
  const onCancel = () => {
    console.log('');
    console.log(dim('  Setup cancelled.'));
    process.exit(0);
  };

  // Helper to get worktree mode index
  const worktreeModeIndex = (mode: string | undefined): number => {
    if (mode === 'off') return 1;
    if (mode === 'require') return 2;
    return 0; // default to 'prompt'
  };

  const response = await prompts([
    {
      type: 'text',
      name: 'url',
      message: 'Mattermost URL',
      initial: existing.MATTERMOST_URL || 'https://your-mattermost-server.com',
      validate: (v: string) => v.startsWith('http') ? true : 'URL must start with http:// or https://',
    },
    {
      type: 'password',
      name: 'token',
      message: 'Bot token',
      hint: existing.MATTERMOST_TOKEN
        ? 'Enter to keep existing, or type new token'
        : 'Create at: Integrations > Bot Accounts > Add Bot Account',
      validate: (v: string) => {
        // Allow empty if we have an existing token (user wants to keep it)
        if (!v && existing.MATTERMOST_TOKEN) return true;
        return v.length > 0 ? true : 'Token is required';
      },
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID',
      initial: existing.MATTERMOST_CHANNEL_ID || '',
      hint: 'Click channel name > View Info > copy ID from URL',
      validate: (v: string) => v.length > 0 ? true : 'Channel ID is required',
    },
    {
      type: 'text',
      name: 'botName',
      message: 'Bot mention name',
      initial: existing.MATTERMOST_BOT_NAME || 'claude-code',
      hint: 'Users will @mention this name',
    },
    {
      type: 'text',
      name: 'allowedUsers',
      message: 'Allowed usernames',
      initial: existing.ALLOWED_USERS || '',
      hint: 'Comma-separated, or empty for all users',
    },
    {
      type: 'confirm',
      name: 'skipPermissions',
      message: 'Skip permission prompts?',
      initial: existing.SKIP_PERMISSIONS !== undefined
        ? existing.SKIP_PERMISSIONS === 'true'
        : true,
      hint: 'If no, you\'ll approve each action via emoji reactions',
    },
    {
      type: 'confirm',
      name: 'chrome',
      message: 'Enable Chrome integration?',
      initial: existing.CLAUDE_CHROME === 'true',
      hint: 'Requires Claude in Chrome extension',
    },
    {
      type: 'select',
      name: 'worktreeMode',
      message: 'Git worktree mode',
      hint: 'Isolate changes in separate worktrees',
      choices: [
        { title: 'Prompt', value: 'prompt', description: 'Ask when starting new sessions' },
        { title: 'Off', value: 'off', description: 'Never use worktrees' },
        { title: 'Require', value: 'require', description: 'Always require a branch name' },
      ],
      initial: worktreeModeIndex(existing.WORKTREE_MODE),
    },
  ], { onCancel });

  // Check if user cancelled - token can be empty if keeping existing
  const finalToken = response.token || existing.MATTERMOST_TOKEN;
  if (!response.url || !finalToken || !response.channelId) {
    console.log('');
    console.log(dim('  Setup incomplete. Run claude-threads again to retry.'));
    process.exit(1);
  }

  // Build .env content
  const envContent = `# claude-threads configuration
# Generated by claude-threads onboarding

# Mattermost server URL
MATTERMOST_URL=${response.url}

# Bot token (from Integrations > Bot Accounts)
MATTERMOST_TOKEN=${finalToken}

# Channel ID where the bot listens
MATTERMOST_CHANNEL_ID=${response.channelId}

# Bot mention name (users @mention this)
MATTERMOST_BOT_NAME=${response.botName || 'claude-code'}

# Allowed usernames (comma-separated, empty = all users)
ALLOWED_USERS=${response.allowedUsers || ''}

# Skip permission prompts (true = auto-approve, false = require emoji approval)
SKIP_PERMISSIONS=${response.skipPermissions ? 'true' : 'false'}

# Chrome integration (requires Claude in Chrome extension)
CLAUDE_CHROME=${response.chrome ? 'true' : 'false'}

# Git worktree mode (off, prompt, require)
WORKTREE_MODE=${response.worktreeMode || 'prompt'}
`;

  // Save to same location if reconfiguring, otherwise default location
  const defaultConfigDir = resolve(homedir(), '.config', 'claude-threads');
  const defaultEnvPath = resolve(defaultConfigDir, '.env');
  const envPath = existingPath || defaultEnvPath;
  const configDir = dirname(envPath);

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envPath, envContent, { mode: 0o600 }); // Secure permissions
  } catch (err) {
    console.error('');
    console.error(`  Failed to save config: ${err}`);
    process.exit(1);
  }

  console.log('');
  console.log(green('  ✓ Configuration saved!'));
  console.log(dim(`    ${envPath}`));
  console.log('');
  console.log(dim('  Starting claude-threads...'));
  console.log('');
}
