# Claude Threads

```
 ✴ ▄█▀ ███ ✴   claude-threads
✴  █▀   █   ✴  Mattermost & Slack × Claude Code
 ✴ ▀█▄  █  ✴
```

<p align="center">
  <a href="https://claude-threads.run"><strong>claude-threads.run</strong></a>
</p>

[![npm version](https://img.shields.io/npm/v/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![npm downloads](https://img.shields.io/npm/dm/claude-threads.svg)](https://www.npmjs.com/package/claude-threads)
[![CI](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml/badge.svg)](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/anneschuth/4951f9235658e276208942986092e5ab/raw/coverage-badge.json)](https://github.com/anneschuth/claude-threads/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/anneschuth/claude-threads/pulls)

**Bring Claude Code to your team.** Run Claude Code on your machine, share it live in Mattermost or Slack. Colleagues can watch, collaborate, and run their own sessions—all from chat.

> *Think of it as screen-sharing for AI pair programming, but everyone can type.*

## Features

- **Real-time streaming** - Claude's responses stream live to chat
- **Multi-platform** - Connect to multiple Mattermost and Slack workspaces
- **Concurrent sessions** - Each thread gets its own Claude session
- **Session persistence** - Sessions survive bot restarts
- **Collaboration** - Invite others to participate in your session
- **Interactive permissions** - Approve Claude's actions via emoji reactions
- **Git worktrees** - Isolate changes in separate branches
- **File attachments** - Attach images, PDFs, and files for Claude to analyze
- **Chrome automation** - Control Chrome browser for web tasks

## Quick Start

### Install & Run

```bash
# Install (pick one)
bun install -g claude-threads   # with Bun (recommended)
npm install -g claude-threads   # with Node

# Run the setup wizard
cd /your/project
claude-threads
```

The **interactive setup wizard** will guide you through everything:
- Configure Claude Code CLI (if needed)
- Set up your Mattermost or Slack bot
- Test credentials and permissions
- Get you up and running in minutes

**Need help with platform setup?** See the [Setup Guide](SETUP_GUIDE.md) for Mattermost or Slack bot creation.

### Prerequisites

- **Bun** or **Node 18+** - [Install Bun](https://bun.sh/) or [Install Node](https://nodejs.org/)
- **Claude Code CLI working** - test with `claude --version` (needs API key or subscription)

### Use

Mention the bot in your chat:

```
@claude help me fix the bug in src/auth.ts
```

## Session Commands

Type `!help` in any session thread:

| Command | Description |
|:--------|:------------|
| `!help` | Show available commands |
| `!context` | Show context usage |
| `!cost` | Show token usage and cost |
| `!compact` | Compress context to free up space |
| `!cd <path>` | Change working directory |
| `!worktree <branch>` | Create and switch to a git worktree |
| `!invite @user` | Invite a user to this session |
| `!kick @user` | Remove an invited user |
| `!bug <desc>` | Report a bug with context |
| `!escape` | Interrupt current task |
| `!stop` | Stop this session |

## Interactive Controls

**Permission approval** - When Claude wants to execute a tool:
- 👍 Allow this action
- ✅ Allow all future actions
- 👎 Deny

**Plan approval** - When Claude creates a plan:
- 👍 Approve and start
- 👎 Request changes

**Questions** - React with 1️⃣ 2️⃣ 3️⃣ 4️⃣ to answer multiple choice

**Cancel session** - Type `!stop` or react with ❌

## File Attachments

Attach files to your messages for Claude to analyze:

| Type | Formats | Max Size |
|:-----|:--------|:---------|
| Images | JPEG, PNG, GIF, WebP | - |
| Documents | PDF | 32 MB |
| Text | .txt, .md, .json, .csv, .xml, .yaml, source code | 1 MB |
| Archives | .zip (auto-extracted, max 20 files) | 50 MB |
| Compressed | .gz (auto-decompressed) | - |

## Collaboration

```
!invite @colleague    # Let them participate
!kick @colleague      # Remove access
```

Unauthorized users can request message approval from the session owner.

## Git Worktrees

Keep your main branch clean while Claude works on features:

```
@claude on branch feature/add-auth implement user authentication
```

Or mid-session: `!worktree feature/add-auth`

## Access Control

Restrict who can use the bot during setup (or reconfigure later with `claude-threads --setup`).

Leave the allowed users list empty to let anyone in the channel use the bot (be careful!)

## Documentation

- **[Setup Guide](SETUP_GUIDE.md)** - Step-by-step setup for Mattermost and Slack
- **[Configuration Reference](CLAUDE.md)** - Technical details and architecture

## Updates

```bash
npm install -g claude-threads
```

The bot checks for updates automatically and notifies you when new versions are available.

## License

Apache-2.0
