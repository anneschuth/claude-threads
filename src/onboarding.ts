import prompts from 'prompts';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CONFIG_PATH,
  saveConfig,
  type NewConfig,
  type PlatformInstanceConfig,
  type MattermostPlatformConfig,
  type SlackPlatformConfig,
} from './config/migration.js';
import { bold, dim, green } from './utils/colors.js';
import { validateClaudeCli } from './claude/version-check.js';

// Get the path to the Slack app manifest file
const __dirname = dirname(fileURLToPath(import.meta.url));
const SLACK_MANIFEST_PATH = join(__dirname, '..', 'docs', 'slack-app-manifest.yaml');

const onCancel = () => {
  console.log('');
  console.log(dim('  Setup cancelled.'));
  process.exit(0);
};

/**
 * Copy text to clipboard (cross-platform)
 * Returns true if successful, false otherwise
 */
async function copyToClipboard(text: string): Promise<boolean> {
  const platform = process.platform;

  let command: string[];
  if (platform === 'darwin') {
    command = ['pbcopy'];
  } else if (platform === 'win32') {
    command = ['clip'];
  } else {
    // Linux - try xclip first, fall back to xsel
    command = ['xclip', '-selection', 'clipboard'];
  }

  try {
    const proc = Bun.spawn(command, { stdin: 'pipe' });
    proc.stdin.write(text);
    proc.stdin.end();
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    // On Linux, try xsel as fallback
    if (platform === 'linux') {
      try {
        const proc = Bun.spawn(['xsel', '--clipboard', '--input'], { stdin: 'pipe' });
        proc.stdin.write(text);
        proc.stdin.end();
        const exitCode = await proc.exited;
        return exitCode === 0;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Show platform-specific setup instructions
 */
async function showPlatformInstructions(platformType: 'mattermost' | 'slack'): Promise<void> {
  if (platformType === 'mattermost') {
    console.log('');
    console.log(bold('  📋 Mattermost Setup - What You\'ll Need:'));
    console.log('');
    console.log(dim('  1. Bot Token:'));
    console.log(dim('     • Go to Main Menu → Integrations → Bot Accounts'));
    console.log(dim('     • Click "Add Bot Account"'));
    console.log(dim('     • Give it a username (e.g., claude-bot) and display name'));
    console.log(dim('     • Enable "post:all" permission'));
    console.log(dim('     • Copy the generated token'));
    console.log('');
    console.log(dim('  2. Channel ID:'));
    console.log(dim('     • Open the channel where the bot should listen'));
    console.log(dim('     • Click the channel name → "View Info"'));
    console.log(dim('     • Copy the ID from the URL (26-character string)'));
    console.log('');
    console.log(dim('  3. Add bot to channel:'));
    console.log(dim('     • In the channel, type: /invite @your-bot-name'));
    console.log('');
  } else {
    // Read manifest from file (single source of truth)
    let manifest: string;
    try {
      manifest = readFileSync(SLACK_MANIFEST_PATH, 'utf-8');
    } catch {
      // Fallback if file not found (shouldn't happen in normal installs)
      console.log('');
      console.log(dim('  ⚠️  Could not find Slack manifest file.'));
      console.log(dim('  📖 See SETUP_GUIDE.md for manual setup instructions.'));
      console.log('');
      return;
    }

    console.log('');
    console.log(bold('  📋 Slack Setup - What You\'ll Need:'));
    console.log('');
    console.log(dim('  Easiest: Use the App Manifest'));
    console.log(dim('  ─────────────────────────────'));
    console.log(dim('  1. Go to https://api.slack.com/apps'));
    console.log(dim('  2. Click "Create New App" → "From an app manifest"'));
    console.log(dim('  3. Select your workspace'));
    console.log(dim('  4. Switch to the "YAML" tab (important!)'));
    console.log(dim('  5. Paste the manifest'));
    console.log(dim('  6. Click "Create" and "Install to Workspace"'));
    console.log('');
    console.log(dim('  Then get your tokens:'));
    console.log(dim('  ─────────────────────'));
    console.log(dim('  • Bot Token: OAuth & Permissions → Bot User OAuth Token (xoxb-...)'));
    console.log(dim('  • App Token: Basic Information → App-Level Tokens → Generate'));
    console.log(dim('    (add "connections:write" scope, copy the xapp-... token)'));
    console.log('');
    console.log(dim('  Finally:'));
    console.log(dim('  ────────'));
    console.log(dim('  • Channel ID: Right-click channel → View details → Copy ID (starts with C)'));
    console.log(dim('  • Add bot: In the channel, type /invite @claude-bot'));
    console.log('');

    // Offer to copy manifest to clipboard
    const { copyManifest } = await prompts({
      type: 'confirm',
      name: 'copyManifest',
      message: 'Copy Slack app manifest to clipboard?',
      initial: true,
    }, { onCancel });

    if (copyManifest) {
      const copied = await copyToClipboard(manifest);
      if (copied) {
        console.log(green('  ✓ Manifest copied to clipboard!'));
        console.log(dim('    Paste it at: https://api.slack.com/apps → Create New App → From manifest → YAML tab'));
      } else {
        // Fallback: show the manifest
        console.log('');
        console.log(dim('  Could not copy to clipboard. Here\'s the manifest:'));
        console.log('');
        console.log(dim('  ───────────────────────────────────────'));
        for (const line of manifest.split('\n')) {
          console.log(dim(`  ${line}`));
        }
        console.log(dim('  ───────────────────────────────────────'));
      }
    } else {
      console.log(dim('  📖 See SETUP_GUIDE.md for the full manifest and manual setup instructions.'));
    }
    console.log('');
  }
}

/**
 * Derive a nice display name from a Mattermost server URL
 * Extracts the first subdomain and converts it to title case.
 *
 * Examples:
 *   https://acme-corp.mattermost.com → "Acme Corp"
 *   https://team-chat.example.com → "Team Chat"
 *   https://digilab.overheid.nl → "Digilab"
 *
 * @internal Exported for testing
 */
export function deriveDisplayName(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    // Get first part before first dot (e.g., "acme-corp" from "acme-corp.mattermost.com")
    const firstPart = hostname.split('.')[0];
    // Split on hyphens/underscores, capitalize each word
    const words = firstPart.split(/[-_]/);
    const titleCase = words.map(word =>
      word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    ).join(' ');
    return titleCase;
  } catch {
    // If URL parsing fails, return generic default
    return 'Mattermost';
  }
}

export async function runOnboarding(reconfigure = false): Promise<void> {
  console.log('');
  console.log(bold('  claude-threads setup'));
  console.log(dim('  ─────────────────────────────────'));
  console.log('');

  // Load existing config if reconfiguring
  let existingConfig: NewConfig | null = null;
  if (reconfigure && existsSync(CONFIG_PATH)) {
    try {
      const content = readFileSync(CONFIG_PATH, 'utf-8');
      existingConfig = Bun.YAML.parse(content) as NewConfig;
      console.log(dim('  Reconfiguring existing setup.'));
    } catch {
      console.log(dim('  Could not load existing config, starting fresh.'));
    }
  }

  // If reconfiguring with existing config, use the improved reconfigure flow
  if (reconfigure && existingConfig) {
    await runReconfigureFlow(existingConfig);
    return;
  }

  // First-time setup: show welcome and prerequisites
  console.log('  Welcome! Let\'s configure claude-threads.');
  console.log('');
  console.log(dim('  This wizard will guide you through:'));
  console.log(dim('    1. Global settings (working directory, Chrome, git)'));
  console.log(dim('    2. Platform setup (Mattermost/Slack bot credentials)'));
  console.log(dim('    3. Credential validation and testing'));
  console.log('');

  // Validate Claude CLI before continuing
  console.log(dim('  Checking prerequisites...'));
  const claudeCheck = validateClaudeCli();

  if (!claudeCheck.installed) {
    console.log('');
    console.log(dim('  ❌ Claude Code CLI not found'));
    console.log('');
    console.log(dim('  Install it with:'));
    console.log(dim('    bun install -g @anthropic-ai/claude-code'));
    console.log('');
    console.log(dim('  Then run `claude-threads` again.'));
    console.log('');
    process.exit(1);
  }

  if (!claudeCheck.compatible) {
    console.log('');
    console.log(dim(`  ⚠️  Claude Code CLI ${claudeCheck.version} is not compatible`));
    console.log('');
    console.log(dim(`  Install a compatible version:`));
    console.log(dim('    bun install -g @anthropic-ai/claude-code@2.0.76'));
    console.log('');

    const { continueAnyway } = await prompts({
      type: 'confirm',
      name: 'continueAnyway',
      message: 'Continue anyway? (may not work correctly)',
      initial: false,
    }, { onCancel });

    if (!continueAnyway) {
      console.log('');
      console.log(dim('  Setup cancelled.'));
      process.exit(0);
    }
  } else {
    console.log(dim(`  ✓ Claude Code CLI ${claudeCheck.version}`));
  }

  console.log('');
  console.log(dim('  📖 Need help creating a bot? See: SETUP_GUIDE.md'));
  console.log(dim('  ⏱️  Estimated time: 10-15 minutes per platform'));
  console.log('');

  const { ready } = await prompts({
    type: 'confirm',
    name: 'ready',
    message: 'Ready to begin?',
    initial: true,
  }, { onCancel });

  if (!ready) {
    console.log('');
    console.log(dim('  Setup cancelled. Run `claude-threads` when ready.'));
    process.exit(0);
  }

  console.log('');

  // Step 1: Global settings
  const globalSettings = await prompts([
    {
      type: 'text',
      name: 'workingDir',
      message: 'Default working directory',
      initial: existingConfig?.workingDir || process.cwd(),
      hint: 'Where Claude Code runs by default',
    },
    {
      type: 'confirm',
      name: 'chrome',
      message: 'Enable Chrome integration?',
      initial: existingConfig?.chrome || false,
      hint: 'Control Chrome browser for web tasks (requires Claude in Chrome extension)',
    },
    {
      type: 'select',
      name: 'worktreeMode',
      message: 'Git worktree mode',
      choices: [
        { title: 'Prompt', value: 'prompt', description: 'Ask when starting each session' },
        { title: 'Off', value: 'off', description: 'Never create worktrees (work on current branch)' },
        { title: 'Require', value: 'require', description: 'Always require branch name before starting' },
      ],
      initial: existingConfig?.worktreeMode === 'off' ? 1 :
               existingConfig?.worktreeMode === 'require' ? 2 : 0,
    },
  ], { onCancel });

  const config: NewConfig = {
    version: 2,
    ...globalSettings,
    platforms: [],
  };

  // Step 2: Add platforms (loop)
  console.log('');
  console.log(bold('  Platform Setup'));
  console.log('');
  console.log(dim('  💡 Tip: You can add more platforms later with --setup'));
  console.log('');

  let platformNumber = 1;
  let addMore = true;

  while (addMore) {
    const isFirst = platformNumber === 1;

    // Ask what platform type
    const { platformType } = await prompts({
      type: 'select',
      name: 'platformType',
      message: isFirst ? 'First platform' : `Platform #${platformNumber}`,
      choices: [
        { title: 'Slack', value: 'slack' },
        { title: 'Mattermost', value: 'mattermost' },
        ...(isFirst ? [] : [{ title: '(Done - finish setup)', value: 'done' }]),
      ],
      initial: 0,
    }, { onCancel });

    if (platformType === 'done') {
      addMore = false;
      break;
    }

    // Show platform-specific setup instructions
    await showPlatformInstructions(platformType);

    // Get platform ID (auto-generate for first of each type, ask only for duplicates)
    const typeCount = config.platforms.filter(p => p.type === platformType).length + 1;
    let platformId: string;

    if (typeCount === 1) {
      // First of this type - just use the type name
      platformId = platformType;
    } else {
      // Multiple of same type - ask for a unique ID
      const result = await prompts({
        type: 'text',
        name: 'platformId',
        message: 'Platform ID',
        initial: `${platformType}-${typeCount}`,
        hint: 'You have multiple ' + platformType + ' platforms - give this one a unique ID',
        validate: (v: string) => {
          if (!v.match(/^[a-z0-9-]+$/)) return 'Use lowercase letters, numbers, hyphens only';
          if (config.platforms.some(p => p.id === v)) return 'ID already in use';
          return true;
        },
      }, { onCancel });
      platformId = result.platformId;
    }

    // Configure the platform (will ask for displayName with smart defaults)
    let platform: PlatformInstanceConfig;
    if (platformType === 'mattermost') {
      platform = await setupMattermostPlatform(platformId, undefined);
    } else {
      platform = await setupSlackPlatform(platformId, undefined);
    }
    config.platforms.push(platform);

    console.log(green(`  ✓ Added ${platform.displayName}`));
    console.log('');

    // Ask to add more (after first one)
    if (platformNumber === 1) {
      const { addAnother } = await prompts({
        type: 'confirm',
        name: 'addAnother',
        message: 'Add another platform?',
        initial: false,
      }, { onCancel });

      addMore = addAnother;
    }

    platformNumber++;
  }

  // Validate at least one platform
  if (config.platforms.length === 0) {
    console.log('');
    console.log(dim('  ⚠️  No platforms configured. Setup cancelled.'));
    process.exit(1);
  }

  // Show summary and confirm
  await showConfigSummary(config);

  // Save config
  saveConfig(config);

  console.log('');
  console.log(green('  ✓ Configuration saved securely!'));
  console.log(dim(`    ${CONFIG_PATH}`));
  console.log(dim('    (file permissions set to owner-only for token security)'));
  console.log('');
  console.log(bold('  🎉 Setup complete!'));
  console.log('');
  console.log(dim('  Next steps:'));
  console.log(dim('    1. claude-threads will start automatically'));
  console.log(dim('    2. In your chat platform, @mention the bot:'));
  console.log(dim('       @botname write "hello world" to test.txt'));
  console.log(dim('    3. The bot will create a thread and stream Claude\'s response'));
  console.log('');
  console.log(dim('  Useful commands (send in a thread):'));
  console.log(dim('    !help              - Show all commands'));
  console.log(dim('    !permissions       - Toggle permission mode'));
  console.log(dim('    !cd /path          - Change working directory'));
  console.log(dim('    !stop              - End session'));
  console.log('');
  console.log(dim('  Troubleshooting:'));
  console.log(dim('    • Run with debug logs: DEBUG=1 claude-threads'));
  console.log(dim('    • Check the setup guide: SETUP_GUIDE.md'));
  console.log(dim('    • Reconfigure anytime: claude-threads --setup'));
  console.log('');
  console.log(dim('  Starting claude-threads...'));
  console.log('');
}

// ============================================================================
// Reconfigure Flow - Improved UX for editing existing config
// ============================================================================

async function runReconfigureFlow(existingConfig: NewConfig): Promise<void> {
  let config = { ...existingConfig, platforms: [...existingConfig.platforms] };
  let keepReconfiguring = true;

  while (keepReconfiguring) {
    console.log('');
    console.log(bold('  What would you like to reconfigure?'));
    console.log('');

    // Build choices menu
    const choices: Array<{ title: string; value: string; description?: string }> = [
      {
        title: 'Global settings',
        value: 'global',
        description: `workingDir, chrome, worktreeMode`
      },
    ];

    // Add existing platforms
    for (let i = 0; i < config.platforms.length; i++) {
      const platform = config.platforms[i];
      choices.push({
        title: `${platform.displayName} (${platform.type})`,
        value: `platform-${i}`,
        description: `Edit or remove this platform`,
      });
    }

    // Add new/done options
    choices.push(
      { title: '+ Add new platform', value: 'add-new' },
      { title: '✓ Done (save and exit)', value: 'done' }
    );

    const { action } = await prompts({
      type: 'select',
      name: 'action',
      message: 'Select what to reconfigure',
      choices,
    }, { onCancel });

    if (action === 'done') {
      keepReconfiguring = false;
      break;
    }

    if (action === 'global') {
      // Reconfigure global settings
      const globalSettings = await prompts([
        {
          type: 'text',
          name: 'workingDir',
          message: 'Default working directory',
          initial: config.workingDir,
          hint: 'Where Claude Code runs by default',
        },
        {
          type: 'confirm',
          name: 'chrome',
          message: 'Enable Chrome integration?',
          initial: config.chrome,
          hint: 'Control Chrome browser for web tasks (requires Claude in Chrome extension)',
        },
        {
          type: 'select',
          name: 'worktreeMode',
          message: 'Git worktree mode',
          choices: [
            { title: 'Prompt', value: 'prompt', description: 'Ask when starting each session' },
            { title: 'Off', value: 'off', description: 'Never create worktrees (work on current branch)' },
            { title: 'Require', value: 'require', description: 'Always require branch name before starting' },
          ],
          initial: config.worktreeMode === 'off' ? 1 :
                   config.worktreeMode === 'require' ? 2 : 0,
        },
      ], { onCancel });

      config = { ...config, ...globalSettings };
      console.log(green('  ✓ Global settings updated'));
    } else if (action === 'add-new') {
      // Add new platform
      console.log('');
      console.log(dim('  Adding new platform...'));

      const { platformType } = await prompts({
        type: 'select',
        name: 'platformType',
        message: 'Platform type',
        choices: [
          { title: 'Slack', value: 'slack' },
          { title: 'Mattermost', value: 'mattermost' },
        ],
      }, { onCancel });

      // Show platform-specific setup instructions
      await showPlatformInstructions(platformType);

      const typeCount = config.platforms.filter(p => p.type === platformType).length + 1;
      const suggestedId = typeCount === 1 ? platformType : `${platformType}-${typeCount}`;

      const { platformId } = await prompts({
        type: 'text',
        name: 'platformId',
        message: 'Platform ID',
        initial: suggestedId,
        hint: 'Unique identifier (e.g., mattermost-main, slack-eng)',
        validate: (v: string) => {
          if (!v.match(/^[a-z0-9-]+$/)) return 'Use lowercase letters, numbers, hyphens only';
          if (config.platforms.some(p => p.id === v)) return 'ID already in use';
          return true;
        },
      }, { onCancel });

      let newPlatform: PlatformInstanceConfig;
      if (platformType === 'mattermost') {
        newPlatform = await setupMattermostPlatform(platformId, undefined);
      } else {
        newPlatform = await setupSlackPlatform(platformId, undefined);
      }

      config.platforms.push(newPlatform);
      console.log(green(`  ✓ Added ${newPlatform.displayName}`));
    } else if (action.startsWith('platform-')) {
      // Edit or remove existing platform
      const platformIndex = parseInt(action.replace('platform-', ''));
      const platform = config.platforms[platformIndex];

      console.log('');
      const { platformAction } = await prompts({
        type: 'select',
        name: 'platformAction',
        message: `${platform.displayName} (${platform.type})`,
        choices: [
          { title: 'Edit configuration', value: 'edit' },
          { title: 'Remove this platform', value: 'remove' },
          { title: '← Back', value: 'back' },
        ],
      }, { onCancel });

      if (platformAction === 'remove') {
        const { confirmRemove } = await prompts({
          type: 'confirm',
          name: 'confirmRemove',
          message: `Remove ${platform.displayName}?`,
          initial: false,
        }, { onCancel });

        if (confirmRemove) {
          config.platforms.splice(platformIndex, 1);
          console.log(green(`  ✓ Removed ${platform.displayName}`));
        }
      } else if (platformAction === 'edit') {
        let updatedPlatform: PlatformInstanceConfig;
        if (platform.type === 'mattermost') {
          updatedPlatform = await setupMattermostPlatform(
            platform.id,
            platform as MattermostPlatformConfig
          );
        } else {
          updatedPlatform = await setupSlackPlatform(
            platform.id,
            platform as SlackPlatformConfig
          );
        }
        config.platforms[platformIndex] = updatedPlatform;
        console.log(green(`  ✓ Updated ${updatedPlatform.displayName}`));
      }
    }
  }

  // Validate at least one platform
  if (config.platforms.length === 0) {
    console.log('');
    console.log(dim('  ⚠️  No platforms configured. At least one platform is required.'));
    console.log(dim('  Setup cancelled.'));
    process.exit(1);
  }

  // Show summary and confirm
  await showConfigSummary(config);

  // Save config
  saveConfig(config);

  console.log('');
  console.log(green('  ✓ Configuration updated securely!'));
  console.log(dim(`    ${CONFIG_PATH}`));
  console.log(dim('    (file permissions set to owner-only for token security)'));
  console.log('');
  console.log(dim('  Restart claude-threads to apply changes.'));
  console.log('');
}

// ============================================================================
// Configuration Summary
// ============================================================================

async function showConfigSummary(config: NewConfig): Promise<void> {
  console.log('');
  console.log(bold('  Configuration Summary'));
  console.log(dim('  ─────────────────────────────────────────────────────'));
  console.log('');
  console.log(dim('  Global Settings:'));
  console.log(dim(`    Working Directory: ${config.workingDir}`));
  console.log(dim(`    Chrome Integration: ${config.chrome ? 'Enabled' : 'Disabled'}`));
  console.log(dim(`    Worktree Mode: ${config.worktreeMode}`));
  console.log('');
  console.log(dim(`  Platforms (${config.platforms.length}):`));
  for (const platform of config.platforms) {
    console.log('');
    console.log(dim(`    ${platform.displayName} (${platform.type})`));
    console.log(dim(`      ID: ${platform.id}`));

    if (platform.type === 'mattermost') {
      const mm = platform as MattermostPlatformConfig;
      console.log(dim(`      Server: ${mm.url}`));
      console.log(dim(`      Channel: ${mm.channelId}`));
      console.log(dim(`      Bot: @${mm.botName}`));

      const allowedUsers = mm.allowedUsers.length > 0
        ? mm.allowedUsers.join(', ')
        : 'ANYONE (⚠️  no restrictions)';
      console.log(dim(`      Allowed Users: ${allowedUsers}`));
      console.log(dim(`      Auto-approve: ${mm.skipPermissions ? 'Yes' : 'No (interactive)'}`));
    } else {
      const slack = platform as SlackPlatformConfig;
      console.log(dim(`      Channel: ${slack.channelId}`));
      console.log(dim(`      Bot: @${slack.botName}`));

      const allowedUsers = slack.allowedUsers.length > 0
        ? slack.allowedUsers.join(', ')
        : 'ANYONE (⚠️  no restrictions)';
      console.log(dim(`      Allowed Users: ${allowedUsers}`));
      console.log(dim(`      Auto-approve: ${slack.skipPermissions ? 'Yes' : 'No (interactive)'}`));
    }
  }
  console.log('');
  console.log(dim('  ─────────────────────────────────────────────────────'));
  console.log('');

  const { confirm } = await prompts({
    type: 'confirm',
    name: 'confirm',
    message: 'Save this configuration?',
    initial: true,
  }, { onCancel });

  if (!confirm) {
    console.log('');
    console.log(dim('  Setup cancelled.'));
    process.exit(0);
  }
}

async function setupMattermostPlatform(
  id: string,
  existing?: PlatformInstanceConfig
): Promise<MattermostPlatformConfig> {
  const existingMattermost = existing?.type === 'mattermost' ? existing as MattermostPlatformConfig : undefined;

  // Track last entered values for prefilling on retry
  let lastUrl = existingMattermost?.url || 'https://chat.example.com';
  let lastDisplayName = existingMattermost?.displayName || '';
  let lastToken = existingMattermost?.token || '';
  let lastChannelId = existingMattermost?.channelId || '';
  let lastBotName = existingMattermost?.botName || 'claude-code';
  let lastAllowedUsers = existingMattermost?.allowedUsers?.join(',') || '';
  let lastRequireApproval = existingMattermost ? !existingMattermost.skipPermissions : true;

  // Main loop - allows retrying when validation fails
  while (true) {
    console.log('');
    console.log(dim('  Now enter your Mattermost credentials:'));
    console.log('');

    // Collect settings one by one with visible hints
    const { url } = await prompts({
      type: 'text',
      name: 'url',
      message: 'Server URL (e.g., https://chat.company.com)',
      initial: lastUrl,
      validate: (v: string) => {
        if (!v.startsWith('http')) return 'Must start with http:// or https://';
        try {
          new URL(v);
          return true;
        } catch {
          return 'Invalid URL format';
        }
      },
    }, { onCancel });

    const { displayName } = await prompts({
      type: 'text',
      name: 'displayName',
      message: 'Display name',
      initial: lastDisplayName || deriveDisplayName(url),
    }, { onCancel });

    if (!lastToken) {
      console.log('');
      console.log(dim('  Bot Token: Main Menu → Integrations → Bot Accounts → Create'));
    }
    const { token } = await prompts({
      type: 'password',
      name: 'token',
      message: lastToken ? 'Bot token' : 'Paste it here',
      initial: lastToken,
      validate: (v: string) => {
        if (!v && lastToken) return true;
        return v.length > 0 ? true : 'Token is required';
      },
    }, { onCancel });

    if (!lastChannelId) {
      console.log('');
      console.log(dim('  Channel ID: Click channel name → View Info → copy ID from URL'));
    }
    const { channelId } = await prompts({
      type: 'text',
      name: 'channelId',
      message: lastChannelId ? 'Channel ID' : 'Paste it here',
      initial: lastChannelId,
      validate: (v: string) => v.length > 0 ? true : 'Channel ID is required',
    }, { onCancel });

    console.log('');
    const { botName } = await prompts({
      type: 'text',
      name: 'botName',
      message: 'Bot username (the one you created)',
      initial: lastBotName,
    }, { onCancel });

    const basicSettings = { url, displayName, token, channelId, botName };

    // Use existing token if user left it empty
    const finalToken = basicSettings.token || lastToken;
    if (!finalToken) {
      console.log('');
      console.log(dim('  ⚠️  Token is required. Setup cancelled.'));
      process.exit(1);
    }

    // Now handle allowed users with loop for re-entry
    let allowedUsers: string[] = [];
    let allowedUsersConfirmed = false;

    while (!allowedUsersConfirmed) {
      console.log('');
      console.log(dim('  Who can use the bot? Enter usernames separated by commas.'));
      console.log(dim('  Leave empty to allow anyone (you\'ll be asked to confirm).'));
      const { allowedUsersInput } = await prompts({
        type: 'text',
        name: 'allowedUsersInput',
        message: 'Allowed usernames',
        initial: lastAllowedUsers,
      }, { onCancel });

      allowedUsers = allowedUsersInput?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [];

      // If empty, confirm they really want to allow anyone
      if (allowedUsers.length === 0) {
        console.log('');
        const { confirmOpen } = await prompts({
          type: 'confirm',
          name: 'confirmOpen',
          message: '⚠️  Allow ANYONE in the channel to use the bot?',
          initial: false,
        }, { onCancel });

        if (confirmOpen) {
          allowedUsersConfirmed = true;
        } else {
          console.log('');
          console.log(dim('  Let\'s add some allowed usernames.'));
          // Loop continues - will re-prompt for usernames
        }
      } else {
        allowedUsersConfirmed = true;
      }
    }

    // Now ask about approval (after user access is settled)
    const { requireApproval } = await prompts({
      type: 'confirm',
      name: 'requireApproval',
      message: 'Require approval for Claude actions?',
      initial: lastRequireApproval,
      hint: 'Yes = approve via reactions (recommended), No = auto-approve everything',
    }, { onCancel });

    // Save entered values for potential retry
    lastUrl = basicSettings.url;
    lastDisplayName = basicSettings.displayName;
    lastToken = finalToken;
    lastChannelId = basicSettings.channelId;
    lastBotName = basicSettings.botName;
    lastAllowedUsers = allowedUsers.join(',');
    lastRequireApproval = requireApproval;

    // Validate credentials
    console.log('');
    console.log(dim('  Validating credentials...'));
    const validationResult = await validateMattermostCredentials(
      basicSettings.url,
      finalToken,
      basicSettings.channelId
    );

    if (!validationResult.success) {
      console.log('');
      console.log(dim(`  ❌ Validation failed: ${validationResult.error}`));
      console.log('');
      console.log(dim('  Troubleshooting tips:'));
      if (validationResult.error?.includes('401') || validationResult.error?.includes('auth')) {
        console.log(dim('    • Check that the bot token is correct'));
        console.log(dim('    • Verify the token is for this Mattermost instance'));
        console.log(dim('    • Try creating a new bot and token'));
      } else if (validationResult.error?.includes('channel') || validationResult.error?.includes('403')) {
        console.log(dim('    • Verify the channel ID is correct'));
        console.log(dim('    • Add the bot to the channel (@botname)'));
        console.log(dim('    • Check bot has "Post:All" permission'));
      } else {
        console.log(dim('    • Check server URL is accessible'));
        console.log(dim('    • Verify network connectivity'));
      }
      console.log('');

      const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { title: 'Re-enter credentials', value: 'retry' },
          { title: 'Save anyway (may not work)', value: 'save' },
          { title: 'Cancel setup', value: 'cancel' },
        ],
      }, { onCancel });

      if (action === 'retry') {
        console.log('');
        console.log(dim('  Let\'s try again...'));
        continue; // Loop back to re-enter credentials
      } else if (action === 'cancel') {
        console.log('');
        console.log(dim('  Setup cancelled.'));
        process.exit(1);
      }
      // action === 'save' falls through to return
    } else {
      console.log(green('  ✓ Credentials validated successfully!'));
      if (validationResult.botUsername) {
        console.log(dim(`    Bot: @${validationResult.botUsername}`));
      }
      if (validationResult.channelName) {
        console.log(dim(`    Channel: ${validationResult.channelName}`));
      }
    }

    return {
      id,
      type: 'mattermost',
      displayName: basicSettings.displayName,
      url: basicSettings.url,
      token: finalToken,
      channelId: basicSettings.channelId,
      botName: basicSettings.botName,
      allowedUsers,
      skipPermissions: !requireApproval,
    };
  }
}

// ============================================================================
// Credential Validation Functions
// ============================================================================

/**
 * Result of credential validation
 * @internal Exported for testing
 */
export interface ValidationResult {
  success: boolean;
  error?: string;
  botUsername?: string;
  channelName?: string;
  teamName?: string;
}

/**
 * Validate Mattermost credentials by making test API calls
 * @internal Exported for testing
 */
export async function validateMattermostCredentials(
  url: string,
  token: string,
  channelId: string
): Promise<ValidationResult> {
  try {
    // Test 1: Get bot user info (validates token and server URL)
    const userResponse = await fetch(`${url}/api/v4/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      if (userResponse.status === 401) {
        return { success: false, error: 'Invalid token or unauthorized' };
      }
      return { success: false, error: `Server error ${userResponse.status}: ${errorText}` };
    }

    const userData = await userResponse.json();
    const botUsername = userData.username;

    // Test 2: Get channel info (validates channel ID and bot access)
    const channelResponse = await fetch(`${url}/api/v4/channels/${channelId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!channelResponse.ok) {
      if (channelResponse.status === 403) {
        return {
          success: false,
          error: 'Cannot access channel (bot may not be a member)',
        };
      }
      if (channelResponse.status === 404) {
        return {
          success: false,
          error: 'Channel not found (check channel ID)',
        };
      }
      return { success: false, error: `Channel access error: ${channelResponse.status}` };
    }

    const channelData = await channelResponse.json();
    const channelName = channelData.display_name || channelData.name;

    return {
      success: true,
      botUsername,
      channelName,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Network error or invalid URL',
    };
  }
}

/**
 * Validate Slack credentials by making test API calls
 * @internal Exported for testing
 */
export async function validateSlackCredentials(
  botToken: string,
  appToken: string,
  channelId: string
): Promise<ValidationResult> {
  try {
    // Test 1: Validate bot token and get bot info
    const authResponse = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!authResponse.ok) {
      return { success: false, error: `HTTP error ${authResponse.status}` };
    }

    const authData = await authResponse.json();
    if (!authData.ok) {
      return { success: false, error: `Auth failed: ${authData.error}` };
    }

    const botUsername = authData.user;
    const teamName = authData.team;

    // Test 2: Validate app token by checking Socket Mode is enabled
    // We can't fully validate Socket Mode without connecting, but we can check the token format
    if (!appToken.startsWith('xapp-')) {
      return { success: false, error: 'App token must start with xapp-' };
    }

    // Test 3: Check bot can access the channel
    const channelResponse = await fetch(
      `https://slack.com/api/conversations.info?channel=${channelId}`,
      {
        headers: {
          Authorization: `Bearer ${botToken}`,
        },
      }
    );

    if (!channelResponse.ok) {
      return { success: false, error: `Cannot check channel: HTTP ${channelResponse.status}` };
    }

    const channelData = await channelResponse.json();
    if (!channelData.ok) {
      if (channelData.error === 'channel_not_found') {
        return { success: false, error: 'Channel not found (check channel ID or invite bot)' };
      }
      if (channelData.error === 'missing_scope') {
        return { success: false, error: 'Missing OAuth scope: channels:read' };
      }
      return { success: false, error: `Channel error: ${channelData.error}` };
    }

    return {
      success: true,
      botUsername,
      teamName,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

// ============================================================================
// Platform Setup Functions
// ============================================================================

async function setupSlackPlatform(
  id: string,
  existing?: PlatformInstanceConfig
): Promise<SlackPlatformConfig> {
  const existingSlack = existing?.type === 'slack' ? existing as SlackPlatformConfig : undefined;

  // Track last entered values for prefilling on retry
  let lastDisplayName = existingSlack?.displayName || 'Slack';
  let lastBotToken = existingSlack?.botToken || '';
  let lastAppToken = existingSlack?.appToken || '';
  let lastChannelId = existingSlack?.channelId || '';
  let lastBotName = existingSlack?.botName || 'claude';
  let lastAllowedUsers = existingSlack?.allowedUsers?.join(',') || '';
  let lastRequireApproval = existingSlack ? !existingSlack.skipPermissions : true;

  // Main loop - allows retrying when validation fails
  while (true) {
    console.log('');
    console.log(dim('  Now enter your Slack credentials:'));
    console.log('');

    // Collect settings one by one with visible hints printed before each prompt
    const { displayName } = await prompts({
      type: 'text',
      name: 'displayName',
      message: 'Display name',
      initial: lastDisplayName,
    }, { onCancel });

    if (!lastBotToken) {
      console.log('');
      console.log(dim('  Bot Token: OAuth & Permissions → Bot User OAuth Token'));
    }
    const { botToken } = await prompts({
      type: 'password',
      name: 'botToken',
      message: lastBotToken ? 'Bot Token (xoxb-...)' : 'Paste it here',
      initial: lastBotToken,
      validate: (v: string) => {
        if (!v && lastBotToken) return true;
        if (!v) return 'Bot token is required';
        return v.startsWith('xoxb-') ? true : 'Must start with xoxb-';
      },
    }, { onCancel });

    if (!lastAppToken) {
      console.log('');
      console.log(dim('  App Token: Basic Information → App-Level Tokens → Generate'));
      console.log(dim('             (create with "connections:write" scope)'));
    }
    const { appToken } = await prompts({
      type: 'password',
      name: 'appToken',
      message: lastAppToken ? 'App Token (xapp-...)' : 'Paste it here',
      initial: lastAppToken,
      validate: (v: string) => {
        if (!v && lastAppToken) return true;
        if (!v) return 'App token is required';
        return v.startsWith('xapp-') ? true : 'Must start with xapp-';
      },
    }, { onCancel });

    if (!lastChannelId) {
      console.log('');
      console.log(dim('  Channel ID: Right-click channel → View details → Copy ID at bottom'));
    }
    const { channelId } = await prompts({
      type: 'text',
      name: 'channelId',
      message: lastChannelId ? 'Channel ID (C...)' : 'Paste it here',
      initial: lastChannelId,
      validate: (v: string) => {
        if (!v) return 'Channel ID is required';
        if (!v.startsWith('C') && !v.startsWith('G')) return 'Should start with C (public) or G (private)';
        return true;
      },
    }, { onCancel });

    console.log('');
    const { botName } = await prompts({
      type: 'text',
      name: 'botName',
      message: 'Bot username (for display)',
      initial: lastBotName,
    }, { onCancel });

    const basicSettings = { displayName, botToken, appToken, channelId, botName };

    // Use existing tokens if user left them empty
    const finalBotToken = basicSettings.botToken || lastBotToken;
    const finalAppToken = basicSettings.appToken || lastAppToken;

    if (!finalBotToken || !finalAppToken) {
      console.log('');
      console.log(dim('  ⚠️  Both tokens are required. Setup cancelled.'));
      process.exit(1);
    }

    // Now handle allowed users with loop for re-entry
    let allowedUsers: string[] = [];
    let allowedUsersConfirmed = false;

    while (!allowedUsersConfirmed) {
      console.log('');
      console.log(dim('  Who can use the bot? Enter Slack usernames separated by commas.'));
      console.log(dim('  Leave empty to allow anyone (you\'ll be asked to confirm).'));
      const { allowedUsersInput } = await prompts({
        type: 'text',
        name: 'allowedUsersInput',
        message: 'Allowed usernames',
        initial: lastAllowedUsers,
      }, { onCancel });

      allowedUsers = allowedUsersInput?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [];

      // If empty, confirm they really want to allow anyone
      if (allowedUsers.length === 0) {
        console.log('');
        const { confirmOpen } = await prompts({
          type: 'confirm',
          name: 'confirmOpen',
          message: '⚠️  Allow ANYONE in the channel to use the bot?',
          initial: false,
        }, { onCancel });

        if (confirmOpen) {
          allowedUsersConfirmed = true;
        } else {
          console.log('');
          console.log(dim('  Let\'s add some allowed usernames.'));
          // Loop continues - will re-prompt for usernames
        }
      } else {
        allowedUsersConfirmed = true;
      }
    }

    // Now ask about approval (after user access is settled)
    const { requireApproval } = await prompts({
      type: 'confirm',
      name: 'requireApproval',
      message: 'Require approval for Claude actions?',
      initial: lastRequireApproval,
      hint: 'Yes = approve via reactions (recommended), No = auto-approve everything',
    }, { onCancel });

    // Save entered values for potential retry
    lastDisplayName = basicSettings.displayName;
    lastBotToken = finalBotToken;
    lastAppToken = finalAppToken;
    lastChannelId = basicSettings.channelId;
    lastBotName = basicSettings.botName;
    lastAllowedUsers = allowedUsers.join(',');
    lastRequireApproval = requireApproval;

    // Validate credentials
    console.log('');
    console.log(dim('  Validating credentials...'));
    const validationResult = await validateSlackCredentials(
      finalBotToken,
      finalAppToken,
      basicSettings.channelId
    );

    if (!validationResult.success) {
      console.log('');
      console.log(dim(`  ❌ Validation failed: ${validationResult.error}`));
      console.log('');
      console.log(dim('  Troubleshooting tips:'));
      if (validationResult.error?.includes('invalid_auth') || validationResult.error?.includes('token')) {
        console.log(dim('    • Verify bot token starts with xoxb-'));
        console.log(dim('    • Verify app token starts with xapp-'));
        console.log(dim('    • Reinstall app to workspace if needed'));
      } else if (validationResult.error?.includes('Socket Mode')) {
        console.log(dim('    • Enable Socket Mode in app settings'));
        console.log(dim('    • Generate app-level token with connections:write scope'));
      } else if (validationResult.error?.includes('missing_scope')) {
        console.log(dim('    • Add required OAuth scopes'));
        console.log(dim('    • Reinstall app after adding scopes'));
      } else if (validationResult.error?.includes('channel')) {
        console.log(dim('    • Invite bot to channel: /invite @botname'));
        console.log(dim('    • Verify channel ID is correct'));
      } else {
        console.log(dim('    • Check network connectivity'));
        console.log(dim('    • See SETUP_GUIDE.md for detailed troubleshooting'));
      }
      console.log('');

      const { action } = await prompts({
        type: 'select',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { title: 'Re-enter credentials', value: 'retry' },
          { title: 'Save anyway (may not work)', value: 'save' },
          { title: 'Cancel setup', value: 'cancel' },
        ],
      }, { onCancel });

      if (action === 'retry') {
        console.log('');
        console.log(dim('  Let\'s try again...'));
        continue; // Loop back to re-enter credentials
      } else if (action === 'cancel') {
        console.log('');
        console.log(dim('  Setup cancelled.'));
        process.exit(1);
      }
      // action === 'save' falls through to return
    } else {
      console.log(green('  ✓ Credentials validated successfully!'));
      if (validationResult.botUsername) {
        console.log(dim(`    Bot: @${validationResult.botUsername}`));
      }
      if (validationResult.teamName) {
        console.log(dim(`    Team: ${validationResult.teamName}`));
      }
    }

    return {
      id,
      type: 'slack',
      displayName: basicSettings.displayName,
      botToken: finalBotToken,
      appToken: finalAppToken,
      channelId: basicSettings.channelId,
      botName: basicSettings.botName,
      allowedUsers,
      skipPermissions: !requireApproval,
    };
  }
}
