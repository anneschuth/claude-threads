/**
 * Lightweight one-shot queries to Claude CLI.
 *
 * Use cases:
 * - Branch name suggestions
 * - Commit message generation
 * - Quick classification tasks
 * - Any fast, non-interactive Claude query
 *
 * Uses -p (print) mode for single-response queries.
 * Defaults to haiku for speed/cost efficiency.
 */

import { spawn } from 'child_process';
import { createLogger } from '../utils/logger.js';

const log = createLogger('quick-query');

export interface QuickQueryOptions {
  /** The prompt to send to Claude */
  prompt: string;

  /** Model to use: 'haiku' (fast/cheap), 'sonnet' (balanced), 'opus' (powerful) */
  model?: 'haiku' | 'sonnet' | 'opus';

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;

  /** Working directory for context (optional) */
  workingDir?: string;

  /** System prompt override (optional) */
  systemPrompt?: string;
}

export interface QuickQueryResult {
  success: boolean;
  response?: string;
  error?: string;
  durationMs: number;
}

/**
 * Quick one-shot query to Claude CLI.
 *
 * Spawns `claude -p --model <model>` and waits for response.
 * Fails silently on errors (returns { success: false }).
 *
 * @example
 * const result = await quickQuery({
 *   prompt: 'Suggest 3 branch names for: "add dark mode"',
 *   model: 'haiku',
 *   timeout: 5000,
 * });
 * if (result.success) {
 *   console.log(result.response);
 * }
 */
export async function quickQuery(options: QuickQueryOptions): Promise<QuickQueryResult> {
  const {
    prompt,
    model = 'haiku',
    timeout = 5000,
    workingDir,
    systemPrompt,
  } = options;

  const startTime = Date.now();

  const claudePath = process.env.CLAUDE_PATH || 'claude';
  const args = ['-p', '--model', model];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  // Add the prompt as the final argument
  args.push(prompt);

  log.debug(`Quick query: model=${model}, timeout=${timeout}ms, prompt="${prompt.substring(0, 50)}..."`);

  return new Promise<QuickQueryResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const proc = spawn(claudePath, args, {
      cwd: workingDir || process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill('SIGTERM');
        log.debug(`Quick query timed out after ${timeout}ms`);
        resolve({
          success: false,
          error: 'timeout',
          durationMs: Date.now() - startTime,
        });
      }
    }, timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        log.debug(`Quick query error: ${err.message}`);
        resolve({
          success: false,
          error: err.message,
          durationMs: Date.now() - startTime,
        });
      }
    });

    proc.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;

        if (code === 0 && stdout.trim()) {
          log.debug(`Quick query success: ${durationMs}ms, ${stdout.length} chars`);
          resolve({
            success: true,
            response: stdout.trim(),
            durationMs,
          });
        } else {
          log.debug(`Quick query failed: code=${code}, stderr=${stderr.substring(0, 100)}`);
          resolve({
            success: false,
            error: stderr || `exit code ${code}`,
            durationMs,
          });
        }
      }
    });

    // Close stdin immediately since we pass prompt as argument
    proc.stdin?.end();
  });
}
