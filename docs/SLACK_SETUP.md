# Slack Setup Guide

> **📖 This guide has been superseded by the comprehensive [Setup Guide](../SETUP_GUIDE.md).**
>
> **For detailed Slack setup instructions, see:**
> **[SETUP_GUIDE.md#slack-setup](../SETUP_GUIDE.md#slack-setup)**

---

## Quick Reference

The new setup guide includes:

- ✅ **Quick setup with app manifest** ([slack-app-manifest.yaml](slack-app-manifest.yaml))
- ✅ Manual setup instructions
- ✅ Required OAuth scopes with explanations
- ✅ Socket Mode configuration
- ✅ Event subscription setup
- ✅ Channel ID discovery
- ✅ Credential validation during onboarding
- ✅ Platform-specific troubleshooting

**Start here:** [SETUP_GUIDE.md → Slack Setup](../SETUP_GUIDE.md#slack-setup)

---

## App Manifest Quick Setup

**Fastest way to get started:**

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create New App → **From an app manifest**
3. Paste [`slack-app-manifest.yaml`](slack-app-manifest.yaml)
4. Generate App-Level Token (Socket Mode)
5. Install to workspace and copy tokens

The manifest automatically configures all required scopes and events.

**Full details:** [SETUP_GUIDE.md#slack-setup](../SETUP_GUIDE.md#slack-setup)

---

## Required OAuth Scopes

If setting up manually, you need these scopes:

- `channels:history` - Read messages
- `channels:read` - View channel info
- `chat:write` - Send messages
- `files:read` - Read file uploads
- `reactions:read` / `reactions:write` - Handle reactions
- `users:read` - View user info

**Full setup steps:** [See the complete guide](../SETUP_GUIDE.md#slack-setup)
