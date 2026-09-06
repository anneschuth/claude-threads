/**
 * Enterprise-managed MCP config detection.
 *
 * When an organization ships a `managed-mcp.json`, the Claude CLI refuses
 * `--strict-mcp-config` outright ("You cannot use --strict-mcp-config when
 * an enterprise MCP config is present") and exits, so a platform with
 * `strictMcpConfig: true` would fail every session start on such a
 * machine. The bot checks the same well-known paths the CLI uses and
 * downgrades with a warning instead. On those machines the org policy
 * already governs which MCP servers load.
 */
import { existsSync } from 'fs';

export const MANAGED_MCP_CONFIG_PATHS: Readonly<Record<string, string>> = {
  darwin: '/Library/Application Support/ClaudeCode/managed-mcp.json',
  linux: '/etc/claude-code/managed-mcp.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-mcp.json',
};

/** Path the CLI would read on this platform, or null when it has none. */
export function managedMcpConfigPath(platform: NodeJS.Platform = process.platform): string | null {
  return MANAGED_MCP_CONFIG_PATHS[platform] ?? null;
}

/**
 * True when an enterprise managed MCP config is present. `exists` is
 * injectable so tests need not touch system directories.
 */
export function managedMcpConfigPresent(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const path = managedMcpConfigPath(platform);
  return path !== null && exists(path);
}
