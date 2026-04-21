# Configuration Reference

Configuration is stored at `~/.config/claude-threads/config.yaml`.

## Full Example

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt

platforms:
  # Mattermost
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    skipPermissions: false

  # Slack
  - id: slack-eng
    type: slack
    displayName: Engineering
    botToken: xoxb-your-bot-token
    appToken: xapp-your-app-token
    channelId: C0123456789
    botName: claude
    allowedUsers: [alice, bob]
    skipPermissions: false
```

## Global Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `workingDir` | Default working directory for Claude | Current directory |
| `chrome` | Enable Chrome integration | `false` |
| `worktreeMode` | Git worktree mode: `off`, `prompt`, or `require` | `prompt` |

## Platform Settings

### Mattermost

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `mattermost` |
| `displayName` | No | Human-readable name |
| `url` | Yes | Mattermost server URL |
| `token` | Yes | Bot access token |
| `channelId` | Yes | Channel to listen in |
| `botName` | No | Mention name (default: `claude-code`) |
| `allowedUsers` | No | List of usernames who can use the bot |
| `skipPermissions` | No | Auto-approve actions (default: `false`) |

### Slack

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Unique identifier for this platform |
| `type` | Yes | Must be `slack` |
| `displayName` | No | Human-readable name |
| `botToken` | Yes | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | Yes | App-Level Token for Socket Mode (`xapp-...`) |
| `channelId` | Yes | Channel ID (e.g., `C0123456789`) |
| `botName` | No | Mention name (default: `claude`) |
| `allowedUsers` | No | List of Slack usernames |
| `skipPermissions` | No | Auto-approve actions (default: `false`) |

## Claude Accounts (optional, multi-account mode)

By default every session spawns `claude` with the bot's own `process.env`, so they all share one subscription's token budget. Add a `claudeAccounts` block to spread load across multiple accounts — the bot round-robins new sessions across the pool and automatically skips accounts in rate-limit cooldown. Omit the block entirely to stay in single-account mode (unchanged behavior).

```yaml
claudeAccounts:
  # OAuth accounts — prepare each HOME first with `HOME=<path> claude login`
  - id: primary
    home: /home/bot/.claude-accounts/primary
  - id: backup
    displayName: Backup (Pro)
    home: /home/bot/.claude-accounts/backup

  # API-key billed
  - id: shared-api
    apiKey: sk-ant-api03-xxxxxxxx...
```

| Setting | Required | Description |
|---------|----------|-------------|
| `id` | Yes | Stable identifier used in logs, UI, and persisted session state |
| `home` | One of | Alternate `$HOME` containing `.claude/.credentials.json` from a prior `HOME=<path> claude login`. For OAuth Pro/Max subscriptions. Session history also lives here, so resumed sessions pick the same account. |
| `apiKey` | One of | Anthropic API key. Billed against that key; session history stays under the bot's default `HOME`. |
| `displayName` | No | Human-readable label in UI (defaults to `id`) |

Exactly one of `home` or `apiKey` should be set per account. Persisted sessions record which account they ran under and resume on the same one.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_SESSIONS` | Max concurrent sessions | `5` |
| `SESSION_TIMEOUT_MS` | Idle timeout in milliseconds | `1800000` (30 min) |
| `NO_UPDATE_NOTIFIER` | Disable update checks | - |
| `DEBUG` | Enable verbose logging | - |
| `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` | Strip `ANTHROPIC_*` / `AWS_*_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` / `GOOGLE_APPLICATION_CREDENTIALS` etc. from Bash, hook, and stdio-MCP subprocesses Claude spawns. Bot-specific vars like `PLATFORM_TOKEN` pass through. **Also forces permission mode to `default`** — `--dangerously-skip-permissions` will be rejected. Requires Claude CLI 2.1.83+. | - |

### Forwarded to Claude CLI automatically

The bot sets two tuning flags on the Claude child process when they aren't
already present in the bot's environment:

| Variable | Effect | Requires |
|----------|--------|----------|
| `MCP_CONNECTION_NONBLOCKING=true` | Caps `--mcp-config` connects at 5s so a slow MCP server never delays startup | Claude CLI 2.1.89+ |
| `ENABLE_PROMPT_CACHING_1H=true` | Opts into 1-hour prompt cache TTL, cutting re-caching cost on long-lived threads | Claude CLI 2.1.108+ |

Export either with a different value in the bot's own env to disable.

## CLI Options

CLI options override config file settings:

```bash
claude-threads [options]

Options:
  --url <url>              Mattermost server URL
  --token <token>          Bot token
  --channel <id>           Channel ID
  --bot-name <name>        Bot mention name (default: claude-code)
  --allowed-users <list>   Comma-separated allowed usernames
  --skip-permissions       Skip permission prompts (auto-approve)
  --no-skip-permissions    Enable permission prompts (override env)
  --chrome                 Enable Chrome integration
  --no-chrome              Disable Chrome integration
  --worktree-mode <mode>   Git worktree mode: off, prompt, require
  --setup                  Re-run setup wizard
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show help
```

## Session Persistence

Active sessions are saved to `~/.config/claude-threads/sessions.json` and automatically resume after bot restarts.

## Keep-Alive

The bot prevents system sleep while sessions are active (uses `caffeinate` on macOS, `systemd-inhibit` on Linux). Disable with `--no-keep-alive` or `keepAlive: false` in config.
