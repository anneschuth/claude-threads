/**
 * Tool Formatter Registry
 *
 * This module provides a plugin-based system for formatting tool calls
 * in chat platforms. Each tool (or group of tools) can register a
 * formatter that knows how to display it.
 *
 * Usage:
 * ```typescript
 * import { toolFormatterRegistry } from './operations/tool-formatters';
 *
 * const result = toolFormatterRegistry.format('Read', { file_path: '/foo/bar.ts' }, {
 *   formatter: platformFormatter,
 *   detailed: true,
 * });
 *
 * console.log(result.display); // "📄 **Read** `~/bar.ts`"
 * ```
 */

// Export types
export type {
  ToolFormatOptions,
  ToolFormatResult,
  ToolInput,
  ToolFormatter,
  ToolFormatterRegistryInterface,
  WorktreeContext,
} from './types.js';

// Export utilities
export {
  shortenPath,
  parseMcpToolName,
  escapeRegExp,
  truncateWithEllipsis,
  escapeCodeBlockContent,
} from './utils.js';

export type { McpToolParts } from './utils.js';

// Export registry class and instance
export { ToolFormatterRegistry, toolFormatterRegistry } from './registry.js';

// Export individual formatters (for testing and customization)
export { fileToolsFormatter } from './file-tools.js';
export { bashToolFormatter } from './bash-tools.js';
export { taskToolsFormatter } from './task-tools.js';
export { chromeToolsFormatter } from './chrome-tools.js';
export { webToolsFormatter } from './web-tools.js';

// ---------------------------------------------------------------------------
// Register all built-in formatters
// ---------------------------------------------------------------------------

import { toolFormatterRegistry } from './registry.js';
import { fileToolsFormatter } from './file-tools.js';
import { bashToolFormatter } from './bash-tools.js';
import { taskToolsFormatter } from './task-tools.js';
import { chromeToolsFormatter } from './chrome-tools.js';
import { webToolsFormatter } from './web-tools.js';

// Register all formatters with the default registry
toolFormatterRegistry.register(fileToolsFormatter);
toolFormatterRegistry.register(bashToolFormatter);
toolFormatterRegistry.register(taskToolsFormatter);
toolFormatterRegistry.register(chromeToolsFormatter);
toolFormatterRegistry.register(webToolsFormatter);
