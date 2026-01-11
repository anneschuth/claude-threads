/**
 * Platform abstraction layer
 *
 * This module provides platform-agnostic interfaces and types that allow
 * claude-threads to work with multiple chat platforms (Mattermost, Slack, etc.)
 * without coupling the core logic to any specific platform.
 */

// Core interfaces
export type { PlatformClient, PlatformClientEvents } from './client.js';
export type { PlatformFormatter } from './formatter.js';
export type {
  PermissionApi,
  PermissionApiConfig,
  MattermostPermissionApiConfig,
  SlackPermissionApiConfig,
  ReactionEvent,
  PostedMessage,
} from './permission-api.js';

// Normalized types
export type {
  PlatformUser,
  PlatformPost,
  PlatformReaction,
  PlatformFile,
  CreatePostRequest,
  UpdatePostRequest,
  AddReactionRequest,
  ThreadMessage,
} from './types.js';

// Platform implementations
export { MattermostClient } from './mattermost/client.js';
export { SlackClient } from './slack/client.js';

// Permission API factory
export { createPermissionApi } from './permission-api-factory.js';
