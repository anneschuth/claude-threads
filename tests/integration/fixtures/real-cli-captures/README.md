# Real Claude CLI reference captures

Verbatim stream-json event streams recorded from the **real** Claude CLI
(2.1.251 — each file's `_meta` line records its exact version), one
JSONL file per flow. Each file starts with a `_meta` line
recording the CLI version, argv, and the prompts that drove the flow.

**Dialect drift found in the 2.1.251 re-capture** (vs 2.1.225–2.1.226), all
verified benign for the bot:

- New top-level `autocompact_state` event (context-window/threshold info) —
  hits the transformer's default case, ignored.
- New `system` subtype `task_summary` (a short label for the turn) — falls
  through the events handler's explicit subtype checks, ignored.
- The post-compact `user` events echoing the continuation summary and
  `<local-command-stdout>Compacted</local-command-stdout>` are no longer
  emitted; the bot never consumed them (compaction posts ride
  `system/status` + `compact_boundary`, unchanged).

The mock does not emit the two new shapes — they are optional noise the bot
ignores, and the mock's job is the surface the bot *consumes*.

Note for re-capturing on a root sandbox: the CLI refuses
`--dangerously-skip-permissions` as root; run the capture with
`IS_SANDBOX=1` in the environment.

These captures are the **ground truth** for the integration mock CLI
(`../mock-claude/runner.ts`): every event shape the mock emits was written
against them. When the mock and a capture disagree, the capture wins — fix
the mock.

## Re-verified against 2.1.263 (2026-09-06)

All flows were re-captured with 2.1.263 on a developer machine and compared
structurally against the files here: event type and subtype sequence,
content-block types, tool names, top-level keys. Every shape the bot consumes
held: the bridge round trips ("User has approved your plan", "Your questions
have been answered"), the deny shapes, `compact_boundary` with
`compact_metadata` after a successful compact and its absence after a failed
one, `error_max_turns`, `aborted_streaming` on SIGINT, TaskCreate ids
resolving through the result text, and `parent_tool_use_id` on subagent
sidechain events. The manual decision-bridge e2e passed on the same version.

The files were deliberately not replaced. The differences that did show up
are environmental, not dialect. The same three flows captured with 2.1.251
and 2.1.263 on that machine were identical to each other, and both differed
from the committed files in ways that follow from the recording environment:
`thinking` blocks and `system/thinking_tokens` come and go with the account's
thinking setting; `active_goal`, `post_turn_summary`, `commands_changed`,
`task_summary` and `autocompact_state` are noise the bot ignores; `system/init`
lists every claude.ai connector the recording account has attached, which does
not belong in a public fixture. `startup_timing` left `system/init` and
`memory_paths` arrived; `result` traded `time_origin_ms`,
`time_to_request_from_spawn_ms` and `warm_spare_claimed` for
`first_content_frame_ms`. The bot reads none of those keys.

Two things to know before the next re-capture:

- Tool schemas are deferred. `ToolSearch` is in the tool list and `Agent`,
  `ExitPlanMode` and `AskUserQuestion` are not, so a prompt has to name the
  tool precisely. The subagent flow now says "Agent tool"; the old "Task tool"
  wording sent haiku to `TaskCreate` and produced a capture without a subagent.
- Record on an account without claude.ai connectors, or expect their tool
  names in `system/init`.

## Flows

| Capture | What it proves |
|---------|----------------|
| `simple-text-multi-turn` | The CLI emits a `result` per turn and **stays alive** for the next user message; `system/init` re-emitted per turn |
| `tool-use-write` | Tool results arrive as `tool_result` blocks inside `user` events (never as top-level `tool_result` events) |
| `tool-use-error` | `is_error: true` tool_result shape |
| `tasks` | Task tracking is TaskCreate/TaskUpdate (never TodoWrite); a task's id resolves only through the "Task #N created successfully" result text |
| `plan-approval-bridge` | ExitPlanMode blocks on the MCP permission prompt; approval arrives as the "User has approved your plan" tool result plus a `system/status` mode-transition event |
| `plan-denied-bridge` | The denial shape for a rejected plan |
| `question-bridge` | AskUserQuestion blocks on the permission prompt; answers ride back via `updatedInput` and surface as "Your questions have been answered: …" |
| `permission-write-denied` | The **deny** shape of an ordinary Write gated through the MCP permission prompt (ordinary tools don't ride the bridge; without a platform the server denies). The approve path's tool_result shape is covered by `tool-use-write` and exercised end-to-end by the integration suite |
| `plan-bypass` / `question-bypass` | Under `--dangerously-skip-permissions` the CLI does not expose ExitPlanMode or AskUserQuestion **at all** |
| `subagent` | Task-tool sidechain events carry `parent_tool_use_id` |
| `compact` | Manual `/compact`: `system/status` `"compacting"` → `compact_result: "success"` → `system/compact_boundary` with `compact_metadata` (pre/post tokens) |
| `compact-failed` | A **failed** compact emits no boundary — only `compact_result: "failed"` + `compact_error` ("Not enough messages to compact.") |
| `error-max-turns` | `subtype: error_max_turns`, `terminal_reason: max_turns` result shape |
| `interrupt` | SIGINT mid-turn: in-flight tools get rejected tool_results, then an `error_during_execution` result with `terminal_reason: aborted_streaming`, then the process **exits** |
| `resume-seed` / `resume` | `--session-id` / `--resume` round trip: the resumed process recalls prior context |

## Re-capturing

When a new CLI version ships (or a shape looks stale):

```bash
bun run build   # bridge flows run the real dist/mcp/mcp-server.js
bun tests/e2e-real-cli/capture-events.ts            # all flows
bun tests/e2e-real-cli/capture-events.ts tasks      # one flow
```

Manual tool — needs live Claude credentials and spends tokens; never run in
CI. Diff the fresh captures against these, update the mock for any shape
change, and commit both together.
