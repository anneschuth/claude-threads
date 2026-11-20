/**
 * Message interceptor: an operator command that may answer a message before
 * it wakes Claude.
 *
 * Some messages need no model at all: a reply that picks option "1A, 2B" from
 * a question the bot posted, a status lookup, an acknowledgement. Sending
 * them to Claude still costs a full turn, and in a long thread that turn
 * re-reads the whole conversation. With `messageInterceptor` configured, a
 * message that has cleared every authorization gate and is about to reach
 * Claude (follow-up, paused-session resume, or new session) is first offered
 * to the command. The command decides:
 *
 *   stdin   one JSON object: { version, platformId, threadId, postId,
 *           username, message, session }  (`session`: active | paused | none)
 *   stdout  `{"handled": true, "reply"?: string, "reaction"?: string}` to
 *           answer it here, anything else to let it through.
 *
 * It fails open: a non-zero exit, a timeout, oversized or malformed output all
 * mean "not handled", so a broken interceptor can only cost what not having
 * one costs. The command is an argv array, run without a shell.
 */

import type { ChildProcess } from 'child_process';
import { crossSpawn } from './utils/spawn.js';

export interface MessageInterceptorConfig {
  /** argv: the program and its arguments. Run without a shell. */
  command: string[];
  /** Kill the command and let the message through after this long (default 10 000). */
  timeoutMs?: number;
}

export type InterceptSessionState = 'active' | 'paused' | 'none';

export interface InterceptRequest {
  version: 1;
  platformId: string;
  threadId: string;
  postId: string;
  /** When the message was posted (ms since epoch), when the platform says; replays can arrive late. */
  createAt?: number;
  username: string;
  /** The message as Claude would get it: bot mention stripped, trimmed. */
  message: string;
  session: InterceptSessionState;
}

export interface InterceptResult {
  handled: boolean;
  /** Posted in the thread as the bot. */
  reply?: string;
  /** Emoji name added to the intercepted post. */
  reaction?: string;
}

export const DEFAULT_INTERCEPTOR_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Commands running at once, across the bot; past it a message passes through unoffered. */
export const MAX_CONCURRENT_INTERCEPTORS = 8;
/** setTimeout's ceiling: a larger delay fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
const NOT_HANDLED: InterceptResult = { handled: false };

/**
 * Normalize the per-platform `messageInterceptor` field. Undefined → off.
 * A malformed value warns and turns the feature off: an interceptor that
 * cannot run must never stand between a user and the bot.
 */
export function resolveMessageInterceptor(
  value: unknown,
  fieldPath: string,
): MessageInterceptorConfig | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = value as Partial<MessageInterceptorConfig>;
  const command = raw?.command;
  const validCommand =
    Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === 'string' && part !== '');
  const timeout = raw?.timeoutMs;
  const validTimeout =
    timeout === undefined || (Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_TIMER_MS);
  if (typeof value !== 'object' || !validCommand || !validTimeout) {
    // The value itself is not echoed: its arguments may carry credentials.
    console.warn(
      `Invalid ${fieldPath} config: expected { command: [program, ...args], timeoutMs?: 1..${MAX_TIMER_MS} }` +
        ' — message interceptor disabled',
    );
    return undefined;
  }
  return { command: [...command], timeoutMs: timeout };
}

type Spawn = (command: string, args: string[]) => ChildProcess;

// Its own process group (POSIX), so a timeout can end any helper it started too.
const ownGroup = process.platform !== 'win32';

const defaultSpawn: Spawn = (command, args) =>
  crossSpawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: ownGroup });

/** Kill what is left of an exited command's process group (POSIX only; nothing on Windows). */
function terminateGroup(child: ChildProcess): void {
  if (!ownGroup || !child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // the group is already gone
  }
}

/** Kill the command and everything it started, and let go of its pipe. */
function terminate(child: ChildProcess | undefined): void {
  if (!child) return;
  live.delete(child);
  try {
    if (ownGroup && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else if (process.platform === 'win32' && child.pid) {
      // A .cmd shim runs under cmd.exe: killing that leaves the program running.
      crossSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        // Without a listener, a taskkill that cannot start would crash the bot.
        .on('error', () => child.kill('SIGKILL'));
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    child.kill('SIGKILL');
  }
  child.stdout?.destroy();
}

// Commands still running when the bot exits (!kill, an update, a crash) are
// in their own process group, so nothing else would stop them.
const live = new Set<ChildProcess>();
let exitHookInstalled = false;
function track(child: ChildProcess): void {
  live.add(child);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const running of [...live]) terminate(running);
  });
}

/** Parse the command's stdout. Anything but a well-formed "handled" object is NOT_HANDLED. */
export function parseInterceptResult(stdout: string): InterceptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return NOT_HANDLED;
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { handled?: unknown }).handled !== true) {
    return NOT_HANDLED;
  }
  const { reply, reaction } = parsed as { reply?: unknown; reaction?: unknown };
  // A field that is present but unusable means the answer cannot be delivered:
  // swallowing the message then would leave the user with no answer at all.
  if (reply !== undefined && (typeof reply !== 'string' || !reply.trim())) return NOT_HANDLED;
  if (reaction !== undefined && (typeof reaction !== 'string' || !/^[\w+-]+$/.test(reaction))) {
    return NOT_HANDLED;
  }
  return { handled: true, reply, reaction };
}

/** Run the interceptor once. Never throws; every failure is NOT_HANDLED. */
export function runMessageInterceptor(
  config: MessageInterceptorConfig,
  request: InterceptRequest,
  spawnFn: Spawn = defaultSpawn,
): Promise<InterceptResult> {
  if (live.size >= MAX_CONCURRENT_INTERCEPTORS) return Promise.resolve(NOT_HANDLED);
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess;
    const finish = (result: InterceptResult) => {
      if (child) live.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminate(child);
      finish(NOT_HANDLED);
    }, config.timeoutMs ?? DEFAULT_INTERCEPTOR_TIMEOUT_MS);

    try {
      child = spawnFn(config.command[0], config.command.slice(1));
      track(child);
    } catch {
      finish(NOT_HANDLED);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        terminate(child);
        finish(NOT_HANDLED);
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish(NOT_HANDLED));
    child.on('close', (code) => {
      // Anything the command left running in its group must not outlive its answer.
      terminateGroup(child);
      finish(code === 0 ? parseInterceptResult(Buffer.concat(chunks).toString('utf8')) : NOT_HANDLED);
    });
    child.stdin?.on('error', () => {
      // EPIPE when the command exits without reading: its exit code decides.
    });
    child.stdin?.end(JSON.stringify(request));
  });
}
