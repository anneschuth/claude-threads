/**
 * Tests for quick-query utility
 *
 * Note: These tests focus on the interface and behavior rather than mocking
 * the spawn call, since Bun's ES module system doesn't support module mocking.
 */

import { describe, expect, test } from 'bun:test';
import { quickQuery, type QuickQueryOptions, type QuickQueryResult } from './quick-query.js';

describe('quickQuery interface', () => {
  test('QuickQueryOptions has required fields', () => {
    // Type-level test: ensure the interface is correctly defined
    const options: QuickQueryOptions = {
      prompt: 'test prompt',
    };
    expect(options.prompt).toBe('test prompt');
    expect(options.model).toBeUndefined();
    expect(options.timeout).toBeUndefined();
    expect(options.workingDir).toBeUndefined();
    expect(options.systemPrompt).toBeUndefined();
  });

  test('QuickQueryOptions accepts all optional fields', () => {
    const options: QuickQueryOptions = {
      prompt: 'test prompt',
      model: 'haiku',
      timeout: 5000,
      workingDir: '/tmp',
      systemPrompt: 'You are helpful',
    };
    expect(options.model).toBe('haiku');
    expect(options.timeout).toBe(5000);
    expect(options.workingDir).toBe('/tmp');
    expect(options.systemPrompt).toBe('You are helpful');
  });

  test('QuickQueryResult success case structure', () => {
    const result: QuickQueryResult = {
      success: true,
      response: 'test response',
      durationMs: 100,
    };
    expect(result.success).toBe(true);
    expect(result.response).toBe('test response');
    expect(result.durationMs).toBe(100);
  });

  test('QuickQueryResult failure case structure', () => {
    const result: QuickQueryResult = {
      success: false,
      error: 'timeout',
      durationMs: 5000,
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('timeout');
    expect(result.durationMs).toBe(5000);
  });

  test('model options are limited to haiku, sonnet, opus', () => {
    // Type-level test: ensure model is one of the expected values
    const options1: QuickQueryOptions = { prompt: 'test', model: 'haiku' };
    const options2: QuickQueryOptions = { prompt: 'test', model: 'sonnet' };
    const options3: QuickQueryOptions = { prompt: 'test', model: 'opus' };

    expect(options1.model).toBe('haiku');
    expect(options2.model).toBe('sonnet');
    expect(options3.model).toBe('opus');
  });
});

// Note: Integration tests for the actual quickQuery function would require
// the Claude CLI to be installed. Those tests should be in the integration
// test suite, not unit tests.

describe('prompt transport (stdin, not argv)', () => {
  // Regression-defender: the prompt must travel over STDIN. As an argv
  // argument, long prompts (distillation feeds ~40KB) exceed the Windows
  // command-line cap via the npm shim and the spawn dies silently.
  test('prompt is written to stdin and not passed in argv', async () => {
    const { mkdtempSync, writeFileSync, rmSync, chmodSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const dir = mkdtempSync(join(tmpdir(), 'ct-quickquery-test-'));
    const stub = join(dir, 'fake-claude');
    // Echoes a JSON record of argv and stdin so the test can assert both.
    writeFileSync(
      stub,
      `#!/usr/bin/env bash\nstdin=$(cat)\nprintf '%s|%s' "$*" "$stdin"\n`,
      { mode: 0o755 },
    );
    chmodSync(stub, 0o755);

    const prevPath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = stub;
    try {
      const result = await quickQuery({
        prompt: 'the quick query prompt payload',
        model: 'haiku',
        timeout: 10000,
      });
      expect(result.success).toBe(true);
      const [argv, stdin] = (result.response ?? '').split('|');
      expect(stdin).toBe('the quick query prompt payload');
      expect(argv).not.toContain('the quick query prompt payload');
    } finally {
      if (prevPath === undefined) delete process.env.CLAUDE_PATH;
      else process.env.CLAUDE_PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
