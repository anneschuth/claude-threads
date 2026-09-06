/**
 * Per-platform MCP posture (#560), resolved once at startup before any
 * platform client exists. Pure apart from the injected managed-MCP probe,
 * so the downgrade logic is unit-testable; `src/index.ts` owns the exit
 * and the logging.
 */
import type { Config, PlatformInstanceConfig } from './types.js';
import { resolveClaudeAiConnectors, resolveMcpServers, resolveStrictMcpConfig } from './types.js';
import { managedMcpConfigPath, managedMcpConfigPresent } from './managed-mcp.js';

export interface McpPostureResult {
  /** Warnings worth showing again once the UI owns the screen. */
  warnings: string[];
}

/**
 * Mutates each platform entry in place: `mcpServers` becomes the validated
 * merge of the top-level map and the platform's own, `strictMcpConfig` and
 * `claudeAiConnectors` become booleans. Throws (with the field path) on a
 * malformed server entry. Derived DM instances spread these entries later,
 * so they inherit the result.
 *
 * `strictMcpConfig: true` is downgraded with a warning when an
 * enterprise-managed MCP config is present: the CLI refuses the flag next
 * to one and exits, which would kill every session at start. The check is
 * best-effort (the CLI knows more sources than the well-known file); the
 * early-exit handler names the refusal when this misses.
 */
export function resolvePlatformMcpPosture(
  platforms: PlatformInstanceConfig[],
  globalMcpServers: Config['mcpServers'],
  managedPresent: () => boolean = () => managedMcpConfigPresent(),
): McpPostureResult {
  const warnings: string[] = [];
  for (const p of platforms) {
    p.mcpServers = resolveMcpServers(globalMcpServers, p.mcpServers, `platforms[${p.id}].mcpServers`);
    p.strictMcpConfig = resolveStrictMcpConfig(p.strictMcpConfig, `platforms[${p.id}].strictMcpConfig`);
    p.claudeAiConnectors = resolveClaudeAiConnectors(p.claudeAiConnectors, `platforms[${p.id}].claudeAiConnectors`);
    if (p.strictMcpConfig && managedPresent()) {
      warnings.push(
        `platforms[${p.id}].strictMcpConfig ignored: an enterprise managed MCP config is present ` +
        `(${managedMcpConfigPath() ?? 'managed-mcp.json'}) and the Claude CLI refuses --strict-mcp-config alongside it.`,
      );
      p.strictMcpConfig = false;
    }
  }
  return { warnings };
}
