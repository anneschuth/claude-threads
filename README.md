# Mattermost Claude Code Bridge

[![npm version](https://img.shields.io/npm/v/mattermost-claude-code.svg)](https://www.npmjs.com/package/mattermost-claude-code)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

## Installation

### Option 1: npm (recommended)
```bash
npm install -g mattermost-claude-code
```

### Option 2: From source
```bash
git clone https://github.com/anneschuth/mattermost-claude-code.git
cd mattermost-claude-code
npm install
npm run build
npm link
```

## Configuration

Create a config file at `~/.config/mm-claude/.env`:

```bash
mkdir -p ~/.config/mm-claude
cp .env.example ~/.config/mm-claude/.env
```

Edit the config with your Mattermost details:
   ```env
   MATTERMOST_URL=https://your-mattermost.com
   MATTERMOST_TOKEN=your-bot-token
   MATTERMOST_CHANNEL_ID=your-channel-id
   MATTERMOST_BOT_NAME=claude-code

   ALLOWED_USERS=anne.schuth,colleague1

   DEFAULT_WORKING_DIR=/path/to/your/project
   ```

## Running

Navigate to your project directory and run:
```bash
cd /your/project
mm-claude
```

With debug output:
```bash
mm-claude --debug
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

## Interactive Features

### Typing Indicator
While Claude is thinking or working, you'll see the "is typing..." indicator in Mattermost.

### Plan Mode Approval
When Claude enters plan mode and is ready to implement:
- Bot posts an approval message with 👍/👎 reactions
- React with 👍 to approve and start building
- React with 👎 to request changes
- Once approved, subsequent plan exits auto-continue

### Questions with Emoji Reactions
When Claude needs to ask questions:
- Questions are posted one at a time (sequential flow)
- Each question shows numbered options: 1️⃣ 2️⃣ 3️⃣ 4️⃣
- React with the corresponding emoji to answer
- After all questions are answered, Claude continues

### Task List Display
When Claude creates a todo list (TodoWrite):
- Tasks are shown with status icons: ⬜ pending, 🔄 in progress, ✅ completed
- The task list updates in place as Claude works
- In-progress tasks show the active description

### Subagent Status
When Claude spawns subagents (Task tool):
- Shows subagent type and description
- Updates to ✅ completed when done

### Permission Approval via Reactions
By default, Claude Code requests permission before executing tools. This service forwards these requests to Mattermost:
- Permission requests are posted with 👍/✅/👎 reactions
- 👍 **Allow this** - approve this specific tool use
- ✅ **Allow all** - approve all future tool uses in this session
- 👎 **Deny** - reject this tool use

To skip permission prompts (use with caution):
```bash
mm-claude --dangerously-skip-permissions
# or set in .env:
SKIP_PERMISSIONS=true
```

### Code Diffs and Previews
- **Edit**: Shows actual diff with `-` old lines and `+` new lines
- **Write**: Shows first 6 lines of content with line count
- **Bash**: Shows the command being executed
- **Read**: Shows the file path being read
- **MCP tools**: Shows tool name and server (e.g., `🔌 get-library-docs *(context7)*`)

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
