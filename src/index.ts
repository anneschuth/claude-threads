#!/usr/bin/env node
import { program } from 'commander';
import { loadConfig, configExists, type CliArgs } from './config.js';
import { runOnboarding } from './onboarding.js';
import { MattermostClient } from './mattermost/client.js';
import { SessionManager } from './claude/session.js';
import type { MattermostPost, MattermostUser } from './mattermost/types.js';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'));

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

// Define CLI options
program
  .name('mm-claude')
  .version(pkg.version)
  .description('Share Claude Code sessions in Mattermost')
  .option('--url <url>', 'Mattermost server URL')
  .option('--token <token>', 'Mattermost bot token')
  .option('--channel <id>', 'Mattermost channel ID')
  .option('--bot-name <name>', 'Bot mention name (default: claude-code)')
  .option('--allowed-users <users>', 'Comma-separated allowed usernames')
  .option('--skip-permissions', 'Skip interactive permission prompts')
  .option('--debug', 'Enable debug logging')
  .parse();

const opts = program.opts();

// Check if required args are provided via CLI
function hasRequiredCliArgs(args: typeof opts): boolean {
  return !!(args.url && args.token && args.channel);
}

async function main() {
  // Set debug mode from CLI flag
  if (opts.debug) {
    process.env.DEBUG = '1';
  }

  // Build CLI args object
  const cliArgs: CliArgs = {
    url: opts.url,
    token: opts.token,
    channel: opts.channel,
    botName: opts.botName,
    allowedUsers: opts.allowedUsers,
    skipPermissions: opts.skipPermissions,
  };

  // Check if we need onboarding
  if (!configExists() && !hasRequiredCliArgs(opts)) {
    await runOnboarding();
  }

  const workingDir = process.cwd();
  const config = loadConfig(cliArgs);

  // Nice startup banner
  console.log('');
  console.log(bold(`  🤖 mm-claude v${pkg.version}`));
  console.log(dim('  ─────────────────────────────────'));
  console.log(`  📂 ${cyan(workingDir)}`);
  console.log(`  💬 ${cyan('@' + config.mattermost.botName)}`);
  console.log(`  🌐 ${dim(config.mattermost.url)}`);
  if (config.skipPermissions) {
    console.log(`  ⚠️  ${dim('Permissions disabled')}`);
  } else {
    console.log(`  🔐 ${dim('Interactive permissions')}`);
  }
  console.log('');

  const mattermost = new MattermostClient(config);
  const session = new SessionManager(mattermost, workingDir, config.skipPermissions);

  mattermost.on('message', async (post: MattermostPost, user: MattermostUser | null) => {
    const username = user?.username || 'unknown';
    const message = post.message;
    const threadRoot = post.root_id || post.id;

    // Follow-up in active thread
    if (session.isInSessionThread(threadRoot)) {
      if (!mattermost.isUserAllowed(username)) return;
      const content = mattermost.isBotMentioned(message)
        ? mattermost.extractPrompt(message)
        : message.trim();

      // Check for stop/cancel commands
      const lowerContent = content.toLowerCase();
      if (lowerContent === '/stop' || lowerContent === 'stop' ||
          lowerContent === '/cancel' || lowerContent === 'cancel') {
        await session.cancelSession(threadRoot, username);
        return;
      }

      if (content) await session.sendFollowUp(threadRoot, content);
      return;
    }

    // New session requires @mention
    if (!mattermost.isBotMentioned(message)) return;

    if (!mattermost.isUserAllowed(username)) {
      await mattermost.createPost(`⚠️ @${username} is not authorized`, threadRoot);
      return;
    }

    const prompt = mattermost.extractPrompt(message);
    if (!prompt) {
      await mattermost.createPost(`Mention me with your request`, threadRoot);
      return;
    }

    await session.startSession({ prompt }, username, threadRoot);
  });

  mattermost.on('connected', () => {});
  mattermost.on('error', (e) => console.error('  ❌ Error:', e));

  await mattermost.connect();
  console.log(`  ✅ ${bold('Ready!')} Waiting for @${config.mattermost.botName} mentions...`);
  console.log('');

  const shutdown = () => {
    console.log('');
    console.log(`  👋 ${dim('Shutting down...')}`);
    session.killAllSessions();
    mattermost.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(e => { console.error(e); process.exit(1); });
