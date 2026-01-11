# claude-threads Setup Guide

This guide walks you through setting up claude-threads to connect to Mattermost and/or Slack.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Mattermost Setup](#mattermost-setup)
3. [Slack Setup](#slack-setup)
4. [Running the Onboarding](#running-the-onboarding)
5. [Troubleshooting](#troubleshooting)

## Prerequisites

Before you begin, make sure you have:

- **Admin access** to your Mattermost server or Slack workspace (or someone who can create bot accounts for you)
- **Node.js and Bun** installed on the machine where you'll run claude-threads
- **Claude Code CLI** installed (`npm install -g @anthropic-ai/claude-code@2.0.76`)
- **Anthropic API key** configured (claude-threads uses Claude Code, which requires an API key)

**Time estimate**: 10-15 minutes per platform

---

## Mattermost Setup

### Step 1: Create a Bot Account

1. **Navigate to Integrations**:
   - Go to your Mattermost workspace
   - Click **Main Menu** (≡) → **Integrations** → **Bot Accounts**
   - Click **Add Bot Account**

2. **Configure the Bot**:
   - **Username**: Choose a username (e.g., `claude-code`, `claude-bot`)
   - **Display Name**: Choose a display name (e.g., "Claude Code Assistant")
   - **Description**: Optional description
   - **Role**: Select **Member** (bot doesn't need admin privileges)
   - **Post:All**: ✅ Enable (bot needs to post messages)
   - **Post:Channels**: ✅ Enable (bot needs to post in channels)
   - Click **Create Bot Account**

3. **Save the Token**:
   - After creation, Mattermost will show you a **Bot Token** (starts with a long alphanumeric string)
   - **⚠️ Copy this token immediately** - you won't see it again!
   - Keep it secure - treat it like a password

### Step 2: Get Channel ID

1. **Open the channel** where you want claude-threads to operate
2. Click the **channel name** at the top
3. Select **View Info**
4. The URL will change to something like:
   ```
   https://chat.example.com/yourteam/channels/abcdefghijklmnopqrstuvwxyz
                                               ^^^^^^^^^^^^^^^^^^^^^^^^^
                                               This is your Channel ID
   ```
5. **Copy the Channel ID** (the last part of the URL after `/channels/`)

### Step 3: Get Server URL

Your server URL is the base URL of your Mattermost instance, for example:
- `https://chat.example.com`
- `https://mattermost.company.com`

**Note**: Do NOT include the team name or channel path - just the base URL.

### Step 4: Required Information Summary

You'll need these during onboarding:

| Field | Example | Where to Find |
|-------|---------|---------------|
| **Server URL** | `https://chat.example.com` | Your Mattermost instance URL |
| **Bot Token** | `ab12cd34ef56...` | Created in Step 1 |
| **Channel ID** | `abc123xyz456...` | Found in Step 2 |
| **Bot Name** | `claude-code` | The username you chose in Step 1 |

### Optional: User Allowlist

If you want to restrict who can use the bot, prepare a comma-separated list of Mattermost usernames:
- Example: `alice,bob,charlie`
- Leave empty to allow everyone in the channel

---

## Slack Setup

### Quick Setup with App Manifest (Recommended)

**Fastest way**: Use the pre-configured app manifest to set up everything automatically.

1. **Go to** https://api.slack.com/apps
2. Click **Create New App**
3. Select **From an app manifest**
4. Choose your workspace
5. **Paste the manifest** from `docs/slack-app-manifest.yaml`:
   - View it here: https://github.com/anneschuth/claude-threads/blob/main/docs/slack-app-manifest.yaml
   - Or copy from your local installation: `~/.bun/install/global/node_modules/claude-threads/docs/slack-app-manifest.yaml`
6. Click **Create**
7. **Skip to Step 2** below (Socket Mode will already be configured)

### Manual Setup (Alternative)

If you prefer to configure manually, follow these steps:

#### Step 1: Create a Slack App

1. **Go to** https://api.slack.com/apps
2. Click **Create New App**
3. Select **From scratch**
4. **App Name**: Choose a name (e.g., "Claude Code Bot")
5. **Workspace**: Select your workspace
6. Click **Create App**

#### Step 2: Enable Socket Mode

Socket Mode allows real-time communication without exposing a public URL.

1. In your app settings, go to **Settings** → **Socket Mode** (left sidebar)
2. Toggle **Enable Socket Mode** to ON
3. Click **Generate an app-level token**:
   - **Token Name**: `websocket-token` (or any name you prefer)
   - **Scopes**: Select `connections:write`
   - Click **Generate**
4. **⚠️ Copy the App-Level Token** (starts with `xapp-`)
   - You won't see this again!

#### Step 3: Configure OAuth Scopes

1. Go to **Features** → **OAuth & Permissions** (left sidebar)
2. Scroll to **Scopes** → **Bot Token Scopes**
3. Click **Add an OAuth Scope** and add these scopes:

   **Required scopes:**
   - `channels:history` - Read messages from public channels
   - `channels:read` - View basic channel information
   - `chat:write` - Send messages
   - `files:read` - Access file content
   - `reactions:read` - View emoji reactions
   - `reactions:write` - Add/remove emoji reactions
   - `users:read` - View users in the workspace

#### Step 4: Install App to Workspace

1. Scroll to the top of **OAuth & Permissions** page
2. Click **Install to Workspace**
3. Review permissions and click **Allow**
4. **⚠️ Copy the Bot User OAuth Token** (starts with `xoxb-`)
   - This will be shown after installation
   - You can also find it later under **OAuth & Permissions** → **Bot User OAuth Token**

#### Step 5: Subscribe to Events

1. Go to **Features** → **Event Subscriptions** (left sidebar)
2. Toggle **Enable Events** to ON
3. Scroll to **Subscribe to bot events**
4. Click **Add Bot User Event** and add:
   - `message.channels` - Listen to messages in public channels
   - `reaction_added` - Listen to emoji reactions being added
   - `reaction_removed` - Listen to emoji reactions being removed
5. Click **Save Changes**

### Finishing Steps (All Setup Methods)

#### Get Channel ID

1. **Open Slack** in your browser or desktop app
2. **Right-click** the channel where you want the bot to operate
3. Select **View channel details**
4. Scroll to the bottom
5. **Copy the Channel ID** (starts with `C`, e.g., `C0123456789`)

   **Alternative method:**
   - In the channel, click the **channel name** at the top
   - The URL will show the channel ID:
     ```
     https://app.slack.com/client/T123ABC/C0123456789
                                          ^^^^^^^^^^^
                                          Channel ID
     ```

#### Invite Bot to Channel

1. In Slack, go to the channel where you want the bot
2. Type `/invite @your-bot-name` (use the display name you chose)
3. Press Enter
4. The bot should join the channel

### Required Information Summary

You'll need these during onboarding:

| Field | Example | Where to Find |
|-------|---------|---------------|
| **Bot User OAuth Token** | `xoxb-123-456-...` | Step 4 (OAuth & Permissions) |
| **App-Level Token** | `xapp-1-A0123-...` | Step 2 (Socket Mode) |
| **Channel ID** | `C0123456789` | Step 6 |
| **Bot Name** | `claude` | Your app's display name |

### Optional: User Allowlist

If you want to restrict who can use the bot, prepare a comma-separated list of Slack **usernames** (not display names):
- Example: `alice.smith,bob.jones,charlie.brown`
- To find a username: Click a user's profile → More → Copy member ID → Username is shown
- Leave empty to allow everyone in the channel

---

## Running the Onboarding

### First Time Setup (Recommended)

> **✅ Use the interactive wizard - it validates everything for you!**

1. **Install claude-threads**:
   ```bash
   npm install -g claude-threads
   ```

2. **Run the onboarding wizard**:
   ```bash
   claude-threads
   ```

   **The wizard will:**
   - ✅ Guide you through each configuration step
   - ✅ Validate your credentials in real-time
   - ✅ Test bot permissions and channel access
   - ✅ Provide specific error messages if something's wrong
   - ✅ Show bot username and channel name on success

   **It will ask for:**
   - Default working directory (where Claude Code will run)
   - Chrome integration (optional - requires Claude in Chrome extension)
   - Git worktree mode (how to handle git branches)
   - Platform configuration (Mattermost/Slack credentials)

3. **Follow the prompts** and enter the information you gathered above

4. **Add multiple platforms** (optional):
   - After configuring the first platform, you'll be asked "Add another platform?"
   - Say "yes" to connect to multiple Mattermost/Slack instances simultaneously
   - Each platform gets a unique ID (e.g., `mattermost-main`, `slack-eng`)

### Reconfiguring

To modify your configuration:

```bash
claude-threads --reconfigure
```

This will reload your existing config and let you update settings.

### Manual Configuration (Advanced)

> **⚠️ Not recommended for first-time setup!**
>
> The interactive wizard (`claude-threads`) is the recommended way to configure claude-threads because it:
> - Validates your credentials in real-time
> - Provides helpful error messages and troubleshooting
> - Ensures correct YAML format
> - Tests bot permissions and channel access
>
> **Only edit manually if you:**
> - Need to quickly update a token or setting
> - Are an experienced user comfortable with YAML
> - Have already run the wizard at least once

If you still want to manually edit the config:

```bash
# Config is stored at:
~/.config/claude-threads/config.yaml

# Edit with your favorite editor:
nano ~/.config/claude-threads/config.yaml

# Then restart claude-threads to apply changes
```

**Reference config.yaml:**

```yaml
version: 2
workingDir: /home/user/projects
chrome: false
worktreeMode: prompt

platforms:
  # Mattermost
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-mattermost-token
    channelId: abc123xyz456
    botName: claude-code
    allowedUsers: []  # empty = allow everyone
    skipPermissions: false

  # Slack
  - id: slack-eng
    type: slack
    displayName: Engineering Team
    botToken: xoxb-your-bot-token
    appToken: xapp-your-app-token
    channelId: C0123456789
    botName: claude
    allowedUsers: []  # empty = allow everyone
    skipPermissions: false
```

---

## Troubleshooting

### Mattermost Issues

#### "Invalid token" or "401 Unauthorized"
- **Check** that you copied the full token from the Bot Account creation page
- **Verify** the token is for the correct Mattermost instance
- **Try** creating a new bot account and token

#### "Cannot find channel" or "403 Forbidden"
- **Add the bot to the channel**: Type `@botname` in the channel to invite it
- **Check** the Channel ID is correct (from View Info)
- **Verify** the bot has "Post:All" and "Post:Channels" permissions

#### Bot doesn't respond to messages
- **Check** the bot name matches what you're @mentioning
- **Verify** the bot is a member of the channel
- **Look at** claude-threads logs for errors (`DEBUG=1 claude-threads`)

### Slack Issues

#### "invalid_auth" or "token_revoked"
- **Regenerate tokens**: Go to your app settings and reinstall the app
- **Check** you're using the Bot User OAuth Token (not User OAuth Token)
- **Verify** Socket Mode is enabled with a valid App-Level Token

#### "channel_not_found"
- **Invite the bot** to the channel: `/invite @your-bot-name`
- **Check** the Channel ID is correct (should start with `C`)
- **Verify** the bot has `channels:read` and `channels:history` scopes

#### Bot doesn't respond to messages
- **Check** Event Subscriptions are enabled with `message.channels`
- **Verify** Socket Mode is enabled (required for receiving events)
- **Invite the bot** to the channel if not already a member
- **Look at** claude-threads logs (`DEBUG=1 claude-threads`)

#### "missing_scope" errors
- **Review** OAuth scopes in Step 3 above
- **Reinstall** the app after adding missing scopes
- **Required scopes**: `channels:history`, `channels:read`, `chat:write`, `files:read`, `reactions:read`, `reactions:write`, `users:read`

### General Issues

#### "Claude CLI not found"
- **Install** Claude Code CLI: `npm install -g @anthropic-ai/claude-code@2.0.76`
- **Verify** it's in PATH: `which claude`
- **Set** custom path if needed: `CLAUDE_PATH=/path/to/claude claude-threads`

#### "Incompatible Claude CLI version"
- **Check** your version: `claude --version`
- **Install** compatible version: `npm install -g @anthropic-ai/claude-code@2.0.76`
- **Skip check** (not recommended): `claude-threads --skip-version-check`

#### Can't find config file
- **Default location**: `~/.config/claude-threads/config.yaml`
- **Create directory**: `mkdir -p ~/.config/claude-threads`
- **Run onboarding**: `claude-threads` will create the config

#### Bot works but permissions don't prompt
- **Check** `skipPermissions` is set to `false` in config
- **Restart** claude-threads after changing config
- **Try** `!permissions interactive` in a running session

### Getting Help

If you're still stuck:

1. **Check logs**: Run with `DEBUG=1 claude-threads` for verbose output
2. **Review the README**: See `CLAUDE.md` for architecture details
3. **Check the issues**: https://github.com/anneschuth/claude-threads/issues
4. **Open an issue**: Include:
   - Platform (Mattermost/Slack)
   - Error messages from logs
   - Steps to reproduce
   - Your config (with tokens redacted!)

---

## Next Steps

Once configured, test your bot:

1. **Start claude-threads**:
   ```bash
   claude-threads
   ```

2. **In your chat platform**, @mention the bot:
   ```
   @botname write "hello world" to test.txt
   ```

3. **Watch** the bot create a thread and stream Claude's response

4. **Explore** commands:
   - `!help` - Show available commands
   - `!permissions interactive` - Enable permission prompts
   - `!cd /path` - Change working directory
   - `!stop` - End the session

Happy coding with Claude! 🚀
