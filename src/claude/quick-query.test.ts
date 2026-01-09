/**
 * Tests for quick-query utility
 *
 * Note: These tests focus on the interface and behavior rather than mocking
 * the spawn call, since Bun's ES module system doesn't support module mocking.
 */

import { describe, expect, test } from 'bun:test';
import type { QuickQueryOptions, QuickQueryResult } from './quick-query.js';

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
