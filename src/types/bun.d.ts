/**
 * Bun's ambient types — `bun:test`, `Bun.*`, `import.meta.dir`.
 *
 * Declared explicitly because `tsconfig.json` sets no `types` array: until
 * this file existed the whole test suite got `bun:test` only because one
 * integration fixture happened to `import type { Server } from 'bun'`, so
 * deleting that fixture silently untyped every `bun:test` import.
 */
/// <reference types="bun" />
