# Slack Integration Test Plan

Manual test plan for verifying Slack platform support against a real Slack workspace.

## Prerequisites

- [ ] Slack App created with required scopes (see README)
- [ ] Socket Mode enabled with `connections:write` scope
- [ ] Bot installed to workspace
- [ ] Bot invited to test channel (`/invite @botname`)
- [ ] `config.yaml` configured with Slack platform

## 1. Connection & Startup

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 1.1 Bot connects | Run `bun start` | "Connected to Slack" in logs, no errors |
| 1.2 Socket Mode | Check logs | "Socket Mode WebSocket connected" message |
| 1.3 Bot user identified | Check logs | Bot user ID retrieved via `auth.test` |
| 1.4 Sticky message | Check channel | Pinned status message appears |

## 2. Session Lifecycle

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 2.1 Start session | `@botname hello` | Thread created, Claude responds |
| 2.2 Continue session | Reply in thread | Claude continues conversation |
| 2.3 Session header | Check thread | Shows working dir, model, permissions mode |
| 2.4 End session | Wait for "Bye!" or `!stop` | Session ends, goodbye message posted |
| 2.5 Session timeout | Leave idle 30min | Auto-cleanup message appears |

## 3. Commands

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 3.1 `!help` | Type `!help` in thread | Help message with all commands |
| 3.2 `!stop` | Type `!stop` | Session terminates immediately |
| 3.3 `!escape` | Type `!escape` during response | Interrupts without killing session |
| 3.4 `!cd /path` | Type `!cd /tmp` | Working directory changes, Claude restarts |
| 3.5 `!permissions` | Type `!permissions` | Shows current permission mode |
| 3.6 `!permissions interactive` | Type command | Enables interactive permissions |
| 3.7 `!permissions skip` | Type command | Disables permission prompts |
| 3.8 `!kill` | Type `!kill` | All sessions terminate, bot exits |

## 4. Reactions

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 4.1 Cancel (❌) | React with ❌ to bot message | Session terminates |
| 4.2 Cancel (🛑) | React with 🛑 | Session terminates |
| 4.3 Interrupt (⏸️) | React with ⏸️ during response | Response interrupted, session continues |

## 5. Multi-User Collaboration

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 5.1 `!invite @user` | Invite another user | User added to session allowlist |
| 5.2 Invited user messages | Invited user sends message | Message processed by Claude |
| 5.3 `!kick @user` | Kick invited user | User removed from session |
| 5.4 Unauthorized user | Non-allowed user messages | Message approval prompt appears |
| 5.5 Approve message | React 👍 to approval prompt | Message sent to Claude |
| 5.6 Deny message | React 👎 to approval prompt | Message rejected |

## 6. Permission System (Interactive Mode)

**Setup:** Enable with `!permissions interactive`

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 6.1 Permission prompt | Ask Claude to write a file | Permission prompt with 👍 ✅ 👎 reactions |
| 6.2 Approve (👍) | React 👍 | Action proceeds |
| 6.3 Approve all (✅) | React ✅ | Action proceeds, future similar actions auto-approved |
| 6.4 Deny (👎) | React 👎 | Action denied, Claude informed |
| 6.5 Timeout | Don't react for 5 min | Permission denied due to timeout |
| 6.6 Wrong user reacts | Non-allowed user reacts | Reaction ignored |

## 7. Plan Approval

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 7.1 Plan presented | Ask Claude for multi-step task | Plan message with 👍 👎 reactions |
| 7.2 Approve plan | React 👍 | Claude proceeds with plan |
| 7.3 Reject plan | React 👎 | Claude asks for alternative |

## 8. Question Answering

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 8.1 Questions presented | Claude asks clarifying question | Options with 1️⃣ 2️⃣ 3️⃣ etc. reactions |
| 8.2 Select option | React with number emoji | Claude proceeds with selected option |

## 9. Context Prompt (Mid-Thread Start)

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 9.1 Start mid-thread | Post messages, then @mention bot | "Include thread context?" prompt |
| 9.2 Accept context | React 👍 | Claude sees previous messages |
| 9.3 Decline context | React 👎 | Claude starts fresh |

## 10. Formatting & Display

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 10.1 Bold text | Claude outputs bold | Displays as *bold* |
| 10.2 Code blocks | Claude outputs code | Proper code block formatting |
| 10.3 User mentions | Claude mentions user | Shows as clickable @mention |
| 10.4 Links | Claude outputs URL | Clickable link |
| 10.5 Long messages | Claude outputs >16KB | Split across multiple messages |

## 11. Task List

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 11.1 Task list appears | Ask for multi-step task | Task list message created |
| 11.2 Tasks update | Claude works on tasks | Task statuses update (⏳ → ✅) |
| 11.3 Task completion | All tasks done | All tasks show ✅ |

## 12. Error Handling

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 12.1 Invalid command | Type `!invalid` | Helpful error message |
| 12.2 Network disconnect | Disconnect network briefly | Auto-reconnect with backoff |
| 12.3 Rate limiting | Spam messages rapidly | Graceful handling, no crashes |

## 13. Session Persistence

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 13.1 Bot restart | Restart bot during session | Session resumes in same thread |
| 13.2 Resume message | Check thread after restart | "Session resumed" message |
| 13.3 Continue after resume | Send message | Claude responds with context |

## 14. Slack-Specific Features

| Test | Steps | Expected Result |
|------|-------|-----------------|
| 14.1 Thread isolation | Start sessions in different threads | Each thread has independent session |
| 14.2 Emoji names | Check reaction handling | Works with Slack emoji names (no colons) |
| 14.3 User lookup | Check @mentions in responses | Shows real usernames, not IDs |

## Test Results

| Section | Pass | Fail | Notes |
|---------|------|------|-------|
| 1. Connection | | | |
| 2. Lifecycle | | | |
| 3. Commands | | | |
| 4. Reactions | | | |
| 5. Multi-User | | | |
| 6. Permissions | | | |
| 7. Plan Approval | | | |
| 8. Questions | | | |
| 9. Context Prompt | | | |
| 10. Formatting | | | |
| 11. Task List | | | |
| 12. Error Handling | | | |
| 13. Persistence | | | |
| 14. Slack-Specific | | | |

**Tested By:** _______________
**Date:** _______________
**Slack Workspace:** _______________
**Bot Version:** _______________
