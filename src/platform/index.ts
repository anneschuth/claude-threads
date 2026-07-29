/**
 * Platform abstraction layer
 *
 * This module provides platform-agnostic interfaces and types that allow
 * claude-threads to work with a chat platform without coupling the core
 * logic to any specific implementation. Mattermost is the only platform
 * currently implemented; see IMPLEMENTATION_GUIDE.md to add another.
 */

// Core interfaces
export type { PlatformClient, PlatformClientEvents } from './client.js';
export type { PlatformFormatter } from './formatter.js';
export type {
  McpPlatformApi,
  MattermostMcpApiConfig,
  ReactionEvent,
  PostedMessage,
  McpPost,
} from './mcp-platform-api.js';

// Normalized types
export type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  ThreadMessage,
  DeliveryTarget,
} from './types.js';

// Platform implementations
export { BasePlatformClient } from './base-client.js';
export { MattermostClient } from './mattermost/client.js';

// MCP platform API factory
export { createMcpPlatformApi } from './mcp-platform-api-factory.js';
