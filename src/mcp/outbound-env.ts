/**
 * Env-var name contract between the bot (which spawns the MCP child) and the
 * MCP child itself.
 *
 * Both sides import these constants so a typo on one side is impossible —
 * it'd be a typo on both sides simultaneously, and either way the test
 * `outbound-env.test.ts` would fail.
 *
 * Why this matters: the bot writes these vars in `buildPermissionArgs`
 * (src/claude/cli.ts) and the child reads them in `mcp-server.ts`.
 * Without a shared constant, a refactor that renamed (say)
 * `SESSION_UPLOAD_DIR` → `SESSION_UPLOADS_DIR` on one side only would not
 * fail any unit test — every helper would still pass — but `send_file`
 * would silently lose its allowed-roots guard at runtime.
 */

export const OUTBOUND_ENV = {
  /** Absolute path to the session's working directory (CWD Claude was started in). */
  SESSION_WORKING_DIR: 'SESSION_WORKING_DIR',
  /** Absolute path to the per-thread upload directory. */
  SESSION_UPLOAD_DIR: 'SESSION_UPLOAD_DIR',
  /** '0' to disable; any other value (including unset) means enabled. */
  OUTBOUND_FILES_ENABLED: 'OUTBOUND_FILES_ENABLED',
  /** Per-file byte cap. Unset → bot default (100 MB). */
  OUTBOUND_FILES_MAX_BYTES: 'OUTBOUND_FILES_MAX_BYTES',
} as const;
