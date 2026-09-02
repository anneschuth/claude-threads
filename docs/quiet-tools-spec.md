# Tool activity: summary line instead of the stream, details one click away

Upstream discussion: anneschuth/claude-threads#505 (shape proposed in the
2026-09-02 comment; `hidden` was agreed by the maintainer on 2026-08-25).

## What it does

Today every tool Claude uses renders into the reply post as it happens
(`Bash …`, `Read …`, then `↳ ✓ (5s)`), and there is no switch. For a coding
session that is the point; for an assistant-style channel the answer is
buried under the commands that produced it.

Two per-platform settings, beside `sessionHeader` / `stickyMessage` /
`lifecycle`:

```yaml
platforms:
  - id: slack-vvs
    type: slack
    toolActivity: summary     # full (default) | summary | hidden
    toolDetails: file         # thread (default with summary) | file | none
    toolDetailsDir: /home/herder/.claude-threads/tool-details   # file only; this is the default
    toolDetailsUrl: https://agents.vvs-capital.com/tool-details  # file only; no default → no link
```

| `toolActivity` | The reply post |
|---|---|
| `full` | unchanged: every tool inline with its `↳` indicator |
| `summary` | one **live line at the top of the turn's post**, `🔧 12 tools · 40 s`, updated as tools start and finish; `· 1 ❌` appended when a tool failed; with `toolDetails: file` and a URL, the line links to the details page. Claude's text follows as today |
| `hidden` | nothing about tools at all, and no `↳` orphans. What the maintainer agreed to in #505 |

| `toolDetails` | Where the full rendering goes when `toolActivity` is not `full` |
|---|---|
| `thread` | posted as replies **in a thread under the turn's post**, streamed the same way the reply is (edit-in-place, split on length). In a thread-mode session the turn's post is already a thread reply and Slack has no nested threads, so the details land in the same thread after the reply; that is `full` with the tools moved below the answer, and documented as such |
| `file` | appended to `<toolDetailsDir>/<platformId>/<sessionId>/<turn>.html`, one file per turn, plus `index.html` per session listing turns. Serving the directory is the operator's job. With `toolDetailsUrl` the summary line links to `<url>/<platformId>/<sessionId>/<turn>.html` |
| `none` | the summary only |

Default: `full` / `none`, so an existing config behaves exactly as before.
`summary` without `toolDetails` means `thread`. `toolDetails` with `full`
is a config error (`resolve…` throws with the path, like the other
per-platform fields).

Untouched in every mode: permission prompts, plan approvals, questions, task
lists, `send_file`, the bug button, session errors. Those are not tool
rendering; they are interactive or they are failures. A *tool* that fails is
Claude's business and shows only as the `❌` count.

## Why

- Assistant use (#505): replies only, but the receipt stays one click away.
- Our voice desk reads the reply post aloud once it settles; forty tool lines
  in it are forty lines it must not read. `summary` is what makes the post
  the answer.
- `file` over a web server in the daemon: the daemon writes, Caddy (or
  anything) serves, nothing new listens. ⚠️ Tool details contain command
  lines and outputs. The directory must be served **behind auth**; the spec
  says so, the README says so, and the default is no URL.

Considered and dropped: a git commit per tool call (a `Read` has no diff;
forty commits a turn would wreck the repo the agent works in) and a
`!tools` runtime toggle (round 2 if anyone asks; the config is enough to
start).

## How

### Transformer (`src/operations/transformer.ts`)

Tool rendering already produces ops tagged `isToolOutput` (tool_use display,
`server_tool_use`, and the `↳` result indicator). With `toolActivity !== 'full'`
the transformer emits, instead of those ops, a `tool_activity` op:

```ts
{ type: 'tool_activity', kind: 'start', toolUseId, name, display }      // display: the same rendered line
{ type: 'tool_activity', kind: 'end',   toolUseId, ok, elapsedMs, display } // display: the ↳ line
```

Nothing else in the transformer changes; special tools keep their own ops.
A `TransformContext.toolActivity` field carries the mode (default `full`).

### Executors

- **`ToolActivityExecutor`** (new, `src/operations/executors/tool-activity.ts`)
  owns the per-turn counter `{ started, finished, failed, firstStartAt, lastEndAt }`
  and renders the summary line. On each op it asks the content executor to
  re-render the post header (debounced through the existing 500 ms flush).
  The turn ends on the `result` event (existing `flush`/`closeCurrentPost`
  path); the last render is the final line and the counter resets.
- **Content executor**: gains an optional `header` (one line) rendered above
  `currentPostContent` on every flush. The header is part of the post but not
  of `pendingContent`, so splitting and length checks stay as they are (the
  header is short and counted in the combined length).
- **Details sinks** (`src/operations/tool-details/`), one interface:
  `ToolDetailsSink { append(op): void; turnEnded(): Promise<void>; linkFor(turn): string | null }`.
  - `thread`: a second `ContentExecutor` whose context posts with
    `rootId = currentPostId` of the main executor; it streams the `display`
    strings exactly like the reply. It starts lazily on the first tool of a
    turn, after the main post exists (if it does not yet, the first render
    creates it: the summary header alone).
  - `file`: appends escaped `<pre>` blocks to the turn file and rewrites
    `index.html`; deterministic path so the link exists from the first tool.
    Writes are sequential per session and errors propagate to the session
    error path (fail loud; a details file that silently stopped would lie).
  - `none`: no-op.

### Config (`src/config/types.ts`)

`PlatformInstanceConfig.toolActivity?`, `toolDetails?`, `toolDetailsDir?`,
`toolDetailsUrl?`; resolved next to the overhead fields into
`PlatformOverhead.tools: { activity, details, dir, url }` with the same
`resolve…` validation and the same wiring through `src/index.ts` →
`SessionManager` → `TransformContext` / executor options as `lifecycle`
(see `pr/quiet-lifecycle` commit 364c371 for the pattern).

### Delivery

Two PRs so each stands alone:

1. `pr/quiet-tools`: `full | summary | hidden`, `thread | none`, transformer
   op, executors, config, tests. (#505's tool half.)
2. `pr/quiet-tools-file` stacked on it: the `file` sink and `toolDetailsUrl`.

VVS runs `summary` + `file` behind Caddy with auth on
`agents.vvs-capital.com/tool-details/`.

## Tests (first)

- transformer: each mode × (tool_use, server_tool_use, tool_result ok/error,
  special tool) → which ops come out; `hidden` leaves no `toolStartTimes`
  entry (no orphan `↳`).
- ToolActivityExecutor: counter and line text through start/end/error/turn
  end; the line with and without a link.
- content executor: header rendered above content, survives a split, counted
  in length checks.
- thread sink: posts under the main post's id, lazy start, thread-mode
  degrade.
- file sink: path, escaping, index rewrite, write error propagates.
- config: defaults, `summary` implies `thread`, `toolDetails` with `full`
  rejected with the config path in the message.

## Decisions

| Decision | Why |
|---|---|
| Two fields, not one enum | what to show and where to keep the rest are independent; `summary+file` and `hidden+file` are both real |
| Summary line at the top of the post, not the bottom | it is the receipt for the whole turn and must not move as text streams in |
| Details as a second content executor | the streaming, splitting and rate behaviour already exist there; a new poster would reimplement them badly |
| `file` writes HTML, not markdown | the point is a browser; markdown in a browser is raw text |
| No HTTP server in the daemon | one more listener, auth, TLS; the operator already has a web server |

## Open

- Q-001: does the summary line also name the last tool (`· Bash`)? Asked in
  #505. Default: count and time only.

## Lessons learned

(none yet)
