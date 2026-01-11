import prompts from 'prompts';
import { existsSync, readFileSync } from 'fs';
import {
  CONFIG_PATH,
  saveConfig,
  type NewConfig,
  type PlatformInstanceConfig,
  type MattermostPlatformConfig,
  type SlackPlatformConfig,
} from './config/migration.js';
import { bold, dim, green } from './utils/colors.js';

const onCancel = () => {
  console.log('');
  console.log(dim('  Setup cancelled.'));
  process.exit(0);
};

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
  console.log(dim('  Before you begin, make sure you have:'));
  console.log(dim('    • Admin access to create bot accounts'));
  console.log(dim('    • Claude Code CLI installed (npm install -g @anthropic-ai/claude-code)'));
  console.log(dim('    • Anthropic API key configured'));
  console.log('');
  console.log(dim('  📖 For detailed setup instructions, see:'));
  console.log(dim('     https://github.com/anneschuth/claude-threads/blob/main/SETUP_GUIDE.md'));
  console.log('');
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

  // Step 2: Show platform setup checklists
  console.log('');
  console.log(bold('  Platform Setup'));
  console.log('');
  console.log(dim('  Before adding platforms, make sure you have completed setup on at least one platform:'));
  console.log('');
  console.log(dim('  📋 Mattermost checklist:'));
  console.log(dim('     • Created bot account (Main Menu → Integrations → Bot Accounts)'));
  console.log(dim('     • Copied bot token (you won\'t see it again!)'));
  console.log(dim('     • Got channel ID (Channel → View Info → copy from URL)'));
  console.log('');
  console.log(dim('  📋 Slack checklist:'));
  console.log(dim('     • Created Slack app (api.slack.com/apps)'));
  console.log(dim('     • Enabled Socket Mode with app token'));
  console.log(dim('     • Added OAuth scopes and installed to workspace'));
  console.log(dim('     • Invited bot to channel (/invite @botname)'));
  console.log('');
  console.log(dim('  📖 Need help? See: SETUP_GUIDE.md'));
  console.log('');

  const { readyForPlatforms } = await prompts({
    type: 'confirm',
    name: 'readyForPlatforms',
    message: 'Ready to add platforms?',
    initial: true,
  }, { onCancel });

  if (!readyForPlatforms) {
    console.log('');
    console.log(dim('  Setup cancelled. Complete platform setup and run `claude-threads` when ready.'));
    process.exit(0);
  }

  // Step 3: Add platforms (loop)
  console.log('');
  console.log(dim('  Now let\'s add your platform connections.'));
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
        { title: 'Mattermost', value: 'mattermost' },
        { title: 'Slack', value: 'slack' },
        ...(isFirst ? [] : [{ title: '(Done - finish setup)', value: 'done' }]),
      ],
      initial: 0,
    }, { onCancel });

    if (platformType === 'done') {
      addMore = false;
      break;
    }

    // Get platform ID and name
    const typeCount = config.platforms.filter(p => p.type === platformType).length + 1;
    const suggestedId = typeCount === 1 ? platformType : `${platformType}-${typeCount}`;

    const { platformId, displayName } = await prompts([
      {
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
      },
      {
        type: 'text',
        name: 'displayName',
        message: 'Display name',
        initial: platformType === 'mattermost' ? 'Mattermost' : 'Slack',
        hint: 'Human-readable name (e.g., "Internal Team", "Engineering")',
      },
    ], { onCancel });

    // Configure the platform
    if (platformType === 'mattermost') {
      const platform = await setupMattermostPlatform(platformId, displayName, undefined);
      config.platforms.push(platform);
    } else {
      const platform = await setupSlackPlatform(platformId, displayName, undefined);
      config.platforms.push(platform);
    }

    console.log(green(`  ✓ Added ${displayName}`));
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
  console.log(green('  ✓ Configuration saved!'));
  console.log(dim(`    ${CONFIG_PATH}`));
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
  console.log(dim('    • Reconfigure anytime: claude-threads --reconfigure'));
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
          { title: 'Mattermost', value: 'mattermost' },
          { title: 'Slack', value: 'slack' },
        ],
      }, { onCancel });

      const typeCount = config.platforms.filter(p => p.type === platformType).length + 1;
      const suggestedId = typeCount === 1 ? platformType : `${platformType}-${typeCount}`;

      const { platformId, displayName } = await prompts([
        {
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
        },
        {
          type: 'text',
          name: 'displayName',
          message: 'Display name',
          initial: platformType === 'mattermost' ? 'Mattermost' : 'Slack',
          hint: 'Human-readable name (e.g., "Internal Team", "Engineering")',
        },
      ], { onCancel });

      let newPlatform: PlatformInstanceConfig;
      if (platformType === 'mattermost') {
        newPlatform = await setupMattermostPlatform(platformId, displayName, undefined);
      } else {
        newPlatform = await setupSlackPlatform(platformId, displayName, undefined);
      }

      config.platforms.push(newPlatform);
      console.log(green(`  ✓ Added ${displayName}`));
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
            platform.displayName,
            platform as MattermostPlatformConfig
          );
        } else {
          updatedPlatform = await setupSlackPlatform(
            platform.id,
            platform.displayName,
            platform as SlackPlatformConfig
          );
        }
        config.platforms[platformIndex] = updatedPlatform;
        console.log(green(`  ✓ Updated ${platform.displayName}`));
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
  console.log(green('  ✓ Configuration updated!'));
  console.log(dim(`    ${CONFIG_PATH}`));
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
  displayName: string,
  existing?: PlatformInstanceConfig
): Promise<MattermostPlatformConfig> {
  console.log('');
  console.log(dim('  Mattermost setup:'));
  console.log('');

  const existingMattermost = existing?.type === 'mattermost' ? existing as MattermostPlatformConfig : undefined;

  const response = await prompts([
    {
      type: 'text',
      name: 'url',
      message: 'Server URL',
      initial: existingMattermost?.url || 'https://chat.example.com',
      hint: 'Your Mattermost base URL (e.g., https://chat.company.com)',
      validate: (v: string) => {
        if (!v.startsWith('http')) return 'Must start with http:// or https://';
        try {
          new URL(v);
          return true;
        } catch {
          return 'Invalid URL format';
        }
      },
    },
    {
      type: 'password',
      name: 'token',
      message: 'Bot token',
      initial: existingMattermost?.token,
      hint: existingMattermost?.token
        ? 'Press Enter to keep existing, or paste new token'
        : 'From: Main Menu > Integrations > Bot Accounts > Create',
      validate: (v: string) => {
        // Allow empty if we have existing token
        if (!v && existingMattermost?.token) return true;
        return v.length > 0 ? true : 'Token is required';
      },
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID',
      initial: existingMattermost?.channelId || '',
      hint: 'Click channel name > View Info > copy from URL',
      validate: (v: string) => v.length > 0 ? true : 'Channel ID is required',
    },
    {
      type: 'text',
      name: 'botName',
      message: 'Bot username',
      initial: existingMattermost?.botName || 'claude-code',
      hint: 'The username you chose when creating the bot',
    },
    {
      type: 'text',
      name: 'allowedUsers',
      message: 'Allowed usernames (optional)',
      initial: existingMattermost?.allowedUsers?.join(',') || '',
      hint: '⚠️  Leave empty to allow ANYONE (security risk) - or enter: alice,bob,charlie',
    },
    {
      type: 'confirm',
      name: 'requireApproval',
      message: 'Require approval for Claude actions?',
      initial: existingMattermost ? !existingMattermost.skipPermissions : true,
      hint: 'Yes = approve via reactions (recommended), No = auto-approve everything',
    },
  ], { onCancel });

  // Use existing token if user left it empty
  const finalToken = response.token || existingMattermost?.token;
  if (!finalToken) {
    console.log('');
    console.log(dim('  ⚠️  Token is required. Setup cancelled.'));
    process.exit(1);
  }

  // Parse allowed users
  const allowedUsers = response.allowedUsers?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [];

  // Confirm if no user restrictions (security risk)
  if (allowedUsers.length === 0) {
    console.log('');
    const { confirmOpen } = await prompts({
      type: 'confirm',
      name: 'confirmOpen',
      message: '⚠️  Allow ANYONE in the channel to use the bot?',
      initial: false,
    }, { onCancel });

    if (!confirmOpen) {
      console.log('');
      console.log(dim('  Setup cancelled. Please specify allowed usernames.'));
      console.log(dim('  Run `claude-threads --reconfigure` to try again.'));
      process.exit(1);
    }
  }

  // Validate credentials
  console.log('');
  console.log(dim('  Validating credentials...'));
  const validationResult = await validateMattermostCredentials(
    response.url,
    finalToken,
    response.channelId
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

    const { continueAnyway } = await prompts({
      type: 'confirm',
      name: 'continueAnyway',
      message: 'Save configuration anyway?',
      initial: false,
    }, { onCancel });

    if (!continueAnyway) {
      console.log('');
      console.log(dim('  Setup cancelled.'));
      process.exit(1);
    }
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
    displayName,
    url: response.url,
    token: finalToken,
    channelId: response.channelId,
    botName: response.botName,
    allowedUsers,
    skipPermissions: !response.requireApproval, // Invert: requireApproval=true means skipPermissions=false
  };
}

// ============================================================================
// Credential Validation Functions
// ============================================================================

interface ValidationResult {
  success: boolean;
  error?: string;
  botUsername?: string;
  channelName?: string;
  teamName?: string;
}

async function validateMattermostCredentials(
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

async function validateSlackCredentials(
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
  displayName: string,
  existing?: PlatformInstanceConfig
): Promise<SlackPlatformConfig> {
  console.log('');
  console.log(dim('  Slack setup (requires Socket Mode):'));
  console.log('');

  const existingSlack = existing?.type === 'slack' ? existing as SlackPlatformConfig : undefined;

  const response = await prompts([
    {
      type: 'password',
      name: 'botToken',
      message: 'Bot User OAuth Token',
      initial: existingSlack?.botToken,
      hint: existingSlack?.botToken
        ? 'Press Enter to keep existing, or paste new token'
        : 'From: OAuth & Permissions > Bot User OAuth Token (xoxb-...)',
      validate: (v: string) => {
        if (!v && existingSlack?.botToken) return true;
        if (!v) return 'Bot token is required';
        return v.startsWith('xoxb-') ? true : 'Bot token must start with xoxb-';
      },
    },
    {
      type: 'password',
      name: 'appToken',
      message: 'App-Level Token',
      initial: existingSlack?.appToken,
      hint: existingSlack?.appToken
        ? 'Press Enter to keep existing, or paste new token'
        : 'From: Socket Mode > Generate token (xapp-...)',
      validate: (v: string) => {
        if (!v && existingSlack?.appToken) return true;
        if (!v) return 'App token is required';
        return v.startsWith('xapp-') ? true : 'App token must start with xapp-';
      },
    },
    {
      type: 'text',
      name: 'channelId',
      message: 'Channel ID',
      initial: existingSlack?.channelId || '',
      hint: 'Right-click channel > View details > Copy ID (starts with C, e.g. C0123456789)',
      validate: (v: string) => {
        if (!v) return 'Channel ID is required';
        if (!v.startsWith('C') && !v.startsWith('G')) return 'Channel ID should start with C (public) or G (private)';
        return true;
      },
    },
    {
      type: 'text',
      name: 'botName',
      message: 'Bot username',
      initial: existingSlack?.botName || 'claude',
      hint: 'The display name of your Slack app',
    },
    {
      type: 'text',
      name: 'allowedUsers',
      message: 'Allowed usernames (optional)',
      initial: existingSlack?.allowedUsers?.join(',') || '',
      hint: '⚠️  Leave empty to allow ANYONE - or enter usernames: alice.smith,bob.jones (find: profile > More > Copy member ID)',
    },
    {
      type: 'confirm',
      name: 'requireApproval',
      message: 'Require approval for Claude actions?',
      initial: existingSlack ? !existingSlack.skipPermissions : true,
      hint: 'Yes = approve via reactions (recommended), No = auto-approve everything',
    },
  ], { onCancel });

  // Use existing tokens if user left them empty
  const finalBotToken = response.botToken || existingSlack?.botToken;
  const finalAppToken = response.appToken || existingSlack?.appToken;

  if (!finalBotToken || !finalAppToken) {
    console.log('');
    console.log(dim('  ⚠️  Both tokens are required. Setup cancelled.'));
    process.exit(1);
  }

  // Parse allowed users
  const allowedUsers = response.allowedUsers?.split(',').map((u: string) => u.trim()).filter((u: string) => u) || [];

  // Confirm if no user restrictions (security risk)
  if (allowedUsers.length === 0) {
    console.log('');
    const { confirmOpen } = await prompts({
      type: 'confirm',
      name: 'confirmOpen',
      message: '⚠️  Allow ANYONE in the channel to use the bot?',
      initial: false,
    }, { onCancel });

    if (!confirmOpen) {
      console.log('');
      console.log(dim('  Setup cancelled. Please specify allowed usernames.'));
      console.log(dim('  Run `claude-threads --reconfigure` to try again.'));
      process.exit(1);
    }
  }

  // Validate credentials
  console.log('');
  console.log(dim('  Validating credentials...'));
  const validationResult = await validateSlackCredentials(
    finalBotToken,
    finalAppToken,
    response.channelId
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

    const { continueAnyway } = await prompts({
      type: 'confirm',
      name: 'continueAnyway',
      message: 'Save configuration anyway?',
      initial: false,
    }, { onCancel });

    if (!continueAnyway) {
      console.log('');
      console.log(dim('  Setup cancelled.'));
      process.exit(1);
    }
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
    displayName,
    botToken: finalBotToken,
    appToken: finalAppToken,
    channelId: response.channelId,
    botName: response.botName,
    allowedUsers,
    skipPermissions: !response.requireApproval, // Invert: requireApproval=true means skipPermissions=false
  };
}
