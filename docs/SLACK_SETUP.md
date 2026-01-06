# Slack Setup Guide

This guide covers setting up a Slack app for claude-threads with Socket Mode.

## Quick Setup (Recommended)

Use the app manifest to configure everything automatically:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From an app manifest**
3. Select your workspace
4. Paste the contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml)
5. Click **Create**
6. Go to **Basic Information** → **App-Level Tokens** → **Generate Token**
   - Name it (e.g., "socket-mode") and add the `connections:write` scope
   - Save this token - it starts with `xapp-`
7. Go to **Install App** → **Install to Workspace** and authorize
8. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
9. Continue to [Get Channel ID](#6-get-channel-id) below

## Manual Setup

If you prefer to configure manually, follow these steps:

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App**
2. Choose **From scratch**
3. Name your app (e.g., "Claude Code") and select your workspace

### 2. Enable Socket Mode

1. Go to **Socket Mode** in the left sidebar
2. Toggle **Enable Socket Mode** to On
3. Create an **App-Level Token** with the `connections:write` scope
4. Save this token - it starts with `xapp-`

### 3. Add Bot Scopes

Go to **OAuth & Permissions** and add these **Bot Token Scopes**:

| Scope | Purpose |
|-------|---------|
| `channels:history` | Read messages in channels |
| `channels:read` | View basic channel info |
| `chat:write` | Send messages |
| `files:read` | Read file uploads (for image attachments) |
| `pins:read` | Read pinned messages |
| `pins:write` | Pin/unpin messages |
| `reactions:read` | Read emoji reactions |
| `reactions:write` | Add emoji reactions |
| `users:read` | View users and their info |

### 4. Enable Events

1. Go to **Event Subscriptions**
2. Toggle **Enable Events** to On
3. Under **Subscribe to bot events**, add:
   - `message.channels` - Messages in public channels
   - `reaction_added` - Reaction added to messages
   - `reaction_removed` - Reaction removed from messages

### 5. Install to Workspace

1. Go to **Install App**
2. Click **Install to Workspace** and authorize
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)

## 6. Get Channel ID

1. In Slack, right-click the channel name → **View channel details**
2. At the bottom, copy the **Channel ID** (starts with `C`)

## 7. Add Bot to Channel

In Slack, type `/invite @YourBotName` in the channel, or click channel name → **Integrations** → **Add apps**

## Configuration

Add to your `~/.config/claude-threads/config.yaml`:

```yaml
platforms:
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

| Setting | Description |
|---------|-------------|
| `botToken` | Bot User OAuth Token (`xoxb-...`) |
| `appToken` | App-Level Token for Socket Mode (`xapp-...`) |
| `channelId` | Channel ID (e.g., `C0123456789`) |
| `botName` | Mention name (default: `claude`) |
| `allowedUsers` | List of Slack usernames |
| `skipPermissions` | Auto-approve actions (`true`/`false`) |

## Troubleshooting

**"not_authed" or "invalid_auth" errors:**
- Verify `botToken` starts with `xoxb-`
- Verify `appToken` starts with `xapp-`
- Make sure the app is installed to your workspace

**Bot not responding to messages:**
- Check that Socket Mode is enabled
- Verify `message.channels` event is subscribed
- Make sure bot is invited to the channel
- Check that username is in `allowedUsers`

**Reactions not working:**
- Verify `reactions:read` and `reactions:write` scopes are added
- Check that `reaction_added` event is subscribed
