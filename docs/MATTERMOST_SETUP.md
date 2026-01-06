# Mattermost Setup Guide

This guide covers setting up a Mattermost bot account for claude-threads.

## Create Bot Account

1. Go to **Integrations > Bot Accounts > Add Bot Account**
2. Give it a username (e.g., `claude-code`) and display name
3. Create a **Personal Access Token** for the bot
4. Add the bot to the channel where it should listen

## Required Permissions

The bot needs permissions to:
- Post messages
- Add reactions
- Read channel messages

## Get Channel ID

1. In Mattermost, click the channel name
2. Select **View Info**
3. Copy the Channel ID from the URL or info panel

## Configuration

Add to your `~/.config/claude-threads/config.yaml`:

```yaml
platforms:
  - id: mattermost-main
    type: mattermost
    displayName: Main Team
    url: https://chat.example.com
    token: your-bot-token
    channelId: abc123
    botName: claude-code
    allowedUsers: [alice, bob]
    skipPermissions: false
```

| Setting | Description |
|---------|-------------|
| `url` | Mattermost server URL |
| `token` | Bot access token |
| `channelId` | Channel to listen in |
| `botName` | Mention name (default: `claude-code`) |
| `allowedUsers` | List of usernames who can use the bot |
| `skipPermissions` | Auto-approve actions (`true`/`false`) |
