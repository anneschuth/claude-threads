/**
 * Env-var names for the agent-feature gates the bot passes to the MCP child
 * at spawn time (via the `--mcp-config` env block — the child gets an
 * explicit env, not the bot's environment). One shared module imported by
 * BOTH sides (src/claude/cli.ts writes, src/mcp/mcp-server.ts reads), so a
 * rename can't desync them — same rationale as src/mcp/outbound-env.ts.
 *
 * These gates are ADVISORY: they only decide which agent tools the MCP
 * server registers, so a disabled feature's tool never shows up in the
 * model's tool list. The authoritative checks run bot-side in
 * src/operations/agent-actions/handler.ts on every bridge request —
 * config could never be enforced from the child, which is model-facing.
 */
export const AGENT_FEATURES_ENV = {
  /** '1' when the platform's channel memory layer is enabled. */
  MEMORY_CHANNEL_ENABLED: 'CT_MEMORY_CHANNEL_ENABLED',
  /** '1' when routines are enabled for the platform. */
  ROUTINES_ENABLED: 'CT_ROUTINES_ENABLED',
  /** '1' when watches are enabled for the platform. */
  WATCHES_ENABLED: 'CT_WATCHES_ENABLED',
  /**
   * '1' when the session is an unattended run (routine fire / watch fire).
   * Suppresses the propose_* tools: an unattended session proposing new
   * unattended work is the self-replication loop the design forbids.
   */
  UNATTENDED: 'CT_UNATTENDED',
  /**
   * '1' for direct-channel-mode sessions. Suppresses the propose_* tools —
   * routines/watches cannot be CREATED in DCM (the bot refuses), so
   * offering the tools would only waste model turns; the list_* tools
   * stay (listing works in DCM).
   */
  DCM: 'CT_DCM',
} as const;
