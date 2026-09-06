import { describe, expect, it } from 'bun:test';
import { managedMcpConfigPath, managedMcpConfigPresent } from './managed-mcp.js';

describe('managedMcpConfigPresent', () => {
  it('checks the CLI\'s well-known path for the platform', () => {
    const seen: string[] = [];
    expect(managedMcpConfigPresent('linux', (p) => { seen.push(p); return true; })).toBe(true);
    expect(seen).toEqual(['/etc/claude-code/managed-mcp.json']);
    expect(managedMcpConfigPresent('darwin', () => false)).toBe(false);
    expect(managedMcpConfigPath('win32')).toContain('ClaudeCode');
  });

  it('is false on a platform without a managed path', () => {
    expect(managedMcpConfigPath('freebsd')).toBeNull();
    expect(managedMcpConfigPresent('freebsd', () => true)).toBe(false);
  });
});
