# Mattermost Claude Code Bridge

Share your Claude Code sessions live in a public Mattermost channel. Your colleagues can watch you work with Claude Code in real-time, and authorized users can even trigger sessions from Mattermost.

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                     Your Local Machine                          │
│  ┌─────────────────┐         ┌─────────────────────────────┐   │
│  │ Claude Code CLI │◄───────►│ This service                │   │
│  │ (subprocess)    │ stdio   │ (Node.js)                   │   │
│  └─────────────────┘         └──────────┬──────────────────┘   │
└─────────────────────────────────────────┼───────────────────────┘
                                          │ WebSocket + REST API
                                          ▼ (outbound only!)
┌─────────────────────────────────────────────────────────────────┐
│                     Mattermost Server                           │
│  ┌─────────────────┐         ┌─────────────────────────────┐   │
│  │ Bot Account     │         │ Public Channel              │   │
│  │ @claude-code    │◄───────►│ #claude-code-sessions       │   │
│  └─────────────────┘         └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

This runs entirely on your local machine - it only makes **outbound** connections to Mattermost. No port forwarding or public IP needed!

## Prerequisites

1. **Claude Code CLI** installed and authenticated (`claude --version`)
2. **Node.js 18+**
3. **Mattermost bot account** with personal access token (ask your admin)

## Setup

1. Clone/copy this project
2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy the example env file and configure it:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your Mattermost details:
   ```env
   MATTERMOST_URL=https://your-mattermost.com
   MATTERMOST_TOKEN=your-bot-token
   MATTERMOST_CHANNEL_ID=your-channel-id
   MATTERMOST_BOT_NAME=claude-code

   ALLOWED_USERS=anne.schuth,colleague1

   DEFAULT_WORKING_DIR=/path/to/your/project
   ```

## Running

Development mode (hot reload):
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Usage

In your Mattermost channel, mention the bot to start a session:

```
@claude-code help me fix the bug in src/auth.ts
```

The bot will:
1. Post a session start message
2. Stream Claude Code's responses in real-time
3. Show tool activity (file reads, edits, bash commands)
4. Post a session end message when complete

## Access Control

- **ALLOWED_USERS**: Comma-separated list of Mattermost usernames that can trigger Claude Code
- If empty, anyone in the channel can use the bot (be careful!)
- Non-authorized users get a polite rejection message

## Message to your Mattermost admin

> "Kun je een bot account voor me aanmaken om Claude Code sessies te delen in een publiek kanaal?
> Ik heb nodig: een bot account met posting rechten, een personal access token, en de bot toegevoegd aan [kanaal naam]."

Or in English:

> "Could you create a bot account for me to share Claude Code sessions in a public channel?
> I need: bot account with posting permissions, a personal access token, and the bot added to [channel name]."

## License

MIT
