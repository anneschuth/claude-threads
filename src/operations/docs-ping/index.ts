/**
 * Docs-ping — the bot notifies the docs bot about a shipped change.
 * See handler.ts for the rationale.
 */

export {
  getDocsPingState,
  resolveDocsPing,
  noteEvent,
  onTurnComplete,
  cancelDocsPing,
  pingPending,
  buildDocsJudgePrompt,
  parseDocsVerdict,
  buildDocsMessage,
  DOCS_PING_QUIESCENCE_MS,
} from './handler.js';

export {
  createDocsPingState,
  type DocsPingState,
  type PersistedDocsPingState,
  type DocsVerdict,
} from './types.js';
