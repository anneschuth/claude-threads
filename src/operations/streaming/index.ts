/**
 * Streaming module - Message streaming utilities
 *
 * Handles typing indicators and file attachments (saved to per-session
 * upload dir, paths handed to Claude).
 */

export {
  buildMessageContent,
  cleanupSessionUploads,
  getSessionUploadDir,
  startTyping,
  stopTyping,
} from './handler.js';
