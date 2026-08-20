import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  configureAuditLog,
  isAuditEnabled,
  auditLog,
  auditDetailForTool,
  _resetAuditLog,
} from './audit-log.js';

describe('audit log', () => {
  let dir: string;
  let prevDir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ct-audit-test-'));
    prevDir = process.env.CLAUDE_THREADS_AUDIT_DIR;
    process.env.CLAUDE_THREADS_AUDIT_DIR = dir;
    _resetAuditLog();
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.CLAUDE_THREADS_AUDIT_DIR;
    else process.env.CLAUDE_THREADS_AUDIT_DIR = prevDir;
    _resetAuditLog();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = () => ({
    threadId: 'thread-1',
    sessionId: 'p1:thread-1',
    actor: 'alice',
    kind: 'tool_use' as const,
    tool: 'Bash',
    detail: 'ls -la',
  });

  it('writes nothing for platforms that are not configured', () => {
    auditLog('p1', entry());
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('appends JSONL entries with timestamp and platform id', () => {
    configureAuditLog('p1', true);
    auditLog('p1', entry());
    auditLog('p1', { ...entry(), tool: 'Edit', detail: '/etc/passwd' });

    const lines = readFileSync(join(dir, 'p1.jsonl'), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.platformId).toBe('p1');
    expect(first.actor).toBe('alice');
    expect(first.tool).toBe('Bash');
    expect(first.detail).toBe('ls -la');
    expect(new Date(first.ts).getTime()).toBeGreaterThan(0);
  });

  it('creates the audit file with owner-only permissions', () => {
    configureAuditLog('p1', true);
    auditLog('p1', entry());
    expect(statSync(join(dir, 'p1.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('caps oversized details', () => {
    configureAuditLog('p1', true);
    auditLog('p1', { ...entry(), detail: 'x'.repeat(2000) });
    const line = JSON.parse(readFileSync(join(dir, 'p1.jsonl'), 'utf-8').trim());
    expect(line.detail).toHaveLength(500);
  });

  it('encodes platform ids collision-free for filenames', () => {
    configureAuditLog('a/b', true);
    configureAuditLog('a_b', true);
    auditLog('a/b', entry());
    auditLog('a_b', entry());
    expect(readdirSync(dir).sort()).toEqual(['a%2Fb.jsonl', 'a_b.jsonl']);
  });

  it('refuses to write through a symlinked audit file', () => {
    configureAuditLog('p1', true);
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'do not touch');
    mkdirSync(join(dir), { recursive: true });
    symlinkSync(victim, join(dir, 'p1.jsonl'));

    auditLog('p1', entry());

    expect(readFileSync(victim, 'utf-8')).toBe('do not touch');
  });

  it('re-tightens permissions on pre-existing files and directories', () => {
    configureAuditLog('p1', true);
    // Simulate a leftover world-readable file + dir from a sloppy restore.
    writeFileSync(join(dir, 'p1.jsonl'), '', { mode: 0o644 });
    chmodSync(join(dir, 'p1.jsonl'), 0o644);
    chmodSync(dir, 0o755);

    auditLog('p1', entry());

    expect(statSync(join(dir, 'p1.jsonl')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('configure(false) disables a previously enabled platform', () => {
    configureAuditLog('p1', true);
    expect(isAuditEnabled('p1')).toBe(true);
    configureAuditLog('p1', false);
    expect(isAuditEnabled('p1')).toBe(false);
  });
});

describe('auditDetailForTool', () => {
  it('extracts the audit-relevant field per tool', () => {
    expect(auditDetailForTool('Bash', { command: 'rm -rf /tmp/x' })).toBe('rm -rf /tmp/x');
    expect(auditDetailForTool('Edit', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(auditDetailForTool('Grep', { pattern: 'secret' })).toBe('secret');
    expect(auditDetailForTool('WebFetch', { url: 'https://x.test' })).toBe('https://x.test');
  });

  it('falls back to compact JSON for unknown tools and handles absence', () => {
    expect(auditDetailForTool('CustomTool', { a: 1 })).toBe('{"a":1}');
    expect(auditDetailForTool('Bash', undefined)).toBeUndefined();
  });
});
