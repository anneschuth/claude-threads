# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately:

1. **Do not** open a public issue
2. Email the maintainer or use GitHub's private vulnerability reporting
3. Include steps to reproduce the issue
4. Allow reasonable time for a fix before public disclosure

## Supported Versions

Only the latest version receives security updates.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

---

# Authorization Model

This section documents the authorization and security model for claude-threads.

## Authorization Layers

Claude-threads uses a multi-layer authorization model:

1. **Platform-level** (`allowedUsers` in config)
   - Defines who can start new sessions and use the `!kill` command
   - Checked via `client.isUserAllowed(username)`

2. **Session-level** (`sessionAllowedUsers` per session)
   - Defines who can participate in a specific session
   - Includes the session owner + invited users
   - Checked via `session.sessionAllowedUsers.has(username)`

3. **Role-based** (session owner vs. invited users)
   - Some actions require session ownership (owner or globally allowed)
   - Enforced via `requireSessionOwner()` in commands

## Authorization Matrix

| Action                     | Session Owner | Invited User | Global Allowed | Unauthorized    |
|----------------------------|---------------|--------------|----------------|-----------------|
| Start new session          | N/A           | N/A          | Yes            | No              |
| Send message to session    | Yes           | Yes          | Yes            | Needs approval  |
| Resume paused session      | Yes           | Yes          | Yes            | No              |
| `!cd` change directory     | Yes           | No           | Yes            | No              |
| `!invite` user             | Yes           | No           | Yes            | No              |
| `!kick` user               | Yes           | No           | Yes            | No              |
| `!permissions` interactive | Yes           | No           | Yes            | No              |
| `!worktree` management     | Yes           | No           | Yes            | No              |
| `!update` force/defer      | Yes           | No           | Yes            | No              |
| `!kill` emergency shutdown | N/A           | N/A          | Yes            | No              |
| Answer question (reaction) | Yes           | Yes          | Yes            | No              |
| Approve plan (reaction)    | Yes           | Yes          | Yes            | No              |
| Cancel session (reaction)  | Yes           | Yes          | Yes            | No              |
| Interrupt session (reaction)| Yes          | Yes          | Yes            | No              |
| Toggle task list           | Yes           | Yes          | Yes            | No              |

## Key Security Files

### Entry Points

- **`src/message-handler.ts`** - Entry point for all messages
  - Lines 61-64: `!kill` requires `client.isUserAllowed()`
  - Lines 110-115: Commands require `session.isUserAllowedInSession()`
  - Lines 256-260: Unauthorized users get message approval flow

### Session Management

- **`src/session/manager.ts:417-422`** - Reaction authorization (primary gate)
  - **All reactions are validated here** before reaching MessageManager/executors
  - Both `sessionAllowedUsers` and `platform.isUserAllowed()` checked
  - Unauthorized reactions are silently dropped

### Command Handlers

- **`src/operations/commands/handler.ts`** - Command authorization
  - `requireSessionOwner()` function enforces ownership for sensitive commands
  - Applied to: `changeDirectory()`, `inviteUser()`, `kickUser()`, `enableInteractivePermissions()`

### Executors

- **`src/operations/executors/message-approval.ts`** - Handles unauthorized message approval
  - Validates user before allowing message to be sent

## Message Approval Flow

When an unauthorized user sends a message to an active session:

1. Message is intercepted before reaching Claude CLI
2. Approval request posted with reaction options: Allow once / Invite / Deny
3. Session owner or allowed user must react to approve
4. Only after approval is the message forwarded to Claude

## Permission System (MCP)

The Claude CLI permission system works via MCP (Model Context Protocol):

1. MCP server spawned per session with platform credentials
2. When Claude needs permission (file write, etc.), MCP server posts to chat
3. Users react to approve/deny
4. MCP server validates reacting user is in allowed list
5. Permission response returned to Claude CLI

## Security Principles

1. **Defense in Depth** - Multiple authorization checks at different layers
2. **Principle of Least Privilege** - Invited users have fewer permissions than owners
3. **Fail Closed** - Unknown users are rejected by default
4. **Audit Trail** - All authorization decisions are logged
