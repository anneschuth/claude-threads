import { ChildProcess } from 'child_process';
import { crossSpawn } from '../utils/spawn.js';
import { EventEmitter } from 'events';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, watchFile, unwatchFile, unlinkSync, statSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { getClaudePath } from './version-check.js';
import { detectRateLimit, cooldownDeadline } from './rate-limit-detector.js';
import type { PermissionMode } from '../config/types.js';

const log = createLogger('claude');

// Re-export so consumers (SessionManager) can import without digging into
// the detector module directly.
export type { RateLimitHit } from './rate-limit-detector.js';

/**
 * Clean up stale Claude browser bridge socket files.
 *
 * Claude CLI creates socket files named `claude-mcp-browser-bridge-{username}` in the temp directory.
 * If these socket files exist when Claude starts, it tries to fs.watch() them which fails with
 * EOPNOTSUPP because you can't watch socket files. This is a Claude CLI bug.
 *
 * Workaround: Remove any stale browser bridge socket files before starting Claude.
 */
function cleanupBrowserBridgeSockets(): void {
  try {
    const tempDir = tmpdir();
    const files = readdirSync(tempDir);

    for (const file of files) {
      if (file.startsWith('claude-mcp-browser-bridge-')) {
        const filePath = join(tempDir, file);
        try {
          const stats = statSync(filePath);
          // Check if it's a socket file (mode & 0xF000 === 0xC000 for sockets)
          if (stats.isSocket()) {
            unlinkSync(filePath);
            log.debug(`Removed stale browser bridge socket: ${file}`);
          }
        } catch {
          // Ignore errors for individual files
        }
      }
    }
  } catch (err) {
    // Don't fail startup if cleanup fails
    log.debug(`Browser bridge cleanup failed: ${err}`);
  }
}

/**
 * Context window usage data from status line
 */
export interface StatusLineData {
  context_window_size: number;
  total_input_tokens: number;
  total_output_tokens: number;
  current_usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null;
  model: {
    id: string;
    display_name: string;
  } | null;
  cost: {
    total_cost_usd: number;
  } | null;
  timestamp: number;
}

export interface ClaudeEvent {
  type: string;
  [key: string]: unknown;
}

export interface PlatformMcpConfig {
  type: string;
  url: string;
  token: string;
  channelId: string;
  allowedUsers: string[];
  /** App-level token for Slack Socket Mode (only needed for Slack) */
  appToken?: string;
  /**
   * Outbound `send_file` settings, surfaced from the platform-instance
   * config. When omitted the bot defaults to enabled with 100MB cap.
   */
  outboundFiles?: { enabled?: boolean; maxBytes?: number };
}

export interface ClaudeCliOptions {
  workingDir: string;
  threadId?: string;  // Thread ID for permission requests
  /**
   * How tool-use permissions are enforced.
   *
   * - `'default'`: MCP permission server posts prompts; user reacts to approve.
   * - `'auto'`: Claude's classifier decides per-tool; high-risk tools still prompt
   *   via the MCP server (so `platformConfig` is still required).
   * - `'bypass'`: pass `--dangerously-skip-permissions`; no MCP server spawned.
   *
   * Defaults to `'default'` when omitted.
   */
  permissionMode?: PermissionMode;
  sessionId?: string;  // Claude session ID (UUID) for --session-id or --resume
  resume?: boolean;    // If true, use --resume instead of --session-id
  chrome?: boolean;    // If true, enable Chrome integration with --chrome
  platformConfig?: PlatformMcpConfig;  // Platform-specific config for MCP server
  appendSystemPrompt?: string;  // Additional system prompt to append
  logSessionId?: string;  // Session ID for log routing (platformId:threadId)
  permissionTimeoutMs?: number;  // Timeout for permission approval (default: 120000)
  /**
   * Optional Claude account to spawn under. When set, `HOME` (for OAuth) or
   * `ANTHROPIC_API_KEY` (for API-billed) in the child env is overridden so
   * Claude uses that account's credentials. When omitted, the child inherits
   * `process.env` — single-account mode, identical to prior behavior.
   */
  account?: ClaudeCliAccount;
  /**
   * Per-session upload directory for `send_file` MCP tool to validate
   * outbound paths against. Same value as getSessionUploadDir(platformId,
   * threadId).
   */
  uploadDir?: string;
  /** Outbound file (`send_file`) settings — undefined uses defaults. */
  outboundFiles?: { enabled?: boolean; maxBytes?: number };
}

/** Minimal subset of ClaudeAccount that `ClaudeCli` needs. */
export interface ClaudeCliAccount {
  id: string;
  home?: string;
  apiKey?: string;
}

/**
 * Assemble the env that Claude CLI will spawn with. Pure function so it can be
 * unit-tested without instantiating the class. See `ClaudeCli.buildChildEnv`
 * for the behavior contract — this function implements it.
 */
export function buildClaudeChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  account?: ClaudeCliAccount
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parentEnv };

  // Always-on tuning flags (opt-out by setting them in the parent env).
  if (env.MCP_CONNECTION_NONBLOCKING === undefined) {
    env.MCP_CONNECTION_NONBLOCKING = 'true';
  }
  if (env.ENABLE_PROMPT_CACHING_1H === undefined) {
    env.ENABLE_PROMPT_CACHING_1H = 'true';
  }

  if (account?.home) {
    env.HOME = account.home;
    env.USERPROFILE = account.home;
    // OAuth lives under HOME, so clear env vars that would otherwise beat
    // the file-based credentials we're pointing at: an inherited API key
    // or OAuth token from the bot's own parent env would silently swap the
    // account we thought we were using.
    delete env.ANTHROPIC_API_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else if (account?.apiKey) {
    env.ANTHROPIC_API_KEY = account.apiKey;
    // Clear an inherited OAuth token so API key billing wins.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  return env;
}

/**
 * True when a Claude `result` event carries an error payload. Gates the
 * rate-limit scanner so assistant text in successful turns (which can legally
 * contain phrases like "rate_limit_error" when the user asks about them) can't
 * poison the account cooldown logic.
 *
 * Error subtypes from Claude CLI include `error_during_execution`,
 * `error_max_turns`, and other `error_*` values. Payloads that set
 * `is_error: true` are also treated as errors.
 */
function isErrorResultEvent(event: ClaudeEvent): boolean {
  const ev = event as { subtype?: unknown; is_error?: unknown };
  if (typeof ev.subtype === 'string' && ev.subtype.startsWith('error')) return true;
  if (ev.is_error === true) return true;
  return false;
}

/**
 * Shape of an MCP `--mcp-config` blob for the Claude CLI. Exported for tests.
 */
export interface McpConfigBlob {
  mcpServers: Record<string, {
    type: 'stdio';
    command: string;
    args: string[];
    env: Record<string, string>;
  }>;
}

/**
 * Materialize an MCP config for handoff to Claude CLI. Writes it to an
 * owner-only tempfile (mode 0600) and returns the path. The `inline` opt
 * is for tests that want to keep Claude invocation off disk — production
 * always goes via tempfile so the bot's platform token doesn't appear in `ps`.
 *
 * Exported so tests can assert file mode + contents without spawning Claude.
 */
export function materializeMcpConfig(
  config: McpConfigBlob,
  sessionId: string | undefined,
  opts: { inline?: boolean; tmpDirOverride?: string } = {},
): { mode: 'inline'; value: string } | { mode: 'file'; path: string } {
  if (opts.inline) {
    return { mode: 'inline', value: JSON.stringify(config) };
  }
  const dir = opts.tmpDirOverride ?? tmpdir();
  const path = join(dir, `claude-threads-mcp-${sessionId ?? process.pid}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { mode: 'file', path };
}

/**
 * Compute the permission-related CLI arguments for Claude and, when applicable,
 * materialize the MCP config tempfile. Extracted so the three-mode branching
 * is covered by unit tests (spawning the real Claude CLI is not viable).
 *
 * Returns `{ args, tempFile }`. `tempFile` is set only when the MCP config
 * was written to disk (i.e. not inline-mode) and must be cleaned up by the
 * caller on process exit.
 */
export function buildPermissionArgs(opts: {
  permissionMode: PermissionMode;
  mcpServerPath: string;
  platformConfig: PlatformMcpConfig | undefined;
  threadId: string | undefined;
  sessionId: string | undefined;
  permissionTimeoutMs: number;
  debug: boolean;
  /** Session working directory; passed to MCP child as SESSION_WORKING_DIR. */
  workingDir?: string;
  /** Per-session upload directory; passed to MCP child as SESSION_UPLOAD_DIR. */
  uploadDir?: string;
  /** Outbound file (`send_file`) settings. Both fields are optional. */
  outboundFiles?: { enabled?: boolean; maxBytes?: number };
  inline?: boolean; // for tests
}): { args: string[]; tempFile: string | null } {
  const args: string[] = [];
  if (opts.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
    return { args, tempFile: null };
  }

  if (!opts.platformConfig) {
    throw new Error(
      `platformConfig is required when permissionMode is '${opts.permissionMode}'`,
    );
  }

  const mcpEnv: Record<string, string> = {
    PLATFORM_TYPE: opts.platformConfig.type,
    PLATFORM_URL: opts.platformConfig.url,
    PLATFORM_TOKEN: opts.platformConfig.token,
    PLATFORM_CHANNEL_ID: opts.platformConfig.channelId,
    PLATFORM_THREAD_ID: opts.threadId || '',
    ALLOWED_USERS: opts.platformConfig.allowedUsers.join(','),
    DEBUG: opts.debug ? '1' : '',
    PERMISSION_TIMEOUT_MS: String(opts.permissionTimeoutMs),
  };
  if (opts.platformConfig.appToken) {
    mcpEnv.PLATFORM_APP_TOKEN = opts.platformConfig.appToken;
  }
  // Outbound-file env: only emit when at least one root is known. The MCP
  // child enforces the same invariant on the read side.
  if (opts.workingDir) {
    mcpEnv.SESSION_WORKING_DIR = opts.workingDir;
  }
  if (opts.uploadDir) {
    mcpEnv.SESSION_UPLOAD_DIR = opts.uploadDir;
  }
  if (opts.outboundFiles?.enabled === false) {
    mcpEnv.OUTBOUND_FILES_ENABLED = '0';
  }
  if (typeof opts.outboundFiles?.maxBytes === 'number') {
    mcpEnv.OUTBOUND_FILES_MAX_BYTES = String(opts.outboundFiles.maxBytes);
  }

  const mcpConfig: McpConfigBlob = {
    mcpServers: {
      'claude-threads-permissions': {
        type: 'stdio',
        command: 'node',
        args: [opts.mcpServerPath],
        env: mcpEnv,
      },
    },
  };

  const materialized = materializeMcpConfig(mcpConfig, opts.sessionId, { inline: opts.inline });
  let tempFile: string | null = null;
  if (materialized.mode === 'file') {
    tempFile = materialized.path;
    args.push('--mcp-config', materialized.path);
  } else {
    args.push('--mcp-config', materialized.value);
  }
  args.push('--permission-prompt-tool', 'mcp__claude-threads-permissions__permission_prompt');

  if (opts.permissionMode === 'auto') {
    args.push('--permission-mode', 'auto');
  }

  return { args, tempFile };
}

// Per-instance stderr cap (enough to surface the most recent error chain).
const STDERR_PER_INSTANCE_CAP = 10_240; // 10KB
// Process-wide soft cap across all live ClaudeCli instances. Once exceeded,
// individual instances start trimming to 1KB instead of the 10KB default, so
// a runaway fleet cannot push the bot's heap above this. 10MB is generous
// relative to any plausible MAX_SESSIONS (5 default; even 1000 sessions at
// 1KB = 1MB); anything beyond 10MB indicates something is very wrong.
const STDERR_AGGREGATE_SOFT_CAP = 10 * 1024 * 1024; // 10MB
// Tracks the sum of stderr buffer lengths across all ClaudeCli instances.
// Module-private — safe to share: every ClaudeCli runs in the same process.
let totalStderrBytes = 0;

export class ClaudeCli extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: ClaudeCliOptions;
  private buffer = '';
  public debug = process.env.DEBUG === '1' || process.argv.includes('--debug');
  private statusFilePath: string | null = null;
  private lastStatusData: StatusLineData | null = null;
  private stderrBuffer = '';  // Capture stderr for error detection
  private mcpConfigTempFile: string | null = null;  // Set when MCP config is passed via tempfile (default)
  // Deadline of the last rate-limit hit we emitted. Zero means we haven't
  // emitted one yet. Used to dedupe repeated hits at the same severity while
  // still letting a LATER deadline through — see maybeEmitRateLimit().
  private lastEmittedRateLimitDeadline = 0;
  private log: ReturnType<typeof createLogger>;  // Session-scoped logger

  constructor(options: ClaudeCliOptions) {
    super();
    this.options = options;
    // Create session-scoped logger if logSessionId provided
    this.log = options.logSessionId
      ? createLogger('claude').forSession(options.logSessionId)
      : createLogger('claude');
  }

  /**
   * Get the path to the status line data file for this session.
   */
  getStatusFilePath(): string | null {
    return this.statusFilePath;
  }

  /**
   * Get the latest status line data (context usage, model, cost).
   * Returns null if no data has been received yet.
   */
  getStatusData(): StatusLineData | null {
    if (!this.statusFilePath) return null;

    try {
      if (existsSync(this.statusFilePath)) {
        const data = readFileSync(this.statusFilePath, 'utf8');
        this.lastStatusData = JSON.parse(data) as StatusLineData;
      }
    } catch (err) {
      this.log.debug(`Failed to read status file: ${err}`);
    }

    return this.lastStatusData;
  }

  /**
   * Start watching the status file for changes.
   * Emits 'status' event when new data is available.
   */
  startStatusWatch(): void {
    if (!this.statusFilePath) {
      this.log.debug('No status file path, skipping status watch');
      return;
    }

    this.log.debug(`Starting status watch: ${this.statusFilePath}`);

    const checkStatus = () => {
      const data = this.getStatusData();
      if (data && data.timestamp !== this.lastStatusData?.timestamp) {
        this.lastStatusData = data;
        this.emit('status', data);
      }
    };

    // Watch for file changes
    watchFile(this.statusFilePath, { interval: 1000 }, checkStatus);
  }

  /**
   * Stop watching the status file and clean up.
   */
  stopStatusWatch(): void {
    if (this.statusFilePath) {
      unwatchFile(this.statusFilePath);
      // Clean up temp file
      try {
        if (existsSync(this.statusFilePath)) {
          unlinkSync(this.statusFilePath);
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  start(): void {
    if (this.process) throw new Error('Already running');

    // Clear stderr buffer and rate-limit dedupe flag from any previous run.
    // Release this instance's contribution to the aggregate stderr cap first.
    totalStderrBytes -= this.stderrBuffer.length;
    this.stderrBuffer = '';
    this.lastEmittedRateLimitDeadline = 0;

    // Clean up stale browser bridge sockets (workaround for Claude CLI bug)
    cleanupBrowserBridgeSockets();

    const claudePath = getClaudePath();
    const args = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // Add session ID for persistence/resume support
    if (this.options.sessionId) {
      if (this.options.resume) {
        args.push('--resume', this.options.sessionId);
      } else {
        args.push('--session-id', this.options.sessionId);
      }
    }

    // Resolve the effective permission mode. New `permissionMode` wins; legacy
    // `skipPermissions` is honored when `permissionMode` is unset. Default is
    // 'default' (prompt user) — the safe choice when config is ambiguous.
    const permissionMode: PermissionMode =
      this.options.permissionMode ?? 'default';

    // SECURITY NOTE ON MCP CONFIG: The `--mcp-config` blob includes the
    // platform bot token. Passing it as an argv string would expose the
    // token in `ps`. `buildPermissionArgs` writes it to an owner-only
    // tempfile (mode 0600) and records the path on `this` for cleanup on
    // exit.
    const permResult = buildPermissionArgs({
      permissionMode,
      mcpServerPath: this.getMcpServerPath(),
      platformConfig: this.options.platformConfig,
      threadId: this.options.threadId,
      sessionId: this.options.sessionId,
      permissionTimeoutMs: this.options.permissionTimeoutMs ?? 120000,
      debug: this.debug,
      workingDir: this.options.workingDir,
      uploadDir: this.options.uploadDir,
      outboundFiles: this.options.outboundFiles,
    });
    args.push(...permResult.args);
    this.mcpConfigTempFile = permResult.tempFile;

    // Chrome integration
    if (this.options.chrome) {
      args.push('--chrome');
    }

    // Append system prompt for context
    if (this.options.appendSystemPrompt) {
      args.push('--append-system-prompt', this.options.appendSystemPrompt);
    }

    // Configure status line to write context data to a temp file
    // This gives us accurate context window usage information
    if (this.options.sessionId) {
      this.statusFilePath = join(tmpdir(), `claude-threads-status-${this.options.sessionId}.json`);
      const statusLineWriterPath = this.getStatusLineWriterPath();
      const statusLineSettings = {
        statusLine: {
          type: 'command',
          command: `node ${statusLineWriterPath} ${this.options.sessionId}`,
          padding: 0,
        },
      };
      args.push('--settings', JSON.stringify(statusLineSettings));
    }

    this.log.debug(`Starting: ${claudePath} ${args.slice(0, 5).join(' ')}...`);

    // Build child env. When an account is configured, override HOME (OAuth) or
    // ANTHROPIC_API_KEY (API) so Claude reads different credentials per session.
    // No account → inherit process.env unchanged (single-account mode).
    const childEnv = this.buildChildEnv();
    if (this.options.account) {
      this.log.debug(`Spawning under Claude account "${this.options.account.id}"`);
    }

    this.process = crossSpawn(claudePath, args, {
      cwd: this.options.workingDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.log.debug(`Claude process spawned: pid=${this.process.pid}`);

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.parseOutput(chunk.toString());
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const before = this.stderrBuffer.length;
      this.stderrBuffer += text;
      // Under-pressure trim: once the aggregate across all sessions exceeds
      // STDERR_AGGREGATE_SOFT_CAP, trim aggressively (1KB) so a single runaway
      // session cannot keep claiming 10KB while the rest of the fleet is
      // competing for heap. Normal operation uses the 10KB per-instance cap.
      const cap = totalStderrBytes > STDERR_AGGREGATE_SOFT_CAP
        ? 1024
        : STDERR_PER_INSTANCE_CAP;
      if (this.stderrBuffer.length > cap) {
        this.stderrBuffer = this.stderrBuffer.slice(-cap);
      }
      totalStderrBytes += this.stderrBuffer.length - before;
      this.log.debug(`stderr: ${text.trim()}`);
      // In integration tests, forward child stderr to our stderr so the
      // CI log captures mock-claude diagnostics. Prod never sets this env.
      if (process.env.INTEGRATION_TEST === '1') {
        process.stderr.write(text);
      }
      this.maybeEmitRateLimit(text);
    });

    this.process.on('error', (err) => {
      this.log.error(`Claude error: ${err}`);
      this.emit('error', err);
    });

    this.process.on('exit', (code) => {
      this.log.debug(`Exited ${code}`);
      this.process = null;
      this.buffer = '';
      // Release this instance's stderr budget so other sessions can use it.
      // We intentionally DON'T clear stderrBuffer here — getLastStderr() is
      // called during crash-diagnosis after exit.
      totalStderrBytes -= this.stderrBuffer.length;
      // Unlink the MCP config tempfile if one was written. Best-effort: if
      // cleanup fails (perms, race, ENOENT from a concurrent cleanup), the
      // file lives in os.tmpdir() and will be reaped by the OS eventually.
      if (this.mcpConfigTempFile) {
        const path = this.mcpConfigTempFile;
        this.mcpConfigTempFile = null;
        try { unlinkSync(path); } catch { /* best-effort */ }
      }
      this.emit('exit', code);
    });
  }

  // Send a user message via JSON stdin.
  sendMessage(content: string): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    }) + '\n';
    const preview = content.substring(0, 50);
    this.log.debug(`Sending: ${preview}...`);
    // Diagnostic for integration tests: trace every sendMessage call with caller.
    if (process.env.INTEGRATION_TEST === '1') {
      const stack = new Error().stack?.split('\n').slice(2, 6).join(' > ').replace(/\s+at\s+/g, ' < ') ?? '?';
      process.stderr.write(`[claude-cli sendMessage pid=${this.process.pid}] ${preview} | ${stack}\n`);
    }
    this.process.stdin.write(msg);
  }

  // Send a tool result response
  sendToolResult(toolUseId: string, content: unknown): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: typeof content === 'string' ? content : JSON.stringify(content)
        }]
      }
    }) + '\n';
    this.log.debug(`Sending tool_result for ${toolUseId}`);
    this.process.stdin.write(msg);
  }

  private parseOutput(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const event = JSON.parse(trimmed) as ClaudeEvent;
        // Note: Event details are logged in events.ts handleEvent with session context
        this.emit('event', event);
        // Scan for rate-limit only on error-flavored result events. `success`
        // results contain the assistant's final answer text, which could easily
        // include phrases like "rate_limit_error" if the user asked about them
        // — scanning those would cool the account down on a normal reply.
        // Error subtypes (e.g. "error_during_execution", "error_max_turns") and
        // any event carrying `is_error: true` are the narrow set we trust.
        if (event.type === 'result' && isErrorResultEvent(event)) {
          this.maybeEmitRateLimit(trimmed);
        }
      } catch {
        // Ignore unparseable lines (usually partial JSON from streaming)
      }
    }
  }

  /**
   * Scan a stderr chunk or result-event body for rate-limit signals and, on a
   * hit, emit a `'rate-limit'` event with the parsed hit.
   *
   * Dedupe semantics: we track the cooldown deadline of the last emit and
   * re-emit only when a new hit would move the deadline FORWARD by more than
   * a minute. This means:
   *  - Identical hits from successive stderr chunks emit once (no spam):
   *    relative hints like "Resets in 10 minutes" recompute against
   *    `Date.now()` each call so deadlines drift by milliseconds — the
   *    epsilon keeps that from counting as "new".
   *  - A second rate-limit with a meaningfully longer reset (e.g. first hit
   *    said 10 min, second says 1 hour) does re-emit, so
   *    `AccountPool.markCooling` — which only extends cooldown — can widen
   *    the deadline.
   *  - A second hit with the same or earlier deadline is skipped: the pool
   *    would have dropped it anyway.
   */
  private maybeEmitRateLimit(text: string): void {
    const hit = detectRateLimit(text);
    if (!hit.detected) return;
    const newDeadline = cooldownDeadline(hit);
    const MIN_ADVANCE_MS = 60_000;  // 1 minute: coarser than clock drift, finer than any real rate-limit reset step
    if (newDeadline - this.lastEmittedRateLimitDeadline < MIN_ADVANCE_MS) return;
    this.lastEmittedRateLimitDeadline = newDeadline;
    this.log.warn(`Rate limit detected: ${hit.matched ?? '(no match text)'}`);
    this.emit('rate-limit', hit);
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  /**
   * Get the last stderr output (up to 10KB).
   */
  getLastStderr(): string {
    return this.stderrBuffer;
  }

  /**
   * Check if the last failure was a permanent error that shouldn't be retried.
   * These are errors in the Claude CLI itself that won't be fixed by retrying.
   */
  isPermanentFailure(): boolean {
    const stderr = this.stderrBuffer;

    // Browser bridge temp file doesn't exist (happens when resuming sessions that had chrome enabled)
    if (stderr.includes('claude-mcp-browser-bridge') &&
        (stderr.includes('EOPNOTSUPP') || stderr.includes('ENOENT'))) {
      return true;
    }

    // Session no longer exists in Claude's conversation history
    // This happens when ~/.claude/projects/* is cleared or session was from a different machine
    if (stderr.includes('No conversation found with session ID')) {
      return true;
    }

    return false;
  }

  /**
   * Get a human-readable description of a permanent failure.
   */
  getPermanentFailureReason(): string | null {
    const stderr = this.stderrBuffer;

    if (stderr.includes('claude-mcp-browser-bridge') &&
        (stderr.includes('EOPNOTSUPP') || stderr.includes('ENOENT'))) {
      return 'Claude browser bridge state from a previous session is no longer accessible. This typically happens when a session with Chrome integration is resumed after a restart.';
    }

    if (stderr.includes('No conversation found with session ID')) {
      return 'The conversation history for this session no longer exists. This can happen if Claude\'s history was cleared or if the session was created on a different machine.';
    }

    return null;
  }

  /**
   * Kill the Claude CLI process.
   * Sends two SIGINTs (like Ctrl+C twice in interactive mode) to allow graceful shutdown,
   * then SIGTERM after a timeout if it doesn't exit.
   * Returns a Promise that resolves when the process has exited.
   */
  kill(): Promise<void> {
    this.stopStatusWatch();
    if (!this.process) {
      this.log.debug('Kill called but process not running');
      return Promise.resolve();
    }

    const proc = this.process;
    const pid = proc.pid;
    this.process = null;

    this.log.debug(`Killing Claude process (pid=${pid})`);

    return new Promise<void>((resolve) => {
      // Send first SIGINT (interrupts current operation)
      this.log.debug('Sending first SIGINT');
      proc.kill('SIGINT');

      // Send second SIGINT after brief delay (triggers exit in interactive mode)
      const secondSigint = setTimeout(() => {
        try {
          this.log.debug('Sending second SIGINT');
          proc.kill('SIGINT');
        } catch {
          // Process may have already exited
        }
      }, 100);

      // Force kill with SIGTERM if still running after grace period
      const forceKillTimeout = setTimeout(() => {
        try {
          this.log.debug('Sending SIGTERM (force kill)');
          proc.kill('SIGTERM');
        } catch {
          // Process may have already exited
        }
      }, 2000); // 2 second grace period for Claude to save conversation

      // Resolve when process exits
      proc.once('exit', (code) => {
        this.log.debug(`Claude process exited (code=${code})`);
        clearTimeout(secondSigint);
        clearTimeout(forceKillTimeout);
        resolve();
      });
    });
  }

  /** Interrupt current processing (like Escape in CLI) - keeps process alive */
  interrupt(): boolean {
    if (!this.process) {
      this.log.debug('Interrupt called but process not running');
      return false;
    }
    this.log.debug(`Interrupting Claude process (pid=${this.process.pid})`);
    this.process.kill('SIGINT');
    return true;
  }

  /**
   * Build the env object for the spawned Claude process.
   *
   * Starts from `process.env` so the parent's environment (including any
   * opt-in hardening like `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`) is inherited,
   * then layers in two always-on tuning flags and optional account overrides.
   *
   * Always-on tuning:
   * - `MCP_CONNECTION_NONBLOCKING=true` caps `--mcp-config` server connects
   *   at 5s (Claude CLI 2.1.89+), so a slow MCP server never delays startup.
   * - `ENABLE_PROMPT_CACHING_1H=true` opts into the 1-hour prompt cache TTL
   *   (Claude CLI 2.1.108+), which meaningfully reduces re-caching cost on
   *   long-lived threads that idle past the default 5-minute window.
   * Both only take effect when not already set, so users can still override.
   *
   * Account overrides (when `options.account` is set):
   * - `home` set → override `HOME` (and `USERPROFILE` on Windows). Claude
   *   reads `.credentials.json`, `.claude/projects/*`, and MCP config from
   *   this directory, so the child session runs fully under that account's
   *   OAuth state.
   * - `apiKey` set → override `ANTHROPIC_API_KEY`. Claude keeps using the
   *   outer HOME for history and MCP, but billing goes to this key. We also
   *   clear the outer OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) so the API key
   *   wins even if both are present.
   *
   * Exposed as a separate method to keep `start()` readable and to make the
   * env-assembly logic straightforward to audit.
   */
  private buildChildEnv(): NodeJS.ProcessEnv {
    return buildClaudeChildEnv(process.env, this.options.account);
  }

  private getMcpServerPath(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    // When bundled with bun build, __dirname is dist/ (not dist/claude/)
    // Try the bundled path first, then fall back to source layout
    const bundledPath = resolve(__dirname, 'mcp', 'permission-server.js');
    if (existsSync(bundledPath)) {
      return bundledPath;
    }
    return resolve(__dirname, '..', 'mcp', 'permission-server.js');
  }

  private getStatusLineWriterPath(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const bundledPath = resolve(__dirname, 'statusline', 'writer.js');
    if (existsSync(bundledPath)) {
      return bundledPath;
    }
    return resolve(__dirname, '..', 'statusline', 'writer.js');
  }
}
