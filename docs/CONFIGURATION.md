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

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAX_SESSIONS` | Max concurrent sessions | `5` |
| `SESSION_TIMEOUT_MS` | Idle timeout in milliseconds | `1800000` (30 min) |
| `NO_UPDATE_NOTIFIER` | Disable update checks | - |
| `DEBUG` | Enable verbose logging | - |

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
