# claude-threads Setup Guide

> **💡 Quick Start:** Run `claude-threads` and the interactive wizard will guide you through setup.
> Use this guide when you need help creating a bot account on Mattermost.

## Table of Contents

1. [Mattermost Setup](#mattermost-setup) - Create bot account and get credentials
2. [Running the Onboarding](#running-the-onboarding) - Interactive wizard walkthrough
3. [Troubleshooting](#troubleshooting) - Common issues and solutions

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

## Running the Onboarding

### First Time Setup

**Just run the tool - it will guide you:**

```bash
# Install
bun install -g claude-threads

# Run the wizard
cd /your/project
claude-threads
```

**The wizard will:**
- ✅ Walk you through global settings (working directory, Chrome, git)
- ✅ Show you platform checklists (what you need before adding a platform)
- ✅ Guide you through adding Mattermost platforms
- ✅ Validate credentials in real-time and test permissions
- ✅ Show a configuration summary before saving

**When prompted for platform credentials:**
- Use the [Mattermost Setup](#mattermost-setup) section above to create your bot
- The wizard will wait while you gather the required information
- Come back and enter the credentials when ready

**Multiple platforms:**
- You can connect to multiple Mattermost instances
- Each platform gets a unique ID (e.g., `mattermost-main`, `mattermost-eng`)
- Add platforms one at a time, or add more later with `--setup`

### Reconfiguring

To modify your configuration:

```bash
claude-threads --setup
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
   - Platform (Mattermost)
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
