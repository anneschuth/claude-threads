import { ChildProcess } from 'child_process';
import { crossSpawn } from '../utils/spawn.js';
import { EventEmitter } from 'events';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, watchFile, unwatchFile, unlinkSync, statSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createLogger } from '../utils/logger.js';
import { getClaudePath } from './version-check.js';
import { detectRateLimit, cooldownDeadline } from './rate-limit-detector.js';

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

// Content block types for messages with images and documents
export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface DocumentContentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: 'application/pdf';
    data: string;
  };
  title?: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock | DocumentContentBlock;

export interface PlatformMcpConfig {
  type: string;
  url: string;
  token: string;
  channelId: string;
  allowedUsers: string[];
  /** App-level token for Slack Socket Mode (only needed for Slack) */
  appToken?: string;
}

export interface ClaudeCliOptions {
  workingDir: string;
  threadId?: string;  // Thread ID for permission requests
  skipPermissions?: boolean;  // If true, use --dangerously-skip-permissions
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

export class ClaudeCli extends EventEmitter {
  private process: ChildProcess | null = null;
  private options: ClaudeCliOptions;
  private buffer = '';
  public debug = process.env.DEBUG === '1' || process.argv.includes('--debug');
  private statusFilePath: string | null = null;
  private lastStatusData: StatusLineData | null = null;
  private stderrBuffer = '';  // Capture stderr for error detection
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

    // Clear stderr buffer and rate-limit dedupe flag from any previous run
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

    // Either use skip permissions or the MCP-based permission system
    if (this.options.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else {
      // Configure the permission MCP server
      const mcpServerPath = this.getMcpServerPath();

      // Platform config is required for MCP permission server
      const platformConfig = this.options.platformConfig;
      if (!platformConfig) {
        throw new Error('platformConfig is required when skipPermissions is false');
      }
      // Platform-agnostic environment variables for MCP permission server
      const mcpEnv: Record<string, string> = {
        PLATFORM_TYPE: platformConfig.type,
        PLATFORM_URL: platformConfig.url,
        PLATFORM_TOKEN: platformConfig.token,
        PLATFORM_CHANNEL_ID: platformConfig.channelId,
        PLATFORM_THREAD_ID: this.options.threadId || '',
        ALLOWED_USERS: platformConfig.allowedUsers.join(','),
        DEBUG: this.debug ? '1' : '',
        PERMISSION_TIMEOUT_MS: String(this.options.permissionTimeoutMs ?? 120000),
      };

      // Add Slack-specific app token if present (needed for Socket Mode)
      if (platformConfig.appToken) {
        mcpEnv.PLATFORM_APP_TOKEN = platformConfig.appToken;
      }

      const mcpConfig = {
        mcpServers: {
          'claude-threads-permissions': {
            type: 'stdio',
            command: 'node',
            args: [mcpServerPath],
            env: mcpEnv,
          },
        },
      };
      args.push('--mcp-config', JSON.stringify(mcpConfig));
      args.push('--permission-prompt-tool', 'mcp__claude-threads-permissions__permission_prompt');
    }

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
      this.stderrBuffer += text;
      // Keep only the last 10KB of stderr to prevent memory issues
      if (this.stderrBuffer.length > 10240) {
        this.stderrBuffer = this.stderrBuffer.slice(-10240);
      }
      this.log.debug(`stderr: ${text.trim()}`);
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
      this.emit('exit', code);
    });
  }

  // Send a user message via JSON stdin
  // content can be a string or an array of content blocks (for images)
  sendMessage(content: string | ContentBlock[]): void {
    if (!this.process?.stdin) throw new Error('Not running');

    const msg = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    }) + '\n';
    const preview = typeof content === 'string'
      ? content.substring(0, 50)
      : `[${content.length} blocks]`;
    this.log.debug(`Sending: ${preview}...`);
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
