# Claude Threads

```
 ✴ ▄█▀ ███ ✴   claude-threads
✴  █▀   █   ✴  Mattermost & Slack × Claude Code
 ✴ ▀█▄  █  ✴
```

[![npm version](https://img.shields.io/npm/v/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![npm downloads](https://img.shields.io/npm/dm/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.2.21-black.svg)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

**Bring Claude Code to your team.** Run Claude Code on your machine, share it live in Mattermost or Slack. Colleagues can watch, collaborate, and run their own sessions—all from chat.

> 💡 *Think of it as screen-sharing for AI pair programming, but everyone can type.*

## Features

- **Real-time streaming** - Claude's responses stream live to Mattermost/Slack
- **Multi-platform support** - Connect to multiple Mattermost and Slack workspaces
- **Multiple concurrent sessions** - Each thread gets its own Claude session
- **Session persistence** - Sessions survive bot restarts and resume automatically
- **Session collaboration** - Invite others to participate in your session
- **Interactive permissions** - Approve Claude's actions via emoji reactions
- **Plan approval** - Review and approve Claude's plans before execution
- **Task tracking** - Live todo list updates as Claude works (collapsible)
- **Code diffs** - See exactly what Claude is changing
- **Image attachments** - Attach images for Claude to analyze
- **Thread context** - Start mid-thread and include previous messages as context
- **Git worktrees** - Isolate changes in separate branches/directories
- **Chrome automation** - Control Chrome browser for web tasks
- **Keep-alive** - Prevents system sleep while sessions are active

## How it works

```mermaid
flowchart TB
    subgraph local["Your Local Machine"]
        cli["Claude Code CLI<br/>(subprocess)"]
        mm["claude-threads<br/>(this service)"]
        cli <-->|"stdio"| mm
    end

    subgraph server["Chat Platform (Mattermost/Slack)"]
        bot["Bot Account<br/>@claude-code"]
        channel["Channel<br/>#claude-sessions"]
        bot <--> channel
    end

    mm -->|"WebSocket + REST API<br/>(outbound only)"| server
```

Runs entirely on your machine - only **outbound** connections to your chat platform. No port forwarding needed!

## Prerequisites

1. **Claude Code CLI** installed and authenticated (`claude --version`)
2. **Bun 1.2.21+** (`bun --version`) - [Install Bun](https://bun.sh/)
3. **Chat platform bot account:**
   - **Mattermost**: Bot account with personal access token
   - **Slack**: Slack app with Socket Mode enabled (see [Slack Setup](#for-slack-admins))

## Quick Start

### 1. Install

```bash
bun install -g claude-threads
```

### 2. Run

```bash
cd /your/project
claude-threads
```

On first run, an interactive setup wizard guides you through configuration:

```
  claude-threads setup
  ─────────────────────────────────

  Welcome! Let's configure claude-threads.

? Default working directory: /home/user/projects
? Enable Chrome integration? No
? Git worktree mode: Prompt

  Now let's add your platform connections.

? First platform: Slack
? Platform ID: slack-team
? Display name: Engineering Team

  Slack setup (requires Socket Mode):
  Create app at: api.slack.com/apps

? Bot token (xoxb-...): ********
? App token (xapp-...): ********
? Channel ID: C0123456789
? Bot mention name: claude
? Allowed usernames (optional): alice,bob

  ✓ Added Slack

? Add another platform? No

  ✓ Configuration saved!
    ~/.config/claude-threads/config.yaml

  Configured 1 platform(s):
    • Engineering Team (slack)

  Starting claude-threads...
```

### 3. Use

In your chat platform, mention the bot:

```
@claude help me fix the bug in src/auth.ts
```

## CLI Options

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
  --setup                  Re-run setup wizard (reconfigure settings)
  --debug                  Enable debug logging
  --version                Show version
  --help                   Show help
```

CLI options override environment variables.

## Session Commands

Type `!help` in any session thread to see available commands:

| Command | Description |
|:--------|:------------|
| `!help` | Show available commands |
| `!release-notes` | Show release notes for current version |
| `!context` | Show context usage (accurate % from Claude's status line) |
| `!cost` | Show token usage and cost for this session |
| `!compact` | Compress context to free up space |
| `!cd <path>` | Change working directory (restarts Claude) |
| `!worktree <branch>` | Create and switch to a git worktree |
| `!invite @user` | Invite a user to this session |
| `!kick @user` | Remove an invited user |
| `!permissions interactive` | Enable interactive permissions |
| `!escape` | Interrupt current task (keeps session active) |
| `!stop` | Stop this session |
| `!kill` | Emergency shutdown (kills ALL sessions, exits bot) |

> **Note:** Commands use `!` prefix instead of `/` to avoid conflicts with platform slash commands.

## Session Collaboration

### Invite Users

Session owners can temporarily allow others to participate:

```
!invite @colleague
```

The colleague can now send messages in this session thread. The bot validates that the user exists before inviting.

### Kick Users

Remove an invited user from the session:

```
!kick @colleague
```

The bot validates that the user exists before attempting to kick them.

### Message Approval

When an unauthorized user sends a message in a session thread, the owner sees an approval prompt:

```
🔒 @unauthorized-user wants to send a message:
> Can you also add error handling?

React 👍 to allow this message, ✅ to invite them to the session, 👎 to deny
```

### Side Conversations

Messages starting with `@someone-else` are ignored by the bot, allowing side conversations in the thread without triggering Claude.

### Downgrade Permissions

If the bot is running with `--skip-permissions` (auto mode), you can enable interactive permissions for a specific session:

```
!permissions interactive
```

This allows collaboration by requiring approval for Claude's actions. Note: you can only downgrade (auto → interactive), not upgrade - this ensures security.

## Git Worktrees

When working on a task that requires code changes, Claude can work in an isolated git worktree. This keeps your main branch clean while Claude works on a feature branch in a separate directory.

### Starting a Session with a Worktree

Specify a branch when starting:

```
@claude on branch feature/add-auth implement user authentication
```

Or use the worktree command:

```
@claude !worktree feature/add-auth implement user authentication
```

### Worktree Commands

| Command | Description |
|:--------|:------------|
| `!worktree <branch>` | Create worktree and switch to it |
| `!worktree list` | List all worktrees for this repo |
| `!worktree switch <branch>` | Switch to an existing worktree |
| `!worktree remove <branch>` | Remove a worktree |
| `!worktree off` | Disable worktree prompts for this session |

### How It Works

1. Creates a new worktree at `../<repo>-worktrees/<branch>/`
2. Creates or checks out the specified branch
3. Claude works in the worktree directory
4. Your main working directory stays untouched

### Environment Variable

| Variable | Description |
|----------|-------------|
| `WORKTREE_MODE` | `prompt` (ask on new sessions), `require` (always require branch), `off` (disable) |

## Interactive Features

### Permission Approval

When Claude wants to execute a tool (edit file, run command, etc.):

- **👍 Allow** - Approve this specific action
- **✅ Allow all** - Approve all future actions this session
- **👎 Deny** - Reject this action

To skip prompts: `claude-threads --skip-permissions` or set `SKIP_PERMISSIONS=true`

### Plan Mode

When Claude creates a plan and is ready to implement:

- **👍** Approve and start building
- **👎** Request changes

Once approved, subsequent plans auto-continue.

### Questions

When Claude asks questions with multiple choice options:

- React with 1️⃣ 2️⃣ 3️⃣ or 4️⃣ to answer
- Questions are asked one at a time

### Task List

Claude's todo list shows live in your chat and stays at the bottom of the thread:

- ○ Pending
- 🔄 In progress (shows elapsed time)
- ✅ Completed

React with 🔽 to collapse/expand the task list. Progress shown as `(2/5 · 40%)`.

### Channel Dashboard

A pinned message at the bottom of the channel shows active sessions and recent history with system status, pending prompts, and current tasks. Session history is retained for up to 3 days.

### Session Header

Each session shows a real-time status bar with context usage (color-coded 🟢🟡🟠🔴), model name, cost, and uptime. The header table displays topic, directory, git branch, participants, and PR link (when working in a worktree with an associated pull request).

### Cancel Session

Stop a running session:

- Type `!stop` or `!cancel` in the thread
- React with ❌ or 🛑 to any message in the thread

### Session Persistence

Sessions automatically survive bot restarts:

- Active sessions are saved to `~/.config/claude-threads/sessions.json`
- On restart, sessions resume with full context via Claude's `--resume` flag
- Users see "Session resumed after bot restart" notification
- Timed-out sessions can be resumed by reacting with 🔄 or sending a new message

### Image Attachments

Attach images (JPEG, PNG, GIF, WebP) to your messages and Claude will analyze them. Works for both new sessions and follow-up messages.

### Thread Context

When starting a session mid-thread (replying to existing conversation), you'll be prompted to include previous messages as context. Options include last 3, 5, 10, or all messages. Single-message threads auto-include context.

## Chrome Integration

Enable browser automation with `--chrome` or `chrome: true` in config:

```bash
claude-threads --chrome
```

Claude can then control your Chrome browser for web tasks like:
- Taking screenshots and analyzing pages
- Filling forms and clicking buttons
- Navigating and extracting content

Requires the [Claude in Chrome](https://chromewebstore.google.com/detail/claude-in-chrome/) extension.

## Access Control

Set `allowedUsers` in your platform config to restrict who can use the bot:

```yaml
platforms:
  - id: mattermost-main
    # ...
    allowedUsers: [alice, bob, carol]

  - id: slack-team
    # ...
    allowedUsers: [alice, bob]  # Slack usernames (not user IDs)
```

- Only listed users can start sessions
- Only listed users can approve permissions
- Session owners can `!invite` others temporarily
- Empty = anyone can use (be careful!)

## Configuration

Configuration is stored in YAML format at `~/.config/claude-threads/config.yaml`.

### Example Config

```yaml
version: 1
workingDir: /home/user/repos/myproject
chrome: false
worktreeMode: prompt

platforms:
  # Mattermost example
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    skipPermissions: false

  # Slack example
  - id: slack-eng
    type: slack
    displayName: Engineering
    botToken: xoxb-your-bot-token      # Bot User OAuth Token
    appToken: xapp-your-app-token      # App-Level Token (Socket Mode)
    channelId: C0123456789
    botName: claude
    allowedUsers: [alice, bob]         # Slack usernames
    skipPermissions: false
```

### Global Settings

| Setting | Description |
|---------|-------------|
| `workingDir` | Default working directory for Claude |
| `chrome` | Enable Chrome integration (`true`/`false`) |
| `worktreeMode` | Git worktree mode: `off`, `prompt`, or `require` |

### Platform Settings (Mattermost)

| Setting | Description |
|---------|-------------|
| `url` | Mattermost server URL |
| `token` | Bot access token |
| `channelId` | Channel to listen in |
| `botName` | Mention name (default: `claude-code`) |
| `allowedUsers` | List of usernames who can use the bot |
| `skipPermissions` | Auto-approve actions (`true`/`false`) |

### Platform Settings (Slack)

| Setting | Description |
|---------|-------------|
| `botToken` | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | App-Level Token for Socket Mode (`xapp-...`) |
| `channelId` | Channel ID to listen in (e.g., `C0123456789`) |
| `botName` | Mention name (default: `claude`) |
| `allowedUsers` | List of Slack usernames (e.g., `alice`, `bob`) |
| `skipPermissions` | Auto-approve actions (`true`/`false`) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MAX_SESSIONS` | Max concurrent sessions (default: `5`) |
| `SESSION_TIMEOUT_MS` | Idle timeout in ms (default: `1800000` = 30 min) |
| `NO_UPDATE_NOTIFIER` | Set to `1` to disable update checks |
| `DEBUG` | Set to `1` for verbose logging |

### Keep-Alive

The bot automatically prevents system sleep while sessions are active (uses `caffeinate` on macOS, `systemd-inhibit` on Linux). Disable with `--no-keep-alive` or `keepAlive: false` in config.

## Code Display

- **Edit**: Shows diff with `-` removed and `+` added lines
- **Write**: Shows preview of new file content
- **Bash**: Shows command being executed
- **Read**: Shows file path being read
- **MCP tools**: Shows tool name and server

## Auto-Updates

claude-threads checks for updates every 30 minutes and notifies you when a new version is available:

- **CLI**: Shows a notification box on startup
- **Chat**: Shows a warning in session headers

To update:

```bash
bun install -g claude-threads
```

To disable update checks, set `NO_UPDATE_NOTIFIER=1`.

## For Mattermost Admins

To set up a bot account:

1. Go to **Integrations > Bot Accounts > Add Bot Account**
2. Give it a username (e.g., `claude-code`) and display name
3. Create a **Personal Access Token** for the bot
4. Add the bot to the channel where it should listen

The bot needs permissions to:
- Post messages
- Add reactions
- Read channel messages

## For Slack Admins

Setting up claude-threads for Slack requires creating a Slack app with Socket Mode enabled.

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name your app (e.g., "Claude Code") and select your workspace

### 2. Enable Socket Mode

1. Go to **Socket Mode** in the left sidebar
2. Toggle **Enable Socket Mode** to On
3. Create an **App-Level Token** with the `connections:write` scope
4. Save this token - it starts with `xapp-` (you'll need it for config)

### 3. Add Bot Scopes

1. Go to **OAuth & Permissions** in the left sidebar
2. Under **Bot Token Scopes**, add these scopes:
   - `channels:history` - Read messages in channels
   - `channels:read` - View basic channel info
   - `chat:write` - Send messages
   - `reactions:read` - Read emoji reactions
   - `reactions:write` - Add emoji reactions
   - `users:read` - View users and their info

### 4. Enable Events

1. Go to **Event Subscriptions** in the left sidebar
2. Toggle **Enable Events** to On
3. Under **Subscribe to bot events**, add:
   - `message.channels` - Messages in public channels
   - `reaction_added` - Reaction added to messages
   - `reaction_removed` - Reaction removed from messages

### 5. Install to Workspace

1. Go to **Install App** in the left sidebar
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** - it starts with `xoxb-`

### 6. Get Channel ID

1. In Slack, right-click the channel name and select **View channel details**
2. At the bottom, copy the **Channel ID** (starts with `C`)

### 7. Add Bot to Channel

1. In Slack, go to the channel where you want the bot
2. Type `/invite @YourBotName` or click the channel name → **Integrations** → **Add apps**

### Troubleshooting Slack

**"not_authed" or "invalid_auth" errors:**
- Verify your `botToken` starts with `xoxb-`
- Verify your `appToken` starts with `xapp-`
- Make sure the app is installed to your workspace

**Bot not responding to messages:**
- Check that Socket Mode is enabled
- Verify `message.channels` event is subscribed
- Make sure bot is invited to the channel
- Check that username is in `allowedUsers`

**Reactions not working:**
- Verify `reactions:read` and `reactions:write` scopes are added
- Check that `reaction_added` event is subscribed

## License

Apache-2.0
