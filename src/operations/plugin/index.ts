/**
 * Plugin module - Claude Code plugin management
 *
 * Exports plugin command handlers for install, uninstall, and list operations.
 */

export {
  handlePluginList,
  handlePluginInstall,
  handlePluginUninstall,
} from './handler.js';
