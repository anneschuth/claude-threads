/**
 * MCP Platform API Factory
 *
 * Creates platform-specific MCP-platform-API implementations based on
 * platform type. This isolates platform selection logic to the platform
 * layer.
 */

import type { McpPlatformApi, MattermostMcpApiConfig, SlackMcpApiConfig } from './mcp-platform-api.js';
import { createMattermostMcpPlatformApi } from './mattermost/mcp-platform-api.js';
import { createSlackMcpPlatformApi } from './slack/mcp-platform-api.js';

/**
 * Create an MCP platform API instance for the specified platform type.
 *
 * @param platformType - The platform type ('mattermost' or 'slack')
 * @param config - Platform-specific configuration object
 */
export function createMcpPlatformApi(
  platformType: string,
  config: MattermostMcpApiConfig | SlackMcpApiConfig
): McpPlatformApi {
  switch (platformType) {
    case 'mattermost':
      return createMattermostMcpPlatformApi(config as MattermostMcpApiConfig);
    case 'slack':
      return createSlackMcpPlatformApi(config as SlackMcpApiConfig);
    default:
      throw new Error(`Unsupported platform type: ${platformType}`);
  }
}
