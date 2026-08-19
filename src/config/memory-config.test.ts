/**
 * Tests for the per-platform `memory` config option resolution.
 */

import { describe, test, expect } from 'bun:test';
import { resolveMemoryConfig, DEFAULT_MEMORY_CONFIG, MEMORY_DISABLED } from './types.js';

describe('resolveMemoryConfig', () => {
  test('undefined / null / true → fully enabled (the default)', () => {
    expect(resolveMemoryConfig(undefined)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(null)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(true)).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  test('false → fully disabled', () => {
    expect(resolveMemoryConfig(false)).toEqual(MEMORY_DISABLED);
  });

  test('empty object → fully enabled', () => {
    expect(resolveMemoryConfig({})).toEqual(DEFAULT_MEMORY_CONFIG);
  });

  test('partial object keeps unmentioned layers on', () => {
    expect(resolveMemoryConfig({ distillation: false })).toEqual({
      enabled: true,
      repoLayer: true,
      channelLayer: true,
      distillation: false,
    });
    expect(resolveMemoryConfig({ repoLayer: false })).toEqual({
      enabled: true,
      repoLayer: false,
      channelLayer: true,
      distillation: true,
    });
  });

  test('enabled: false gates every layer regardless of the rest', () => {
    expect(resolveMemoryConfig({ enabled: false, repoLayer: true, channelLayer: true })).toEqual(
      MEMORY_DISABLED,
    );
  });

  test('malformed values warn and fall back to defaults', () => {
    expect(resolveMemoryConfig('yes' as unknown)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig(42 as unknown)).toEqual(DEFAULT_MEMORY_CONFIG);
    expect(resolveMemoryConfig([true] as unknown)).toEqual(DEFAULT_MEMORY_CONFIG);
    // Non-boolean field values fall back to that field's default.
    expect(resolveMemoryConfig({ repoLayer: 'nope' })).toEqual(DEFAULT_MEMORY_CONFIG);
  });
});
